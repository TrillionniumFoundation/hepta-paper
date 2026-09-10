use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_journal::{JournalError, JournalTransitionV1, OperationJournalV1, OperationState};
use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use hepta_codex_runtime::{
    GateProcessObservationV1, PreExecGateIdentityV1, ProcessLimitsV1, observe_preexec_gate_process,
    terminate_journaled_preexec_gate,
};
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
    AfterProcessIdentityInsert,
    AfterReleaseAuthorization,
    AfterProcessTermination,
}

#[cfg(test)]
fn pause_for_sigkill_test(point: FaultInjectionPointV1) {
    let expected = match point {
        FaultInjectionPointV1::None => "none",
        FaultInjectionPointV1::AfterOperationInsert => "after_operation_insert",
        FaultInjectionPointV1::AfterNonceInsert => "after_nonce_insert",
        FaultInjectionPointV1::AfterTransitionInsert => "after_transition_insert",
        FaultInjectionPointV1::AfterProjectionUpdate => "after_projection_update",
        FaultInjectionPointV1::AfterProcessIdentityInsert => "after_process_identity_insert",
        FaultInjectionPointV1::AfterReleaseAuthorization => "after_release_authorization",
        FaultInjectionPointV1::AfterProcessTermination => "after_process_termination",
    };
    if std::env::var("HEPTA_TEST_SIGKILL_POINT").ok().as_deref() != Some(expected) {
        return;
    }
    let ready = std::env::var_os("HEPTA_TEST_SIGKILL_READY")
        .map(PathBuf::from)
        .expect("SIGKILL test ready path");
    std::fs::write(
        &ready, b"ready
",
    )
    .expect("publish SIGKILL test readiness");
    loop {
        std::thread::park_timeout(std::time::Duration::from_secs(60));
    }
}

/// Result of reserving an idempotent provider operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReservationOutcomeV1 {
    Reserved(OperationJournalV1),
    Existing(OperationJournalV1),
}

/// Durable release phase for one pre-exec gate identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessReleaseStateV1 {
    Blocked,
    Authorized,
    Terminated,
}

impl ProcessReleaseStateV1 {
    fn from_db(value: &str) -> Result<Self, BrokerJournalError> {
        match value {
            "blocked" => Ok(Self::Blocked),
            "authorized" => Ok(Self::Authorized),
            "terminated" => Ok(Self::Terminated),
            _ => Err(BrokerJournalError::CorruptDatabaseValue(
                "process_release_state",
            )),
        }
    }
}

/// Exact process identity and release state persisted with `process_spawned`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerProcessLaunchV1 {
    pub operation_id: String,
    pub identity: PreExecGateIdentityV1,
    pub release_state: ProcessReleaseStateV1,
    pub linked_at_unix_ms: u64,
    pub release_authorized_at_unix_ms: Option<u64>,
    pub terminated_at_unix_ms: Option<u64>,
    pub reconciliation_disposition: Option<String>,
}

/// Deterministic startup recovery result for one durable process launch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessReconciliationDispositionV1 {
    BlockedGateTerminated,
    ReleasedProcessTerminated,
    OrphanedProcessGroupTerminated,
    BlockedGateAlreadyAbsent,
    ReleasedProcessOutcomeAmbiguous,
    ManualIdentityMismatch,
}

impl ProcessReconciliationDispositionV1 {
    fn as_reason(self) -> &'static str {
        match self {
            Self::BlockedGateTerminated => "startup_blocked_gate_terminated",
            Self::ReleasedProcessTerminated => "startup_released_process_terminated",
            Self::OrphanedProcessGroupTerminated => "startup_orphaned_process_group_terminated",
            Self::BlockedGateAlreadyAbsent => "startup_blocked_gate_absent",
            Self::ReleasedProcessOutcomeAmbiguous => "startup_released_process_outcome_ambiguous",
            Self::ManualIdentityMismatch => "startup_process_identity_mismatch",
        }
    }
}

