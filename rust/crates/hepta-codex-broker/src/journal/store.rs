use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_journal::{JournalError, JournalTransitionV1, OperationJournalV1, OperationState};
use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use thiserror::Error;

use crate::AuthenticatedBrokerRequestV1;

use super::{
    codec::{from_i64, sha256_digest, state_from_db, state_to_db, to_i64},
    path::{inspect_database_envelope, open_secure_database, verify_database_contract},
};

const HARD_MAXIMUM_BUSY_TIMEOUT_MS: u64 = 30_000;
const HARD_MAXIMUM_DATABASE_BYTES: u64 = 1024 * 1024 * 1024;
const HARD_MAXIMUM_REQUEST_BYTES: usize = 1024 * 1024;

/// Filesystem and SQLite durability policy for the broker-owned journal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerJournalPolicyV1 {
    pub version: u16,
    pub owner_uid: u32,
    pub owner_gid: Option<u32>,
    pub busy_timeout_ms: u64,
    pub maximum_database_bytes: u64,
}

impl BrokerJournalPolicyV1 {
    /// Strict policy for a journal owned by one broker service principal.
    #[must_use]
    pub const fn strict(owner_uid: u32) -> Self {
        Self {
            version: 1,
            owner_uid,
            owner_gid: None,
            busy_timeout_ms: 5_000,
            maximum_database_bytes: 512 * 1024 * 1024,
        }
    }

    fn validate(self) -> Result<Self, BrokerJournalError> {
        if self.version != 1
            || self.busy_timeout_ms == 0
            || self.busy_timeout_ms > HARD_MAXIMUM_BUSY_TIMEOUT_MS
            || self.maximum_database_bytes == 0
            || self.maximum_database_bytes > HARD_MAXIMUM_DATABASE_BYTES
        {
            return Err(BrokerJournalError::InvalidPolicy);
        }
        Ok(self)
    }
}

/// Deterministic fault point used to prove transaction rollback.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FaultInjectionPointV1 {
    None,
    AfterOperationInsert,
    AfterNonceInsert,
    AfterTransitionInsert,
    AfterProjectionUpdate,
}

/// Result of reserving an idempotent provider operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReservationOutcomeV1 {
    Reserved(OperationJournalV1),
    Existing(OperationJournalV1),
}

/// Single-connection broker journal store. It is `Send` but intentionally not `Sync`.
pub struct BrokerJournalStoreV1 {
    connection: Connection,
    path: PathBuf,
    policy: BrokerJournalPolicyV1,
}

impl BrokerJournalStoreV1 {
    /// Opens or creates a private broker database and validates all durable state.
    pub fn open(
        path: impl AsRef<Path>,
        policy: BrokerJournalPolicyV1,
    ) -> Result<Self, BrokerJournalError> {
        let policy = policy.validate()?;
        let (path, connection) = open_secure_database(path.as_ref(), policy)?;
        let store = Self {
            connection,
            path,
            policy,
        };
        store.validate_integrity()?;
        Ok(store)
    }

