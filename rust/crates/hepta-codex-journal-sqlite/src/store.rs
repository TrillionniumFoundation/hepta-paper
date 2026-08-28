use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use hepta_codex_broker_protocol::{PeerCredentialsV1, VerifiedBrokerRequestV1};
use hepta_codex_journal::{
    JournalTransitionV1, OperationJournalV1, OperationState,
};
use hepta_codex_protocol::{AgentRole, CodexExecutionRequestV1, Sha256Digest};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
    params,
};
use sha2::{Digest, Sha256};

use crate::{
    schema::{SCHEMA_SQL, SCHEMA_VERSION},
    types::{
        JournalFaultPointV1, JournalIntegrityReportV1, JournalPathPolicyV1,
        JournalStoreError, OperationRecordV1, ReservationOutcomeV1,
    },
};

/// Single-writer broker-owned operation journal.
pub struct BrokerJournalStoreV1 {
    connection: Connection,
    database_path: PathBuf,
}

impl BrokerJournalStoreV1 {
    /// Opens or creates a private SQLite journal and verifies its schema.
    pub fn open(
        database_path: impl AsRef<Path>,
        policy: JournalPathPolicyV1,
    ) -> Result<Self, JournalStoreError> {
        let policy = policy.validate()?;
        let database_path = validate_database_parent(database_path.as_ref(), policy)?;
        let existed = database_path.exists();
        if existed {
            validate_database_file(&database_path, policy)?;
        }
        let connection = Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        if !existed {
            fs::set_permissions(&database_path, fs::Permissions::from_mode(0o600))
                .map_err(|error| JournalStoreError::Filesystem("database_permissions", error.kind()))?;
        }
        validate_database_file(&database_path, policy)?;
        connection.busy_timeout(Duration::from_millis(policy.busy_timeout_ms))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA trusted_schema=OFF;
             PRAGMA temp_store=MEMORY;
             PRAGMA wal_autocheckpoint=1000;",
        )?;
        let user_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if !matches!(user_version, 0 | SCHEMA_VERSION) {
            return Err(JournalStoreError::UnsupportedSchemaVersion(user_version));
        }
        connection.execute_batch(SCHEMA_SQL)?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        let stored_schema: i64 = connection.query_row(
            "SELECT CAST(value AS INTEGER) FROM broker_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )?;
        if stored_schema != SCHEMA_VERSION {
            return Err(JournalStoreError::UnsupportedSchemaVersion(stored_schema));
        }
        let store = Self {
            connection,
            database_path,
        };
        store.verify_integrity()?;
        Ok(store)
    }

    #[must_use]
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Durably reserves one verified request. Exact duplicate admission is idempotent.
    pub fn reserve_verified_request(
        &mut self,
        verified: &VerifiedBrokerRequestV1,
        admitted_at_unix_ms: u64,
    ) -> Result<ReservationOutcomeV1, JournalStoreError> {
        self.reserve_with_injector(verified, admitted_at_unix_ms, &NoFault)
    }

    /// Appends one legal operation transition and atomically advances current state.
    pub fn append_transition(
        &mut self,
        operation_id: &str,
        to: OperationState,
        recorded_at_unix_ms: u64,
        evidence_hash: Option<Sha256Digest>,
        reason_code: Option<String>,
    ) -> Result<OperationRecordV1, JournalStoreError> {
        self.append_with_injector(
            operation_id,
            to,
            recorded_at_unix_ms,
            evidence_hash,
            reason_code,
            &NoFault,
        )
    }

    pub fn load_operation(
        &self,
        operation_id: &str,
    ) -> Result<OperationRecordV1, JournalStoreError> {
        query_operation(&self.connection, operation_id)?
            .ok_or_else(|| JournalStoreError::OperationNotFound(operation_id.to_owned()))
    }

    pub fn load_journal(
        &self,
        operation_id: &str,
    ) -> Result<OperationJournalV1, JournalStoreError> {
        load_journal_from_connection(&self.connection, operation_id)
    }

