use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    CampaignWriterError, StateSubjectV1,
    schema::{APPLICATION_ID, SCHEMA_SQL, USER_VERSION},
    types::{
        CampaignStatusV1, NodeClaimV1, NodeStateV1, NodeStatusV1, PreparedNodeResultV1,
        WriterAuthorityV1, valid_digest, valid_identifier,
    },
};

const MAXIMUM_DATABASE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const BUSY_TIMEOUT_MS: u64 = 5_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FaultPointV1 {
    None,
    AfterCampaignResourceUpdate,
    AfterNodeUpdate,
    AfterEventInsert,
}

pub struct CampaignWriterStoreV1 {
    connection: Connection,
    path: PathBuf,
    owner_uid: u32,
}

impl CampaignWriterStoreV1 {
    pub fn open(path: impl AsRef<Path>, owner_uid: u32) -> Result<Self, CampaignWriterError> {
        let path = prepare_path(path.as_ref(), owner_uid)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(&path, flags)?;
        connection.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA trusted_schema = OFF;
             PRAGMA temp_store = MEMORY;",
        )?;
        let application_id: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let user_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if application_id == 0 && user_version == 0 {
            let object_count: i64 = connection.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )?;
            if object_count != 0 {
                return Err(CampaignWriterError::DatabaseIdentityMismatch {
                    application_id,
                    user_version,
                });
            }
            connection.execute_batch(SCHEMA_SQL)?;
        } else if application_id != APPLICATION_ID || user_version != USER_VERSION {
            return Err(CampaignWriterError::DatabaseIdentityMismatch {
                application_id,
                user_version,
            });
        }
        let store = Self {
            connection,
            path,
            owner_uid,
        };
        store.validate_integrity()?;
        Ok(store)
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn acquire_writer(
        &mut self,
        authority: &WriterAuthorityV1,
        now_unix_ms: u64,
    ) -> Result<(), CampaignWriterError> {
        if now_unix_ms == 0 {
            return Err(CampaignWriterError::InvalidValue);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT generation, token FROM writer_authority WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        match existing {
            None => {
                tx.execute(
                    "INSERT INTO writer_authority (singleton, generation, token, acquired_at_unix_ms)
                     VALUES (1, ?1, ?2, ?3)",
                    params![to_i64(authority.generation)?, authority.token, to_i64(now_unix_ms)?],
                )?;
            }
            Some((generation, token)) => {
                let generation = from_i64(generation)?;
                if generation == authority.generation && token == authority.token {
                    tx.commit()?;
                    return Ok(());
                }
                if authority.generation <= generation {
                    return Err(CampaignWriterError::StaleWriter);
                }
                tx.execute(
                    "UPDATE writer_authority
                     SET generation = ?1, token = ?2, acquired_at_unix_ms = ?3
                     WHERE singleton = 1 AND generation = ?4 AND token = ?5",
                    params![
                        to_i64(authority.generation)?,
                        authority.token,
                        to_i64(now_unix_ms)?,
                        to_i64(generation)?,
                        token,
                    ],
                )?;
            }
        }
        tx.commit()?;
        self.inspect_envelope()
    }

    pub fn create_campaign(
        &mut self,
        authority: &WriterAuthorityV1,
        campaign_id: &str,
        budget_microusd: u64,
        cpu_jobs: u32,
        now_unix_ms: u64,
    ) -> Result<CampaignStatusV1, CampaignWriterError> {
        if !valid_identifier(campaign_id)
            || budget_microusd == 0
            || cpu_jobs == 0
            || now_unix_ms == 0
        {
            return Err(CampaignWriterError::InvalidValue);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_authority(&tx, authority)?;
        tx.execute(
            "INSERT INTO campaigns (
                campaign_id, revision, budget_remaining_microusd, cpu_jobs_remaining,
                created_at_unix_ms, updated_at_unix_ms
             ) VALUES (?1, 0, ?2, ?3, ?4, ?4)",
            params![
                campaign_id,
                to_i64(budget_microusd)?,
                i64::from(cpu_jobs),
                to_i64(now_unix_ms)?,
            ],
        )?;
        append_event(
            &tx,
            campaign_id,
            0,
            "campaign_created",
            None,
            now_unix_ms,
            &json!({"budgetMicrousd": budget_microusd, "cpuJobs": cpu_jobs}),
            FaultPointV1::None,
        )?;
        tx.commit()?;
        self.inspect_envelope()?;
        self.campaign_status(campaign_id)
    }

    pub fn add_node(
        &mut self,
        authority: &WriterAuthorityV1,
        campaign_id: &str,
        node_id: &str,
        now_unix_ms: u64,
    ) -> Result<NodeStatusV1, CampaignWriterError> {
        if !valid_identifier(campaign_id) || !valid_identifier(node_id) || now_unix_ms == 0 {
            return Err(CampaignWriterError::InvalidIdentifier);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_authority(&tx, authority)?;
        let observed_revision = campaign_revision(&tx, campaign_id)?;
        tx.execute(
            "INSERT INTO nodes (
                campaign_id, node_id, state, lease_generation, updated_at_unix_ms
             ) VALUES (?1, ?2, 'ready', 0, ?3)",
            params![campaign_id, node_id, to_i64(now_unix_ms)?],
        )?;
        let revision = advance_revision(&tx, campaign_id, observed_revision, now_unix_ms)?;
        append_event(
            &tx,
            campaign_id,
            revision,
            "node_added",
            Some(node_id),
            now_unix_ms,
            &json!({}),
            FaultPointV1::None,
        )?;
        tx.commit()?;
        self.inspect_envelope()?;
        self.node_status(campaign_id, node_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn claim_node(
        &mut self,
        authority: &WriterAuthorityV1,
        campaign_id: &str,
        node_id: &str,
        expected_campaign_revision: u64,
        attempt_id: &str,
        claim_owner: &str,
        deadline_unix_ms: u64,
        reserve_microusd: u64,
        reserve_cpu_jobs: u32,
        now_unix_ms: u64,
        fault: FaultPointV1,
    ) -> Result<NodeClaimV1, CampaignWriterError> {
        if !valid_identifier(campaign_id)
            || !valid_identifier(node_id)
            || !valid_identifier(attempt_id)
            || !valid_identifier(claim_owner)
            || reserve_microusd == 0
            || reserve_cpu_jobs == 0
            || now_unix_ms == 0
            || deadline_unix_ms <= now_unix_ms
        {
            return Err(CampaignWriterError::InvalidValue);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_authority(&tx, authority)?;
        let (revision, budget, cpu) = tx.query_row(
            "SELECT revision, budget_remaining_microusd, cpu_jobs_remaining
             FROM campaigns WHERE campaign_id = ?1",
            [campaign_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?;
        let revision = from_i64(revision)?;
        if revision != expected_campaign_revision {
            return Err(CampaignWriterError::StaleRevision {
                expected: expected_campaign_revision,
                observed: revision,
            });
        }
        if from_i64(budget)? < reserve_microusd {
            return Err(CampaignWriterError::BudgetExhausted);
        }
        if from_i64(cpu)? < u64::from(reserve_cpu_jobs) {
            return Err(CampaignWriterError::CpuCapacityExhausted);
        }
        let (state, lease_generation) = tx.query_row(
            "SELECT state, lease_generation FROM nodes
             WHERE campaign_id = ?1 AND node_id = ?2",
            params![campaign_id, node_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let state = NodeStateV1::from_str(&state)?;
        if state != NodeStateV1::Ready {
            return Err(CampaignWriterError::StateConflict {
                subject: StateSubjectV1::Node,
                expected: NodeStateV1::Ready.as_str().to_owned(),
                observed: state.as_str().to_owned(),
            });
        }
        let lease_generation = from_i64(lease_generation)?
            .checked_add(1)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        let resources_updated = tx.execute(
            "UPDATE campaigns
             SET budget_remaining_microusd = budget_remaining_microusd - ?1,
                 cpu_jobs_remaining = cpu_jobs_remaining - ?2,
                 updated_at_unix_ms = ?3
             WHERE campaign_id = ?4 AND revision = ?5
               AND budget_remaining_microusd >= ?1 AND cpu_jobs_remaining >= ?2",
            params![
                to_i64(reserve_microusd)?,
                i64::from(reserve_cpu_jobs),
                to_i64(now_unix_ms)?,
                campaign_id,
                to_i64(revision)?,
            ],
        )?;
        if resources_updated != 1 {
            return Err(CampaignWriterError::StaleRevision {
                expected: revision,
                observed: campaign_revision(&tx, campaign_id)?,
            });
        }
        inject(fault, FaultPointV1::AfterCampaignResourceUpdate)?;
        let updated = tx.execute(
            "UPDATE nodes
             SET state = 'claimed', lease_generation = ?1, attempt_id = ?2,
                 claim_owner = ?3, claim_deadline_unix_ms = ?4,
                 reserved_microusd = ?5, reserved_cpu_jobs = ?6,
                 provider_action_may_have_started = 0,
                 prepared_receipt_hash = NULL, integrated_result_hash = NULL,
                 updated_at_unix_ms = ?7
             WHERE campaign_id = ?8 AND node_id = ?9 AND state = 'ready'",
            params![
                to_i64(lease_generation)?,
                attempt_id,
                claim_owner,
                to_i64(deadline_unix_ms)?,
                to_i64(reserve_microusd)?,
                i64::from(reserve_cpu_jobs),
                to_i64(now_unix_ms)?,
                campaign_id,
                node_id,
            ],
        )?;
        if updated != 1 {
            return Err(CampaignWriterError::StateConflict {
                subject: StateSubjectV1::Node,
                expected: NodeStateV1::Ready.as_str().to_owned(),
                observed: "changed_concurrently".to_owned(),
            });
        }
        inject(fault, FaultPointV1::AfterNodeUpdate)?;
        let new_revision = advance_revision(&tx, campaign_id, revision, now_unix_ms)?;
        append_event(
            &tx,
            campaign_id,
            new_revision,
            "node_claimed",
            Some(node_id),
            now_unix_ms,
            &json!({
                "attemptId": attempt_id,
                "claimOwner": claim_owner,
                "leaseGeneration": lease_generation,
                "reservedMicrousd": reserve_microusd,
                "reservedCpuJobs": reserve_cpu_jobs,
            }),
            fault,
        )?;
        tx.commit()?;
        self.inspect_envelope()?;
        Ok(NodeClaimV1 {
            campaign_id: campaign_id.to_owned(),
            node_id: node_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            claim_owner: claim_owner.to_owned(),
            campaign_revision: new_revision,
            lease_generation,
            deadline_unix_ms,
            reserved_microusd: reserve_microusd,
            reserved_cpu_jobs: reserve_cpu_jobs,
        })
    }

    pub fn heartbeat(
        &mut self,
        authority: &WriterAuthorityV1,
        claim: &NodeClaimV1,
        new_deadline_unix_ms: u64,
        now_unix_ms: u64,
    ) -> Result<NodeClaimV1, CampaignWriterError> {
        if now_unix_ms == 0 || new_deadline_unix_ms <= now_unix_ms {
            return Err(CampaignWriterError::InvalidValue);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_authority(&tx, authority)?;
        verify_claim(&tx, claim, NodeStateV1::Claimed)?;
        let updated = tx.execute(
            "UPDATE nodes SET claim_deadline_unix_ms = ?1, updated_at_unix_ms = ?2
             WHERE campaign_id = ?3 AND node_id = ?4 AND state = 'claimed'
               AND lease_generation = ?5 AND attempt_id = ?6 AND claim_owner = ?7",
            params![
                to_i64(new_deadline_unix_ms)?,
                to_i64(now_unix_ms)?,
                claim.campaign_id,
                claim.node_id,
                to_i64(claim.lease_generation)?,
                claim.attempt_id,
                claim.claim_owner,
            ],
        )?;
        if updated != 1 {
            return Err(CampaignWriterError::ClaimIdentityMismatch);
        }
        append_event(
            &tx,
            &claim.campaign_id,
            campaign_revision(&tx, &claim.campaign_id)?,
            "node_heartbeat",
            Some(&claim.node_id),
            now_unix_ms,
            &json!({"deadlineUnixMs": new_deadline_unix_ms}),
            FaultPointV1::None,
        )?;
        tx.commit()?;
        self.inspect_envelope()?;
        let mut result = claim.clone();
        result.deadline_unix_ms = new_deadline_unix_ms;
        Ok(result)
    }

    pub fn record_prepared_result(
        &mut self,
        authority: &WriterAuthorityV1,
        claim: &NodeClaimV1,
        prepared_receipt_hash: &str,
        provider_action_may_have_started: bool,
        now_unix_ms: u64,
        fault: FaultPointV1,
    ) -> Result<PreparedNodeResultV1, CampaignWriterError> {
        if !valid_digest(prepared_receipt_hash) || now_unix_ms == 0 {
            return Err(CampaignWriterError::InvalidDigest);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_authority(&tx, authority)?;
        verify_claim(&tx, claim, NodeStateV1::Claimed)?;
        let revision = campaign_revision(&tx, &claim.campaign_id)?;
        let updated = tx.execute(
            "UPDATE nodes
             SET state = 'prepared', prepared_receipt_hash = ?1,
                 provider_action_may_have_started = ?2, updated_at_unix_ms = ?3
             WHERE campaign_id = ?4 AND node_id = ?5 AND state = 'claimed'
               AND lease_generation = ?6 AND attempt_id = ?7 AND claim_owner = ?8",
            params![
                prepared_receipt_hash,
                i64::from(provider_action_may_have_started),
                to_i64(now_unix_ms)?,
                claim.campaign_id,
                claim.node_id,
                to_i64(claim.lease_generation)?,
                claim.attempt_id,
                claim.claim_owner,
            ],
        )?;
        if updated != 1 {
            return Err(CampaignWriterError::ClaimIdentityMismatch);
        }
        inject(fault, FaultPointV1::AfterNodeUpdate)?;
        let new_revision = advance_revision(&tx, &claim.campaign_id, revision, now_unix_ms)?;
        append_event(
            &tx,
            &claim.campaign_id,
            new_revision,
            "result_prepared",
            Some(&claim.node_id),
            now_unix_ms,
            &json!({
                "preparedReceiptHash": prepared_receipt_hash,
                "providerActionMayHaveStarted": provider_action_may_have_started,
            }),
            fault,
        )?;
        tx.commit()?;
        self.inspect_envelope()?;
        let mut prepared_claim = claim.clone();
        prepared_claim.campaign_revision = new_revision;
        Ok(PreparedNodeResultV1 {
            claim: prepared_claim,
            prepared_receipt_hash: prepared_receipt_hash.to_owned(),
            provider_action_may_have_started,
        })
    }

    pub fn integrate_prepared_result(
        &mut self,
        authority: &WriterAuthorityV1,
        prepared: &PreparedNodeResultV1,
        integrated_result_hash: &str,
        now_unix_ms: u64,
        fault: FaultPointV1,
    ) -> Result<NodeStatusV1, CampaignWriterError> {
        if !valid_digest(integrated_result_hash) || now_unix_ms == 0 {
            return Err(CampaignWriterError::InvalidDigest);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_authority(&tx, authority)?;
        let existing = load_node_status(&tx, &prepared.claim.campaign_id, &prepared.claim.node_id)?;
        if existing.state == NodeStateV1::Completed {
            if existing.integrated_result_hash.as_deref() == Some(integrated_result_hash)
                && existing.prepared_receipt_hash.as_deref()
                    == Some(prepared.prepared_receipt_hash.as_str())
            {
                tx.commit()?;
                return Ok(existing);
            }
            return Err(CampaignWriterError::PreparedResultConflict);
        }
        verify_claim(&tx, &prepared.claim, NodeStateV1::Prepared)?;
        if existing.prepared_receipt_hash.as_deref()
            != Some(prepared.prepared_receipt_hash.as_str())
            || existing.provider_action_may_have_started
                != prepared.provider_action_may_have_started
        {
            return Err(CampaignWriterError::PreparedResultConflict);
        }
        let revision = campaign_revision(&tx, &prepared.claim.campaign_id)?;
        if revision != prepared.claim.campaign_revision {
            return Err(CampaignWriterError::StaleRevision {
                expected: prepared.claim.campaign_revision,
                observed: revision,
            });
        }
        let updated = tx.execute(
            "UPDATE nodes
             SET state = 'completed', integrated_result_hash = ?1,
                 claim_deadline_unix_ms = NULL, updated_at_unix_ms = ?2
             WHERE campaign_id = ?3 AND node_id = ?4 AND state = 'prepared'
               AND lease_generation = ?5 AND attempt_id = ?6 AND claim_owner = ?7
               AND prepared_receipt_hash = ?8",
            params![
                integrated_result_hash,
                to_i64(now_unix_ms)?,
                prepared.claim.campaign_id,
                prepared.claim.node_id,
                to_i64(prepared.claim.lease_generation)?,
                prepared.claim.attempt_id,
                prepared.claim.claim_owner,
                prepared.prepared_receipt_hash,
            ],
        )?;
        if updated != 1 {
            return Err(CampaignWriterError::PreparedResultConflict);
        }
        inject(fault, FaultPointV1::AfterNodeUpdate)?;
        let new_revision = advance_revision(
            &tx,
            &prepared.claim.campaign_id,
            revision,
            now_unix_ms,
        )?;
        append_event(
            &tx,
            &prepared.claim.campaign_id,
            new_revision,
            "result_integrated",
            Some(&prepared.claim.node_id),
            now_unix_ms,
            &json!({"integratedResultHash": integrated_result_hash}),
            fault,
        )?;
        tx.commit()?;
        self.inspect_envelope()?;
        self.node_status(&prepared.claim.campaign_id, &prepared.claim.node_id)
    }

    pub fn fail_before_provider(
        &mut self,
        authority: &WriterAuthorityV1,
        claim: &NodeClaimV1,
        now_unix_ms: u64,
        fault: FaultPointV1,
    ) -> Result<NodeStatusV1, CampaignWriterError> {
        self.finish_with_settlement(
            authority,
            claim,
            false,
            NodeStateV1::FailedPreProvider,
            now_unix_ms,
            fault,
        )
    }

    pub fn settle_ambiguous(
        &mut self,
        authority: &WriterAuthorityV1,
        claim: &NodeClaimV1,
        now_unix_ms: u64,
        fault: FaultPointV1,
    ) -> Result<NodeStatusV1, CampaignWriterError> {
        self.finish_with_settlement(
            authority,
            claim,
            true,
            NodeStateV1::Ambiguous,
            now_unix_ms,
            fault,
        )
    }

    fn finish_with_settlement(
        &mut self,
        authority: &WriterAuthorityV1,
        claim: &NodeClaimV1,
        provider_action_may_have_started: bool,
        terminal_state: NodeStateV1,
        now_unix_ms: u64,
        fault: FaultPointV1,
    ) -> Result<NodeStatusV1, CampaignWriterError> {
        if now_unix_ms == 0 {
            return Err(CampaignWriterError::InvalidValue);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_authority(&tx, authority)?;
        let status = load_node_status(&tx, &claim.campaign_id, &claim.node_id)?;
        if !matches!(status.state, NodeStateV1::Claimed | NodeStateV1::Prepared) {
            return Err(CampaignWriterError::StateConflict {
                subject: StateSubjectV1::Node,
                expected: "claimed_or_prepared".to_owned(),
                observed: status.state.as_str().to_owned(),
            });
        }
        verify_claim_any_active(&tx, claim)?;
        if !provider_action_may_have_started && status.provider_action_may_have_started {
            return Err(CampaignWriterError::RefundAfterProviderAction);
        }
        let revision = campaign_revision(&tx, &claim.campaign_id)?;
        if !provider_action_may_have_started {
            tx.execute(
                "UPDATE campaigns
                 SET budget_remaining_microusd = budget_remaining_microusd + ?1,
                     cpu_jobs_remaining = cpu_jobs_remaining + ?2,
                     updated_at_unix_ms = ?3
                 WHERE campaign_id = ?4 AND revision = ?5",
                params![
                    to_i64(claim.reserved_microusd)?,
                    i64::from(claim.reserved_cpu_jobs),
                    to_i64(now_unix_ms)?,
                    claim.campaign_id,
                    to_i64(revision)?,
                ],
            )?;
            inject(fault, FaultPointV1::AfterCampaignResourceUpdate)?;
        }
        let updated = tx.execute(
            "UPDATE nodes
             SET state = ?1, provider_action_may_have_started = ?2,
                 claim_deadline_unix_ms = NULL, updated_at_unix_ms = ?3
             WHERE campaign_id = ?4 AND node_id = ?5
               AND state IN ('claimed', 'prepared') AND lease_generation = ?6
               AND attempt_id = ?7 AND claim_owner = ?8",
            params![
                terminal_state.as_str(),
                i64::from(provider_action_may_have_started),
                to_i64(now_unix_ms)?,
                claim.campaign_id,
                claim.node_id,
                to_i64(claim.lease_generation)?,
                claim.attempt_id,
                claim.claim_owner,
            ],
        )?;
        if updated != 1 {
            return Err(CampaignWriterError::ClaimIdentityMismatch);
        }
        inject(fault, FaultPointV1::AfterNodeUpdate)?;
        let new_revision = advance_revision(&tx, &claim.campaign_id, revision, now_unix_ms)?;
        append_event(
            &tx,
            &claim.campaign_id,
            new_revision,
            terminal_state.as_str(),
            Some(&claim.node_id),
            now_unix_ms,
            &json!({
                "providerActionMayHaveStarted": provider_action_may_have_started,
                "refunded": !provider_action_may_have_started,
            }),
            fault,
        )?;
        tx.commit()?;
        self.inspect_envelope()?;
        self.node_status(&claim.campaign_id, &claim.node_id)
    }

    pub fn recover_expired_claims(
        &mut self,
        authority: &WriterAuthorityV1,
        now_unix_ms: u64,
    ) -> Result<u64, CampaignWriterError> {
        if now_unix_ms == 0 {
            return Err(CampaignWriterError::InvalidValue);
        }
        let candidates = {
            let mut statement = self.connection.prepare(
                "SELECT campaign_id, node_id, attempt_id, claim_owner, lease_generation,
                        reserved_microusd, reserved_cpu_jobs, provider_action_may_have_started
                 FROM nodes
                 WHERE state = 'claimed' AND claim_deadline_unix_ms < ?1
                 ORDER BY campaign_id, node_id",
            )?;
            statement
                .query_map([to_i64(now_unix_ms)?], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut recovered = 0_u64;
        for (campaign_id, node_id, attempt_id, claim_owner, lease, budget, cpu, provider) in
            candidates
        {
            let claim = NodeClaimV1 {
                campaign_revision: self.campaign_status(&campaign_id)?.revision,
                campaign_id,
                node_id,
                attempt_id,
                claim_owner,
                lease_generation: from_i64(lease)?,
                deadline_unix_ms: now_unix_ms.saturating_sub(1),
                reserved_microusd: from_i64(budget)?,
                reserved_cpu_jobs: u32::try_from(from_i64(cpu)?)
                    .map_err(|_| CampaignWriterError::NumericOverflow)?,
            };
            if provider != 0 {
                self.settle_ambiguous(
                    authority,
                    &claim,
                    now_unix_ms,
                    FaultPointV1::None,
                )?;
            } else {
                self.fail_before_provider(
                    authority,
                    &claim,
                    now_unix_ms,
                    FaultPointV1::None,
                )?;
            }
            recovered = recovered
                .checked_add(1)
                .ok_or(CampaignWriterError::NumericOverflow)?;
        }
        Ok(recovered)
    }

    pub fn load_prepared_result(
        &self,
        campaign_id: &str,
        node_id: &str,
    ) -> Result<PreparedNodeResultV1, CampaignWriterError> {
        let revision = self.campaign_status(campaign_id)?.revision;
        self.connection.query_row(
            "SELECT attempt_id, claim_owner, lease_generation, claim_deadline_unix_ms,
                    reserved_microusd, reserved_cpu_jobs, prepared_receipt_hash,
                    provider_action_may_have_started, state
             FROM nodes WHERE campaign_id = ?1 AND node_id = ?2",
            params![campaign_id, node_id],
            |row| {
                let state: String = row.get(8)?;
                if state != "prepared" && state != "completed" {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                Ok(PreparedNodeResultV1 {
                    claim: NodeClaimV1 {
                        campaign_id: campaign_id.to_owned(),
                        node_id: node_id.to_owned(),
                        attempt_id: row.get(0)?,
                        claim_owner: row.get(1)?,
                        campaign_revision: revision,
                        lease_generation: from_i64_sql(row.get(2)?)?,
                        deadline_unix_ms: row
                            .get::<_, Option<i64>>(3)?
                            .map_or(Ok(0), from_i64_sql)?,
                        reserved_microusd: from_i64_sql(row.get(4)?)?,
                        reserved_cpu_jobs: u32::try_from(from_i64_sql(row.get(5)?)?)
                            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(5, i64::MAX))?,
                    },
                    prepared_receipt_hash: row.get(6)?,
                    provider_action_may_have_started: row.get::<_, i64>(7)? != 0,
                })
            },
        ).map_err(CampaignWriterError::from)
    }

    pub fn campaign_status(
        &self,
        campaign_id: &str,
    ) -> Result<CampaignStatusV1, CampaignWriterError> {
        self.connection.query_row(
            "SELECT c.revision, c.budget_remaining_microusd, c.cpu_jobs_remaining,
                    sum(CASE WHEN n.state = 'completed' THEN 1 ELSE 0 END),
                    sum(CASE WHEN n.state = 'ambiguous' THEN 1 ELSE 0 END)
             FROM campaigns c LEFT JOIN nodes n ON n.campaign_id = c.campaign_id
             WHERE c.campaign_id = ?1 GROUP BY c.campaign_id",
            [campaign_id],
            |row| {
                Ok(CampaignStatusV1 {
                    campaign_id: campaign_id.to_owned(),
                    revision: from_i64_sql(row.get(0)?)?,
                    budget_remaining_microusd: from_i64_sql(row.get(1)?)?,
                    cpu_jobs_remaining: u32::try_from(from_i64_sql(row.get(2)?)?)
                        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(2, i64::MAX))?,
                    completed_nodes: from_i64_sql(row.get::<_, i64>(3)?)?,
                    ambiguous_nodes: from_i64_sql(row.get::<_, i64>(4)?)?,
                })
            },
        ).map_err(CampaignWriterError::from)
    }

    pub fn node_status(
        &self,
        campaign_id: &str,
        node_id: &str,
    ) -> Result<NodeStatusV1, CampaignWriterError> {
        load_node_status(&self.connection, campaign_id, node_id)
    }

    pub fn validate_integrity(&self) -> Result<(), CampaignWriterError> {
        let integrity: String =
            self.connection
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(CampaignWriterError::IntegrityFailure(integrity));
        }
        let foreign_key_errors: i64 = self.connection.query_row(
            "SELECT count(*) FROM pragma_foreign_key_check",
            [],
            |row| row.get(0),
        )?;
        if foreign_key_errors != 0 {
            return Err(CampaignWriterError::IntegrityFailure(
                "foreign_key_check".to_owned(),
            ));
        }
        validate_event_chain(&self.connection)?;
        self.inspect_envelope()
    }

    pub fn create_backup(
        &mut self,
        destination: impl AsRef<Path>,
    ) -> Result<String, CampaignWriterError> {
        let destination = destination.as_ref();
        if destination.exists() || !destination.is_absolute() {
            return Err(CampaignWriterError::DestinationExists);
        }
        self.validate_integrity()?;
        self.connection.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
        self.connection.execute("VACUUM INTO ?1", [destination])?;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600))
            .map_err(|error| CampaignWriterError::Filesystem("backup_permissions", error.kind()))?;
        File::open(destination)
            .and_then(|file| file.sync_all())
            .map_err(|error| CampaignWriterError::Filesystem("backup_sync", error.kind()))?;
        sync_parent(destination)?;
        let hash = hash_file(destination)?;
        let backup = Self::open(destination, self.owner_uid)?;
        backup.validate_integrity()?;
        Ok(hash)
    }

    pub fn restore_create_only(
        backup: impl AsRef<Path>,
        destination: impl AsRef<Path>,
        owner_uid: u32,
    ) -> Result<Self, CampaignWriterError> {
        let backup = backup.as_ref();
        let destination = destination.as_ref();
        if destination.exists() || !destination.is_absolute() {
            return Err(CampaignWriterError::DestinationExists);
        }
        let source = Self::open(backup, owner_uid)?;
        source.validate_integrity()?;
        let parent = destination
            .parent()
            .ok_or(CampaignWriterError::DatabasePathInvalid)?;
        inspect_parent(parent, owner_uid)?;
        let temporary = parent.join(format!(
            ".{}.restore.{}",
            destination
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(CampaignWriterError::DatabasePathInvalid)?,
            std::process::id()
        ));
        let mut input = File::open(backup)
            .map_err(|error| CampaignWriterError::Filesystem("restore_open", error.kind()))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| CampaignWriterError::Filesystem("restore_create", error.kind()))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|error| CampaignWriterError::Filesystem("restore_copy", error.kind()))?;
        output
            .sync_all()
            .map_err(|error| CampaignWriterError::Filesystem("restore_sync", error.kind()))?;
        fs::rename(&temporary, destination)
            .map_err(|error| CampaignWriterError::Filesystem("restore_publish", error.kind()))?;
        sync_parent(destination)?;
        let restored = Self::open(destination, owner_uid)?;
        restored.validate_integrity()?;
        Ok(restored)
    }

    fn inspect_envelope(&self) -> Result<(), CampaignWriterError> {
        inspect_parent(
            self.path
                .parent()
                .ok_or(CampaignWriterError::DatabasePathInvalid)?,
            self.owner_uid,
        )?;
        inspect_database(&self.path, self.owner_uid)
    }
}

fn prepare_path(path: &Path, owner_uid: u32) -> Result<PathBuf, CampaignWriterError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    let parent = path
        .parent()
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    inspect_parent(parent, owner_uid)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| CampaignWriterError::Filesystem("database_parent", error.kind()))?;
    let canonical = canonical_parent.join(
        path.file_name()
            .ok_or(CampaignWriterError::DatabasePathInvalid)?,
    );
    if canonical != path {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    if !path.exists() {
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| CampaignWriterError::Filesystem("database_create", error.kind()))?;
        file.sync_all()
            .map_err(|error| CampaignWriterError::Filesystem("database_create", error.kind()))?;
        sync_parent(path)?;
    }
    inspect_database(path, owner_uid)?;
    Ok(canonical)
}

fn inspect_parent(parent: &Path, owner_uid: u32) -> Result<(), CampaignWriterError> {
    let canonical = fs::canonicalize(parent)
        .map_err(|error| CampaignWriterError::Filesystem("database_parent", error.kind()))?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| CampaignWriterError::Filesystem("database_parent", error.kind()))?;
    if canonical != parent
        || metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(CampaignWriterError::DatabaseAuthorityInvalid);
    }
    Ok(())
}

fn inspect_database(path: &Path, owner_uid: u32) -> Result<(), CampaignWriterError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CampaignWriterError::Filesystem("database", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
        || metadata.size() > MAXIMUM_DATABASE_BYTES
    {
        return Err(CampaignWriterError::DatabaseAuthorityInvalid);
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        if let Ok(sidecar_metadata) = fs::symlink_metadata(&sidecar)
            && (sidecar_metadata.file_type().is_symlink()
                || !sidecar_metadata.is_file()
                || sidecar_metadata.uid() != owner_uid
                || sidecar_metadata.nlink() != 1)
        {
            return Err(CampaignWriterError::DatabaseAuthorityInvalid);
        }
    }
    Ok(())
}

fn assert_authority(
    tx: &Transaction<'_>,
    authority: &WriterAuthorityV1,
) -> Result<(), CampaignWriterError> {
    let active = tx
        .query_row(
            "SELECT generation, token FROM writer_authority WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    match active {
        Some((generation, token))
            if from_i64(generation)? == authority.generation && token == authority.token =>
        {
            Ok(())
        }
        _ => Err(CampaignWriterError::StaleWriter),
    }
}

fn verify_claim(
    connection: &Connection,
    claim: &NodeClaimV1,
    expected_state: NodeStateV1,
) -> Result<(), CampaignWriterError> {
    let (state, lease, attempt, owner, reserved_budget, reserved_cpu) = connection.query_row(
        "SELECT state, lease_generation, attempt_id, claim_owner,
                reserved_microusd, reserved_cpu_jobs
         FROM nodes WHERE campaign_id = ?1 AND node_id = ?2",
        params![claim.campaign_id, claim.node_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        },
    )?;
    let observed_state = NodeStateV1::from_str(&state)?;
    if observed_state != expected_state {
        return Err(CampaignWriterError::StateConflict {
            subject: StateSubjectV1::Node,
            expected: expected_state.as_str().to_owned(),
            observed: observed_state.as_str().to_owned(),
        });
    }
    let observed_lease = from_i64(lease)?;
    if observed_lease != claim.lease_generation {
        return Err(CampaignWriterError::StaleLease {
            expected: claim.lease_generation,
            observed: observed_lease,
        });
    }
    if attempt.as_deref() != Some(claim.attempt_id.as_str())
        || owner.as_deref() != Some(claim.claim_owner.as_str())
        || from_i64(reserved_budget)? != claim.reserved_microusd
        || from_i64(reserved_cpu)? != u64::from(claim.reserved_cpu_jobs)
    {
        return Err(CampaignWriterError::ClaimIdentityMismatch);
    }
    Ok(())
}

fn verify_claim_any_active(
    connection: &Connection,
    claim: &NodeClaimV1,
) -> Result<(), CampaignWriterError> {
    let state: String = connection.query_row(
        "SELECT state FROM nodes WHERE campaign_id = ?1 AND node_id = ?2",
        params![claim.campaign_id, claim.node_id],
        |row| row.get(0),
    )?;
    let state = NodeStateV1::from_str(&state)?;
    if !matches!(state, NodeStateV1::Claimed | NodeStateV1::Prepared) {
        return Err(CampaignWriterError::StateConflict {
            subject: StateSubjectV1::Node,
            expected: "claimed_or_prepared".to_owned(),
            observed: state.as_str().to_owned(),
        });
    }
    verify_claim(connection, claim, state)
}

fn campaign_revision(
    connection: &Connection,
    campaign_id: &str,
) -> Result<u64, CampaignWriterError> {
    let revision: i64 = connection.query_row(
        "SELECT revision FROM campaigns WHERE campaign_id = ?1",
        [campaign_id],
        |row| row.get(0),
    )?;
    from_i64(revision)
}

fn advance_revision(
    tx: &Transaction<'_>,
    campaign_id: &str,
    expected: u64,
    now_unix_ms: u64,
) -> Result<u64, CampaignWriterError> {
    let next = expected
        .checked_add(1)
        .ok_or(CampaignWriterError::NumericOverflow)?;
    let updated = tx.execute(
        "UPDATE campaigns SET revision = ?1, updated_at_unix_ms = ?2
         WHERE campaign_id = ?3 AND revision = ?4",
        params![
            to_i64(next)?,
            to_i64(now_unix_ms)?,
            campaign_id,
            to_i64(expected)?,
        ],
    )?;
    if updated != 1 {
        return Err(CampaignWriterError::StaleRevision {
            expected,
            observed: campaign_revision(tx, campaign_id)?,
        });
    }
    Ok(next)
}

#[allow(clippy::too_many_arguments)]
fn append_event<T: Serialize>(
    tx: &Transaction<'_>,
    campaign_id: &str,
    revision: u64,
    kind: &str,
    subject_id: Option<&str>,
    recorded_at_unix_ms: u64,
    payload: &T,
    fault: FaultPointV1,
) -> Result<(), CampaignWriterError> {
    if !valid_identifier(kind) || recorded_at_unix_ms == 0 {
        return Err(CampaignWriterError::InvalidValue);
    }
    let previous: Option<String> = tx.query_row(
        "SELECT event_hash FROM campaign_events
         WHERE campaign_id = ?1 ORDER BY sequence DESC LIMIT 1",
        [campaign_id],
        |row| row.get(0),
    ).optional()?;
    let payload_json = serde_json::to_vec(payload)
        .map_err(|_| CampaignWriterError::CorruptValue("event_payload"))?;
    let event_hash = hash_event(
        campaign_id,
        revision,
        kind,
        subject_id,
        recorded_at_unix_ms,
        &payload_json,
        previous.as_deref(),
    )?;
    tx.execute(
        "INSERT INTO campaign_events (
            campaign_id, campaign_revision, event_kind, subject_id,
            recorded_at_unix_ms, payload_json, previous_event_hash, event_hash
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            campaign_id,
            to_i64(revision)?,
            kind,
            subject_id,
            to_i64(recorded_at_unix_ms)?,
            payload_json,
            previous,
            event_hash,
        ],
    )?;
    inject(fault, FaultPointV1::AfterEventInsert)
}

fn validate_event_chain(connection: &Connection) -> Result<(), CampaignWriterError> {
    let mut statement = connection.prepare(
        "SELECT campaign_id, campaign_revision, event_kind, subject_id,
                recorded_at_unix_ms, payload_json, previous_event_hash, event_hash
         FROM campaign_events ORDER BY campaign_id, sequence",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Vec<u8>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let mut prior_campaign: Option<String> = None;
    let mut prior_hash: Option<String> = None;
    for row in rows {
        let (campaign, revision, kind, subject, recorded, payload, previous, event_hash) = row?;
        if prior_campaign.as_deref() != Some(campaign.as_str()) {
            prior_campaign = Some(campaign.clone());
            prior_hash = None;
        }
        if previous != prior_hash {
            return Err(CampaignWriterError::EventChainCorrupt);
        }
        let expected = hash_event(
            &campaign,
            from_i64(revision)?,
            &kind,
            subject.as_deref(),
            from_i64(recorded)?,
            &payload,
            prior_hash.as_deref(),
        )?;
        if expected != event_hash {
            return Err(CampaignWriterError::EventChainCorrupt);
        }
        prior_hash = Some(event_hash);
    }
    Ok(())
}

fn hash_event(
    campaign_id: &str,
    revision: u64,
    kind: &str,
    subject_id: Option<&str>,
    recorded_at_unix_ms: u64,
    payload: &[u8],
    previous: Option<&str>,
) -> Result<String, CampaignWriterError> {
    let mut hasher = Sha256::new();
    update_field(&mut hasher, b"HeptaCampaignEventV1")?;
    update_field(&mut hasher, campaign_id.as_bytes())?;
    update_field(&mut hasher, &revision.to_be_bytes())?;
    update_field(&mut hasher, kind.as_bytes())?;
    update_field(&mut hasher, subject_id.unwrap_or_default().as_bytes())?;
    update_field(&mut hasher, &recorded_at_unix_ms.to_be_bytes())?;
    update_field(&mut hasher, payload)?;
    update_field(&mut hasher, previous.unwrap_or_default().as_bytes())?;
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update_field(hasher: &mut Sha256, bytes: &[u8]) -> Result<(), CampaignWriterError> {
    hasher.update(
        u64::try_from(bytes.len())
            .map_err(|_| CampaignWriterError::NumericOverflow)?
            .to_be_bytes(),
    );
    hasher.update(bytes);
    Ok(())
}

fn load_node_status(
    connection: &Connection,
    campaign_id: &str,
    node_id: &str,
) -> Result<NodeStatusV1, CampaignWriterError> {
    connection.query_row(
        "SELECT state, lease_generation, attempt_id, prepared_receipt_hash,
                integrated_result_hash, provider_action_may_have_started
         FROM nodes WHERE campaign_id = ?1 AND node_id = ?2",
        params![campaign_id, node_id],
        |row| {
            Ok(NodeStatusV1 {
                campaign_id: campaign_id.to_owned(),
                node_id: node_id.to_owned(),
                state: NodeStateV1::from_str(&row.get::<_, String>(0)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                lease_generation: from_i64_sql(row.get(1)?)?,
                attempt_id: row.get(2)?,
                prepared_receipt_hash: row.get(3)?,
                integrated_result_hash: row.get(4)?,
                provider_action_may_have_started: row.get::<_, i64>(5)? != 0,
            })
        },
    ).map_err(CampaignWriterError::from)
}

fn inject(selected: FaultPointV1, current: FaultPointV1) -> Result<(), CampaignWriterError> {
    if selected == current {
        Err(CampaignWriterError::InjectedFault(current))
    } else {
        Ok(())
    }
}

fn to_i64(value: u64) -> Result<i64, CampaignWriterError> {
    i64::try_from(value).map_err(|_| CampaignWriterError::NumericOverflow)
}

fn from_i64(value: i64) -> Result<u64, CampaignWriterError> {
    u64::try_from(value).map_err(|_| CampaignWriterError::CorruptValue("negative_integer"))
}

fn from_i64_sql(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn sync_parent(path: &Path) -> Result<(), CampaignWriterError> {
    let parent = path
        .parent()
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| CampaignWriterError::Filesystem("parent_sync", error.kind()))
}

fn hash_file(path: &Path) -> Result<String, CampaignWriterError> {
    use std::io::Read;
    let mut file = File::open(path)
        .map_err(|error| CampaignWriterError::Filesystem("hash_file", error.kind()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| CampaignWriterError::Filesystem("hash_file", error.kind()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        database: PathBuf,
        uid: u32,
    }

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "hepta-writer-{}-{nonce}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).expect("create root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
            let uid = fs::metadata(&root).expect("root metadata").uid();
            Self {
                database: root.join("campaign.sqlite"),
                root,
                uid,
            }
        }

        fn store(&self) -> CampaignWriterStoreV1 {
            CampaignWriterStoreV1::open(&self.database, self.uid).expect("open store")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn digest(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn setup() -> (Fixture, CampaignWriterStoreV1, WriterAuthorityV1) {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        let authority = WriterAuthorityV1::new(1, "writer-token-1").expect("authority");
        store.acquire_writer(&authority, 1).expect("acquire");
        store
            .create_campaign(&authority, "campaign-1", 10_000, 8, 2)
            .expect("campaign");
        store
            .add_node(&authority, "campaign-1", "node-1", 3)
            .expect("node");
        (fixture, store, authority)
    }

    #[test]
    fn stale_writer_and_stale_revision_cannot_claim() {
        let (_fixture, mut store, authority) = setup();
        let stale = WriterAuthorityV1::new(1, "other-token").expect("stale");
        assert!(matches!(
            store.claim_node(
                &stale,
                "campaign-1",
                "node-1",
                1,
                "attempt-1",
                "worker-1",
                100,
                100,
                1,
                4,
                FaultPointV1::None,
            ),
            Err(CampaignWriterError::StaleWriter)
        ));
        let revision = store.campaign_status("campaign-1").expect("status").revision;
        assert!(matches!(
            store.claim_node(
                &authority,
                "campaign-1",
                "node-1",
                revision - 1,
                "attempt-1",
                "worker-1",
                100,
                100,
                1,
                4,
                FaultPointV1::None,
            ),
            Err(CampaignWriterError::StaleRevision { .. })
        ));
    }

    #[test]
    fn prepared_result_integrates_exactly_once_after_reopen() {
        let (fixture, mut store, authority) = setup();
        let revision = store.campaign_status("campaign-1").expect("status").revision;
        let claim = store
            .claim_node(
                &authority,
                "campaign-1",
                "node-1",
                revision,
                "attempt-1",
                "worker-1",
                100,
                500,
                2,
                4,
                FaultPointV1::None,
            )
            .expect("claim");
        let prepared = store
            .record_prepared_result(
                &authority,
                &claim,
                &digest('a'),
                true,
                5,
                FaultPointV1::None,
            )
            .expect("prepared");
        drop(store);
        let mut reopened = fixture.store();
        reopened.acquire_writer(&authority, 6).expect("reacquire");
        let loaded = reopened
            .load_prepared_result("campaign-1", "node-1")
            .expect("load prepared");
        assert_eq!(loaded.prepared_receipt_hash, prepared.prepared_receipt_hash);
        let completed = reopened
            .integrate_prepared_result(
                &authority,
                &loaded,
                &digest('b'),
                7,
                FaultPointV1::None,
            )
            .expect("integrate");
        assert_eq!(completed.state, NodeStateV1::Completed);
        let duplicate = reopened
            .integrate_prepared_result(
                &authority,
                &loaded,
                &digest('b'),
                8,
                FaultPointV1::None,
            )
            .expect("duplicate");
        assert_eq!(duplicate, completed);
    }

    #[test]
    fn transaction_fault_refunds_nothing_and_persists_nothing() {
        let (_fixture, mut store, authority) = setup();
        let before = store.campaign_status("campaign-1").expect("before");
        assert!(matches!(
            store.claim_node(
                &authority,
                "campaign-1",
                "node-1",
                before.revision,
                "attempt-1",
                "worker-1",
                100,
                500,
                2,
                4,
                FaultPointV1::AfterNodeUpdate,
            ),
            Err(CampaignWriterError::InjectedFault(FaultPointV1::AfterNodeUpdate))
        ));
        assert_eq!(store.campaign_status("campaign-1").expect("after"), before);
        assert_eq!(
            store.node_status("campaign-1", "node-1").expect("node").state,
            NodeStateV1::Ready
        );
    }

    #[test]
    fn pre_provider_failure_refunds_but_ambiguous_execution_does_not() {
        let (_fixture, mut store, authority) = setup();
        let revision = store.campaign_status("campaign-1").expect("status").revision;
        let claim = store
            .claim_node(
                &authority,
                "campaign-1",
                "node-1",
                revision,
                "attempt-1",
                "worker-1",
                100,
                500,
                2,
                4,
                FaultPointV1::None,
            )
            .expect("claim");
        store
            .fail_before_provider(&authority, &claim, 5, FaultPointV1::None)
            .expect("refund");
        let refunded = store.campaign_status("campaign-1").expect("refunded");
        assert_eq!(refunded.budget_remaining_microusd, 10_000);
        assert_eq!(refunded.cpu_jobs_remaining, 8);

        store
            .add_node(&authority, "campaign-1", "node-2", 6)
            .expect("node2");
        let revision = store.campaign_status("campaign-1").expect("status2").revision;
        let claim = store
            .claim_node(
                &authority,
                "campaign-1",
                "node-2",
                revision,
                "attempt-2",
                "worker-1",
                100,
                700,
                3,
                7,
                FaultPointV1::None,
            )
            .expect("claim2");
        store
            .settle_ambiguous(&authority, &claim, 8, FaultPointV1::None)
            .expect("ambiguous");
        let settled = store.campaign_status("campaign-1").expect("settled");
        assert_eq!(settled.budget_remaining_microusd, 9_300);
        assert_eq!(settled.cpu_jobs_remaining, 5);
    }

    #[test]
    fn backup_restore_and_ten_thousand_node_projection_validate() {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        let authority = WriterAuthorityV1::new(1, "writer-token-1").expect("authority");
        store.acquire_writer(&authority, 1).expect("acquire");
        store
            .create_campaign(&authority, "campaign-large", 1_000_000, 20_000, 2)
            .expect("campaign");
        for index in 0..10_000_u32 {
            store
                .add_node(
                    &authority,
                    "campaign-large",
                    &format!("node-{index:05}"),
                    3 + u64::from(index),
                )
                .expect("add node");
        }
        store.validate_integrity().expect("integrity");
        let backup = fixture.root.join("backup.sqlite");
        let hash = store.create_backup(&backup).expect("backup");
        assert!(valid_digest(&hash));
        drop(store);
        let restored_path = fixture.root.join("restored.sqlite");
        let restored = CampaignWriterStoreV1::restore_create_only(
            &backup,
            &restored_path,
            fixture.uid,
        )
        .expect("restore");
        restored.validate_integrity().expect("restored integrity");
        assert_eq!(
            restored
                .campaign_status("campaign-large")
                .expect("restored status")
                .revision,
            10_000
        );
    }
}
