use std::{fs, path::{Path, PathBuf}, str::FromStr};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ResourceVectorV1;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, canonical_hash_v1};

const RESOURCE_LEDGER_APPLICATION_ID: i64 = 0x4852_4c47;
const RESOURCE_LEDGER_USER_VERSION: i64 = 1;
const MAXIMUM_RESOURCE_JSON_BYTES: usize = 64 * 1024;

const RESOURCE_LEDGER_SCHEMA_V1: &str = r#"
BEGIN IMMEDIATE;
PRAGMA application_id = 1213353031;
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS resource_leases_v1 (
  reservation_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  fence_generation INTEGER NOT NULL CHECK(fence_generation > 0),
  fence_token_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  issued_at_unix_ms INTEGER NOT NULL CHECK(issued_at_unix_ms > 0),
  expires_at_unix_ms INTEGER NOT NULL CHECK(expires_at_unix_ms > issued_at_unix_ms),
  state TEXT NOT NULL CHECK(state IN ('prepared','finalized','uncertain','released')),
  reconciliation_receipt_hash TEXT,
  row_hash TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS resource_leases_v1_state_idx
  ON resource_leases_v1(state, expires_at_unix_ms, reservation_id);
COMMIT;
"#;

/// Durable resource-lease lifecycle. Unknown or ambiguous consumption is never silently released.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableResourceLeaseStateV1 {
    /// Capacity is durably prepared but no dispatch capability may be consumed yet.
    Prepared,
    /// Capacity is finalized and may back one fenced dispatch.
    Finalized,
    /// Consumption cannot be proven released and remains charged.
    Uncertain,
    /// Capacity is reconciled and no longer charged.
    Released,
}

impl DurableResourceLeaseStateV1 {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Finalized => "finalized",
            Self::Uncertain => "uncertain",
            Self::Released => "released",
        }
    }

    fn parse(value: &str) -> Result<Self, ControlPlaneError> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "finalized" => Ok(Self::Finalized),
            "uncertain" => Ok(Self::Uncertain),
            "released" => Ok(Self::Released),
            _ => Err(ControlPlaneError::ResourcePersistenceInvalid),
        }
    }
}

/// Complete immutable input to the durable prepare boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableResourcePrepareV1 {
    /// Stable reservation identity.
    pub reservation_id: String,
    /// Principal or worker owner identity.
    pub owner_id: String,
    /// Leaf scheduling-domain identity.
    pub domain_id: String,
    /// Monotonic fence generation.
    pub fence_generation: u64,
    /// Hash of the single-use fence token; raw token bytes are not persisted here.
    pub fence_token_hash: Sha256Digest,
    /// Exact hierarchical resource-policy identity.
    pub policy_hash: Sha256Digest,
    /// Exact plan certificate identity.
    pub plan_hash: Sha256Digest,
    /// Exact action/candidate identity.
    pub action_hash: Sha256Digest,
    /// Complete reserved resource vector.
    pub resources: ResourceVectorV1,
    /// Explicit issue time.
    pub issued_at_unix_ms: u64,
    /// Explicit lease expiry.
    pub expires_at_unix_ms: u64,
}

impl DurableResourcePrepareV1 {
    fn validate(&self) -> Result<(), ControlPlaneError> {
        if !valid_identifier(&self.reservation_id)
            || !valid_identifier(&self.owner_id)
            || !valid_identifier(&self.domain_id)
            || self.fence_generation == 0
            || self.resources.is_zero()
            || self.issued_at_unix_ms == 0
            || self.expires_at_unix_ms <= self.issued_at_unix_ms
        {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        Ok(())
    }
}

/// Exact durable lease record including its canonical integrity hash.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableResourceLeaseV1 {
    /// Stable reservation identity.
    pub reservation_id: String,
    /// Principal or worker owner identity.
    pub owner_id: String,
    /// Leaf scheduling-domain identity.
    pub domain_id: String,
    /// Monotonic fence generation.
    pub fence_generation: u64,
    /// Hash of the single-use fence token.
    pub fence_token_hash: Sha256Digest,
    /// Exact policy identity.
    pub policy_hash: Sha256Digest,
    /// Exact plan identity.
    pub plan_hash: Sha256Digest,
    /// Exact action identity.
    pub action_hash: Sha256Digest,
    /// Complete resource vector retained while this record is active or uncertain.
    pub resources: ResourceVectorV1,
    /// Issue time.
    pub issued_at_unix_ms: u64,
    /// Current expiry.
    pub expires_at_unix_ms: u64,
    /// Durable lifecycle state.
    pub state: DurableResourceLeaseStateV1,
    /// Trusted reconciliation receipt required to release finalized or uncertain capacity.
    pub reconciliation_receipt_hash: Option<Sha256Digest>,
    /// Canonical record hash excluding this field.
    pub row_hash: Sha256Digest,
}