    /// Runs SQLite and application-level integrity verification.
    pub fn verify_integrity(&self) -> Result<JournalIntegrityReportV1, JournalStoreError> {
        let mut integrity = self.connection.prepare("PRAGMA integrity_check")?;
        let messages = integrity
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if messages.as_slice() != ["ok"] {
            return Err(JournalStoreError::IntegrityCheckFailed(messages.join("; ")));
        }

        let mut foreign_keys = self.connection.prepare("PRAGMA foreign_key_check")?;
        if foreign_keys.query([])?.next()?.is_some() {
            return Err(JournalStoreError::ForeignKeyViolation);
        }

        let operation_count = nonnegative_i64_to_u64(
            self.connection
                .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))?,
            "operation_count",
        )?;
        let transition_count = nonnegative_i64_to_u64(
            self.connection.query_row(
                "SELECT COUNT(*) FROM operation_transitions",
                [],
                |row| row.get(0),
            )?,
            "transition_count",
        )?;
        let mut statement = self
            .connection
            .prepare("SELECT operation_id FROM operations ORDER BY operation_id")?;
        let operation_ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for operation_id in operation_ids {
            verify_operation_integrity(&self.connection, &operation_id)?;
        }
        Ok(JournalIntegrityReportV1 {
            operation_count,
            transition_count,
        })
    }

    fn reserve_with_injector<I: FaultInjector>(
        &mut self,
        verified: &VerifiedBrokerRequestV1,
        admitted_at_unix_ms: u64,
        injector: &I,
    ) -> Result<ReservationOutcomeV1, JournalStoreError> {
        validate_verified_request(verified, admitted_at_unix_ms)?;
        let request = &verified.request;
        let capability = &request.request_capability;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing_id) = transaction
            .query_row(
                "SELECT operation_id FROM operations WHERE idempotency_key=?1",
                [request.idempotency_key.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            let existing = query_operation(&transaction, &existing_id)?
                .ok_or_else(|| JournalStoreError::OperationNotFound(existing_id.clone()))?;
            if existing.operation_id == request.operation_id
                && existing.request_hash == verified.payload_hash
                && existing.signer_key_id == capability.signer_key_id
                && existing.nonce == capability.nonce
                && existing.peer == verified.peer
                && existing.request_payload == verified.payload
            {
                transaction.commit()?;
                return Ok(ReservationOutcomeV1::Existing(existing));
            }
            return Err(JournalStoreError::IdempotencyConflict);
        }

        let nonce_owner = transaction
            .query_row(
                "SELECT operation_id FROM operations
                 WHERE signer_key_id=?1 AND nonce=?2",
                params![capability.signer_key_id, capability.nonce],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if nonce_owner.is_some() {
            return Err(JournalStoreError::NonceReplay);
        }

        transaction.execute(
            "INSERT INTO operations(
               operation_id, request_hash, idempotency_key, signer_key_id, nonce,
               peer_pid, peer_uid, peer_gid, role, current_state,
               created_at_unix_ms, updated_at_unix_ms,
               provider_action_may_have_started, prepared_receipt_hash, request_payload
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'reserved',
               ?10, ?10, 0, NULL, ?11
             )",
            params![
                request.operation_id,
                verified.payload_hash.as_str(),
                request.idempotency_key.as_str(),
                capability.signer_key_id,
                capability.nonce,
                i64::from(verified.peer.pid),
                i64::from(verified.peer.uid),
                i64::from(verified.peer.gid),
                role_name(request.role),
                u64_to_i64(admitted_at_unix_ms, "admitted_at_unix_ms")?,
                verified.payload,
            ],
        )?;
        injector.hit(JournalFaultPointV1::AfterOperationInsert)?;
        transaction.commit()?;
        Ok(ReservationOutcomeV1::Reserved(
            self.load_operation(&request.operation_id)?,
        ))
    }

    fn append_with_injector<I: FaultInjector>(
        &mut self,
        operation_id: &str,
        to: OperationState,
        recorded_at_unix_ms: u64,
        evidence_hash: Option<Sha256Digest>,
        reason_code: Option<String>,
        injector: &I,
    ) -> Result<OperationRecordV1, JournalStoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = query_operation(&transaction, operation_id)?
            .ok_or_else(|| JournalStoreError::OperationNotFound(operation_id.to_owned()))?;
        let mut journal = load_journal_from_connection(&transaction, operation_id)?;
        let from = journal.current_state;
        journal
            .transition(
                to,
                recorded_at_unix_ms,
                evidence_hash.clone(),
                reason_code.clone(),
            )
            .map_err(|error| JournalStoreError::InvalidStoredJournal(error.to_string()))?;
        let transition = journal
            .transitions
            .last()
            .cloned()
            .ok_or_else(|| JournalStoreError::InvalidStoredJournal("transition missing".into()))?;

        transaction.execute(
            "INSERT INTO operation_transitions(
               operation_id, sequence, from_state, to_state, recorded_at_unix_ms,
               evidence_hash, reason_code
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                operation_id,
                u64_to_i64(transition.sequence, "transition.sequence")?,
                state_name(transition.from),
                state_name(transition.to),
                u64_to_i64(transition.recorded_at_unix_ms, "transition.recorded_at")?,
                transition.evidence_hash.as_ref().map(Sha256Digest::as_str),
                transition.reason_code,
            ],
        )?;
        injector.hit(JournalFaultPointV1::AfterTransitionInsert)?;

        let provider_action = existing.provider_action_may_have_started
            || state_implies_provider_action(to);
        let prepared_receipt = if to == OperationState::ResultPrepared {
            evidence_hash.as_ref().map(Sha256Digest::as_str)
        } else {
            existing.prepared_receipt_hash.as_ref().map(Sha256Digest::as_str)
        };
        let changed = transaction.execute(
            "UPDATE operations
             SET current_state=?1,
                 updated_at_unix_ms=?2,
                 provider_action_may_have_started=?3,
                 prepared_receipt_hash=?4
             WHERE operation_id=?5 AND current_state=?6",
            params![
                state_name(to),
                u64_to_i64(recorded_at_unix_ms, "recorded_at_unix_ms")?,
                i64::from(provider_action),
                prepared_receipt,
                operation_id,
                state_name(from),
            ],
        )?;
        if changed != 1 {
            return Err(JournalStoreError::StateCompareAndSwapFailed);
        }
        injector.hit(JournalFaultPointV1::AfterStateUpdate)?;
        transaction.commit()?;
        self.load_operation(operation_id)
    }

    #[cfg(test)]
    pub(crate) fn reserve_with_fault(
        &mut self,
        verified: &VerifiedBrokerRequestV1,
        admitted_at_unix_ms: u64,
        point: JournalFaultPointV1,
    ) -> Result<ReservationOutcomeV1, JournalStoreError> {
        self.reserve_with_injector(
            verified,
            admitted_at_unix_ms,
            &SingleFault { point },
        )
    }

    #[cfg(test)]
    pub(crate) fn append_with_fault(
        &mut self,
        operation_id: &str,
        to: OperationState,
        recorded_at_unix_ms: u64,
        evidence_hash: Option<Sha256Digest>,
        reason_code: Option<String>,
        point: JournalFaultPointV1,
    ) -> Result<OperationRecordV1, JournalStoreError> {
        self.append_with_injector(
            operation_id,
            to,
            recorded_at_unix_ms,
            evidence_hash,
            reason_code,
            &SingleFault { point },
        )
    }
}

