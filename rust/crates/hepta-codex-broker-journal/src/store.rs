use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_journal::{
    JournalError, JournalTransitionV1, OperationJournalV1, OperationState,
};
use hepta_codex_protocol::Sha256Digest;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::{
    path::{prepare_database_path, validate_database_and_sidecars},
    schema::{initialize_connection, verify_connection_contract},
    types::{
        BrokerJournalPolicyV1, BrokerOperationSnapshotV1, OperationReservationV1,
        ReservationDisposition, TransitionCommandV1,
    },
};

/// Broker-owned SQLite journal handle. Methods requiring writes take `&mut self`
/// so one process cannot accidentally issue concurrent operations through one
/// connection.
pub struct BrokerJournalV1 {
    connection: Connection,
    database_path: PathBuf,
    policy: BrokerJournalPolicyV1,
}

impl BrokerJournalV1 {
    /// Opens or creates a private, owner-bound SQLite database and verifies its schema.
    pub fn open(
        database_path: &Path,
        policy: BrokerJournalPolicyV1,
    ) -> Result<Self, JournalStoreError> {
        let database_path = prepare_database_path(database_path, policy)?;
        let connection = Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(JournalStoreError::Sqlite)?;
        initialize_connection(&connection, policy)?;
        validate_database_and_sidecars(&database_path, policy)?;
        let journal = Self {
            connection,
            database_path,
            policy,
        };
        journal.audit()?;
        Ok(journal)
    }