impl DurableResourceLeaseV1 {
    /// Verifies the persisted self-hash and basic invariants.
    pub fn validate(&self) -> Result<(), ControlPlaneError> {
        let input = DurableResourcePrepareV1 {
            reservation_id: self.reservation_id.clone(),
            owner_id: self.owner_id.clone(),
            domain_id: self.domain_id.clone(),
            fence_generation: self.fence_generation,
            fence_token_hash: self.fence_token_hash.clone(),
            policy_hash: self.policy_hash.clone(),
            plan_hash: self.plan_hash.clone(),
            action_hash: self.action_hash.clone(),
            resources: self.resources,
            issued_at_unix_ms: self.issued_at_unix_ms,
            expires_at_unix_ms: self.expires_at_unix_ms,
        };
        input.validate()?;
        if self.state == DurableResourceLeaseStateV1::Released
            && self.reconciliation_receipt_hash.is_none()
        {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        if self.row_hash != lease_row_hash(self)? {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        Ok(())
    }
}

/// Crash-recovery disposition for the durable resource ledger.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRecoveryReportV1 {
    /// Expired prepared reservations rolled back before dispatch.
    pub prepared_released: Vec<String>,
    /// Expired finalized reservations moved to `uncertain` and retained as charges.
    pub finalized_marked_uncertain: Vec<String>,
    /// Already uncertain reservation identities retained as charges.
    pub retained_uncertain: Vec<String>,
    /// Canonical report identity.
    pub report_hash: Sha256Digest,
}

/// SQLite-backed resource lease journal. It owns resource-accounting facts only, never campaign state.
pub struct DurableResourceLeaseLedgerV1 {
    path: PathBuf,
    connection: Connection,
}

impl DurableResourceLeaseLedgerV1 {
    /// Opens or creates a strict resource lease ledger at a non-symlink path.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ControlPlaneError> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() || path.symlink_metadata().is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        }
        let connection = Connection::open(path)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA trusted_schema = OFF;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = FULL;",
            )
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let application_id: i64 = connection
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if application_id == 0 && user_version == 0 {
            connection
                .execute_batch(RESOURCE_LEDGER_SCHEMA_V1)
                .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        }
        let application_id: i64 = connection
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if application_id != RESOURCE_LEDGER_APPLICATION_ID || user_version != RESOURCE_LEDGER_USER_VERSION {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        let ledger = Self {
            path: path.to_path_buf(),
            connection,
        };
        ledger.validate_integrity()?;
        Ok(ledger)
    }

    /// Returns the exact backing path for operator evidence binding.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Durably prepares one resource vector before dispatch. Exact retries are idempotent.
    pub fn prepare(
        &mut self,
        request: DurableResourcePrepareV1,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        request.validate()?;
        let candidate = lease_from_prepare(request, DurableResourceLeaseStateV1::Prepared, None)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if let Some(existing) = load_lease(&transaction, &candidate.reservation_id)? {
            return if existing == candidate {
                Ok(existing)
            } else {
                Err(ControlPlaneError::ReservationInvalid)
            };
        }
        insert_lease(&transaction, &candidate)?;
        transaction
            .commit()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        Ok(candidate)
    }

    /// Finalizes a prepared lease after plan/capacity generations have been revalidated.
    pub fn finalize(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        self.transition_owned(
            reservation_id,
            fence_generation,
            fence_token_hash,
            now_unix_ms,
            DurableResourceLeaseStateV1::Prepared,
            DurableResourceLeaseStateV1::Finalized,
            None,
            None,
        )
    }