trait FaultInjector {
    fn hit(&self, point: JournalFaultPointV1) -> Result<(), JournalStoreError>;
}

struct NoFault;

impl FaultInjector for NoFault {
    fn hit(&self, _point: JournalFaultPointV1) -> Result<(), JournalStoreError> {
        Ok(())
    }
}

#[cfg(test)]
struct SingleFault {
    point: JournalFaultPointV1,
}

#[cfg(test)]
impl FaultInjector for SingleFault {
    fn hit(&self, point: JournalFaultPointV1) -> Result<(), JournalStoreError> {
        if self.point == point {
            Err(JournalStoreError::InjectedFault(point))
        } else {
            Ok(())
        }
    }
}

fn validate_verified_request(
    verified: &VerifiedBrokerRequestV1,
    admitted_at_unix_ms: u64,
) -> Result<(), JournalStoreError> {
    if admitted_at_unix_ms == 0
        || admitted_at_unix_ms < verified.request.request_capability.issued_at_unix_ms
        || admitted_at_unix_ms >= verified.request.request_capability.expires_at_unix_ms
        || admitted_at_unix_ms > verified.request.absolute_deadline_unix_ms
    {
        return Err(JournalStoreError::InvalidAdmissionTime);
    }
    let decoded: CodexExecutionRequestV1 = serde_json::from_slice(&verified.payload)
        .map_err(|error| JournalStoreError::InvalidStoredRequest(error.to_string()))?;
    decoded
        .validate()
        .map_err(|error| JournalStoreError::InvalidStoredRequest(error.to_string()))?;
    if decoded != verified.request {
        return Err(JournalStoreError::VerifiedPayloadMismatch);
    }
    if digest_bytes(&verified.payload)? != verified.payload_hash {
        return Err(JournalStoreError::VerifiedPayloadHashMismatch);
    }
    let capability = &verified.request.request_capability;
    if capability.peer_pid != verified.peer.pid
        || capability.peer_uid != verified.peer.uid
        || capability.peer_gid != verified.peer.gid
    {
        return Err(JournalStoreError::OperationIdentityMismatch("peer"));
    }
    Ok(())
}

