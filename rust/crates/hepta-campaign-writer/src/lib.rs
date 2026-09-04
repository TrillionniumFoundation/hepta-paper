//! Generation-fenced single-writer campaign persistence.

#![forbid(unsafe_code)]

use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use hepta_codex_protocol::Sha256Digest;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod cutover;

pub use cutover::{
    VerifiedWriterCutoverV1, WriterCutoverAuthorizationV1, WriterCutoverPolicyV1,
    WriterCutoverSubjectV1, WriterCutoverTrustStoreV1, WriterDatabasePreimageV1,
    WriterDatabaseStateV1, inspect_writer_database_preimage_v1,
    verify_writer_cutover_authorization_v1, writer_cutover_signing_bytes_v1,
    writer_database_preimage_hash_v1, writer_lease_activation_hash_v1,
};

const APPLICATION_ID: i64 = 0x4850_4357;
const SCHEMA_VERSION: i64 = 1;
const MAXIMUM_DATABASE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAXIMUM_BUSY_TIMEOUT_MS: u64 = 30_000;
const MAXIMUM_IDENTIFIER_BYTES: usize = 128;
const MAXIMUM_TOKEN_BYTES: usize = 256;
const MAXIMUM_BACKUP_BYTES: u64 = 16 * 1024 * 1024 * 1024;

const SCHEMA: &str = r#"
BEGIN IMMEDIATE;
PRAGMA application_id = 1213219671;
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS writer_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation INTEGER NOT NULL CHECK(generation > 0),
  token TEXT NOT NULL,
  expires_at_unix_ms INTEGER NOT NULL CHECK(expires_at_unix_ms > 0)
) STRICT;
CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  state TEXT NOT NULL,
  budget_remaining_microusd INTEGER NOT NULL CHECK(budget_remaining_microusd >= 0),
  cpu_remaining INTEGER NOT NULL CHECK(cpu_remaining >= 0),
  gpu_remaining INTEGER NOT NULL CHECK(gpu_remaining >= 0),
  created_at_unix_ms INTEGER NOT NULL CHECK(created_at_unix_ms > 0),
  updated_at_unix_ms INTEGER NOT NULL CHECK(updated_at_unix_ms > 0)
) STRICT;
CREATE TABLE IF NOT EXISTS nodes (
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  node_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  writer_generation INTEGER NOT NULL CHECK(writer_generation > 0),
  claim_token TEXT NOT NULL,
  claim_expires_at_unix_ms INTEGER NOT NULL CHECK(claim_expires_at_unix_ms > 0),
  status TEXT NOT NULL,
  prepared_result_hash TEXT,
  integrated_result_hash TEXT,
  budget_reserved_microusd INTEGER NOT NULL CHECK(budget_reserved_microusd >= 0),
  cpu_reserved INTEGER NOT NULL CHECK(cpu_reserved >= 0),
  gpu_reserved INTEGER NOT NULL CHECK(gpu_reserved >= 0),
  provider_action_may_have_started INTEGER NOT NULL CHECK(provider_action_may_have_started IN (0,1)),
  updated_at_unix_ms INTEGER NOT NULL CHECK(updated_at_unix_ms > 0),
  PRIMARY KEY(campaign_id, node_id)
) STRICT;
CREATE TABLE IF NOT EXISTS campaign_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  recorded_at_unix_ms INTEGER NOT NULL CHECK(recorded_at_unix_ms > 0)
) STRICT;
COMMIT;
"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CampaignWriterPolicyV1 {
    pub version: u16,
    pub owner_uid: u32,
    pub busy_timeout_ms: u64,
    pub maximum_database_bytes: u64,
}

impl CampaignWriterPolicyV1 {
    #[must_use]
    pub const fn strict(owner_uid: u32) -> Self {
        Self {
            version: 1,
            owner_uid,
            busy_timeout_ms: 5_000,
            maximum_database_bytes: 4 * 1024 * 1024 * 1024,
        }
    }