    /// Renews a live finalized lease without changing its generation or token identity.
    pub fn renew(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        now_unix_ms: u64,
        new_expires_at_unix_ms: u64,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        if new_expires_at_unix_ms <= now_unix_ms {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        self.transition_owned(
            reservation_id,
            fence_generation,
            fence_token_hash,
            now_unix_ms,
            DurableResourceLeaseStateV1::Finalized,
            DurableResourceLeaseStateV1::Finalized,
            Some(new_expires_at_unix_ms),
            None,
        )
    }

    /// Marks a live finalized lease uncertain after owner loss or ambiguous external disposition.
    pub fn mark_uncertain(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        self.transition_owned(
            reservation_id,
            fence_generation,
            fence_token_hash,
            now_unix_ms,
            DurableResourceLeaseStateV1::Finalized,
            DurableResourceLeaseStateV1::Uncertain,
            None,
            None,
        )
    }

    /// Releases finalized or uncertain capacity only with a trusted reconciliation receipt.
    pub fn reconcile_and_release(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        reconciliation_receipt_hash: Sha256Digest,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let mut lease = load_lease(&transaction, reservation_id)?
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        assert_owner(&lease, fence_generation, fence_token_hash)?;
        if lease.state == DurableResourceLeaseStateV1::Released {
            return if lease.reconciliation_receipt_hash.as_ref() == Some(&reconciliation_receipt_hash) {
                Ok(lease)
            } else {
                Err(ControlPlaneError::ReservationInvalid)
            };
        }
        if !matches!(
            lease.state,
            DurableResourceLeaseStateV1::Finalized | DurableResourceLeaseStateV1::Uncertain
        ) {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        lease.state = DurableResourceLeaseStateV1::Released;
        lease.reconciliation_receipt_hash = Some(reconciliation_receipt_hash);
        lease.row_hash = lease_row_hash(&lease)?;
        update_lease(&transaction, &lease)?;
        transaction
            .commit()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        Ok(lease)
    }

    /// Recovers expired reservations conservatively after a crash or restart.
    ///
    /// Prepared-but-never-finalized capacity is rolled back with an internal deterministic
    /// pre-dispatch receipt. Expired finalized capacity becomes uncertain and remains charged.
    pub fn recover_expired(
        &mut self,
        now_unix_ms: u64,
    ) -> Result<ResourceRecoveryReportV1, ControlPlaneError> {
        if now_unix_ms == 0 {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let leases = load_non_released_leases(&transaction)?;
        let mut prepared_released = Vec::new();
        let mut finalized_marked_uncertain = Vec::new();
        let mut retained_uncertain = Vec::new();
        for mut lease in leases {
            match lease.state {
                DurableResourceLeaseStateV1::Prepared if lease.expires_at_unix_ms <= now_unix_ms => {
                    lease.state = DurableResourceLeaseStateV1::Released;
                    lease.reconciliation_receipt_hash = Some(canonical_hash_v1(&(
                        "resource_pre_dispatch_expiry_v1",
                        lease.reservation_id.as_str(),
                        lease.row_hash.clone(),
                        now_unix_ms,
                    ))?);
                    lease.row_hash = lease_row_hash(&lease)?;
                    update_lease(&transaction, &lease)?;
                    prepared_released.push(lease.reservation_id);
                }
                DurableResourceLeaseStateV1::Finalized if lease.expires_at_unix_ms <= now_unix_ms => {
                    lease.state = DurableResourceLeaseStateV1::Uncertain;
                    lease.row_hash = lease_row_hash(&lease)?;
                    update_lease(&transaction, &lease)?;
                    finalized_marked_uncertain.push(lease.reservation_id);
                }
                DurableResourceLeaseStateV1::Uncertain => {
                    retained_uncertain.push(lease.reservation_id);
                }
                _ => {}
            }
        }
        prepared_released.sort();
        finalized_marked_uncertain.sort();
        retained_uncertain.sort();
        let report_body = (
            prepared_released.clone(),
            finalized_marked_uncertain.clone(),
            retained_uncertain.clone(),
            now_unix_ms,
        );
        let report_hash = canonical_hash_v1(&report_body)?;
        transaction
            .commit()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        Ok(ResourceRecoveryReportV1 {
            prepared_released,
            finalized_marked_uncertain,
            retained_uncertain,
            report_hash,
        })
    }

    /// Returns every lease that still consumes or conservatively retains capacity.
    pub fn active_charges(&self) -> Result<Vec<DurableResourceLeaseV1>, ControlPlaneError> {
        load_non_released_leases(&self.connection)
    }

    /// Loads one exact reservation when present.
    pub fn load(
        &self,
        reservation_id: &str,
    ) -> Result<Option<DurableResourceLeaseV1>, ControlPlaneError> {
        if !valid_identifier(reservation_id) {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        load_lease(&self.connection, reservation_id)
    }

    /// Checks SQLite integrity and every persisted lease self-hash.
    pub fn validate_integrity(&self) -> Result<(), ControlPlaneError> {
        let integrity: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        if integrity != "ok" {
            return Err(ControlPlaneError::ResourcePersistenceInvalid);
        }
        let mut statement = self
            .connection
            .prepare("SELECT reservation_id FROM resource_leases_v1 ORDER BY reservation_id")
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        for id in ids {
            let lease = load_lease(&self.connection, &id)?
                .ok_or(ControlPlaneError::ResourcePersistenceInvalid)?;
            lease.validate()?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn transition_owned(
        &mut self,
        reservation_id: &str,
        fence_generation: u64,
        fence_token_hash: &Sha256Digest,
        now_unix_ms: u64,
        required_state: DurableResourceLeaseStateV1,
        next_state: DurableResourceLeaseStateV1,
        new_expiry: Option<u64>,
        reconciliation_receipt_hash: Option<Sha256Digest>,
    ) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
        if now_unix_ms == 0 {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        let mut lease = load_lease(&transaction, reservation_id)?
            .ok_or(ControlPlaneError::ReservationInvalid)?;
        assert_owner(&lease, fence_generation, fence_token_hash)?;
        if lease.state != required_state || lease.expires_at_unix_ms <= now_unix_ms {
            return Err(ControlPlaneError::ReservationInvalid);
        }
        if let Some(expiry) = new_expiry {
            if expiry <= now_unix_ms || expiry < lease.expires_at_unix_ms {
                return Err(ControlPlaneError::ReservationInvalid);
            }
            lease.expires_at_unix_ms = expiry;
        }
        lease.state = next_state;
        lease.reconciliation_receipt_hash = reconciliation_receipt_hash;
        lease.row_hash = lease_row_hash(&lease)?;
        update_lease(&transaction, &lease)?;
        transaction
            .commit()
            .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
        Ok(lease)
    }
}

fn lease_from_prepare(
    request: DurableResourcePrepareV1,
    state: DurableResourceLeaseStateV1,
    reconciliation_receipt_hash: Option<Sha256Digest>,
) -> Result<DurableResourceLeaseV1, ControlPlaneError> {
    let mut lease = DurableResourceLeaseV1 {
        reservation_id: request.reservation_id,
        owner_id: request.owner_id,
        domain_id: request.domain_id,
        fence_generation: request.fence_generation,
        fence_token_hash: request.fence_token_hash,
        policy_hash: request.policy_hash,
        plan_hash: request.plan_hash,
        action_hash: request.action_hash,
        resources: request.resources,
        issued_at_unix_ms: request.issued_at_unix_ms,
        expires_at_unix_ms: request.expires_at_unix_ms,
        state,
        reconciliation_receipt_hash,
        row_hash: Sha256Digest::from_str(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        )
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?,
    };
    lease.row_hash = lease_row_hash(&lease)?;
    Ok(lease)
}

fn lease_row_hash(lease: &DurableResourceLeaseV1) -> Result<Sha256Digest, ControlPlaneError> {
    canonical_hash_v1(&ResourceLeaseHashBodyV1 {
        reservation_id: lease.reservation_id.as_str(),
        owner_id: lease.owner_id.as_str(),
        domain_id: lease.domain_id.as_str(),
        fence_generation: lease.fence_generation,
        fence_token_hash: &lease.fence_token_hash,
        policy_hash: &lease.policy_hash,
        plan_hash: &lease.plan_hash,
        action_hash: &lease.action_hash,
        resources: lease.resources,
        issued_at_unix_ms: lease.issued_at_unix_ms,
        expires_at_unix_ms: lease.expires_at_unix_ms,
        state: lease.state,
        reconciliation_receipt_hash: lease.reconciliation_receipt_hash.as_ref(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLeaseHashBodyV1<'a> {
    reservation_id: &'a str,
    owner_id: &'a str,
    domain_id: &'a str,
    fence_generation: u64,
    fence_token_hash: &'a Sha256Digest,
    policy_hash: &'a Sha256Digest,
    plan_hash: &'a Sha256Digest,
    action_hash: &'a Sha256Digest,
    resources: ResourceVectorV1,
    issued_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    state: DurableResourceLeaseStateV1,
    reconciliation_receipt_hash: Option<&'a Sha256Digest>,
}

fn assert_owner(
    lease: &DurableResourceLeaseV1,
    fence_generation: u64,
    fence_token_hash: &Sha256Digest,
) -> Result<(), ControlPlaneError> {
    if fence_generation != lease.fence_generation || fence_token_hash != &lease.fence_token_hash {
        return Err(ControlPlaneError::ReservationInvalid);
    }
    Ok(())
}

fn insert_lease(
    connection: &Connection,
    lease: &DurableResourceLeaseV1,
) -> Result<(), ControlPlaneError> {
    let resource_json = serde_json::to_string(&lease.resources)
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
    if resource_json.len() > MAXIMUM_RESOURCE_JSON_BYTES {
        return Err(ControlPlaneError::ResourcePersistenceInvalid);
    }
    connection
        .execute(
            "INSERT INTO resource_leases_v1(
               reservation_id, owner_id, domain_id, fence_generation, fence_token_hash,
               policy_hash, plan_hash, action_hash, resource_json, issued_at_unix_ms,
               expires_at_unix_ms, state, reconciliation_receipt_hash, row_hash
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                lease.reservation_id,
                lease.owner_id,
                lease.domain_id,
                to_i64(lease.fence_generation)?,
                lease.fence_token_hash.to_string(),
                lease.policy_hash.to_string(),
                lease.plan_hash.to_string(),
                lease.action_hash.to_string(),
                resource_json,
                to_i64(lease.issued_at_unix_ms)?,
                to_i64(lease.expires_at_unix_ms)?,
                lease.state.as_str(),
                lease.reconciliation_receipt_hash.as_ref().map(ToString::to_string),
                lease.row_hash.to_string(),
            ],
        )
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
    Ok(())
}

fn update_lease(
    connection: &Connection,
    lease: &DurableResourceLeaseV1,
) -> Result<(), ControlPlaneError> {
    let changed = connection
        .execute(
            "UPDATE resource_leases_v1 SET
               expires_at_unix_ms=?2, state=?3, reconciliation_receipt_hash=?4, row_hash=?5
             WHERE reservation_id=?1",
            params![
                lease.reservation_id,
                to_i64(lease.expires_at_unix_ms)?,
                lease.state.as_str(),
                lease.reconciliation_receipt_hash.as_ref().map(ToString::to_string),
                lease.row_hash.to_string(),
            ],
        )
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
    if changed != 1 {
        return Err(ControlPlaneError::ResourcePersistenceInvalid);
    }
    Ok(())
}

fn load_non_released_leases(
    connection: &Connection,
) -> Result<Vec<DurableResourceLeaseV1>, ControlPlaneError> {
    let mut statement = connection
        .prepare(
            "SELECT reservation_id FROM resource_leases_v1
             WHERE state != 'released' ORDER BY reservation_id",
        )
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
    ids.into_iter()
        .map(|id| {
            load_lease(connection, &id)?.ok_or(ControlPlaneError::ResourcePersistenceInvalid)
        })
        .collect()
}

fn load_lease(
    connection: &Connection,
    reservation_id: &str,
) -> Result<Option<DurableResourceLeaseV1>, ControlPlaneError> {
    let raw = connection
        .query_row(
            "SELECT owner_id, domain_id, fence_generation, fence_token_hash, policy_hash,
                    plan_hash, action_hash, resource_json, issued_at_unix_ms, expires_at_unix_ms,
                    state, reconciliation_receipt_hash, row_hash
             FROM resource_leases_v1 WHERE reservation_id=?1",
            [reservation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                ))
            },
        )
        .optional()
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
    let Some((
        owner_id,
        domain_id,
        fence_generation,
        fence_token_hash,
        policy_hash,
        plan_hash,
        action_hash,
        resource_json,
        issued_at_unix_ms,
        expires_at_unix_ms,
        state,
        reconciliation_receipt_hash,
        row_hash,
    )) = raw
    else {
        return Ok(None);
    };
    let resources: ResourceVectorV1 = serde_json::from_str(&resource_json)
        .map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)?;
    let lease = DurableResourceLeaseV1 {
        reservation_id: reservation_id.to_owned(),
        owner_id,
        domain_id,
        fence_generation: to_u64(fence_generation)?,
        fence_token_hash: parse_hash(&fence_token_hash)?,
        policy_hash: parse_hash(&policy_hash)?,
        plan_hash: parse_hash(&plan_hash)?,
        action_hash: parse_hash(&action_hash)?,
        resources,
        issued_at_unix_ms: to_u64(issued_at_unix_ms)?,
        expires_at_unix_ms: to_u64(expires_at_unix_ms)?,
        state: DurableResourceLeaseStateV1::parse(&state)?,
        reconciliation_receipt_hash: reconciliation_receipt_hash
            .as_deref()
            .map(parse_hash)
            .transpose()?,
        row_hash: parse_hash(&row_hash)?,
    };
    lease.validate()?;
    Ok(Some(lease))
}

fn parse_hash(value: &str) -> Result<Sha256Digest, ControlPlaneError> {
    Sha256Digest::from_str(value).map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)
}

fn to_i64(value: u64) -> Result<i64, ControlPlaneError> {
    i64::try_from(value).map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)
}

fn to_u64(value: i64) -> Result<u64, ControlPlaneError> {
    u64::try_from(value).map_err(|_| ControlPlaneError::ResourcePersistenceInvalid)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

#[cfg(test)]
mod tests {
    use std::{fs, process, sync::atomic::{AtomicU64, Ordering}};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64))
            .parse()
            .expect("digest")
    }

    fn test_path(label: &str) -> PathBuf {
        let ordinal = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "hepta-resource-ledger-{label}-{}-{ordinal}.sqlite",
            process::id()
        ))
    }

    fn prepare(id: &str, issued: u64, expires: u64) -> DurableResourcePrepareV1 {
        DurableResourcePrepareV1 {
            reservation_id: id.to_owned(),
            owner_id: "worker-a".to_owned(),
            domain_id: "campaign-a".to_owned(),
            fence_generation: 7,
            fence_token_hash: digest('a'),
            policy_hash: digest('b'),
            plan_hash: digest('c'),
            action_hash: digest('d'),
            resources: ResourceVectorV1 {
                cpu_millis: 100,
                memory_bytes: 1024,
                ..ResourceVectorV1::default()
            },
            issued_at_unix_ms: issued,
            expires_at_unix_ms: expires,
        }
    }

    #[test]
    fn expired_finalized_capacity_becomes_uncertain_and_stays_charged() {
        let path = test_path("uncertain");
        let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
        let lease = ledger.prepare(prepare("r1", 10, 20)).expect("prepare");
        ledger
            .finalize("r1", lease.fence_generation, &lease.fence_token_hash, 11)
            .expect("finalize");
        let report = ledger.recover_expired(21).expect("recover");
        assert_eq!(report.finalized_marked_uncertain, vec!["r1"]);
        let active = ledger.active_charges().expect("charges");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].state, DurableResourceLeaseStateV1::Uncertain);
        drop(ledger);
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_fence_cannot_renew_or_release() {
        let path = test_path("fence");
        let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
        let lease = ledger.prepare(prepare("r2", 10, 30)).expect("prepare");
        ledger
            .finalize("r2", lease.fence_generation, &lease.fence_token_hash, 11)
            .expect("finalize");
        assert_eq!(
            ledger.renew("r2", 6, &lease.fence_token_hash, 12, 40),
            Err(ControlPlaneError::ReservationInvalid)
        );
        assert_eq!(
            ledger.reconcile_and_release("r2", 6, &lease.fence_token_hash, digest('e')),
            Err(ControlPlaneError::ReservationInvalid)
        );
        ledger
            .reconcile_and_release("r2", 7, &lease.fence_token_hash, digest('e'))
            .expect("release");
        assert!(ledger.active_charges().expect("charges").is_empty());
        drop(ledger);
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
        let _ = fs::remove_file(path);
    }
}