fn query_operation(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<OperationRecordV1>, JournalStoreError> {
    let raw = connection
        .query_row(
            "SELECT operation_id, request_hash, idempotency_key, signer_key_id, nonce,
                    peer_pid, peer_uid, peer_gid, role, current_state,
                    created_at_unix_ms, updated_at_unix_ms,
                    provider_action_may_have_started, prepared_receipt_hash, request_payload
             FROM operations WHERE operation_id=?1",
            [operation_id],
            |row| {
                Ok(RawOperationRow {
                    operation_id: row.get(0)?,
                    request_hash: row.get(1)?,
                    idempotency_key: row.get(2)?,
                    signer_key_id: row.get(3)?,
                    nonce: row.get(4)?,
                    peer_pid: row.get(5)?,
                    peer_uid: row.get(6)?,
                    peer_gid: row.get(7)?,
                    role: row.get(8)?,
                    current_state: row.get(9)?,
                    created_at_unix_ms: row.get(10)?,
                    updated_at_unix_ms: row.get(11)?,
                    provider_action_may_have_started: row.get(12)?,
                    prepared_receipt_hash: row.get(13)?,
                    request_payload: row.get(14)?,
                })
            },
        )
        .optional()?;
    raw.map(OperationRecordV1::try_from).transpose()
}

fn load_journal_from_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<OperationJournalV1, JournalStoreError> {
    let operation = query_operation(connection, operation_id)?
        .ok_or_else(|| JournalStoreError::OperationNotFound(operation_id.to_owned()))?;
    let mut statement = connection.prepare(
        "SELECT sequence, from_state, to_state, recorded_at_unix_ms,
                evidence_hash, reason_code
         FROM operation_transitions
         WHERE operation_id=?1 ORDER BY sequence",
    )?;
    let raw = statement
        .query_map([operation_id], |row| {
            Ok(RawTransitionRow {
                sequence: row.get(0)?,
                from_state: row.get(1)?,
                to_state: row.get(2)?,
                recorded_at_unix_ms: row.get(3)?,
                evidence_hash: row.get(4)?,
                reason_code: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let transitions = raw
        .into_iter()
        .map(JournalTransitionV1::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    let journal = OperationJournalV1 {
        version: 1,
        operation_id: operation.operation_id,
        request_hash: operation.request_hash,
        current_state: operation.current_state,
        transitions,
    };
    journal
        .validate()
        .map_err(|error| JournalStoreError::InvalidStoredJournal(error.to_string()))?;
    Ok(journal)
}

fn verify_operation_integrity(
    connection: &Connection,
    operation_id: &str,
) -> Result<(), JournalStoreError> {
    let operation = query_operation(connection, operation_id)?
        .ok_or_else(|| JournalStoreError::OperationNotFound(operation_id.to_owned()))?;
    let journal = load_journal_from_connection(connection, operation_id)?;
    let request: CodexExecutionRequestV1 = serde_json::from_slice(&operation.request_payload)
        .map_err(|error| JournalStoreError::InvalidStoredRequest(error.to_string()))?;
    request
        .validate()
        .map_err(|error| JournalStoreError::InvalidStoredRequest(error.to_string()))?;
    if digest_bytes(&operation.request_payload)? != operation.request_hash {
        return Err(JournalStoreError::OperationIdentityMismatch("request_hash"));
    }
    if request.operation_id != operation.operation_id {
        return Err(JournalStoreError::OperationIdentityMismatch("operation_id"));
    }
    if request.idempotency_key != operation.idempotency_key {
        return Err(JournalStoreError::OperationIdentityMismatch("idempotency_key"));
    }
    if request.request_capability.signer_key_id != operation.signer_key_id {
        return Err(JournalStoreError::OperationIdentityMismatch("signer_key_id"));
    }
    if request.request_capability.nonce != operation.nonce {
        return Err(JournalStoreError::OperationIdentityMismatch("nonce"));
    }
    if request.request_capability.peer_pid != operation.peer.pid
        || request.request_capability.peer_uid != operation.peer.uid
        || request.request_capability.peer_gid != operation.peer.gid
    {
        return Err(JournalStoreError::OperationIdentityMismatch("peer"));
    }
    if request.role != operation.role {
        return Err(JournalStoreError::OperationIdentityMismatch("role"));
    }

    let provider_action = journal
        .transitions
        .iter()
        .any(|transition| state_implies_provider_action(transition.to));
    if provider_action != operation.provider_action_may_have_started {
        return Err(JournalStoreError::ProviderActionMarkerMismatch);
    }
    let prepared = journal
        .transitions
        .iter()
        .find(|transition| transition.to == OperationState::ResultPrepared)
        .and_then(|transition| transition.evidence_hash.clone());
    if prepared != operation.prepared_receipt_hash {
        return Err(JournalStoreError::PreparedReceiptMarkerMismatch);
    }
    Ok(())
}

fn validate_database_parent(
    path: &Path,
    policy: JournalPathPolicyV1,
) -> Result<PathBuf, JournalStoreError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(JournalStoreError::InvalidDatabasePath);
    }
    let parent = path.parent().ok_or(JournalStoreError::InvalidDatabasePath)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| JournalStoreError::Filesystem("journal_parent", error.kind()))?;
    if canonical_parent != parent {
        return Err(JournalStoreError::ParentDirectoryNonCanonical);
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| JournalStoreError::Filesystem("journal_parent", error.kind()))?;
    let mode = metadata.permissions().mode() & 0o7777;
    if !metadata.file_type().is_dir() || mode & 0o077 != 0 {
        return Err(JournalStoreError::ParentDirectoryNotPrivate);
    }
    validate_owner("journal_parent", &metadata, policy)?;
    Ok(parent.join(
        path.file_name()
            .ok_or(JournalStoreError::InvalidDatabasePath)?,
    ))
}

fn validate_database_file(
    path: &Path,
    policy: JournalPathPolicyV1,
) -> Result<(), JournalStoreError> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| JournalStoreError::Filesystem("journal_database", error.kind()))?;
    if canonical != path {
        return Err(JournalStoreError::DatabaseFileNotPrivate);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| JournalStoreError::Filesystem("journal_database", error.kind()))?;
    let mode = metadata.permissions().mode() & 0o7777;
    if !metadata.file_type().is_file() || metadata.nlink() != 1 || mode & 0o077 != 0 {
        return Err(JournalStoreError::DatabaseFileNotPrivate);
    }
    validate_owner("journal_database", &metadata, policy)
}

fn validate_owner(
    subject: &'static str,
    metadata: &fs::Metadata,
    policy: JournalPathPolicyV1,
) -> Result<(), JournalStoreError> {
    if metadata.uid() != policy.owner_uid
        || policy
            .owner_gid
            .is_some_and(|expected| metadata.gid() != expected)
    {
        return Err(JournalStoreError::OwnerMismatch {
            subject,
            expected_uid: policy.owner_uid,
            observed_uid: metadata.uid(),
            expected_gid: policy.owner_gid,
            observed_gid: metadata.gid(),
        });
    }
    Ok(())
}

fn digest_bytes(bytes: &[u8]) -> Result<Sha256Digest, JournalStoreError> {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(digest)))
        .map_err(|_| JournalStoreError::InvalidStoredDigest("constructed digest".into()))
}

