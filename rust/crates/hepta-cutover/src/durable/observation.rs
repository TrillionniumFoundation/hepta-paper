//! Borrowed external-v2 storage evidence while the original journal lock is held.
use super::*;

/// Callback-local observation of the existing external-v2 enrollment. Private
/// fields prevent construction from JSON, paths or a copied durable state. This
/// grants no production qualification, native admission or business operation.
///
/// It owns no Files and cannot outlive the journal transaction. Every check uses
/// the original retained directory/marker pins, named metadata, held marker
/// read_at, and the original SQLite journal connection. No target, journal or
/// replacement marker is reopened, including on a rejection path.
pub struct ExternalWriterStorageObservationV2<'scope> {
    storage: &'scope storage::ExternalStorageV2,
    target: &'scope Path,
    connection: &'scope Connection,
    state: &'scope DurableCutoverStateV1,
}

impl ExternalWriterStorageObservationV2<'_> {
    /// Recheck complete enrollment identity, fixed journal schema and the exact
    /// locked durable state without opening or closing a regular-file handle.
    pub fn assert_current(&self) -> Result<(), DurableCutoverError> {
        self.storage.assert_current(self.target, self.connection)?;
        if load_state(self.connection)? != *self.state {
            return Err(DurableCutoverError::JournalCorrupt);
        }
        Ok(())
    }

    /// Retained canonical root. This diagnostic is not a currentness check or
    /// authority; the owning callback must call assert_current at its boundaries.
    pub fn external_storage_root_v2(&self) -> &Path {
        self.storage.root_path()
    }

    /// Immutable enrollment-marker digest, with the same diagnostic limitations
    /// as external_storage_root_v2. The marker is reread only through its held FD.
    pub fn external_storage_enrollment_hash_v2(&self) -> &str {
        self.storage.enrollment_hash()
    }
}

impl DurableCutoverCoordinatorV1 {
    /// Observe an actual production ShadowVerified state under the external-v2
    /// journal lock, before a signed canary authorization exists. The writer
    /// must still be disabled, with no canary scope or activation receipt.
    ///
    /// This is a diagnostic observation, not a writer lease, transition, signed
    /// authorization or permission to mutate the application. No journal state
    /// is written. The callback receives neither a Connection nor a SQL surface.
    /// All regular-file captures must finish before this coordinator is opened;
    /// while its SQLite connection lives use only retained currentness checks.
    /// Storage and the exact locked state are checked before and after callback
    /// execution. Callback errors are preserved, and unwind releases the lock.
    pub fn with_production_shadow_observation_v2<T>(
        &mut self,
        action: impl FnOnce(
            &DurableCutoverStateV1,
            &ExternalWriterStorageObservationV2<'_>,
        ) -> Result<T, String>,
    ) -> Result<T, DurableCutoverError> {
        let storage = self
            .external_storage
            .as_ref()
            .ok_or(DurableCutoverError::InvalidInput)?;
        self.validate_identity()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        storage.assert_current(&self.database_path, &tx)?;
        let state = load_state(&tx)?;
        if state.mode != DurableCutoverModeV1::Production {
            return Err(DurableCutoverError::ProductionAuthorityRequired);
        }
        require_shadow(&state)?;
        if state.writer_id.is_some()
            || !state.canary_scopes.is_empty()
            || state.production_activation
            || state.activation_receipt_hash.is_some()
            || state.shadow_cases > MAX_SAFE_INTEGER
            || state.revision == 0
        {
            return Err(DurableCutoverError::IllegalTransition);
        }
        let observation = ExternalWriterStorageObservationV2 {
            storage,
            target: &self.database_path,
            connection: &tx,
            state: &state,
        };
        observation.assert_current()?;
        let result = action(&state, &observation).map_err(DurableCutoverError::Application);
        let completed = observation.assert_current();
        drop(tx);
        match result {
            Err(cause) => Err(cause),
            Ok(value) => {
                completed?;
                Ok(value)
            }
        }
    }

    /// Only external-v2 enrollments support this borrowed storage observation.
    /// The same lease/scope/phase rules as with_writer_state_v1 apply, including
    /// Planned and RolledBack compatibility. A native production owner must
    /// separately require its exact signed Production+Canary writer subject.
    ///
    /// Storage is checked before/after the synchronous callback; the callback
    /// must ALSO check the observation at every required precommit boundary.
    /// A post-callback failure cannot roll back a business commit. Keep the
    /// actual mutation outcome separately when reporting such a failure. If the
    /// callback itself fails, its Application error is preserved.
    ///
    /// This method exposes no journal connection and adds no raw SQLite FD pin.
    /// Its observation must never be replaced by opening another coordinator
    /// while a target SQLite connection is alive.
    pub fn with_writer_state_and_external_storage_v2<T>(
        &mut self,
        lease: &WriterFenceV1,
        scope: &str,
        action: impl FnOnce(
            &DurableCutoverStateV1,
            &ExternalWriterStorageObservationV2<'_>,
        ) -> Result<T, String>,
    ) -> Result<T, DurableCutoverError> {
        let storage = self
            .external_storage
            .as_ref()
            .ok_or(DurableCutoverError::InvalidInput)?;
        self.validate_identity()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        storage.assert_current(&self.database_path, &tx)?;
        let state = load_state(&tx)?;
        if state.writer_fence().as_ref() != Some(lease) {
            return Err(DurableCutoverError::StaleWriter);
        }
        if state.phase == DurableCutoverPhaseV1::Canary
            && !state.canary_scopes.iter().any(|allowed| allowed == scope)
        {
            return Err(DurableCutoverError::CanaryScopeRejected);
        }
        if !matches!(
            state.phase,
            DurableCutoverPhaseV1::Planned
                | DurableCutoverPhaseV1::Canary
                | DurableCutoverPhaseV1::Active
                | DurableCutoverPhaseV1::RolledBack
        ) {
            return Err(DurableCutoverError::WriterDisabled);
        }
        let observation = ExternalWriterStorageObservationV2 {
            storage,
            target: &self.database_path,
            connection: &tx,
            state: &state,
        };
        observation.assert_current()?;
        let result = action(&state, &observation).map_err(DurableCutoverError::Application);
        let completed = observation.assert_current();
        // Observation and state borrow the transaction and own no file handle.
        // Releasing this read-only journal lock never undoes a target commit.
        drop(tx);
        match result {
            Err(cause) => Err(cause),
            Ok(value) => {
                completed?;
                Ok(value)
            }
        }
    }
}