    /// Exact path of the private broker journal.
    #[must_use]
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Atomically creates an operation reservation or returns the exact existing reservation.
    pub fn reserve_operation(
        &mut self,
        reservation: &OperationReservationV1,
    ) -> Result<BrokerOperationSnapshotV1, JournalStoreError> {
        validate_reservation(reservation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(JournalStoreError::Sqlite)?;

        if let Some(existing) = load_identity_by_operation(&transaction, &reservation.operation_id)? {
            validate_exact_existing_reservation(&existing, reservation)?;
            transaction.commit().map_err(JournalStoreError::Sqlite)?;
            return self.load_operation_with_disposition(
                &reservation.operation_id,
                ReservationDisposition::Existing,
            );
        }

        reject_secondary_identity_conflicts(&transaction, reservation)?;
        transaction
            .execute(
                "INSERT INTO operations(\
                   operation_id, request_hash, idempotency_key, capability_nonce,\
                   peer_process_id, peer_user_id, peer_group_id, current_state,\
                   created_at_unix_ms, updated_at_unix_ms, revision,\
                   provider_action_may_have_started, prepared_receipt_hash\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reserved', ?8, ?8, 0, 0, NULL)",
                params![
                    reservation.operation_id,
                    reservation.request_hash.as_str(),
                    reservation.idempotency_key.as_str(),
                    reservation.capability_nonce,
                    i64::from(reservation.peer_process_id),
                    i64::from(reservation.peer_user_id),
                    i64::from(reservation.peer_group_id),
                    to_sql_u64(reservation.created_at_unix_ms, "createdAtUnixMs")?,
                ],
            )
            .map_err(map_constraint_error)?;
        transaction.commit().map_err(JournalStoreError::Sqlite)?;
        self.load_operation_with_disposition(
            &reservation.operation_id,
            ReservationDisposition::Created,
        )
    }

    /// Applies one state-machine transition with current-state and revision CAS.
    pub fn append_transition(
        &mut self,
        command: &TransitionCommandV1,
    ) -> Result<BrokerOperationSnapshotV1, JournalStoreError> {
        if !valid_identifier(&command.operation_id) {
            return Err(JournalStoreError::InvalidOperationId);
        }
        if command.recorded_at_unix_ms == 0 {
            return Err(JournalStoreError::InvalidTimestamp("recordedAtUnixMs"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(JournalStoreError::Sqlite)?;
        let mut snapshot = load_operation_from_connection(
            &transaction,
            &command.operation_id,
            ReservationDisposition::Existing,
        )?;
        if snapshot.journal.current_state != command.expected_state {
            return Err(JournalStoreError::StaleExpectedState {
                expected: command.expected_state,
                observed: snapshot.journal.current_state,
            });
        }
        let previous_state = snapshot.journal.current_state;
        snapshot
            .journal
            .transition(
                command.to_state,
                command.recorded_at_unix_ms,
                command.evidence_hash.clone(),
                command.reason_code.clone(),
            )
            .map_err(JournalStoreError::Journal)?;
        let transition = snapshot
            .journal
            .transitions
            .last()
            .cloned()
            .ok_or(JournalStoreError::TransitionMissingAfterApply)?;
        let transition_hash = transition_hash(&command.operation_id, &transition)?;
        transaction
            .execute(
                "INSERT INTO operation_transitions(\
                   operation_id, sequence, from_state, to_state, recorded_at_unix_ms,\
                   evidence_hash, reason_code, transition_hash\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    command.operation_id,
                    to_sql_u64(transition.sequence, "sequence")?,
                    state_name(transition.from),
                    state_name(transition.to),
                    to_sql_u64(transition.recorded_at_unix_ms, "recordedAtUnixMs")?,
                    transition.evidence_hash.as_ref().map(Sha256Digest::as_str),
                    transition.reason_code,
                    transition_hash.as_str(),
                ],
            )
            .map_err(map_constraint_error)?;

        let provider_action_may_have_started =
            snapshot.provider_action_may_have_started || command.to_state == OperationState::ProcessSpawned;
        let prepared_receipt_hash = if command.to_state == OperationState::ResultPrepared {
            command.evidence_hash.as_ref()
        } else {
            snapshot.prepared_receipt_hash.as_ref()
        };
        let changed = transaction
            .execute(
                "UPDATE operations SET\
                   current_state = ?1,\
                   updated_at_unix_ms = ?2,\
                   revision = revision + 1,\
                   provider_action_may_have_started = ?3,\
                   prepared_receipt_hash = ?4\
                 WHERE operation_id = ?5 AND current_state = ?6 AND revision = ?7",
                params![
                    state_name(command.to_state),
                    to_sql_u64(command.recorded_at_unix_ms, "recordedAtUnixMs")?,
                    i64::from(provider_action_may_have_started),
                    prepared_receipt_hash.map(Sha256Digest::as_str),
                    command.operation_id,
                    state_name(previous_state),
                    to_sql_u64(snapshot.revision, "revision")?,
                ],
            )
            .map_err(map_constraint_error)?;
        if changed != 1 {
            return Err(JournalStoreError::CompareAndSwapLost);
        }
        transaction.commit().map_err(JournalStoreError::Sqlite)?;
        self.load_operation_with_disposition(
            &command.operation_id,
            ReservationDisposition::Existing,
        )
    }

    /// Loads and re-validates one complete operation journal.
    pub fn load_operation(
        &self,
        operation_id: &str,
    ) -> Result<BrokerOperationSnapshotV1, JournalStoreError> {
        self.load_operation_with_disposition(operation_id, ReservationDisposition::Existing)
    }

    /// Runs SQLite integrity/foreign-key checks and replays every operation journal.
    pub fn audit(&self) -> Result<JournalAuditV1, JournalStoreError> {
        verify_connection_contract(&self.connection)?;
        validate_database_and_sidecars(&self.database_path, self.policy)?;
        let mut integrity_statement = self
            .connection
            .prepare("PRAGMA integrity_check")
            .map_err(JournalStoreError::Sqlite)?;
        let integrity_rows = integrity_statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(JournalStoreError::Sqlite)?;
        for row in integrity_rows {
            let result = row.map_err(JournalStoreError::Sqlite)?;
            if result != "ok" {
                return Err(JournalStoreError::IntegrityCheckFailed(result));
            }
        }
        drop(integrity_statement);

        let mut foreign_key_statement = self
            .connection
            .prepare("PRAGMA foreign_key_check")
            .map_err(JournalStoreError::Sqlite)?;
        let mut foreign_key_rows = foreign_key_statement
            .query([])
            .map_err(JournalStoreError::Sqlite)?;
        if foreign_key_rows
            .next()
            .map_err(JournalStoreError::Sqlite)?
            .is_some()
        {
            return Err(JournalStoreError::ForeignKeyCheckFailed);
        }
        drop(foreign_key_rows);
        drop(foreign_key_statement);

        let mut operation_statement = self
            .connection
            .prepare("SELECT operation_id FROM operations ORDER BY operation_id")
            .map_err(JournalStoreError::Sqlite)?;
        let operation_rows = operation_statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(JournalStoreError::Sqlite)?;
        let mut operation_ids = Vec::new();
        for row in operation_rows {
            operation_ids.push(row.map_err(JournalStoreError::Sqlite)?);
        }
        drop(operation_statement);

        let mut transition_count = 0_u64;
        for operation_id in &operation_ids {
            let snapshot = self.load_operation(operation_id)?;
            transition_count = transition_count
                .checked_add(
                    u64::try_from(snapshot.journal.transitions.len())
                        .map_err(|_| JournalStoreError::IntegerOverflow)?,
                )
                .ok_or(JournalStoreError::IntegerOverflow)?;
        }
        Ok(JournalAuditV1 {
            operation_count: u64::try_from(operation_ids.len())
                .map_err(|_| JournalStoreError::IntegerOverflow)?,
            transition_count,
        })
    }

    /// Forces a full WAL checkpoint and re-validates database/sidecar identities.
    pub fn checkpoint(&self) -> Result<(), JournalStoreError> {
        let (busy, _log_frames, _checkpointed_frames): (i64, i64, i64) = self
            .connection
            .query_row("PRAGMA wal_checkpoint(FULL)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(JournalStoreError::Sqlite)?;
        if busy != 0 {
            return Err(JournalStoreError::CheckpointBusy);
        }
        validate_database_and_sidecars(&self.database_path, self.policy)
    }

    fn load_operation_with_disposition(
        &self,
        operation_id: &str,
        disposition: ReservationDisposition,
    ) -> Result<BrokerOperationSnapshotV1, JournalStoreError> {
        load_operation_from_connection(&self.connection, operation_id, disposition)
    }
}

/// Aggregate audit counts after every journal has replayed successfully.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JournalAuditV1 {
    pub operation_count: u64,
    pub transition_count: u64,
}

#[derive(Clone, Debug)]
struct OperationIdentityRow {
    operation_id: String,
    request_hash: String,
    idempotency_key: String,
    capability_nonce: String,
    peer_process_id: i64,
    peer_user_id: i64,
    peer_group_id: i64,
    current_state: String,
    created_at_unix_ms: i64,
    updated_at_unix_ms: i64,
    revision: i64,
    provider_action_may_have_started: i64,
    prepared_receipt_hash: Option<String>,
}

fn load_identity_by_operation(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<OperationIdentityRow>, JournalStoreError> {
    connection
        .query_row(
            "SELECT operation_id, request_hash, idempotency_key, capability_nonce,\
                    peer_process_id, peer_user_id, peer_group_id, current_state,\
                    created_at_unix_ms, updated_at_unix_ms, revision,\
                    provider_action_may_have_started, prepared_receipt_hash\
             FROM operations WHERE operation_id = ?1",
            [operation_id],
            row_to_identity,
        )
        .optional()
        .map_err(JournalStoreError::Sqlite)
}

fn row_to_identity(row: &rusqlite::Row<'_>) -> rusqlite::Result<OperationIdentityRow> {
    Ok(OperationIdentityRow {
        operation_id: row.get(0)?,
        request_hash: row.get(1)?,
        idempotency_key: row.get(2)?,
        capability_nonce: row.get(3)?,
        peer_process_id: row.get(4)?,
        peer_user_id: row.get(5)?,
        peer_group_id: row.get(6)?,
        current_state: row.get(7)?,
        created_at_unix_ms: row.get(8)?,
        updated_at_unix_ms: row.get(9)?,
        revision: row.get(10)?,
        provider_action_may_have_started: row.get(11)?,
        prepared_receipt_hash: row.get(12)?,
    })
}

fn reject_secondary_identity_conflicts(
    transaction: &Transaction<'_>,
    reservation: &OperationReservationV1,
) -> Result<(), JournalStoreError> {
    for (column, value, conflict) in [
        (
            "request_hash",
            reservation.request_hash.as_str(),
            JournalStoreError::RequestHashConflict,
        ),
        (
            "idempotency_key",
            reservation.idempotency_key.as_str(),
            JournalStoreError::IdempotencyConflict,
        ),
        (
            "capability_nonce",
            reservation.capability_nonce.as_str(),
            JournalStoreError::CapabilityNonceReplay,
        ),
    ] {
        let query = format!("SELECT operation_id FROM operations WHERE {column} = ?1");
        let existing: Option<String> = transaction
            .query_row(&query, [value], |row| row.get(0))
            .optional()
            .map_err(JournalStoreError::Sqlite)?;
        if existing.is_some() {
            return Err(conflict);
        }
    }
    Ok(())
}

fn validate_exact_existing_reservation(
    existing: &OperationIdentityRow,
    reservation: &OperationReservationV1,
) -> Result<(), JournalStoreError> {
    if existing.operation_id != reservation.operation_id
        || existing.request_hash != reservation.request_hash.as_str()
        || existing.idempotency_key != reservation.idempotency_key.as_str()
        || existing.capability_nonce != reservation.capability_nonce
        || existing.peer_process_id != i64::from(reservation.peer_process_id)
        || existing.peer_user_id != i64::from(reservation.peer_user_id)
        || existing.peer_group_id != i64::from(reservation.peer_group_id)
        || existing.created_at_unix_ms
            != to_sql_u64(reservation.created_at_unix_ms, "createdAtUnixMs")?
    {
        return Err(JournalStoreError::OperationIdentityConflict);
    }
    Ok(())
}

fn load_operation_from_connection(
    connection: &Connection,
    operation_id: &str,
    disposition: ReservationDisposition,
) -> Result<BrokerOperationSnapshotV1, JournalStoreError> {
    if !valid_identifier(operation_id) {
        return Err(JournalStoreError::InvalidOperationId);
    }
    let identity = load_identity_by_operation(connection, operation_id)?
        .ok_or_else(|| JournalStoreError::OperationNotFound(operation_id.to_owned()))?;
    let request_hash = parse_digest(&identity.request_hash)?;
    let idempotency_key = parse_digest(&identity.idempotency_key)?;
    let current_state = parse_state(&identity.current_state)?;
    let revision = from_sql_u64(identity.revision, "revision")?;
    let provider_action_may_have_started = match identity.provider_action_may_have_started {
        0 => false,
        1 => true,
        value => return Err(JournalStoreError::InvalidBoolean(value)),
    };
    let prepared_receipt_hash = identity
        .prepared_receipt_hash
        .as_deref()
        .map(parse_digest)
        .transpose()?;

    let mut statement = connection
        .prepare(
            "SELECT sequence, from_state, to_state, recorded_at_unix_ms,\
                    evidence_hash, reason_code, transition_hash\
             FROM operation_transitions\
             WHERE operation_id = ?1 ORDER BY sequence",
        )
        .map_err(JournalStoreError::Sqlite)?;
    let rows = statement
        .query_map([operation_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(JournalStoreError::Sqlite)?;
    let mut transitions = Vec::new();
    let mut observed_transition_hashes = Vec::new();
    for row in rows {
        let (sequence, from, to, recorded_at, evidence, reason, transition_hash_value) =
            row.map_err(JournalStoreError::Sqlite)?;
        let transition = JournalTransitionV1 {
            sequence: from_sql_u64(sequence, "sequence")?,
            from: parse_state(&from)?,
            to: parse_state(&to)?,
            recorded_at_unix_ms: from_sql_u64(recorded_at, "recordedAtUnixMs")?,
            evidence_hash: evidence.as_deref().map(parse_digest).transpose()?,
            reason_code: reason,
        };
        transitions.push(transition);
        observed_transition_hashes.push(parse_digest(&transition_hash_value)?);
    }
    drop(statement);

    let journal = OperationJournalV1 {
        version: 1,
        operation_id: identity.operation_id.clone(),
        request_hash,
        current_state,
        transitions,
    };
    journal.validate().map_err(JournalStoreError::Journal)?;
    if revision
        != u64::try_from(journal.transitions.len())
            .map_err(|_| JournalStoreError::IntegerOverflow)?
    {
        return Err(JournalStoreError::RevisionTransitionMismatch {
            revision,
            transition_count: journal.transitions.len(),
        });
    }
    for (transition, observed_hash) in journal
        .transitions
        .iter()
        .zip(&observed_transition_hashes)
    {
        if transition_hash(operation_id, transition)? != *observed_hash {
            return Err(JournalStoreError::TransitionHashMismatch(
                transition.sequence,
            ));
        }
    }
    let expected_provider_flag = journal
        .transitions
        .iter()
        .any(|transition| transition.to == OperationState::ProcessSpawned);
    if expected_provider_flag != provider_action_may_have_started {
        return Err(JournalStoreError::ProviderActionFlagMismatch);
    }
    let expected_prepared_hash = journal
        .transitions
        .iter()
        .find(|transition| transition.to == OperationState::ResultPrepared)
        .and_then(|transition| transition.evidence_hash.clone());
    if expected_prepared_hash != prepared_receipt_hash {
        return Err(JournalStoreError::PreparedReceiptMismatch);
    }
    if identity.updated_at_unix_ms < identity.created_at_unix_ms {
        return Err(JournalStoreError::TimestampRegression);
    }
    Ok(BrokerOperationSnapshotV1 {
        disposition,
        idempotency_key,
        capability_nonce: identity.capability_nonce,
        peer_process_id: i32::try_from(identity.peer_process_id)
            .map_err(|_| JournalStoreError::IntegerOverflow)?,
        peer_user_id: u32::try_from(identity.peer_user_id)
            .map_err(|_| JournalStoreError::IntegerOverflow)?,
        peer_group_id: u32::try_from(identity.peer_group_id)
            .map_err(|_| JournalStoreError::IntegerOverflow)?,
        revision,
        provider_action_may_have_started,
        prepared_receipt_hash,
        journal,
    })
}

fn validate_reservation(reservation: &OperationReservationV1) -> Result<(), JournalStoreError> {
    if !valid_identifier(&reservation.operation_id) {
        return Err(JournalStoreError::InvalidOperationId);
    }
    if !valid_identifier(&reservation.capability_nonce) {
        return Err(JournalStoreError::InvalidCapabilityNonce);
    }
    if reservation.peer_process_id <= 0 {
        return Err(JournalStoreError::InvalidPeerProcessId(
            reservation.peer_process_id,
        ));
    }
    if reservation.created_at_unix_ms == 0 {
        return Err(JournalStoreError::InvalidTimestamp("createdAtUnixMs"));
    }
    to_sql_u64(reservation.created_at_unix_ms, "createdAtUnixMs")?;
    OperationJournalV1::new(
        reservation.operation_id.clone(),
        reservation.request_hash.clone(),
    )
    .map_err(JournalStoreError::Journal)?;
    Ok(())
}

fn transition_hash(
    operation_id: &str,
    transition: &JournalTransitionV1,
) -> Result<Sha256Digest, JournalStoreError> {
    let mut hasher = Sha256::new();
    update_field(&mut hasher, b"HeptaBrokerJournalTransitionV1");
    update_field(&mut hasher, operation_id.as_bytes());
    update_field(&mut hasher, &transition.sequence.to_be_bytes());
    update_field(&mut hasher, state_name(transition.from).as_bytes());
    update_field(&mut hasher, state_name(transition.to).as_bytes());
    update_field(
        &mut hasher,
        &transition.recorded_at_unix_ms.to_be_bytes(),
    );
    update_optional(
        &mut hasher,
        transition.evidence_hash.as_ref().map(Sha256Digest::as_str),
    );
    update_optional(&mut hasher, transition.reason_code.as_deref());
    parse_digest(&format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn update_optional(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            update_field(hasher, &[1]);
            update_field(hasher, value.as_bytes());
        }
        None => update_field(hasher, &[0]),
    }
}

fn parse_digest(value: &str) -> Result<Sha256Digest, JournalStoreError> {
    Sha256Digest::from_str(value).map_err(|_| JournalStoreError::InvalidDigest)
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
        })
}

fn to_sql_u64(value: u64, field: &'static str) -> Result<i64, JournalStoreError> {
    i64::try_from(value).map_err(|_| JournalStoreError::IntegerOutOfRange(field))
}

fn from_sql_u64(value: i64, field: &'static str) -> Result<u64, JournalStoreError> {
    u64::try_from(value).map_err(|_| JournalStoreError::IntegerOutOfRange(field))
}

const fn state_name(state: OperationState) -> &'static str {
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

fn parse_state(value: &str) -> Result<OperationState, JournalStoreError> {
    match value {
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
        _ => Err(JournalStoreError::UnknownOperationState(value.to_owned())),
    }
}

fn map_constraint_error(error: rusqlite::Error) -> JournalStoreError {
    match &error {
        rusqlite::Error::SqliteFailure(code, message)
            if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            JournalStoreError::UniqueConstraint(message.clone())
        }
        _ => JournalStoreError::Sqlite(error),
    }
}

/// Filesystem, schema, identity, transaction or replay failure.
#[derive(Debug, Error)]
pub enum JournalStoreError {
    #[error("broker journal policy is invalid")]
    InvalidPolicy,
    #[error("database path must be absolute")]
    DatabasePathMustBeAbsolute,
    #[error("database path is invalid")]
    DatabasePathInvalid,
    #[error("database path is noncanonical")]
    DatabasePathNonCanonical,
    #[error("database parent is missing")]
    DatabaseParentMissing,
    #[error("database parent must be a real directory")]
    DatabaseParentNotRealDirectory,
    #[error("database parent is noncanonical")]
    DatabaseParentNonCanonical,
    #[error("database parent permissions are invalid: {0:o}")]
    DatabaseParentPermissionsInvalid(u32),
    #[error("database must be a real regular file")]
    DatabaseNotRealRegularFile,
    #[error("database permissions are invalid: {0:o}")]
    DatabasePermissionsInvalid(u32),
    #[error("database link count is invalid: {0}")]
    DatabaseLinkCountInvalid(u64),
    #[error("database is too large: observed {observed}, maximum {maximum}")]
    DatabaseTooLarge { observed: u64, maximum: u64 },
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
    #[error("SQLite error: {0}")]
    Sqlite(rusqlite::Error),
    #[error("SQLite unique constraint failed: {0:?}")]
    UniqueConstraint(Option<String>),
    #[error("SQLite journal mode is not WAL: {0}")]
    JournalModeNotWal(String),
    #[error("SQLite foreign keys are disabled")]
    ForeignKeysDisabled,
    #[error("SQLite application id mismatch: {0}")]
    ApplicationIdMismatch(i64),
    #[error("SQLite schema version mismatch: {0}")]
    SchemaVersionMismatch(i64),
    #[error("broker journal kind mismatch: {0}")]
    JournalKindMismatch(String),
    #[error("operation id is invalid")]
    InvalidOperationId,
    #[error("capability nonce is invalid")]
    InvalidCapabilityNonce,
    #[error("peer process id is invalid: {0}")]
    InvalidPeerProcessId(i32),
    #[error("timestamp is invalid: {0}")]
    InvalidTimestamp(&'static str),
    #[error("integer is out of SQLite range: {0}")]
    IntegerOutOfRange(&'static str),
    #[error("integer arithmetic overflowed")]
    IntegerOverflow,
    #[error("digest stored in the journal is invalid")]
    InvalidDigest,
    #[error("operation state stored in the journal is unknown: {0}")]
    UnknownOperationState(String),
    #[error("operation does not exist: {0}")]
    OperationNotFound(String),
    #[error("operation id already exists with different identity")]
    OperationIdentityConflict,
    #[error("request hash already belongs to another operation")]
    RequestHashConflict,
    #[error("idempotency key already belongs to another operation")]
    IdempotencyConflict,
    #[error("capability nonce has already been used")]
    CapabilityNonceReplay,
    #[error("journal state-machine validation failed: {0}")]
    Journal(JournalError),
    #[error("expected state is stale: expected {expected:?}, observed {observed:?}")]
    StaleExpectedState {
        expected: OperationState,
        observed: OperationState,
    },
    #[error("transition was not present after state-machine application")]
    TransitionMissingAfterApply,
    #[error("operation compare-and-swap update lost")]
    CompareAndSwapLost,
    #[error("invalid stored boolean: {0}")]
    InvalidBoolean(i64),
    #[error("operation revision {revision} does not match transition count {transition_count}")]
    RevisionTransitionMismatch {
        revision: u64,
        transition_count: usize,
    },
    #[error("transition hash mismatch at sequence {0}")]
    TransitionHashMismatch(u64),
    #[error("provider-action flag does not match replayed transitions")]
    ProviderActionFlagMismatch,
    #[error("prepared receipt hash does not match replayed transitions")]
    PreparedReceiptMismatch,
    #[error("operation timestamp regressed")]
    TimestampRegression,
    #[error("SQLite integrity check failed: {0}")]
    IntegrityCheckFailed(String),
    #[error("SQLite foreign-key check failed")]
    ForeignKeyCheckFailed,
    #[error("SQLite checkpoint remained busy")]
    CheckpointBusy,
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::Write,
        os::unix::fs::{MetadataExt, PermissionsExt, symlink},
        path::{Path, PathBuf},
        str::FromStr,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use hepta_codex_journal::OperationState;
    use hepta_codex_protocol::Sha256Digest;

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "hepta-broker-journal-{}-{nonce}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir(&path).expect("create temp directory");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("private temp directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    fn open_journal(directory: &TempDirectory) -> BrokerJournalV1 {
        let owner = fs::metadata(&directory.0)
            .expect("directory metadata")
            .uid();
        BrokerJournalV1::open(
            &directory.0.join("broker.sqlite"),
            BrokerJournalPolicyV1::strict(owner),
        )
        .expect("open broker journal")
    }

    fn reservation(operation_id: &str) -> OperationReservationV1 {
        OperationReservationV1 {
            operation_id: operation_id.to_owned(),
            request_hash: digest('1'),
            idempotency_key: digest('2'),
            capability_nonce: "nonce-1".to_owned(),
            peer_process_id: 42,
            peer_user_id: 1000,
            peer_group_id: 1000,
            created_at_unix_ms: 100,
        }
    }

    #[test]
    fn exact_duplicate_reservation_is_idempotent() {
        let directory = TempDirectory::new();
        let mut journal = open_journal(&directory);
        let first = journal
            .reserve_operation(&reservation("operation-1"))
            .expect("first reservation");
        assert_eq!(first.disposition, ReservationDisposition::Created);
        let second = journal
            .reserve_operation(&reservation("operation-1"))
            .expect("idempotent reservation");
        assert_eq!(second.disposition, ReservationDisposition::Existing);
        assert_eq!(journal.audit().expect("audit").operation_count, 1);
    }

    #[test]
    fn nonce_and_idempotency_replay_for_another_operation_are_rejected() {
        let directory = TempDirectory::new();
        let mut journal = open_journal(&directory);
        journal
            .reserve_operation(&reservation("operation-1"))
            .expect("first reservation");
        let mut replay = reservation("operation-2");
        replay.request_hash = digest('3');
        replay.idempotency_key = digest('4');
        assert!(matches!(
            journal.reserve_operation(&replay),
            Err(JournalStoreError::CapabilityNonceReplay),
        ));
        replay.capability_nonce = "nonce-2".to_owned();
        replay.idempotency_key = digest('2');
        assert!(matches!(
            journal.reserve_operation(&replay),
            Err(JournalStoreError::IdempotencyConflict),
        ));
    }

    #[test]
    fn stale_state_cannot_append_a_transition() {
        let directory = TempDirectory::new();
        let mut journal = open_journal(&directory);
        journal
            .reserve_operation(&reservation("operation-1"))
            .expect("reservation");
        journal
            .append_transition(&TransitionCommandV1 {
                operation_id: "operation-1".into(),
                expected_state: OperationState::Reserved,
                to_state: OperationState::RequestBound,
                recorded_at_unix_ms: 101,
                evidence_hash: None,
                reason_code: None,
            })
            .expect("request bound");
        assert!(matches!(
            journal.append_transition(&TransitionCommandV1 {
                operation_id: "operation-1".into(),
                expected_state: OperationState::Reserved,
                to_state: OperationState::RejectedPreflight,
                recorded_at_unix_ms: 102,
                evidence_hash: None,
                reason_code: Some("stale".into()),
            }),
            Err(JournalStoreError::StaleExpectedState { .. }),
        ));
        assert_eq!(journal.load_operation("operation-1").expect("load").revision, 1);
    }

    #[test]
    fn transaction_rolls_back_when_operation_update_is_injected_to_fail() {
        let directory = TempDirectory::new();
        let mut journal = open_journal(&directory);
        journal
            .reserve_operation(&reservation("operation-1"))
            .expect("reservation");
        journal
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER inject_operation_update_failure\
                 BEFORE UPDATE ON operations\
                 BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;",
            )
            .expect("inject trigger");
        assert!(journal
            .append_transition(&TransitionCommandV1 {
                operation_id: "operation-1".into(),
                expected_state: OperationState::Reserved,
                to_state: OperationState::RequestBound,
                recorded_at_unix_ms: 101,
                evidence_hash: None,
                reason_code: None,
            })
            .is_err());
        let snapshot = journal.load_operation("operation-1").expect("load");
        assert_eq!(snapshot.revision, 0);
        assert!(snapshot.journal.transitions.is_empty());
    }

    #[test]
    fn result_prepared_receipt_is_recoverable_without_provider_rerun() {
        let directory = TempDirectory::new();
        let mut journal = open_journal(&directory);
        journal
            .reserve_operation(&reservation("operation-1"))
            .expect("reservation");
        let path = [
            (OperationState::RequestBound, None),
            (OperationState::ProcessSpawned, Some(digest('3'))),
            (OperationState::EventStreamStarted, None),
            (OperationState::TerminalEventObserved, Some(digest('4'))),
            (OperationState::FinalOutputCaptured, Some(digest('5'))),
            (OperationState::SchemaValidated, Some(digest('6'))),
            (OperationState::WorkspaceSnapshotted, Some(digest('7'))),
            (OperationState::MutationValidated, Some(digest('8'))),
            (OperationState::ResultPrepared, Some(digest('9'))),
        ];
        let mut expected = OperationState::Reserved;
        for (index, (to, evidence)) in path.into_iter().enumerate() {
            journal
                .append_transition(&TransitionCommandV1 {
                    operation_id: "operation-1".into(),
                    expected_state: expected,
                    to_state: to,
                    recorded_at_unix_ms: 101 + u64::try_from(index).expect("index"),
                    evidence_hash: evidence,
                    reason_code: None,
                })
                .expect("transition");
            expected = to;
        }
        let snapshot = journal.load_operation("operation-1").expect("load");
        assert_eq!(snapshot.prepared_receipt_hash, Some(digest('9')));
        assert!(snapshot.provider_action_may_have_started);
        assert_eq!(
            snapshot.journal.recovery_disposition(),
            hepta_codex_journal::RecoveryDisposition::IntegratePreparedResult,
        );
    }

    #[test]
    fn symlink_database_is_rejected() {
        let directory = TempDirectory::new();
        let target = directory.0.join("target.sqlite");
        let mut file = File::create(&target).expect("target file");
        file.write_all(b"not sqlite").expect("write target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600))
            .expect("target mode");
        let link = directory.0.join("link.sqlite");
        symlink(&target, &link).expect("create symlink");
        let owner = fs::metadata(&directory.0)
            .expect("directory metadata")
            .uid();
        assert!(matches!(
            BrokerJournalV1::open(&link, BrokerJournalPolicyV1::strict(owner)),
            Err(JournalStoreError::DatabaseNotRealRegularFile),
        ));
    }
}