fn state_name(state: OperationState) -> &'static str {
    match state {
        OperationState::Reserved => "reserved",
        OperationState::RequestBound => "request_bound",
        OperationState::ProcessSpawned => "process_spawned",
        OperationState::EventStreamStarted => "event_stream_started",
        OperationState::TerminalEventObserved => "terminal_event_observed",
        OperationState::FinalOutputCaptured => "final_output_captured",
        OperationState::SchemaValidated => "schema_validated",
        OperationState::WorkspaceSnapshotted => "workspace_snapshotted",
        OperationState::MutationValidated => "mutation_validated",
        OperationState::ResultPrepared => "result_prepared",
        OperationState::Acknowledged => "acknowledged",
        OperationState::RejectedPreflight => "rejected_preflight",
        OperationState::FailedBeforeSpawn => "failed_before_spawn",
        OperationState::CancelledBeforeSpawn => "cancelled_before_spawn",
        OperationState::FailedAfterSpawn => "failed_after_spawn",
        OperationState::TimedOutAfterSpawn => "timed_out_after_spawn",
        OperationState::TerminalFailure => "terminal_failure",
        OperationState::EventStreamInvalid => "event_stream_invalid",
        OperationState::OutputSchemaInvalid => "output_schema_invalid",
        OperationState::MutationPolicyViolated => "mutation_policy_violated",
        OperationState::ResultAmbiguous => "result_ambiguous",
    }
}