/// One startup reconciliation record. Identity mismatches are reported without signaling.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerProcessReconciliationV1 {
    pub operation_id: String,
    pub prior_state: OperationState,
    pub observation: GateProcessObservationV1,
    pub disposition: ProcessReconciliationDispositionV1,
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
            #[cfg(test)]
            pause_for_sigkill_test(fault);
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
            #[cfg(test)]
            pause_for_sigkill_test(fault);
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
        if next_state == OperationState::ProcessSpawned {
            return Err(BrokerJournalError::ProcessSpawnedRequiresGateIdentity);
        }
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
        insert_transition(&transaction, operation_id, &transition)?;
        if fault == FaultInjectionPointV1::AfterTransitionInsert {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
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
        update_operation_projection(
            &transaction,
            operation_id,
            expected_state,
            next_state,
            recorded_at_unix_ms,
            provider_action_may_have_started,
            prepared_receipt_hash,
        )?;
        if fault == FaultInjectionPointV1::AfterProjectionUpdate {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        transaction.commit()?;
        inspect_database_envelope(&self.path, self.policy)?;
        Ok(journal)
    }

    /// Atomically binds a stopped OS gate identity and the `process_spawned` transition.
    pub fn link_blocked_process(
        &mut self,
        operation_id: &str,
        recorded_at_unix_ms: u64,
        identity: &PreExecGateIdentityV1,
        fault: FaultInjectionPointV1,
    ) -> Result<OperationJournalV1, BrokerJournalError> {
        if recorded_at_unix_ms == 0 {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
        identity
            .validate_hash()
            .map_err(|_| BrokerJournalError::InvalidProcessIdentity)?;
        let identity_payload =
            serde_json::to_vec(identity).map_err(|_| BrokerJournalError::InvalidProcessIdentity)?;
        if identity_payload.is_empty() || identity_payload.len() > HARD_MAXIMUM_REQUEST_BYTES {
            return Err(BrokerJournalError::InvalidProcessIdentity);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut journal = load_journal_from_connection(&transaction, operation_id)?;
        if journal.current_state != OperationState::RequestBound {
            return Err(BrokerJournalError::StateConflict {
                expected: OperationState::RequestBound,
                observed: journal.current_state,
            });
        }
        let existing: Option<String> = transaction
            .query_row(
                "SELECT identity_hash FROM operation_processes WHERE operation_id = ?1",
                [operation_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(BrokerJournalError::ProcessIdentityConflict);
        }
        transaction.execute(
            "INSERT INTO operation_processes (
                operation_id, identity_payload, identity_hash, pid, process_group_id,
                session_id, start_time_ticks, process_uid, boot_id_hash,
                gate_executable_hash, target_executable_hash, launch_envelope_hash,
                release_state, linked_at_unix_ms, release_authorized_at_unix_ms,
                terminated_at_unix_ms, reconciliation_disposition
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                'blocked', ?13, NULL, NULL, NULL
             )",
            params![
                operation_id,
                identity_payload,
                identity.identity_hash.as_str(),
                i64::from(identity.pid),
                i64::from(identity.process_group_id),
                i64::from(identity.session_id),
                to_i64(identity.start_time_ticks)?,
                i64::from(identity.uid),
                identity.boot_id_hash.as_str(),
                identity.gate_executable.content_hash.as_str(),
                identity.target_executable.content_hash.as_str(),
                identity.launch_envelope.content_hash.as_str(),
                to_i64(recorded_at_unix_ms)?,
            ],
        )?;
        if fault == FaultInjectionPointV1::AfterProcessIdentityInsert {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        let transition = journal
            .transition(
                OperationState::ProcessSpawned,
                recorded_at_unix_ms,
                Some(identity.identity_hash.clone()),
                None,
            )?
            .clone();
        insert_transition(&transaction, operation_id, &transition)?;
        if fault == FaultInjectionPointV1::AfterTransitionInsert {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        update_operation_projection(
            &transaction,
            operation_id,
            OperationState::RequestBound,
            OperationState::ProcessSpawned,
            recorded_at_unix_ms,
            true,
            None,
        )?;
        if fault == FaultInjectionPointV1::AfterProjectionUpdate {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        transaction.commit()?;
        inspect_database_envelope(&self.path, self.policy)?;
        Ok(journal)
    }

    /// Durably authorizes release before the stopped gate receives `SIGCONT`.
    pub fn authorize_process_release(
        &mut self,
        operation_id: &str,
        identity_hash: &Sha256Digest,
        recorded_at_unix_ms: u64,
        fault: FaultInjectionPointV1,
    ) -> Result<BrokerProcessLaunchV1, BrokerJournalError> {
        if recorded_at_unix_ms == 0 {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let journal = load_journal_from_connection(&transaction, operation_id)?;
        if journal.current_state != OperationState::ProcessSpawned {
            return Err(BrokerJournalError::StateConflict {
                expected: OperationState::ProcessSpawned,
                observed: journal.current_state,
            });
        }
        let launch = load_process_launch_from_connection(&transaction, operation_id)?;
        if &launch.identity.identity_hash != identity_hash {
            return Err(BrokerJournalError::ProcessIdentityConflict);
        }
        match launch.release_state {
            ProcessReleaseStateV1::Blocked => {}
            ProcessReleaseStateV1::Authorized => {
                transaction.commit()?;
                return Ok(launch);
            }
            ProcessReleaseStateV1::Terminated => {
                return Err(BrokerJournalError::ProcessAlreadyTerminated);
            }
        }
        if recorded_at_unix_ms < launch.linked_at_unix_ms {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
        let updated = transaction.execute(
            "UPDATE operation_processes
             SET release_state = 'authorized', release_authorized_at_unix_ms = ?1
             WHERE operation_id = ?2 AND identity_hash = ?3 AND release_state = 'blocked'",
            params![
                to_i64(recorded_at_unix_ms)?,
                operation_id,
                identity_hash.as_str(),
            ],
        )?;
        if updated != 1 {
            return Err(BrokerJournalError::ConcurrentProcessStateChange);
        }
        if fault == FaultInjectionPointV1::AfterReleaseAuthorization {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        transaction.commit()?;
        inspect_database_envelope(&self.path, self.policy)?;
        self.load_process_launch(operation_id)
    }

    /// Records that the bound process group is no longer live. The identity remains immutable.
    pub fn mark_process_terminated(
        &mut self,
        operation_id: &str,
        identity_hash: &Sha256Digest,
        recorded_at_unix_ms: u64,
        disposition: &str,
    ) -> Result<BrokerProcessLaunchV1, BrokerJournalError> {
        if recorded_at_unix_ms == 0 || !valid_reason_code(disposition) {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let launch = load_process_launch_from_connection(&transaction, operation_id)?;
        if &launch.identity.identity_hash != identity_hash {
            return Err(BrokerJournalError::ProcessIdentityConflict);
        }
        if launch.release_state == ProcessReleaseStateV1::Terminated {
            if launch.reconciliation_disposition.as_deref() == Some(disposition) {
                transaction.commit()?;
                return Ok(launch);
            }
            return Err(BrokerJournalError::ProcessAlreadyTerminated);
        }
        if recorded_at_unix_ms < launch.linked_at_unix_ms {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
        let updated = transaction.execute(
            "UPDATE operation_processes
             SET release_state = 'terminated', terminated_at_unix_ms = ?1,
                 reconciliation_disposition = ?2
             WHERE operation_id = ?3 AND identity_hash = ?4
               AND release_state IN ('blocked', 'authorized')",
            params![
                to_i64(recorded_at_unix_ms)?,
                disposition,
                operation_id,
                identity_hash.as_str(),
            ],
        )?;
        if updated != 1 {
            return Err(BrokerJournalError::ConcurrentProcessStateChange);
        }
        transaction.commit()?;
        inspect_database_envelope(&self.path, self.policy)?;
        self.load_process_launch(operation_id)
    }

    /// Atomically records process-group termination and the state transition that consumes the
    /// supervised process result. This prevents restart recovery from observing a terminated
    /// process row without the corresponding journal disposition, or vice versa.
    #[allow(clippy::too_many_arguments)]
    pub fn finish_process_and_transition(
        &mut self,
        operation_id: &str,
        identity_hash: &Sha256Digest,
        expected_state: OperationState,
        next_state: OperationState,
        recorded_at_unix_ms: u64,
        evidence_hash: Option<Sha256Digest>,
        reason_code: Option<String>,
        disposition: &str,
        fault: FaultInjectionPointV1,
    ) -> Result<OperationJournalV1, BrokerJournalError> {
        if recorded_at_unix_ms == 0 || !valid_reason_code(disposition) {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
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
        let launch = load_process_launch_from_connection(&transaction, operation_id)?;
        if &launch.identity.identity_hash != identity_hash {
            return Err(BrokerJournalError::ProcessIdentityConflict);
        }
        if launch.release_state == ProcessReleaseStateV1::Terminated {
            return Err(BrokerJournalError::ProcessAlreadyTerminated);
        }
        if recorded_at_unix_ms < launch.linked_at_unix_ms {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }

        let transition = journal
            .transition(next_state, recorded_at_unix_ms, evidence_hash, reason_code)?
            .clone();
        let terminated = transaction.execute(
            "UPDATE operation_processes
             SET release_state = 'terminated', terminated_at_unix_ms = ?1,
                 reconciliation_disposition = ?2
             WHERE operation_id = ?3 AND identity_hash = ?4
               AND release_state IN ('blocked', 'authorized')",
            params![
                to_i64(recorded_at_unix_ms)?,
                disposition,
                operation_id,
                identity_hash.as_str(),
            ],
        )?;
        if terminated != 1 {
            return Err(BrokerJournalError::ConcurrentProcessStateChange);
        }
        if fault == FaultInjectionPointV1::AfterProcessTermination {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        insert_transition(&transaction, operation_id, &transition)?;
        if fault == FaultInjectionPointV1::AfterTransitionInsert {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
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
        update_operation_projection(
            &transaction,
            operation_id,
            expected_state,
            next_state,
            recorded_at_unix_ms,
            provider_action_may_have_started,
            prepared_receipt_hash,
        )?;
        if fault == FaultInjectionPointV1::AfterProjectionUpdate {
            #[cfg(test)]
            pause_for_sigkill_test(fault);
            return Err(BrokerJournalError::InjectedFault(fault));
        }
        transaction.commit()?;
        inspect_database_envelope(&self.path, self.policy)?;
        Ok(journal)
    }

    /// Loads and revalidates one exact process-launch identity.
    pub fn load_process_launch(
        &self,
        operation_id: &str,
    ) -> Result<BrokerProcessLaunchV1, BrokerJournalError> {
        load_process_launch_from_connection(&self.connection, operation_id)
    }

    /// Reconciles every pending gate before a listener can be marked ready.
    pub fn reconcile_pending_processes(
        &mut self,
        now_unix_ms: u64,
        limits: ProcessLimitsV1,
    ) -> Result<Vec<BrokerProcessReconciliationV1>, BrokerJournalError> {
        if now_unix_ms == 0 {
            return Err(BrokerJournalError::InvalidRecordedTime);
        }
        let mut statement = self.connection.prepare(
            "SELECT operation_id FROM operations
             WHERE current_state IN ('process_spawned', 'event_stream_started')
             ORDER BY operation_id",
        )?;
        let operation_ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut results = Vec::with_capacity(operation_ids.len());
        for operation_id in operation_ids {
            let journal = self.load_journal(&operation_id)?;
            let launch = self.load_process_launch(&operation_id)?;
            let observation = observe_preexec_gate_process(&launch.identity)
                .map_err(BrokerJournalError::ProcessRuntime)?;
            let disposition = match observation {
                GateProcessObservationV1::IdentityMismatch => {
                    results.push(BrokerProcessReconciliationV1 {
                        operation_id,
                        prior_state: journal.current_state,
                        observation,
                        disposition: ProcessReconciliationDispositionV1::ManualIdentityMismatch,
                    });
                    continue;
                }
                GateProcessObservationV1::Blocked => {
                    terminate_journaled_preexec_gate(&launch.identity, limits)
                        .map_err(BrokerJournalError::ProcessRuntime)?;
                    if launch.release_state == ProcessReleaseStateV1::Blocked {
                        ProcessReconciliationDispositionV1::BlockedGateTerminated
                    } else {
                        ProcessReconciliationDispositionV1::ReleasedProcessOutcomeAmbiguous
                    }
                }
                GateProcessObservationV1::ReleasedOrRunning => {
                    terminate_journaled_preexec_gate(&launch.identity, limits)
                        .map_err(BrokerJournalError::ProcessRuntime)?;
                    ProcessReconciliationDispositionV1::ReleasedProcessTerminated
                }
                GateProcessObservationV1::OrphanedProcessGroup => {
                    terminate_journaled_preexec_gate(&launch.identity, limits)
                        .map_err(BrokerJournalError::ProcessRuntime)?;
                    ProcessReconciliationDispositionV1::OrphanedProcessGroupTerminated
                }
                GateProcessObservationV1::Absent => {
                    if launch.release_state == ProcessReleaseStateV1::Blocked {
                        ProcessReconciliationDispositionV1::BlockedGateAlreadyAbsent
                    } else {
                        ProcessReconciliationDispositionV1::ReleasedProcessOutcomeAmbiguous
                    }
                }
            };
            let transition_time = journal
                .transitions
                .last()
                .map_or(now_unix_ms, |transition| {
                    now_unix_ms.max(transition.recorded_at_unix_ms.saturating_add(1))
                });
            let release_was_authorized = launch.release_authorized_at_unix_ms.is_some();
            let next_state = if !release_was_authorized
                && matches!(
                    disposition,
                    ProcessReconciliationDispositionV1::BlockedGateTerminated
                        | ProcessReconciliationDispositionV1::BlockedGateAlreadyAbsent
                ) {
                OperationState::FailedAfterSpawn
            } else {
                OperationState::ResultAmbiguous
            };
            if launch.release_state == ProcessReleaseStateV1::Terminated {
                self.append_transition(
                    &operation_id,
                    journal.current_state,
                    next_state,
                    transition_time,
                    None,
                    Some(disposition.as_reason().to_owned()),
                    FaultInjectionPointV1::None,
                )?;
            } else {
                self.finish_process_and_transition(
                    &operation_id,
                    &launch.identity.identity_hash,
                    journal.current_state,
                    next_state,
                    transition_time,
                    None,
                    Some(disposition.as_reason().to_owned()),
                    disposition.as_reason(),
                    FaultInjectionPointV1::None,
                )?;
            }
            results.push(BrokerProcessReconciliationV1 {
                operation_id,
                prior_state: journal.current_state,
                observation,
                disposition,
            });
        }
        Ok(results)
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
        let orphan_process_count: i64 = self.connection.query_row(
            "SELECT count(*)
             FROM operation_processes AS process
             LEFT JOIN operations AS operation
               ON operation.operation_id = process.operation_id
             WHERE operation.operation_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        if orphan_process_count != 0 {
            return Err(BrokerJournalError::ProcessIdentityProjectionMismatch);
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
            validate_process_projection(&self.connection, &journal)?;
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

fn insert_transition(
    transaction: &Transaction<'_>,
    operation_id: &str,
    transition: &JournalTransitionV1,
) -> Result<(), BrokerJournalError> {
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
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn update_operation_projection(
    transaction: &Transaction<'_>,
    operation_id: &str,
    expected_state: OperationState,
    next_state: OperationState,
    recorded_at_unix_ms: u64,
    provider_action_may_have_started: bool,
    prepared_receipt_hash: Option<&str>,
) -> Result<(), BrokerJournalError> {
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
    Ok(())
}

fn load_process_launch_from_connection(
    connection: &Connection,
    operation_id: &str,
) -> Result<BrokerProcessLaunchV1, BrokerJournalError> {
    let row = connection
        .query_row(
            "SELECT identity_payload, identity_hash, pid, process_group_id, session_id,
                    start_time_ticks, process_uid, boot_id_hash, gate_executable_hash,
                    target_executable_hash, launch_envelope_hash, release_state,
                    linked_at_unix_ms, release_authorized_at_unix_ms,
                    terminated_at_unix_ms, reconciliation_disposition
             FROM operation_processes WHERE operation_id = ?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                    row.get::<_, Option<i64>>(14)?,
                    row.get::<_, Option<String>>(15)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| BrokerJournalError::ProcessIdentityNotFound(operation_id.to_owned()))?;
    let identity: PreExecGateIdentityV1 = serde_json::from_slice(&row.0)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("process_identity_payload"))?;
    identity
        .validate_hash()
        .map_err(|_| BrokerJournalError::InvalidProcessIdentity)?;
    let identity_hash = Sha256Digest::from_str(&row.1)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("process_identity_hash"))?;
    let boot_id_hash = Sha256Digest::from_str(&row.7)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("process_boot_id_hash"))?;
    let gate_hash = Sha256Digest::from_str(&row.8)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("gate_executable_hash"))?;
    let target_hash = Sha256Digest::from_str(&row.9)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("target_executable_hash"))?;
    let envelope_hash = Sha256Digest::from_str(&row.10)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("launch_envelope_hash"))?;
    let pid = u32::try_from(row.2)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("process_pid"))?;
    let process_group_id = u32::try_from(row.3)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("process_group_id"))?;
    let session_id = u32::try_from(row.4)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("process_session_id"))?;
    let process_uid = u32::try_from(row.6)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("process_uid"))?;
    if identity_hash != identity.identity_hash
        || pid != identity.pid
        || process_group_id != identity.process_group_id
        || session_id != identity.session_id
        || from_i64(row.5)? != identity.start_time_ticks
        || process_uid != identity.uid
        || boot_id_hash != identity.boot_id_hash
        || gate_hash != identity.gate_executable.content_hash
        || target_hash != identity.target_executable.content_hash
        || envelope_hash != identity.launch_envelope.content_hash
    {
        return Err(BrokerJournalError::ProcessIdentityProjectionMismatch);
    }
    let linked_at_unix_ms = from_i64(row.12)?;
    let release_authorized_at_unix_ms = row.13.map(from_i64).transpose()?;
    let terminated_at_unix_ms = row.14.map(from_i64).transpose()?;
    let release_state = ProcessReleaseStateV1::from_db(&row.11)?;
    if release_authorized_at_unix_ms.is_some_and(|value| value < linked_at_unix_ms)
        || terminated_at_unix_ms.is_some_and(|value| value < linked_at_unix_ms)
        || (release_state == ProcessReleaseStateV1::Blocked
            && release_authorized_at_unix_ms.is_some())
        || (release_state == ProcessReleaseStateV1::Authorized
            && release_authorized_at_unix_ms.is_none())
        || (release_state == ProcessReleaseStateV1::Terminated && terminated_at_unix_ms.is_none())
    {
        return Err(BrokerJournalError::ProcessIdentityProjectionMismatch);
    }
    Ok(BrokerProcessLaunchV1 {
        operation_id: operation_id.to_owned(),
        identity,
        release_state,
        linked_at_unix_ms,
        release_authorized_at_unix_ms,
        terminated_at_unix_ms,
        reconciliation_disposition: row.15,
    })
}

fn valid_reason_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
        })
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

fn validate_process_projection(
    connection: &Connection,
    journal: &OperationJournalV1,
) -> Result<(), BrokerJournalError> {
    let process_transition = journal
        .transitions
        .iter()
        .find(|transition| transition.to == OperationState::ProcessSpawned);
    let process_exists = connection
        .query_row(
            "SELECT 1 FROM operation_processes WHERE operation_id = ?1",
            [&journal.operation_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    match (process_transition, process_exists) {
        (None, false) => Ok(()),
        (Some(transition), true) => {
            let launch = load_process_launch_from_connection(connection, &journal.operation_id)?;
            if transition.evidence_hash.as_ref() != Some(&launch.identity.identity_hash)
                || transition.recorded_at_unix_ms != launch.linked_at_unix_ms
            {
                return Err(BrokerJournalError::ProcessIdentityProjectionMismatch);
            }
            Ok(())
        }
        _ => Err(BrokerJournalError::ProcessIdentityProjectionMismatch),
    }
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
    #[error("process_spawned requires an exact durable gate identity")]
    ProcessSpawnedRequiresGateIdentity,
    #[error("durable gate process identity is invalid")]
    InvalidProcessIdentity,
    #[error("durable gate process identity already exists or differs")]
    ProcessIdentityConflict,
    #[error("durable gate process identity was not found: {0}")]
    ProcessIdentityNotFound(String),
    #[error("durable gate process identity projection differs from its payload")]
    ProcessIdentityProjectionMismatch,
    #[error("durable gate process state changed concurrently")]
    ConcurrentProcessStateChange,
    #[error("durable gate process was already terminated")]
    ProcessAlreadyTerminated,
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
    ProcessRuntime(hepta_codex_runtime::DurableGateError),
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}