    /// Canonical private database path owned by this broker.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reserves an operation exactly once or returns the exact existing journal.
    pub fn reserve_operation(
        &mut self,
        admitted: &AuthenticatedBrokerRequestV1,
        now_unix_ms: u64,
        fault: FaultInjectionPointV1,
    ) -> Result<ReservationOutcomeV1, BrokerJournalError> {
        if now_unix_ms == 0 {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
        validate_authenticated_request(admitted)?;
        if now_unix_ms >= admitted.request.request_capability.expires_at_unix_ms
            || now_unix_ms >= admitted.request.absolute_deadline_unix_ms
        {
            return Err(BrokerJournalError::AuthenticatedRequestExpired);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing) =
            existing_by_idempotency(&transaction, admitted.request.idempotency_key.as_str())?
        {
            if !existing.matches(admitted) {
                return Err(BrokerJournalError::IdempotencyConflict);
            }
            let journal =
                load_journal_from_connection(&transaction, &admitted.request.operation_id)?;
            transaction.commit()?;
            return Ok(ReservationOutcomeV1::Existing(journal));
        }

        if operation_exists(&transaction, &admitted.request.operation_id)? {
            return Err(BrokerJournalError::OperationIdentityConflict);
        }
        if nonce_exists(&transaction, &admitted.capability.nonce)? {
            return Err(BrokerJournalError::CapabilityNonceReplay);
        }

        let journal = OperationJournalV1::new(
            admitted.request.operation_id.clone(),
            admitted.request_hash.clone(),
        )?;
        transaction.execute(
            "INSERT INTO operations (
                operation_id, request_hash, idempotency_key, request_payload,
                peer_pid, peer_uid, peer_gid, signer_key_id, capability_nonce,
                capability_message_hash, current_state, created_at_unix_ms,
                updated_at_unix_ms, provider_action_may_have_started,
                prepared_receipt_hash
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, 0, NULL
             )",
            params![
                admitted.request.operation_id,
                admitted.request_hash.as_str(),
                admitted.request.idempotency_key.as_str(),
                admitted.request_payload,
                i64::from(admitted.peer.pid),
                i64::from(admitted.peer.uid),
                i64::from(admitted.peer.gid),
                admitted.capability.signer_key_id,
                admitted.capability.nonce,
                admitted.capability.signing_message_hash.as_str(),
                state_to_db(OperationState::Reserved),
                to_i64(now_unix_ms)?,
            ],
        )?;
        if fault == FaultInjectionPointV1::AfterOperationInsert {
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        transaction.execute(
            "INSERT INTO capability_nonces (
                nonce, signer_key_id, operation_id, consumed_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                admitted.capability.nonce,
                admitted.capability.signer_key_id,
                admitted.request.operation_id,
                to_i64(now_unix_ms)?,
            ],
        )?;
        if fault == FaultInjectionPointV1::AfterNonceInsert {
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        transaction.commit()?;
        inspect_database_envelope(&self.path, self.policy)?;
        Ok(ReservationOutcomeV1::Reserved(journal))
    }

    /// Appends one validated state transition using compare-and-swap semantics.
    #[allow(clippy::too_many_arguments)]
    pub fn append_transition(
        &mut self,
        operation_id: &str,
        expected_state: OperationState,
        next_state: OperationState,
        recorded_at_unix_ms: u64,
        evidence_hash: Option<Sha256Digest>,
        reason_code: Option<String>,
        fault: FaultInjectionPointV1,
    ) -> Result<OperationJournalV1, BrokerJournalError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut journal = load_journal_from_connection(&transaction, operation_id)?;
        if journal.current_state != expected_state {
            return Err(BrokerJournalError::StateConflict {
                expected: expected_state,
                observed: journal.current_state,
            });
        }
        let transition = journal
            .transition(next_state, recorded_at_unix_ms, evidence_hash, reason_code)?
            .clone();
        transaction.execute(
            "INSERT INTO operation_transitions (
                operation_id, sequence, from_state, to_state, recorded_at_unix_ms,
                evidence_hash, reason_code
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                operation_id,
                to_i64(transition.sequence)?,
                state_to_db(transition.from),
                state_to_db(transition.to),
                to_i64(transition.recorded_at_unix_ms)?,
                transition.evidence_hash.as_ref().map(Sha256Digest::as_str),
                transition.reason_code,
            ],
        )?;
        if fault == FaultInjectionPointV1::AfterTransitionInsert {
            return Err(BrokerJournalError::InjectedFault(fault));
        }

        let provider_action_may_have_started = journal
            .transitions
            .iter()
            .any(|item| item.to == OperationState::ProcessSpawned);
        let prepared_receipt_hash = if next_state == OperationState::ResultPrepared {
            transition.evidence_hash.as_ref().map(Sha256Digest::as_str)
        } else {
            None
        };
        let updated = transaction.execute(
            "UPDATE operations
             SET current_state = ?1,
                 updated_at_unix_ms = ?2,
                 provider_action_may_have_started = MAX(
                     provider_action_may_have_started, ?3
                 ),
                 prepared_receipt_hash = COALESCE(?4, prepared_receipt_hash)
             WHERE operation_id = ?5 AND current_state = ?6",
            params![
                state_to_db(next_state),
                to_i64(recorded_at_unix_ms)?,
                if provider_action_may_have_started {
                    1_i64
                } else {
                    0_i64
                },
                prepared_receipt_hash,
                operation_id,
                state_to_db(expected_state),
            ],
        )?;
        if updated != 1 {
            return Err(BrokerJournalError::ConcurrentStateChange);
        }
        if fault == FaultInjectionPointV1::AfterProjectionUpdate {
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        transaction.commit()?;
        inspect_database_envelope(&self.path, self.policy)?;
        Ok(journal)
    }