fn parse_state(value: String) -> Result<OperationState, JournalStoreError> {
    match value.as_str() {
        "reserved" => Ok(OperationState::Reserved),
        "request_bound" => Ok(OperationState::RequestBound),
        "process_spawned" => Ok(OperationState::ProcessSpawned),
        "event_stream_started" => Ok(OperationState::EventStreamStarted),
        "terminal_event_observed" => Ok(OperationState::TerminalEventObserved),
        "final_output_captured" => Ok(OperationState::FinalOutputCaptured),
        "schema_validated" => Ok(OperationState::SchemaValidated),
        "workspace_snapshotted" => Ok(OperationState::WorkspaceSnapshotted),
        "mutation_validated" => Ok(OperationState::MutationValidated),
        "result_prepared" => Ok(OperationState::ResultPrepared),
        "acknowledged" => Ok(OperationState::Acknowledged),
        "rejected_preflight" => Ok(OperationState::RejectedPreflight),
        "failed_before_spawn" => Ok(OperationState::FailedBeforeSpawn),
        "cancelled_before_spawn" => Ok(OperationState::CancelledBeforeSpawn),
        "failed_after_spawn" => Ok(OperationState::FailedAfterSpawn),
        "timed_out_after_spawn" => Ok(OperationState::TimedOutAfterSpawn),
        "terminal_failure" => Ok(OperationState::TerminalFailure),
        "event_stream_invalid" => Ok(OperationState::EventStreamInvalid),
        "output_schema_invalid" => Ok(OperationState::OutputSchemaInvalid),
        "mutation_policy_violated" => Ok(OperationState::MutationPolicyViolated),
        "result_ambiguous" => Ok(OperationState::ResultAmbiguous),
        _ => Err(JournalStoreError::InvalidStoredState(value)),
    }
}

fn role_name(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Author => "author",
        AgentRole::Reviewer => "reviewer",
        AgentRole::FormalReviewer => "formal_reviewer",
        AgentRole::Repairer => "repairer",
    }
}

fn parse_role(value: String) -> Result<AgentRole, JournalStoreError> {
    match value.as_str() {
        "author" => Ok(AgentRole::Author),
        "reviewer" => Ok(AgentRole::Reviewer),
        "formal_reviewer" => Ok(AgentRole::FormalReviewer),
        "repairer" => Ok(AgentRole::Repairer),
        _ => Err(JournalStoreError::InvalidStoredRole(value)),
    }
}