    fn validate(self) -> Result<Self, CampaignWriterError> {
        if self.version != 1
            || self.busy_timeout_ms == 0
            || self.busy_timeout_ms > MAXIMUM_BUSY_TIMEOUT_MS
            || self.maximum_database_bytes == 0
            || self.maximum_database_bytes > MAXIMUM_DATABASE_BYTES
        {
            return Err(CampaignWriterError::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriterLeaseV1 {
    pub generation: u64,
    pub token: String,
    pub expires_at_unix_ms: u64,
}

impl WriterLeaseV1 {
    fn validate(&self, now_unix_ms: u64) -> Result<(), CampaignWriterError> {
        if self.generation == 0
            || !valid_token(&self.token)
            || now_unix_ms == 0
            || self.expires_at_unix_ms <= now_unix_ms
        {
            return Err(CampaignWriterError::InvalidWriterLease);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CampaignStateV1 {
    Running,
    Paused,
    Cancelled,
    Completed,
}

impl CampaignStateV1 {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Cancelled => "cancelled",
            Self::Completed => "completed",
        }
    }

    fn from_str(value: &str) -> Result<Self, CampaignWriterError> {
        match value {
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "cancelled" => Ok(Self::Cancelled),
            "completed" => Ok(Self::Completed),
            _ => Err(CampaignWriterError::CorruptValue("campaign_state")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatusV1 {
    Claimed,
    Prepared,
    Integrated,
    FailedPreProvider,
    Ambiguous,
    Cancelled,
}

impl NodeStatusV1 {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Claimed => "claimed",
            Self::Prepared => "prepared",
            Self::Integrated => "integrated",
            Self::FailedPreProvider => "failed_pre_provider",
            Self::Ambiguous => "ambiguous",
            Self::Cancelled => "cancelled",
        }
    }

    fn from_str(value: &str) -> Result<Self, CampaignWriterError> {
        match value {
            "claimed" => Ok(Self::Claimed),
            "prepared" => Ok(Self::Prepared),
            "integrated" => Ok(Self::Integrated),
            "failed_pre_provider" => Ok(Self::FailedPreProvider),
            "ambiguous" => Ok(Self::Ambiguous),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(CampaignWriterError::CorruptValue("node_status")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CampaignSnapshotV1 {
    pub campaign_id: String,
    pub revision: u64,
    pub state: CampaignStateV1,
    pub budget_remaining_microusd: u64,
    pub cpu_remaining: u64,
    pub gpu_remaining: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeClaimV1 {
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub writer_generation: u64,
    pub claim_token: String,
    pub claim_expires_at_unix_ms: u64,
    pub campaign_revision: u64,
    pub budget_reserved_microusd: u64,
    pub cpu_reserved: u64,
    pub gpu_reserved: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeSnapshotV1 {
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub writer_generation: u64,
    pub status: NodeStatusV1,
    pub prepared_result_hash: Option<Sha256Digest>,
    pub integrated_result_hash: Option<Sha256Digest>,
    pub provider_action_may_have_started: bool,
}

/// Single SQLite connection. It is `Send` but intentionally not `Sync`.
pub struct CampaignWriterStoreV1 {
    path: PathBuf,
    connection: Connection,
    policy: CampaignWriterPolicyV1,
    activation: Option<VerifiedWriterCutoverV1>,
    initial_writer_acquired: bool,
}

impl CampaignWriterStoreV1 {
    fn open_internal(
        path: impl AsRef<Path>,
        policy: CampaignWriterPolicyV1,
        activation: Option<VerifiedWriterCutoverV1>,
    ) -> Result<Self, CampaignWriterError> {
        let policy = policy.validate()?;
        let path = prepare_database(path.as_ref(), policy)?;
        let before_open = fs::symlink_metadata(&path)
            .map_err(|error| CampaignWriterError::Filesystem("database_open", error.kind()))?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(&path, flags)?;
        let after_open = fs::symlink_metadata(&path)
            .map_err(|error| CampaignWriterError::Filesystem("database_open", error.kind()))?;
        if before_open.file_type().is_symlink()
            || after_open.file_type().is_symlink()
            || !same_database_identity(&before_open, &after_open)
        {
            return Err(CampaignWriterError::DatabasePreimageChanged);
        }
        connection.busy_timeout(Duration::from_millis(policy.busy_timeout_ms))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA locking_mode = EXCLUSIVE;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA temp_store = MEMORY;",
        )?;
        let user_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if user_version == 0 {
            connection.execute_batch(SCHEMA)?;
        }
        verify_schema(&connection)?;
        connection.execute_batch("BEGIN EXCLUSIVE; COMMIT;")?;
        let store = Self {
            path,
            connection,
            policy,
            activation,
            initial_writer_acquired: false,
        };
        store.validate_integrity()?;
        Ok(store)
    }

    /// Opens the only public read-write store path after exact signed cutover verification.
    pub fn open_for_cutover(
        path: impl AsRef<Path>,
        policy: CampaignWriterPolicyV1,
        verified: &VerifiedWriterCutoverV1,
        now_unix_ms: u64,
    ) -> Result<Self, CampaignWriterError> {
        verified.assert_current(now_unix_ms)?;
        let observed = inspect_writer_database_preimage_v1(path.as_ref(), policy)?;
        let observed_hash = writer_database_preimage_hash_v1(&observed)?;
        if &observed_hash != verified.database_preimage_hash() {
            return Err(CampaignWriterError::DatabasePreimageChanged);
        }
        Self::open_internal(path, policy, Some(verified.clone()))
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn acquire_writer(
        &mut self,
        requested: WriterLeaseV1,
        now_unix_ms: u64,
    ) -> Result<WriterLeaseV1, CampaignWriterError> {
        let activation = self
            .activation
            .as_ref()
            .ok_or(CampaignWriterError::ActiveWriterAuthorizationRequired)?;
        requested.validate(now_unix_ms)?;
        if !self.initial_writer_acquired
            && &writer_lease_activation_hash_v1(&requested)?
                != activation.initial_writer_lease_hash()
        {
            return Err(CampaignWriterError::CutoverWriterBindingMismatch);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = load_writer_lease(&transaction)?;
        if let Some(existing) = existing {
            if existing.generation > requested.generation
                || (existing.generation == requested.generation
                    && existing.token != requested.token)
            {
                return Err(CampaignWriterError::StaleWriterGeneration);
            }
            if existing.generation == requested.generation && existing.token == requested.token {
                transaction.execute(
                    "UPDATE writer_lease SET expires_at_unix_ms = ?1 WHERE singleton = 1",
                    [to_i64(requested.expires_at_unix_ms)?],
                )?;
                transaction.commit()?;
                self.initial_writer_acquired = true;
                return Ok(requested);
            }
        }
        transaction.execute(
            "INSERT INTO writer_lease(singleton, generation, token, expires_at_unix_ms)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(singleton) DO UPDATE SET
               generation = excluded.generation,
               token = excluded.token,
               expires_at_unix_ms = excluded.expires_at_unix_ms",
            params![
                to_i64(requested.generation)?,
                requested.token,
                to_i64(requested.expires_at_unix_ms)?,
            ],
        )?;
        transaction.commit()?;
        self.initial_writer_acquired = true;
        self.inspect_envelope()?;
        Ok(requested)
    }

    pub fn create_campaign(
        &mut self,
        writer: &WriterLeaseV1,
        campaign_id: &str,
        budget_microusd: u64,
        cpu_units: u64,
        gpu_units: u64,
        now_unix_ms: u64,
    ) -> Result<CampaignSnapshotV1, CampaignWriterError> {
        validate_identifier(campaign_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&transaction, writer, now_unix_ms)?;
        transaction.execute(
            "INSERT INTO campaigns(
               campaign_id, revision, state, budget_remaining_microusd,
               cpu_remaining, gpu_remaining, created_at_unix_ms, updated_at_unix_ms
             ) VALUES (?1, 0, 'running', ?2, ?3, ?4, ?5, ?5)",
            params![
                campaign_id,
                to_i64(budget_microusd)?,
                to_i64(cpu_units)?,
                to_i64(gpu_units)?,
                to_i64(now_unix_ms)?,
            ],
        )?;
        append_event(
            &transaction,
            campaign_id,
            "campaign_created",
            &CampaignCreatedEventV1 {
                budget_microusd,
                cpu_units,
                gpu_units,
            },
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.load_campaign(campaign_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn claim_node(
        &mut self,
        writer: &WriterLeaseV1,
        campaign_id: &str,
        node_id: &str,
        attempt_id: &str,
        expected_revision: u64,
        claim_token: &str,
        claim_expires_at_unix_ms: u64,
        budget_reservation_microusd: u64,
        cpu_reservation: u64,
        gpu_reservation: u64,
        now_unix_ms: u64,
    ) -> Result<NodeClaimV1, CampaignWriterError> {
        validate_identifier(campaign_id)?;
        validate_identifier(node_id)?;
        validate_identifier(attempt_id)?;
        if !valid_token(claim_token) || claim_expires_at_unix_ms <= now_unix_ms {
            return Err(CampaignWriterError::InvalidNodeClaim);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&transaction, writer, now_unix_ms)?;
        let campaign = load_campaign_from(&transaction, campaign_id)?;
        if campaign.state != CampaignStateV1::Running {
            return Err(CampaignWriterError::CampaignNotRunning);
        }
        if campaign.revision != expected_revision {
            return Err(CampaignWriterError::StaleCampaignRevision);
        }
        if campaign.budget_remaining_microusd < budget_reservation_microusd
            || campaign.cpu_remaining < cpu_reservation
            || campaign.gpu_remaining < gpu_reservation
        {
            return Err(CampaignWriterError::ResourceUnavailable);
        }
        if let Some(existing) = load_node_optional(&transaction, campaign_id, node_id)? {
            if existing.attempt_id == attempt_id
                && existing.writer_generation == writer.generation
                && existing.status == NodeStatusV1::Claimed
            {
                transaction.commit()?;
                return Ok(NodeClaimV1 {
                    campaign_id: campaign_id.to_owned(),
                    node_id: node_id.to_owned(),
                    attempt_id: attempt_id.to_owned(),
                    writer_generation: writer.generation,
                    claim_token: claim_token.to_owned(),
                    claim_expires_at_unix_ms,
                    campaign_revision: campaign.revision,
                    budget_reserved_microusd: budget_reservation_microusd,
                    cpu_reserved: cpu_reservation,
                    gpu_reserved: gpu_reservation,
                });
            }
            return Err(CampaignWriterError::NodeAlreadyClaimed);
        }
        let next_revision = expected_revision
            .checked_add(1)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        let updated = transaction.execute(
            "UPDATE campaigns SET
               revision = ?1,
               budget_remaining_microusd = budget_remaining_microusd - ?2,
               cpu_remaining = cpu_remaining - ?3,
               gpu_remaining = gpu_remaining - ?4,
               updated_at_unix_ms = ?5
             WHERE campaign_id = ?6 AND revision = ?7 AND state = 'running'",
            params![
                to_i64(next_revision)?,
                to_i64(budget_reservation_microusd)?,
                to_i64(cpu_reservation)?,
                to_i64(gpu_reservation)?,
                to_i64(now_unix_ms)?,
                campaign_id,
                to_i64(expected_revision)?,
            ],
        )?;
        if updated != 1 {
            return Err(CampaignWriterError::ConcurrentCampaignChange);
        }
        transaction.execute(
            "INSERT INTO nodes(
               campaign_id, node_id, attempt_id, writer_generation, claim_token,
               claim_expires_at_unix_ms, status, prepared_result_hash,
               integrated_result_hash, budget_reserved_microusd, cpu_reserved,
               gpu_reserved, provider_action_may_have_started, updated_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'claimed', NULL, NULL, ?7, ?8, ?9, 0, ?10)",
            params![
                campaign_id,
                node_id,
                attempt_id,
                to_i64(writer.generation)?,
                claim_token,
                to_i64(claim_expires_at_unix_ms)?,
                to_i64(budget_reservation_microusd)?,
                to_i64(cpu_reservation)?,
                to_i64(gpu_reservation)?,
                to_i64(now_unix_ms)?,
            ],
        )?;
        append_event(
            &transaction,
            campaign_id,
            "node_claimed",
            &NodeClaimedEventV1 {
                node_id,
                attempt_id,
                writer_generation: writer.generation,
                budget_reservation_microusd,
                cpu_reservation,
                gpu_reservation,
            },
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.inspect_envelope()?;
        Ok(NodeClaimV1 {
            campaign_id: campaign_id.to_owned(),
            node_id: node_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            writer_generation: writer.generation,
            claim_token: claim_token.to_owned(),
            claim_expires_at_unix_ms,
            campaign_revision: next_revision,
            budget_reserved_microusd: budget_reservation_microusd,
            cpu_reserved: cpu_reservation,
            gpu_reserved: gpu_reservation,
        })
    }

    pub fn heartbeat_node(
        &mut self,
        writer: &WriterLeaseV1,
        claim: &NodeClaimV1,
        new_expiry_unix_ms: u64,
        now_unix_ms: u64,
    ) -> Result<(), CampaignWriterError> {
        if new_expiry_unix_ms <= now_unix_ms {
            return Err(CampaignWriterError::InvalidNodeClaim);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&transaction, writer, now_unix_ms)?;
        assert_claim(&transaction, claim, now_unix_ms)?;
        let updated = transaction.execute(
            "UPDATE nodes SET claim_expires_at_unix_ms = ?1, updated_at_unix_ms = ?2
             WHERE campaign_id = ?3 AND node_id = ?4 AND attempt_id = ?5
               AND writer_generation = ?6 AND claim_token = ?7
               AND status IN ('claimed','prepared')",
            params![
                to_i64(new_expiry_unix_ms)?,
                to_i64(now_unix_ms)?,
                &claim.campaign_id,
                &claim.node_id,
                claim.attempt_id,
                to_i64(claim.writer_generation)?,
                claim.claim_token,
            ],
        )?;
        if updated != 1 {
            return Err(CampaignWriterError::StaleNodeClaim);
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn store_prepared_result(
        &mut self,
        writer: &WriterLeaseV1,
        claim: &NodeClaimV1,
        prepared_result_hash: &Sha256Digest,
        provider_action_may_have_started: bool,
        now_unix_ms: u64,
    ) -> Result<NodeSnapshotV1, CampaignWriterError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&transaction, writer, now_unix_ms)?;
        assert_claim(&transaction, claim, now_unix_ms)?;
        let existing = load_node(&transaction, &claim.campaign_id, &claim.node_id)?;
        if existing.status == NodeStatusV1::Prepared
            && existing.prepared_result_hash.as_ref() == Some(prepared_result_hash)
        {
            transaction.commit()?;
            return Ok(existing);
        }
        if existing.status != NodeStatusV1::Claimed {
            return Err(CampaignWriterError::InvalidNodeState);
        }
        transaction.execute(
            "UPDATE nodes SET status = 'prepared', prepared_result_hash = ?1,
               provider_action_may_have_started = ?2, updated_at_unix_ms = ?3
             WHERE campaign_id = ?4 AND node_id = ?5 AND status = 'claimed'",
            params![
                prepared_result_hash.as_str(),
                if provider_action_may_have_started {
                    1_i64
                } else {
                    0_i64
                },
                to_i64(now_unix_ms)?,
                &claim.campaign_id,
                &claim.node_id,
            ],
        )?;
        append_event(
            &transaction,
            &claim.campaign_id,
            "result_prepared",
            &PreparedEventV1 {
                node_id: &claim.node_id,
                attempt_id: &claim.attempt_id,
                prepared_result_hash,
                provider_action_may_have_started,
            },
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.load_node(&claim.campaign_id, &claim.node_id)
    }

    pub fn integrate_prepared_result(
        &mut self,
        writer: &WriterLeaseV1,
        claim: &NodeClaimV1,
        prepared_result_hash: &Sha256Digest,
        integrated_result_hash: &Sha256Digest,
        actual_cost_microusd: u64,
        now_unix_ms: u64,
    ) -> Result<NodeSnapshotV1, CampaignWriterError> {
        if actual_cost_microusd > claim.budget_reserved_microusd {
            return Err(CampaignWriterError::CostExceedsReservation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&transaction, writer, now_unix_ms)?;
        let existing = load_node(&transaction, &claim.campaign_id, &claim.node_id)?;
        if existing.status == NodeStatusV1::Integrated
            && existing.integrated_result_hash.as_ref() == Some(integrated_result_hash)
        {
            transaction.commit()?;
            return Ok(existing);
        }
        assert_claim(&transaction, claim, now_unix_ms)?;
        if existing.status != NodeStatusV1::Prepared
            || existing.prepared_result_hash.as_ref() != Some(prepared_result_hash)
        {
            return Err(CampaignWriterError::PreparedResultMismatch);
        }
        let refund = claim
            .budget_reserved_microusd
            .checked_sub(actual_cost_microusd)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        settle_campaign_resources(
            &transaction,
            &claim.campaign_id,
            refund,
            claim.cpu_reserved,
            claim.gpu_reserved,
            now_unix_ms,
        )?;
        transaction.execute(
            "UPDATE nodes SET status = 'integrated', integrated_result_hash = ?1,
               updated_at_unix_ms = ?2
             WHERE campaign_id = ?3 AND node_id = ?4 AND status = 'prepared'",
            params![
                integrated_result_hash.as_str(),
                to_i64(now_unix_ms)?,
                &claim.campaign_id,
                &claim.node_id,
            ],
        )?;
        append_event(
            &transaction,
            &claim.campaign_id,
            "result_integrated",
            &IntegratedEventV1 {
                node_id: &claim.node_id,
                attempt_id: &claim.attempt_id,
                prepared_result_hash,
                integrated_result_hash,
                actual_cost_microusd,
                refunded_microusd: refund,
            },
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.inspect_envelope()?;
        self.load_node(&claim.campaign_id, &claim.node_id)
    }

    pub fn fail_before_provider(
        &mut self,
        writer: &WriterLeaseV1,
        claim: &NodeClaimV1,
        now_unix_ms: u64,
    ) -> Result<NodeSnapshotV1, CampaignWriterError> {
        self.terminal_settlement(
            writer,
            claim,
            NodeStatusV1::FailedPreProvider,
            claim.budget_reserved_microusd,
            false,
            now_unix_ms,
        )
    }

    pub fn settle_ambiguous(
        &mut self,
        writer: &WriterLeaseV1,
        claim: &NodeClaimV1,
        now_unix_ms: u64,
    ) -> Result<NodeSnapshotV1, CampaignWriterError> {
        self.terminal_settlement(writer, claim, NodeStatusV1::Ambiguous, 0, true, now_unix_ms)
    }

    fn terminal_settlement(
        &mut self,
        writer: &WriterLeaseV1,
        claim: &NodeClaimV1,
        terminal: NodeStatusV1,
        budget_refund: u64,
        provider_may_have_started: bool,
        now_unix_ms: u64,
    ) -> Result<NodeSnapshotV1, CampaignWriterError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&transaction, writer, now_unix_ms)?;
        assert_claim(&transaction, claim, now_unix_ms)?;
        let current = load_node(&transaction, &claim.campaign_id, &claim.node_id)?;
        if !matches!(
            current.status,
            NodeStatusV1::Claimed | NodeStatusV1::Prepared
        ) {
            return Err(CampaignWriterError::InvalidNodeState);
        }
        if provider_may_have_started && !current.provider_action_may_have_started {
            return Err(CampaignWriterError::ProviderAmbiguityNotEstablished);
        }
        settle_campaign_resources(
            &transaction,
            &claim.campaign_id,
            budget_refund,
            claim.cpu_reserved,
            claim.gpu_reserved,
            now_unix_ms,
        )?;
        transaction.execute(
            "UPDATE nodes SET status = ?1, updated_at_unix_ms = ?2
             WHERE campaign_id = ?3 AND node_id = ?4
               AND status IN ('claimed','prepared')",
            params![
                terminal.as_str(),
                to_i64(now_unix_ms)?,
                &claim.campaign_id,
                &claim.node_id,
            ],
        )?;
        append_event(
            &transaction,
            &claim.campaign_id,
            terminal.as_str(),
            &TerminalEventV1 {
                node_id: &claim.node_id,
                attempt_id: &claim.attempt_id,
                budget_refund,
                provider_may_have_started,
            },
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.load_node(&claim.campaign_id, &claim.node_id)
    }

    pub fn set_campaign_state(
        &mut self,
        writer: &WriterLeaseV1,
        campaign_id: &str,
        expected_revision: u64,
        next_state: CampaignStateV1,
        now_unix_ms: u64,
    ) -> Result<CampaignSnapshotV1, CampaignWriterError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&transaction, writer, now_unix_ms)?;
        let current = load_campaign_from(&transaction, campaign_id)?;
        if current.revision != expected_revision {
            return Err(CampaignWriterError::StaleCampaignRevision);
        }
        if current.state == CampaignStateV1::Completed
            || current.state == CampaignStateV1::Cancelled
        {
            return Err(CampaignWriterError::TerminalCampaignCannotReopen);
        }
        let next_revision = expected_revision
            .checked_add(1)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        transaction.execute(
            "UPDATE campaigns SET state = ?1, revision = ?2, updated_at_unix_ms = ?3
             WHERE campaign_id = ?4 AND revision = ?5",
            params![
                next_state.as_str(),
                to_i64(next_revision)?,
                to_i64(now_unix_ms)?,
                campaign_id,
                to_i64(expected_revision)?,
            ],
        )?;
        append_event(
            &transaction,
            campaign_id,
            "campaign_state_changed",
            &CampaignStateEventV1 { next_state },
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.load_campaign(campaign_id)
    }

    pub fn load_campaign(
        &self,
        campaign_id: &str,
    ) -> Result<CampaignSnapshotV1, CampaignWriterError> {
        load_campaign_from(&self.connection, campaign_id)
    }

    pub fn load_node(
        &self,
        campaign_id: &str,
        node_id: &str,
    ) -> Result<NodeSnapshotV1, CampaignWriterError> {
        load_node(&self.connection, campaign_id, node_id)
    }

    pub fn validate_integrity(&self) -> Result<(), CampaignWriterError> {
        verify_schema(&self.connection)?;
        let integrity: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(CampaignWriterError::IntegrityCheckFailed(integrity));
        }
        let foreign: i64 = self.connection.query_row(
            "SELECT count(*) FROM pragma_foreign_key_check",
            [],
            |row| row.get(0),
        )?;
        if foreign != 0 {
            return Err(CampaignWriterError::ForeignKeyCheckFailed);
        }
        validate_event_chain(&self.connection)?;
        self.inspect_envelope()
    }

    pub fn checkpoint(&self) -> Result<(), CampaignWriterError> {
        let checkpoint: (i64, i64, i64) =
            self.connection
                .query_row("PRAGMA wal_checkpoint(FULL)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
        if checkpoint.0 != 0 || checkpoint.1 != checkpoint.2 {
            return Err(CampaignWriterError::CheckpointIncomplete);
        }
        File::open(&self.path)
            .and_then(|file| file.sync_all())
            .map_err(|error| CampaignWriterError::Filesystem("checkpoint_sync", error.kind()))?;
        Ok(())
    }

    pub fn create_backup(
        &self,
        destination: impl AsRef<Path>,
    ) -> Result<CampaignBackupReceiptV1, CampaignWriterError> {
        self.validate_integrity()?;
        self.checkpoint()?;
        let destination = destination.as_ref();
        inspect_absent_destination(destination, self.policy.owner_uid)?;
        let destination_text = destination
            .to_str()
            .ok_or(CampaignWriterError::DatabasePathInvalid)?;
        let quoted: String =
            self.connection
                .query_row("SELECT quote(?1)", [destination_text], |row| row.get(0))?;
        self.connection
            .execute_batch(&format!("VACUUM INTO {quoted};"))?;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600))
            .map_err(|error| CampaignWriterError::Filesystem("backup_mode", error.kind()))?;
        File::open(destination)
            .and_then(|file| file.sync_all())
            .map_err(|error| CampaignWriterError::Filesystem("backup_sync", error.kind()))?;
        sync_parent(destination)?;
        let (content_hash, byte_count) = hash_file(destination, MAXIMUM_BACKUP_BYTES)?;
        Ok(CampaignBackupReceiptV1 {
            version: 1,
            source_path_hash: hash_path(&self.path)?,
            backup_path_hash: hash_path(destination)?,
            content_hash,
            byte_count,
        })
    }

    fn inspect_envelope(&self) -> Result<(), CampaignWriterError> {
        inspect_database_file(&self.path, self.policy)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignBackupReceiptV1 {
    pub version: u16,
    pub source_path_hash: Sha256Digest,
    pub backup_path_hash: Sha256Digest,
    pub content_hash: Sha256Digest,
    pub byte_count: u64,
}

pub fn restore_backup(
    backup: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    policy: CampaignWriterPolicyV1,
) -> Result<CampaignBackupReceiptV1, CampaignWriterError> {
    let policy = policy.validate()?;
    let backup = backup.as_ref();
    let destination = destination.as_ref();
    inspect_database_file(backup, policy)?;
    inspect_absent_destination(destination, policy.owner_uid)?;
    let temporary = destination.with_extension("restore.tmp");
    if temporary.exists() {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    let mut source = File::open(backup)
        .map_err(|error| CampaignWriterError::Filesystem("restore_source", error.kind()))?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| CampaignWriterError::Filesystem("restore_target", error.kind()))?;
    let copied = std::io::copy(&mut source, &mut target)
        .map_err(|error| CampaignWriterError::Filesystem("restore_copy", error.kind()))?;
    if copied == 0 || copied > MAXIMUM_BACKUP_BYTES {
        return Err(CampaignWriterError::DatabaseTooLarge);
    }
    target
        .sync_all()
        .map_err(|error| CampaignWriterError::Filesystem("restore_sync", error.kind()))?;
    drop(target);
    fs::rename(&temporary, destination)
        .map_err(|error| CampaignWriterError::Filesystem("restore_publish", error.kind()))?;
    sync_parent(destination)?;
    let store = CampaignWriterStoreV1::open_internal(destination, policy, None)?;
    store.validate_integrity()?;
    let (content_hash, byte_count) = hash_file(destination, MAXIMUM_BACKUP_BYTES)?;
    Ok(CampaignBackupReceiptV1 {
        version: 1,
        source_path_hash: hash_path(backup)?,
        backup_path_hash: hash_path(destination)?,
        content_hash,
        byte_count,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CampaignCreatedEventV1 {
    budget_microusd: u64,
    cpu_units: u64,
    gpu_units: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeClaimedEventV1<'a> {
    node_id: &'a str,
    attempt_id: &'a str,
    writer_generation: u64,
    budget_reservation_microusd: u64,
    cpu_reservation: u64,
    gpu_reservation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedEventV1<'a> {
    node_id: &'a str,
    attempt_id: &'a str,
    prepared_result_hash: &'a Sha256Digest,
    provider_action_may_have_started: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegratedEventV1<'a> {
    node_id: &'a str,
    attempt_id: &'a str,
    prepared_result_hash: &'a Sha256Digest,
    integrated_result_hash: &'a Sha256Digest,
    actual_cost_microusd: u64,
    refunded_microusd: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalEventV1<'a> {
    node_id: &'a str,
    attempt_id: &'a str,
    budget_refund: u64,
    provider_may_have_started: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CampaignStateEventV1 {
    next_state: CampaignStateV1,
}

fn load_writer_lease(
    connection: &Connection,
) -> Result<Option<WriterLeaseV1>, CampaignWriterError> {
    connection
        .query_row(
            "SELECT generation, token, expires_at_unix_ms FROM writer_lease WHERE singleton = 1",
            [],
            |row| {
                Ok(WriterLeaseV1 {
                    generation: from_i64(row.get(0)?).map_err(to_sqlite_error)?,
                    token: row.get(1)?,
                    expires_at_unix_ms: from_i64(row.get(2)?).map_err(to_sqlite_error)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn assert_writer(
    connection: &Connection,
    expected: &WriterLeaseV1,
    now_unix_ms: u64,
) -> Result<(), CampaignWriterError> {
    expected.validate(now_unix_ms)?;
    let observed = load_writer_lease(connection)?.ok_or(CampaignWriterError::WriterLeaseMissing)?;
    if observed.generation != expected.generation
        || observed.token != expected.token
        || observed.expires_at_unix_ms <= now_unix_ms
    {
        return Err(CampaignWriterError::StaleWriterGeneration);
    }
    Ok(())
}

fn assert_claim(
    connection: &Connection,
    claim: &NodeClaimV1,
    now_unix_ms: u64,
) -> Result<(), CampaignWriterError> {
    let row: Option<(String, i64, String, i64)> = connection
        .query_row(
            "SELECT attempt_id, writer_generation, claim_token, claim_expires_at_unix_ms
             FROM nodes WHERE campaign_id = ?1 AND node_id = ?2",
            params![&claim.campaign_id, &claim.node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((attempt_id, generation, token, expiry)) = row else {
        return Err(CampaignWriterError::NodeNotFound);
    };
    if attempt_id != claim.attempt_id
        || from_i64(generation)? != claim.writer_generation
        || token != claim.claim_token
        || from_i64(expiry)? <= now_unix_ms
    {
        return Err(CampaignWriterError::StaleNodeClaim);
    }
    Ok(())
}

fn load_campaign_from(
    connection: &Connection,
    campaign_id: &str,
) -> Result<CampaignSnapshotV1, CampaignWriterError> {
    connection
        .query_row(
            "SELECT revision, state, budget_remaining_microusd, cpu_remaining, gpu_remaining
             FROM campaigns WHERE campaign_id = ?1",
            [campaign_id],
            |row| {
                let state: String = row.get(1)?;
                Ok(CampaignSnapshotV1 {
                    campaign_id: campaign_id.to_owned(),
                    revision: from_i64(row.get(0)?).map_err(to_sqlite_error)?,
                    state: CampaignStateV1::from_str(&state).map_err(to_sqlite_error)?,
                    budget_remaining_microusd: from_i64(row.get(2)?).map_err(to_sqlite_error)?,
                    cpu_remaining: from_i64(row.get(3)?).map_err(to_sqlite_error)?,
                    gpu_remaining: from_i64(row.get(4)?).map_err(to_sqlite_error)?,
                })
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => CampaignWriterError::CampaignNotFound,
            other => CampaignWriterError::Sqlite(other),
        })
}

fn load_node_optional(
    connection: &Connection,
    campaign_id: &str,
    node_id: &str,
) -> Result<Option<NodeSnapshotV1>, CampaignWriterError> {
    connection
        .query_row(
            "SELECT attempt_id, writer_generation, status, prepared_result_hash,
                    integrated_result_hash, provider_action_may_have_started
             FROM nodes WHERE campaign_id = ?1 AND node_id = ?2",
            params![campaign_id, node_id],
            |row| decode_node(row, campaign_id, node_id),
        )
        .optional()
        .map_err(Into::into)
}

fn load_node(
    connection: &Connection,
    campaign_id: &str,
    node_id: &str,
) -> Result<NodeSnapshotV1, CampaignWriterError> {
    load_node_optional(connection, campaign_id, node_id)?.ok_or(CampaignWriterError::NodeNotFound)
}

fn decode_node(
    row: &rusqlite::Row<'_>,
    campaign_id: &str,
    node_id: &str,
) -> Result<NodeSnapshotV1, rusqlite::Error> {
    let status: String = row.get(2)?;
    let prepared: Option<String> = row.get(3)?;
    let integrated: Option<String> = row.get(4)?;
    Ok(NodeSnapshotV1 {
        campaign_id: campaign_id.to_owned(),
        node_id: node_id.to_owned(),
        attempt_id: row.get(0)?,
        writer_generation: from_i64(row.get(1)?).map_err(to_sqlite_error)?,
        status: NodeStatusV1::from_str(&status).map_err(to_sqlite_error)?,
        prepared_result_hash: prepared
            .map(|value| {
                Sha256Digest::from_str(&value)
                    .map_err(|_| CampaignWriterError::CorruptValue("prepared_hash"))
            })
            .transpose()
            .map_err(to_sqlite_error)?,
        integrated_result_hash: integrated
            .map(|value| {
                Sha256Digest::from_str(&value)
                    .map_err(|_| CampaignWriterError::CorruptValue("integrated_hash"))
            })
            .transpose()
            .map_err(to_sqlite_error)?,
        provider_action_may_have_started: row.get::<_, i64>(5)? == 1,
    })
}

fn to_sqlite_error(error: CampaignWriterError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn settle_campaign_resources(
    transaction: &Transaction<'_>,
    campaign_id: &str,
    budget_refund: u64,
    cpu_refund: u64,
    gpu_refund: u64,
    now_unix_ms: u64,
) -> Result<(), CampaignWriterError> {
    let campaign = load_campaign_from(transaction, campaign_id)?;
    let next_revision = campaign
        .revision
        .checked_add(1)
        .ok_or(CampaignWriterError::NumericOverflow)?;
    let updated = transaction.execute(
        "UPDATE campaigns SET revision = ?1,
           budget_remaining_microusd = budget_remaining_microusd + ?2,
           cpu_remaining = cpu_remaining + ?3,
           gpu_remaining = gpu_remaining + ?4,
           updated_at_unix_ms = ?5
         WHERE campaign_id = ?6 AND revision = ?7",
        params![
            to_i64(next_revision)?,
            to_i64(budget_refund)?,
            to_i64(cpu_refund)?,
            to_i64(gpu_refund)?,
            to_i64(now_unix_ms)?,
            campaign_id,
            to_i64(campaign.revision)?,
        ],
    )?;
    if updated != 1 {
        return Err(CampaignWriterError::ConcurrentCampaignChange);
    }
    Ok(())
}

fn append_event<T: Serialize>(
    transaction: &Transaction<'_>,
    campaign_id: &str,
    event_kind: &str,
    payload: &T,
    now_unix_ms: u64,
) -> Result<(), CampaignWriterError> {
    let payload_hash = hash_serialized("HeptaCampaignEventPayloadV1", payload)?;
    let previous: Option<String> = transaction
        .query_row(
            "SELECT event_hash FROM campaign_events ORDER BY sequence DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let event_hash = hash_serialized(
        "HeptaCampaignEventV1",
        &EventHashView {
            campaign_id,
            event_kind,
            payload_hash: &payload_hash,
            previous_event_hash: previous.as_deref(),
            recorded_at_unix_ms: now_unix_ms,
        },
    )?;
    transaction.execute(
        "INSERT INTO campaign_events(
           campaign_id, event_kind, payload_hash, previous_event_hash,
           event_hash, recorded_at_unix_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            campaign_id,
            event_kind,
            payload_hash.as_str(),
            previous,
            event_hash.as_str(),
            to_i64(now_unix_ms)?,
        ],
    )?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventHashView<'a> {
    campaign_id: &'a str,
    event_kind: &'a str,
    payload_hash: &'a Sha256Digest,
    previous_event_hash: Option<&'a str>,
    recorded_at_unix_ms: u64,
}

fn validate_event_chain(connection: &Connection) -> Result<(), CampaignWriterError> {
    let mut statement = connection.prepare(
        "SELECT campaign_id, event_kind, payload_hash, previous_event_hash,
                event_hash, recorded_at_unix_ms
         FROM campaign_events ORDER BY sequence",
    )?;
    let mut rows = statement.query([])?;
    let mut previous: Option<String> = None;
    while let Some(row) = rows.next()? {
        let campaign_id: String = row.get(0)?;
        let event_kind: String = row.get(1)?;
        let payload_text: String = row.get(2)?;
        let persisted_previous: Option<String> = row.get(3)?;
        let persisted_hash: String = row.get(4)?;
        let recorded_at = from_i64(row.get(5)?)?;
        if persisted_previous != previous {
            return Err(CampaignWriterError::EventChainInvalid);
        }
        let payload_hash = Sha256Digest::from_str(&payload_text)
            .map_err(|_| CampaignWriterError::EventChainInvalid)?;
        let expected = hash_serialized(
            "HeptaCampaignEventV1",
            &EventHashView {
                campaign_id: &campaign_id,
                event_kind: &event_kind,
                payload_hash: &payload_hash,
                previous_event_hash: previous.as_deref(),
                recorded_at_unix_ms: recorded_at,
            },
        )?;
        if expected.as_str() != persisted_hash {
            return Err(CampaignWriterError::EventChainInvalid);
        }
        previous = Some(persisted_hash);
    }
    Ok(())
}

fn prepare_database(
    requested: &Path,
    policy: CampaignWriterPolicyV1,
) -> Result<PathBuf, CampaignWriterError> {
    if !requested.is_absolute() || requested.file_name().is_none() {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    let parent = requested
        .parent()
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    inspect_parent(parent, policy.owner_uid)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| CampaignWriterError::Filesystem("database_parent", error.kind()))?;
    let path = canonical_parent.join(
        requested
            .file_name()
            .ok_or(CampaignWriterError::DatabasePathInvalid)?,
    );
    if path != requested {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    if path.exists() {
        inspect_database_file(&path, policy)?;
    } else {
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| CampaignWriterError::Filesystem("database_create", error.kind()))?;
        file.sync_all()
            .map_err(|error| CampaignWriterError::Filesystem("database_create", error.kind()))?;
        sync_parent(&path)?;
    }
    Ok(path)
}

fn inspect_parent(parent: &Path, owner_uid: u32) -> Result<(), CampaignWriterError> {
    if !parent.is_absolute() {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
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
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    Ok(())
}

fn same_database_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
}

fn inspect_database_file(
    path: &Path,
    policy: CampaignWriterPolicyV1,
) -> Result<(), CampaignWriterError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CampaignWriterError::Filesystem("database_file", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != policy.owner_uid
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
        || metadata.size() > policy.maximum_database_bytes
    {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    Ok(())
}

fn inspect_absent_destination(path: &Path, owner_uid: u32) -> Result<(), CampaignWriterError> {
    if !path.is_absolute() || path.file_name().is_none() || path.exists() {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    inspect_parent(
        path.parent()
            .ok_or(CampaignWriterError::DatabasePathInvalid)?,
        owner_uid,
    )
}

fn verify_schema(connection: &Connection) -> Result<(), CampaignWriterError> {
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if application_id != APPLICATION_ID || user_version != SCHEMA_VERSION {
        return Err(CampaignWriterError::SchemaMismatch);
    }
    for table in ["writer_lease", "campaigns", "nodes", "campaign_events"] {
        let present: i64 = connection.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        if present != 1 {
            return Err(CampaignWriterError::SchemaMismatch);
        }
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), CampaignWriterError> {
    if value.is_empty()
        || value.len() > MAXIMUM_IDENTIFIER_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(CampaignWriterError::InvalidIdentifier);
    }
    Ok(())
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAXIMUM_TOKEN_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn to_i64(value: u64) -> Result<i64, CampaignWriterError> {
    i64::try_from(value).map_err(|_| CampaignWriterError::NumericOverflow)
}

fn from_i64(value: i64) -> Result<u64, CampaignWriterError> {
    u64::try_from(value).map_err(|_| CampaignWriterError::CorruptValue("negative_integer"))
}

fn hash_serialized<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<Sha256Digest, CampaignWriterError> {
    let bytes = serde_json::to_vec(value).map_err(|_| CampaignWriterError::Serialization)?;
    let mut hasher = Sha256::new();
    update_field(&mut hasher, domain.as_bytes());
    update_field(&mut hasher, &bytes);
    digest(hasher)
}

fn hash_path(path: &Path) -> Result<Sha256Digest, CampaignWriterError> {
    let value = path
        .to_str()
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    let mut hasher = Sha256::new();
    update_field(&mut hasher, b"HeptaCampaignWriterPathV1");
    update_field(&mut hasher, value.as_bytes());
    digest(hasher)
}

fn hash_file(path: &Path, maximum: u64) -> Result<(Sha256Digest, u64), CampaignWriterError> {
    let mut file = File::open(path)
        .map_err(|error| CampaignWriterError::Filesystem("hash_file", error.kind()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| CampaignWriterError::Filesystem("hash_file", error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| CampaignWriterError::NumericOverflow)?)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        if total > maximum {
            return Err(CampaignWriterError::DatabaseTooLarge);
        }
        hasher.update(&buffer[..read]);
    }
    Ok((digest(hasher)?, total))
}

fn update_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn digest(hasher: Sha256) -> Result<Sha256Digest, CampaignWriterError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| CampaignWriterError::DigestConstruction)
}

fn sync_parent(path: &Path) -> Result<(), CampaignWriterError> {
    let parent = path
        .parent()
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| CampaignWriterError::Filesystem("parent_sync", error.kind()))
}

#[derive(Debug, Error)]
pub enum CampaignWriterError {
    #[error("campaign writer policy is invalid")]
    InvalidPolicy,
    #[error("campaign writer database path is invalid")]
    DatabasePathInvalid,
    #[error("campaign writer database exceeds the byte limit")]
    DatabaseTooLarge,
    #[error("campaign writer schema does not match")]
    SchemaMismatch,
    #[error("writer lease is invalid")]
    InvalidWriterLease,
    #[error("writer lease is missing")]
    WriterLeaseMissing,
    #[error("writer generation or token is stale")]
    StaleWriterGeneration,
    #[error("campaign identifier is invalid")]
    InvalidIdentifier,
    #[error("campaign does not exist")]
    CampaignNotFound,
    #[error("campaign is not running")]
    CampaignNotRunning,
    #[error("campaign revision is stale")]
    StaleCampaignRevision,
    #[error("campaign changed concurrently")]
    ConcurrentCampaignChange,
    #[error("campaign is terminal and cannot reopen")]
    TerminalCampaignCannotReopen,
    #[error("campaign resource reservation is unavailable")]
    ResourceUnavailable,
    #[error("node claim is invalid")]
    InvalidNodeClaim,
    #[error("node is already claimed")]
    NodeAlreadyClaimed,
    #[error("node does not exist")]
    NodeNotFound,
    #[error("node claim is stale")]
    StaleNodeClaim,
    #[error("node state is invalid")]
    InvalidNodeState,
    #[error("prepared result does not match")]
    PreparedResultMismatch,
    #[error("provider ambiguity was not established")]
    ProviderAmbiguityNotEstablished,
    #[error("actual cost exceeds the reserved maximum")]
    CostExceedsReservation,
    #[error("cutover policy is invalid")]
    InvalidCutoverPolicy,
    #[error("cutover trust-store size is invalid")]
    InvalidCutoverTrustStoreSize,
    #[error("cutover signer key id is invalid")]
    InvalidCutoverSignerKeyId,
    #[error("cutover signer key id is duplicated: {0}")]
    DuplicateCutoverSignerKeyId(String),
    #[error("cutover verification key is weak: {0}")]
    WeakCutoverVerificationKey(String),
    #[error("cutover signer key is unknown: {0}")]
    UnknownCutoverSignerKey(String),
    #[error("cutover subject is invalid")]
    InvalidCutoverSubject,
    #[error("cutover subject does not match the expected runtime")]
    CutoverSubjectMismatch,
    #[error("cutover authorization is not yet valid")]
    CutoverNotYetValid,
    #[error("cutover authorization has expired")]
    CutoverExpired,
    #[error("cutover signature encoding is invalid")]
    InvalidCutoverSignatureEncoding,
    #[error("cutover signature was rejected")]
    CutoverSignatureRejected,
    #[error("cutover signing message is too large")]
    CutoverSigningMessageTooLarge,
    #[error("writer database preimage is invalid")]
    InvalidDatabasePreimage,
    #[error("writer database preimage changed before activation")]
    DatabasePreimageChanged,
    #[error("writer database has an unresolved SQLite sidecar")]
    DatabaseSidecarPresent,
    #[error("active writer authorization is required")]
    ActiveWriterAuthorizationRequired,
    #[error("initial writer lease does not match the signed cutover permit")]
    CutoverWriterBindingMismatch,
    #[error("cutover authorization is absent or invalid")]
    CutoverNotAuthorized,
    #[error("event hash chain is invalid")]
    EventChainInvalid,
    #[error("database integrity check failed: {0}")]
    IntegrityCheckFailed(String),
    #[error("database foreign key check failed")]
    ForeignKeyCheckFailed,
    #[error("WAL checkpoint did not fully complete")]
    CheckpointIncomplete,
    #[error("persisted value is corrupt: {0}")]
    CorruptValue(&'static str),
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("serialization failed")]
    Serialization,
    #[error("digest construction failed")]
    DigestConstruction,
    #[error("filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
    };

    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        database: PathBuf,
        uid: u32,
    }

    impl Fixture {
        fn new() -> Self {
            let sequence = NEXT_TEST.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "hepta-campaign-writer-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
            let uid = fs::metadata(&root).expect("metadata").uid();
            Self {
                database: root.join("campaign.sqlite"),
                root,
                uid,
            }
        }

        fn store(&self) -> CampaignWriterStoreV1 {
            self.store_at(&self.database)
        }

        fn store_at(&self, database: &Path) -> CampaignWriterStoreV1 {
            activated_store(database, self.uid)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64))).expect("digest")
    }

    fn cutover_subject() -> WriterCutoverSubjectV1 {
        WriterCutoverSubjectV1 {
            repository: "TrillionniumFoundation/hepta-paper".to_owned(),
            commit_sha: "1".repeat(40),
            tree_sha: "2".repeat(40),
            binary_hash: digest('3'),
            configuration_hash: digest('4'),
            host_identity_hash: digest('5'),
            service_identity_hash: digest('6'),
        }
    }

    fn verified_cutover(
        database: &Path,
        uid: u32,
    ) -> (CampaignWriterPolicyV1, VerifiedWriterCutoverV1) {
        let policy = CampaignWriterPolicyV1::strict(uid);
        let preimage =
            inspect_writer_database_preimage_v1(database, policy).expect("database preimage");
        let signing_key = SigningKey::from_bytes(&[41_u8; 32]);
        let mut authorization = WriterCutoverAuthorizationV1 {
            version: 1,
            cutover_id: "unit-cutover".to_owned(),
            subject: cutover_subject(),
            database_preimage_hash: writer_database_preimage_hash_v1(&preimage)
                .expect("preimage hash"),
            initial_writer_lease_hash: writer_lease_activation_hash_v1(&lease(1))
                .expect("writer lease hash"),
            node_writer_disabled: true,
            issued_at_unix_ms: 1,
            expires_at_unix_ms: 100_000,
            nonce: "unit-cutover-nonce".to_owned(),
            signer_key_id: "unit-cutover-key".to_owned(),
            signature_base64: "AA".to_owned(),
        };
        let message = writer_cutover_signing_bytes_v1(&authorization).expect("signing bytes");
        authorization.signature_base64 =
            Base64UrlUnpadded::encode_string(&signing_key.sign(&message).to_bytes());
        let trust = WriterCutoverTrustStoreV1::new([(
            "unit-cutover-key".to_owned(),
            signing_key.verifying_key(),
        )])
        .expect("cutover trust");
        let verified = verify_writer_cutover_authorization_v1(
            &authorization,
            &cutover_subject(),
            10,
            WriterCutoverPolicyV1::default(),
            &trust,
        )
        .expect("verified cutover");
        (policy, verified)
    }

    fn activated_store(database: &Path, uid: u32) -> CampaignWriterStoreV1 {
        let (policy, verified) = verified_cutover(database, uid);
        CampaignWriterStoreV1::open_for_cutover(database, policy, &verified, 10)
            .expect("writer store")
    }

    fn lease(generation: u64) -> WriterLeaseV1 {
        WriterLeaseV1 {
            generation,
            token: format!("writer-{generation}"),
            expires_at_unix_ms: 1_000_000,
        }
    }

    #[test]
    fn database_preimage_change_blocks_activation_before_sqlite_open() {
        let fixture = Fixture::new();
        let (policy, verified) = verified_cutover(&fixture.database, fixture.uid);
        fs::write(&fixture.database, b"replaced preimage").expect("replacement");
        fs::set_permissions(&fixture.database, fs::Permissions::from_mode(0o600))
            .expect("replacement mode");
        assert!(matches!(
            CampaignWriterStoreV1::open_for_cutover(&fixture.database, policy, &verified, 10,),
            Err(CampaignWriterError::DatabasePreimageChanged)
        ));
    }

    #[test]
    fn one_verified_preimage_cannot_open_two_concurrent_writer_stores() {
        let fixture = Fixture::new();
        let (policy, verified) = verified_cutover(&fixture.database, fixture.uid);
        let first =
            CampaignWriterStoreV1::open_for_cutover(&fixture.database, policy, &verified, 10)
                .expect("first store");
        let second =
            CampaignWriterStoreV1::open_for_cutover(&fixture.database, policy, &verified, 10);
        assert!(matches!(
            second,
            Err(CampaignWriterError::DatabasePreimageChanged)
                | Err(CampaignWriterError::DatabaseSidecarPresent)
                | Err(CampaignWriterError::Sqlite(_))
        ));
        drop(first);
    }

    #[test]
    fn first_writer_lease_must_match_the_signed_cutover_binding() {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        assert!(matches!(
            store.acquire_writer(lease(2), 1),
            Err(CampaignWriterError::CutoverWriterBindingMismatch)
        ));
        store
            .acquire_writer(lease(1), 1)
            .expect("signed initial writer");
        store
            .acquire_writer(lease(2), 2)
            .expect("later generation is internally fenced");
    }

    #[test]
    fn stale_writer_and_stale_revision_cannot_commit() {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        let first = store.acquire_writer(lease(1), 1).expect("first lease");
        store
            .create_campaign(&first, "campaign-1", 10_000, 4, 1, 2)
            .expect("campaign");
        let second = store.acquire_writer(lease(2), 3).expect("second lease");
        assert!(matches!(
            store.claim_node(
                &first,
                "campaign-1",
                "node-1",
                "attempt-1",
                0,
                "claim-1",
                100,
                100,
                1,
                0,
                4,
            ),
            Err(CampaignWriterError::StaleWriterGeneration)
        ));
        store
            .claim_node(
                &second,
                "campaign-1",
                "node-1",
                "attempt-1",
                0,
                "claim-1",
                100,
                100,
                1,
                0,
                4,
            )
            .expect("claim");
        assert!(matches!(
            store.claim_node(
                &second,
                "campaign-1",
                "node-2",
                "attempt-1",
                0,
                "claim-2",
                100,
                100,
                1,
                0,
                5,
            ),
            Err(CampaignWriterError::StaleCampaignRevision)
        ));
    }

    #[test]
    fn prepared_result_integrates_exactly_once_and_refunds_only_difference() {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        let writer = store.acquire_writer(lease(1), 1).expect("lease");
        store
            .create_campaign(&writer, "campaign-1", 10_000, 4, 1, 2)
            .expect("campaign");
        let claim = store
            .claim_node(
                &writer,
                "campaign-1",
                "node-1",
                "attempt-1",
                0,
                "claim-1",
                100,
                1_000,
                2,
                1,
                3,
            )
            .expect("claim");
        let prepared = digest('a');
        let integrated = digest('b');
        store
            .store_prepared_result(&writer, &claim, &prepared, true, 4)
            .expect("prepared");
        let first = store
            .integrate_prepared_result(&writer, &claim, &prepared, &integrated, 600, 5)
            .expect("integrate");
        let second = store
            .integrate_prepared_result(&writer, &claim, &prepared, &integrated, 600, 6)
            .expect("idempotent integrate");
        assert_eq!(first, second);
        let campaign = store.load_campaign("campaign-1").expect("campaign");
        assert_eq!(campaign.budget_remaining_microusd, 9_400);
        assert_eq!(campaign.cpu_remaining, 4);
        assert_eq!(campaign.gpu_remaining, 1);
        store.validate_integrity().expect("integrity");
    }

    #[test]
    fn pre_provider_failure_refunds_but_ambiguous_execution_does_not() {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        let writer = store.acquire_writer(lease(1), 1).expect("lease");
        store
            .create_campaign(&writer, "campaign-1", 2_000, 2, 0, 2)
            .expect("campaign");
        let first = store
            .claim_node(
                &writer,
                "campaign-1",
                "node-1",
                "attempt-1",
                0,
                "claim-1",
                100,
                500,
                1,
                0,
                3,
            )
            .expect("claim one");
        store
            .fail_before_provider(&writer, &first, 4)
            .expect("pre-provider failure");
        let revision = store
            .load_campaign("campaign-1")
            .expect("campaign")
            .revision;
        let second = store
            .claim_node(
                &writer,
                "campaign-1",
                "node-2",
                "attempt-1",
                revision,
                "claim-2",
                100,
                700,
                1,
                0,
                5,
            )
            .expect("claim two");
        store
            .store_prepared_result(&writer, &second, &digest('c'), true, 6)
            .expect("prepared");
        store
            .settle_ambiguous(&writer, &second, 7)
            .expect("ambiguous");
        let campaign = store.load_campaign("campaign-1").expect("campaign");
        assert_eq!(campaign.budget_remaining_microusd, 1_300);
        assert_eq!(campaign.cpu_remaining, 2);
    }

    #[test]
    fn backup_restore_and_large_state_projection_are_recoverable() {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        let writer = store.acquire_writer(lease(1), 1).expect("lease");
        store
            .create_campaign(&writer, "campaign-1", 2_000_000, 20_000, 0, 2)
            .expect("campaign");
        let mut revision = 0_u64;
        for index in 0..10_000_u64 {
            let claim = store
                .claim_node(
                    &writer,
                    "campaign-1",
                    &format!("node-{index}"),
                    "attempt-1",
                    revision,
                    &format!("claim-{index}"),
                    1_000_000,
                    100,
                    1,
                    0,
                    10 + index * 3,
                )
                .expect("claim");
            store
                .fail_before_provider(&writer, &claim, 11 + index * 3)
                .expect("refund");
            revision = store
                .load_campaign("campaign-1")
                .expect("campaign")
                .revision;
        }
        store.validate_integrity().expect("integrity");
        let backup = fixture.root.join("backup.sqlite");
        let receipt = store.create_backup(&backup).expect("backup");
        assert!(receipt.byte_count > 0);
        drop(store);
        let restored = fixture.root.join("restored.sqlite");
        restore_backup(
            &backup,
            &restored,
            CampaignWriterPolicyV1::strict(fixture.uid),
        )
        .expect("restore");
        let restored_store = fixture.store_at(&restored);
        restored_store
            .validate_integrity()
            .expect("restored integrity");
    }
}