    /// Loads and re-validates one complete append-only operation journal.
    pub fn load_journal(
        &self,
        operation_id: &str,
    ) -> Result<OperationJournalV1, BrokerJournalError> {
        load_journal_from_connection(&self.connection, operation_id)
    }

    /// Runs SQLite integrity checks and validates every journal projection.
    pub fn validate_integrity(&self) -> Result<(), BrokerJournalError> {
        inspect_database_envelope(&self.path, self.policy)?;
        verify_database_contract(&self.connection)?;
        let integrity: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(BrokerJournalError::IntegrityCheckFailed(integrity));
        }
        let mut foreign_keys = self.connection.prepare("PRAGMA foreign_key_check")?;
        let mut foreign_key_rows = foreign_keys.query([])?;
        if foreign_key_rows.next()?.is_some() {
            return Err(BrokerJournalError::ForeignKeyCheckFailed);
        }
        drop(foreign_key_rows);
        drop(foreign_keys);

        let nonce_mismatch_count: i64 = self.connection.query_row(
            "SELECT count(*)
             FROM operations AS operation
             LEFT JOIN capability_nonces AS nonce
               ON nonce.operation_id = operation.operation_id
              AND nonce.nonce = operation.capability_nonce
              AND nonce.signer_key_id = operation.signer_key_id
              AND nonce.consumed_at_unix_ms = operation.created_at_unix_ms
             WHERE nonce.operation_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        let orphan_nonce_count: i64 = self.connection.query_row(
            "SELECT count(*)
             FROM capability_nonces AS nonce
             LEFT JOIN operations AS operation
               ON operation.operation_id = nonce.operation_id
             WHERE operation.operation_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        if nonce_mismatch_count != 0 || orphan_nonce_count != 0 {
            return Err(BrokerJournalError::NonceProjectionMismatch);
        }

        let mut statement = self
            .connection
            .prepare("SELECT operation_id FROM operations ORDER BY operation_id")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for operation_id in ids {
            let journal = self.load_journal(&operation_id)?;
            validate_operation_record(&self.connection, &operation_id)?;
            validate_operation_projection(&self.connection, &journal)?;
        }
        Ok(())
    }

    /// Number of durable operation reservations.
    pub fn operation_count(&self) -> Result<u64, BrokerJournalError> {
        let value: i64 =
            self.connection
                .query_row("SELECT count(*) FROM operations", [], |row| row.get(0))?;
        from_i64(value)
    }
}

#[derive(Debug)]
struct ExistingReservationRow {
    operation_id: String,
    request_hash: String,
    request_payload: Vec<u8>,
    peer_uid: u32,
    peer_gid: u32,
    signer_key_id: String,
    capability_nonce: String,
}

impl ExistingReservationRow {
    fn matches(&self, admitted: &AuthenticatedBrokerRequestV1) -> bool {
        self.operation_id == admitted.request.operation_id
            && self.request_hash == admitted.request_hash.as_str()
            && self.request_payload == admitted.request_payload
            && self.peer_uid == admitted.peer.uid
            && self.peer_gid == admitted.peer.gid
            && self.signer_key_id == admitted.capability.signer_key_id
            && self.capability_nonce == admitted.capability.nonce
    }
}

fn existing_by_idempotency(
    transaction: &Transaction<'_>,
    idempotency_key: &str,
) -> Result<Option<ExistingReservationRow>, BrokerJournalError> {
    let raw = transaction
        .query_row(
            "SELECT operation_id, request_hash, request_payload, peer_uid, peer_gid,
                    signer_key_id, capability_nonce
             FROM operations WHERE idempotency_key = ?1",
            [idempotency_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;
    raw.map(
        |(
            operation_id,
            request_hash,
            request_payload,
            peer_uid,
            peer_gid,
            signer_key_id,
            capability_nonce,
        )| {
            Ok(ExistingReservationRow {
                operation_id,
                request_hash,
                request_payload,
                peer_uid: u32::try_from(peer_uid)
                    .map_err(|_| BrokerJournalError::CorruptDatabaseValue("peer_uid"))?,
                peer_gid: u32::try_from(peer_gid)
                    .map_err(|_| BrokerJournalError::CorruptDatabaseValue("peer_gid"))?,
                signer_key_id,
                capability_nonce,
            })
        },
    )
    .transpose()
}

fn operation_exists(
    transaction: &Transaction<'_>,
    operation_id: &str,
) -> Result<bool, BrokerJournalError> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM operations WHERE operation_id = ?1",
            [operation_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn nonce_exists(transaction: &Transaction<'_>, nonce: &str) -> Result<bool, BrokerJournalError> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM capability_nonces WHERE nonce = ?1",
            [nonce],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn load_journal_from_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<OperationJournalV1, BrokerJournalError> {
    let raw = connection
        .query_row(
            "SELECT request_hash, current_state FROM operations WHERE operation_id = ?1",
            [operation_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| BrokerJournalError::OperationNotFound(operation_id.to_owned()))?;
    let request_hash = Sha256Digest::from_str(&raw.0)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("request_hash"))?;
    let current_state = state_from_db(&raw.1)?;

    let mut statement = connection.prepare(
        "SELECT sequence, from_state, to_state, recorded_at_unix_ms,
                evidence_hash, reason_code
         FROM operation_transitions
         WHERE operation_id = ?1 ORDER BY sequence",
    )?;
    let rows = statement.query_map([operation_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    let mut transitions = Vec::new();
    for row in rows {
        let (sequence, from, to, recorded, evidence, reason) = row?;
        transitions.push(JournalTransitionV1 {
            sequence: from_i64(sequence)?,
            from: state_from_db(&from)?,
            to: state_from_db(&to)?,
            recorded_at_unix_ms: from_i64(recorded)?,
            evidence_hash: evidence
                .map(|value| {
                    Sha256Digest::from_str(&value)
                        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("evidence_hash"))
                })
                .transpose()?,
            reason_code: reason,
        });
    }
    let journal = OperationJournalV1 {
        version: 1,
        operation_id: operation_id.to_owned(),
        request_hash,
        current_state,
        transitions,
    };
    journal.validate()?;
    Ok(journal)
}

fn validate_operation_record(
    connection: &Connection,
    operation_id: &str,
) -> Result<(), BrokerJournalError> {
    let row = connection.query_row(
        "SELECT operation.request_hash, operation.idempotency_key,
                operation.request_payload, operation.peer_pid, operation.peer_uid,
                operation.peer_gid, operation.signer_key_id,
                operation.capability_nonce, operation.capability_message_hash,
                operation.created_at_unix_ms, operation.updated_at_unix_ms,
                nonce.consumed_at_unix_ms
         FROM operations AS operation
         JOIN capability_nonces AS nonce ON nonce.operation_id = operation.operation_id
         WHERE operation.operation_id = ?1",
        [operation_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, i64>(11)?,
            ))
        },
    )?;
    let request: CodexExecutionRequestV1 = serde_json::from_slice(&row.2)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("request_payload"))?;
    request
        .validate()
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("request_payload"))?;
    let expected_request_hash = sha256_digest(&row.2)?;
    let capability_message = crate::capability_signing_bytes(&request)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("capability_message"))?;
    let expected_capability_hash = sha256_digest(&capability_message)?;
    let peer_uid =
        u32::try_from(row.4).map_err(|_| BrokerJournalError::CorruptDatabaseValue("peer_uid"))?;
    let peer_gid =
        u32::try_from(row.5).map_err(|_| BrokerJournalError::CorruptDatabaseValue("peer_gid"))?;
    if row.3 <= 0
        || request.operation_id != operation_id
        || request.idempotency_key.as_str() != row.1
        || expected_request_hash.as_str() != row.0
        || request.request_capability.peer_uid != peer_uid
        || request.request_capability.peer_gid != peer_gid
        || request.request_capability.signer_key_id != row.6
        || request.request_capability.nonce != row.7
        || expected_capability_hash.as_str() != row.8
        || row.9 <= 0
        || row.10 < row.9
        || row.11 != row.9
        || u64::try_from(row.9).ok().is_none_or(|created_at| {
            created_at >= request.request_capability.expires_at_unix_ms
                || created_at >= request.absolute_deadline_unix_ms
        })
    {
        return Err(BrokerJournalError::OperationRecordMismatch);
    }
    Ok(())
}

fn validate_operation_projection(
    connection: &Connection,
    journal: &OperationJournalV1,
) -> Result<(), BrokerJournalError> {
    let (provider_started, prepared_hash, created_at, updated_at): (i64, Option<String>, i64, i64) =
        connection.query_row(
            "SELECT provider_action_may_have_started, prepared_receipt_hash,
                created_at_unix_ms, updated_at_unix_ms
         FROM operations WHERE operation_id = ?1",
            [&journal.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let expected_provider_started = journal
        .transitions
        .iter()
        .any(|transition| transition.to == OperationState::ProcessSpawned);
    if (provider_started == 1) != expected_provider_started {
        return Err(BrokerJournalError::ProviderProjectionMismatch);
    }
    let expected_prepared = journal
        .transitions
        .iter()
        .find(|transition| transition.to == OperationState::ResultPrepared)
        .and_then(|transition| transition.evidence_hash.as_ref())
        .map(Sha256Digest::as_str);
    if prepared_hash.as_deref() != expected_prepared {
        return Err(BrokerJournalError::PreparedReceiptProjectionMismatch);
    }
    let expected_updated_at = journal
        .transitions
        .last()
        .map(|transition| transition.recorded_at_unix_ms)
        .unwrap_or_else(|| u64::try_from(created_at).unwrap_or(0));
    if u64::try_from(updated_at).ok() != Some(expected_updated_at) {
        return Err(BrokerJournalError::UpdatedAtProjectionMismatch);
    }
    Ok(())
}

fn validate_authenticated_request(
    admitted: &AuthenticatedBrokerRequestV1,
) -> Result<(), BrokerJournalError> {
    if admitted.request_payload.is_empty()
        || admitted.request_payload.len() > HARD_MAXIMUM_REQUEST_BYTES
    {
        return Err(BrokerJournalError::InvalidAuthenticatedRequest);
    }
    admitted
        .request
        .validate()
        .map_err(|_| BrokerJournalError::InvalidAuthenticatedRequest)?;
    let decoded: CodexExecutionRequestV1 = serde_json::from_slice(&admitted.request_payload)
        .map_err(|_| BrokerJournalError::InvalidAuthenticatedRequest)?;
    let canonical_payload = serde_json::to_vec(&decoded)
        .map_err(|_| BrokerJournalError::InvalidAuthenticatedRequest)?;
    let signing_message = crate::capability_signing_bytes(&decoded)
        .map_err(|_| BrokerJournalError::InvalidAuthenticatedRequest)?;
    if decoded != admitted.request || canonical_payload != admitted.request_payload {
        return Err(BrokerJournalError::InvalidAuthenticatedRequest);
    }
    if sha256_digest(&admitted.request_payload)? != admitted.request_hash
        || sha256_digest(&signing_message)? != admitted.capability.signing_message_hash
        || admitted.request.request_capability.nonce != admitted.capability.nonce
        || admitted.request.request_capability.signer_key_id != admitted.capability.signer_key_id
        || admitted.request.request_capability.peer_uid != admitted.peer.uid
        || admitted.request.request_capability.peer_gid != admitted.peer.gid
        || admitted.capability.peer_uid != admitted.peer.uid
        || admitted.capability.peer_gid != admitted.peer.gid
    {
        return Err(BrokerJournalError::InvalidAuthenticatedRequest);
    }
    Ok(())
}

/// Filesystem, transaction, idempotency, replay, or durable-integrity failure.
#[derive(Debug, Error)]
pub enum BrokerJournalError {
    #[error("broker journal policy is invalid")]
    InvalidPolicy,
    #[error("broker journal database path is invalid")]
    DatabasePathInvalid,
    #[error("broker journal database path is noncanonical")]
    DatabasePathNonCanonical,
    #[error("broker journal parent directory is invalid")]
    DatabaseParentInvalid,
    #[error("broker journal parent permissions are invalid: {0:o}")]
    DatabaseParentPermissionsInvalid(u32),
    #[error("broker journal database file is invalid")]
    DatabaseFileInvalid,
    #[error("broker journal initialization marker is invalid")]
    InitializationMarkerInvalid,
    #[error("initializing broker database contains an unstamped foreign schema")]
    InitializationCandidateForeignSchema,
    #[error("broker journal database permissions are invalid: {0:o}")]
    DatabaseFilePermissionsInvalid(u32),
    #[error("broker journal database link count is invalid: {0}")]
    DatabaseFileLinkCountInvalid(u64),
    #[error("broker journal database is too large: observed {observed}, maximum {maximum}")]
    DatabaseFileTooLarge { observed: u64, maximum: u64 },
    #[error("broker journal sidecar is invalid: {0}")]
    DatabaseSidecarInvalid(String),
    #[error("broker journal sidecar permissions are invalid for {suffix}: {mode:o}")]
    DatabaseSidecarPermissionsInvalid { suffix: String, mode: u32 },
    #[error("broker journal sidecar link count is invalid for {suffix}: {link_count}")]
    DatabaseSidecarLinkCountInvalid { suffix: String, link_count: u64 },
    #[error(
        "broker journal sidecar is too large for {suffix}: observed {observed}, maximum {maximum}"
    )]
    DatabaseSidecarTooLarge {
        suffix: String,
        observed: u64,
        maximum: u64,
    },
    #[error("filesystem owner mismatch for {subject}")]
    OwnerMismatch {
        subject: &'static str,
        expected_uid: u32,
        observed_uid: u32,
        expected_gid: Option<u32>,
        observed_gid: u32,
    },
    #[error("filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error(
        "broker journal database identity is invalid: application_id={application_id}, user_version={user_version}"
    )]
    DatabaseIdentityMismatch {
        application_id: i64,
        user_version: i64,
    },
    #[error("broker journal connection pragmas are not fail-closed")]
    ConnectionPragmaMismatch,
    #[error("unsupported broker journal schema version: {0}")]
    UnsupportedSchemaVersion(String),
    #[error("broker metadata manifest differs from the qualified schema version")]
    BrokerMetadataMismatch,
    #[error("broker journal schema objects differ from the qualified manifest")]
    SchemaObjectMismatch {
        expected: Vec<(String, String)>,
        observed: Vec<(String, String)>,
    },
    #[error("broker journal table is not STRICT: {0}")]
    TableNotStrict(&'static str),
    #[error("authenticated broker request is internally inconsistent")]
    InvalidAuthenticatedRequest,
    #[error("broker operation recorded time is invalid")]
    InvalidRecordedTime,
    #[error("authenticated broker request expired before durable reservation")]
    AuthenticatedRequestExpired,
    #[error("idempotency key is already bound to different request evidence")]
    IdempotencyConflict,
    #[error("operation id is already bound to a different reservation")]
    OperationIdentityConflict,
    #[error("capability nonce was already consumed")]
    CapabilityNonceReplay,
    #[error("operation was not found: {0}")]
    OperationNotFound(String),
    #[error("state compare-and-swap conflict: expected {expected:?}, observed {observed:?}")]
    StateConflict {
        expected: OperationState,
        observed: OperationState,
    },
    #[error("operation state changed concurrently")]
    ConcurrentStateChange,
    #[error("injected transactional fault: {0:?}")]
    InjectedFault(FaultInjectionPointV1),
    #[error("broker journal integrity check failed: {0}")]
    IntegrityCheckFailed(String),
    #[error("broker journal foreign-key check failed")]
    ForeignKeyCheckFailed,
    #[error("operation and nonce projections differ")]
    NonceProjectionMismatch,
    #[error("operation immutable record does not match its request evidence")]
    OperationRecordMismatch,
    #[error("provider-action projection differs from append-only transitions")]
    ProviderProjectionMismatch,
    #[error("prepared-receipt projection differs from append-only transitions")]
    PreparedReceiptProjectionMismatch,
    #[error("operation updated-at projection differs from append-only transitions")]
    UpdatedAtProjectionMismatch,
    #[error("database value is corrupt: {0}")]
    CorruptDatabaseValue(&'static str),
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("failed to construct broker journal digest")]
    DigestConstruction,
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}