fn state_implies_provider_action(state: OperationState) -> bool {
    !matches!(
        state,
        OperationState::Reserved
            | OperationState::RequestBound
            | OperationState::RejectedPreflight
            | OperationState::FailedBeforeSpawn
            | OperationState::CancelledBeforeSpawn
    )
}

fn u64_to_i64(value: u64, field: &'static str) -> Result<i64, JournalStoreError> {
    i64::try_from(value).map_err(|_| JournalStoreError::InvalidStoredInteger(field))
}

fn nonnegative_i64_to_u64(
    value: i64,
    field: &'static str,
) -> Result<u64, JournalStoreError> {
    u64::try_from(value).map_err(|_| JournalStoreError::InvalidStoredInteger(field))
}

fn nonnegative_i64_to_u32(
    value: i64,
    field: &'static str,
) -> Result<u32, JournalStoreError> {
    u32::try_from(value).map_err(|_| JournalStoreError::InvalidStoredInteger(field))
}

struct RawOperationRow {
    operation_id: String,
    request_hash: String,
    idempotency_key: String,
    signer_key_id: String,
    nonce: String,
    peer_pid: i64,
    peer_uid: i64,
    peer_gid: i64,
    role: String,
    current_state: String,
    created_at_unix_ms: i64,
    updated_at_unix_ms: i64,
    provider_action_may_have_started: i64,
    prepared_receipt_hash: Option<String>,
    request_payload: Vec<u8>,
}

impl TryFrom<RawOperationRow> for OperationRecordV1 {
    type Error = JournalStoreError;

    fn try_from(value: RawOperationRow) -> Result<Self, Self::Error> {
        Ok(Self {
            operation_id: value.operation_id,
            request_hash: parse_digest(value.request_hash)?,
            idempotency_key: parse_digest(value.idempotency_key)?,
            signer_key_id: value.signer_key_id,
            nonce: value.nonce,
            peer: PeerCredentialsV1 {
                pid: nonnegative_i64_to_u32(value.peer_pid, "peer_pid")?,
                uid: nonnegative_i64_to_u32(value.peer_uid, "peer_uid")?,
                gid: nonnegative_i64_to_u32(value.peer_gid, "peer_gid")?,
            },
            role: parse_role(value.role)?,
            current_state: parse_state(value.current_state)?,
            created_at_unix_ms: nonnegative_i64_to_u64(
                value.created_at_unix_ms,
                "created_at_unix_ms",
            )?,
            updated_at_unix_ms: nonnegative_i64_to_u64(
                value.updated_at_unix_ms,
                "updated_at_unix_ms",
            )?,
            provider_action_may_have_started: match value.provider_action_may_have_started {
                0 => false,
                1 => true,
                _ => {
                    return Err(JournalStoreError::InvalidStoredInteger(
                        "provider_action_may_have_started",
                    ));
                }
            },
            prepared_receipt_hash: value
                .prepared_receipt_hash
                .map(parse_digest)
                .transpose()?,
            request_payload: value.request_payload,
        })
    }
}

struct RawTransitionRow {
    sequence: i64,
    from_state: String,
    to_state: String,
    recorded_at_unix_ms: i64,
    evidence_hash: Option<String>,
    reason_code: Option<String>,
}

impl TryFrom<RawTransitionRow> for JournalTransitionV1 {
    type Error = JournalStoreError;

    fn try_from(value: RawTransitionRow) -> Result<Self, Self::Error> {
        Ok(Self {
            sequence: nonnegative_i64_to_u64(value.sequence, "transition.sequence")?,
            from: parse_state(value.from_state)?,
            to: parse_state(value.to_state)?,
            recorded_at_unix_ms: nonnegative_i64_to_u64(
                value.recorded_at_unix_ms,
                "transition.recorded_at_unix_ms",
            )?,
            evidence_hash: value.evidence_hash.map(parse_digest).transpose()?,
            reason_code: value.reason_code,
        })
    }
}

fn parse_digest(value: String) -> Result<Sha256Digest, JournalStoreError> {
    Sha256Digest::from_str(&value)
        .map_err(|_| JournalStoreError::InvalidStoredDigest(value))
}
