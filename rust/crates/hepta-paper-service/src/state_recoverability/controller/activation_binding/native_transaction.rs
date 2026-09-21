//! Fixed native-store recoverability checks while SQLite retains its locks.
//! All full observations occur before the owner opens SQLite. This is retained
//! evidence, not writer admission, a SQL plan, or an activated runtime.
use super::*;
use crate::state_database_inventory::NativeStoreTransactionInventoryGuardV1;

/// The owner MUST retain this token and its borrowed original inventory until
/// every owning SQLite connection has closed, on success, failure and unwind.
/// Declare the token before the connection (reverse local-drop order), or make
/// the owning struct drop/close its connection before this field. Ending the SQL
/// transaction alone is insufficient: idle WAL connections retain SHM locks.
///
/// Holding the same Rc<Evidence>, rather than cloning its Files, keeps all old
/// raw database/WAL/SHM descriptors open even if controller feedback invalidates
/// the generation and clears its own evidence reference. Drop performs no I/O
/// until the last evidence owner is released; no custom destructor is needed.
pub(crate) struct RetainedNativeStoreRecoverabilityV1<'a> {
    binding: &'a VerifiedRecoverabilityActivationBindingV1,
    guard: &'a NativeStoreTransactionInventoryGuardV1<'a>,
    evidence: Rc<Evidence>,
    scope: Rc<()>,
}

impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    SharedRecoverabilityEpochFenceV1<B, O>
{
    fn assert_native_token(&self, token: &RetainedNativeStoreRecoverabilityV1<'_>) -> Result<()> {
        if !Rc::ptr_eq(&self.origin, &token.binding.action.origin) {
            return Err(denied("fence_origin_mismatch"));
        }
        let state = self.state.try_borrow().map_err(|_| denied("fence_busy"))?;
        ensure(
            state
                .native_transaction
                .upgrade()
                .is_some_and(|scope| Rc::ptr_eq(&scope, &token.scope)),
            &suffix("native_transaction_scope_changed"),
        )?;
        if !Rc::ptr_eq(&state.generation, &token.binding.action.generation) {
            return Err(denied("fence_generation_changed"));
        }
        state.controller.check_fatal()?;
        ensure(
            token.binding.action.value()["action"] == ACTION
                && state.controller.verified.is_some()
                && state.controller.dirty.is_none()
                && state.controller.requirements.is_empty()
                && state
                    .controller
                    .evidence
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &token.evidence)),
            &suffix("native_transaction_evidence_changed"),
        )
    }

    // A failed scope can never be retried into validity. Keep the token's Rc
    // alive; clearing only the controller reference cannot release SQLite locks.
    fn native_transaction_failure(
        &self,
        token: &RetainedNativeStoreRecoverabilityV1<'_>,
        mut failure: SqliteMutationCoordinatorError,
    ) -> SqliteMutationCoordinatorError {
        if Rc::ptr_eq(&self.origin, &token.binding.action.origin)
            && let Ok(mut state) = self.state.try_borrow_mut()
            && state
                .native_transaction
                .upgrade()
                .is_some_and(|scope| Rc::ptr_eq(&scope, &token.scope))
        {
            state.generation = Rc::new(());
            state.controller.dirty = Some(json!({"globalSequence":null,"globalHash":null}));
            state.controller.evidence = None;
        }
        if !failure.state_recoverability_fatal {
            failure.state_recoverability_deferred = true;
            failure.retryable = true;
        }
        failure
    }

    // Generic fixture core is visible only within activation_binding. The
    // crate-visible API below always supplies actual process transport checks.
    pub(super) fn retain_native_store_with_pins<'a, T: MutationAuthorityTransportV1>(
        &self,
        binding: &'a VerifiedRecoverabilityActivationBindingV1,
        guard: &'a NativeStoreTransactionInventoryGuardV1<'a>,
        authority: &PinnedMutationAuthorityV1<T>,
        assert_process_pins: impl Fn() -> Result<()>,
    ) -> Result<RetainedNativeStoreRecoverabilityV1<'a>> {
        self.assert_no_native_transaction()?;
        // This intentionally includes full inventory and resident-row
        // observation. It MUST run before any owning target connection opens.
        self.assert_activation_binding_with_pins(
            binding,
            guard.pre_inventory(),
            authority,
            &assert_process_pins,
        )?;
        guard.assert_during_transaction()?;
        let evidence = {
            let state = self.state.try_borrow().map_err(|_| denied("fence_busy"))?;
            Rc::clone(
                state
                    .controller
                    .evidence
                    .as_ref()
                    .ok_or_else(|| denied("epoch_reconciliation_required"))?,
            )
        };
        evidence
            .resident
            .assert_inventory_binding(guard.pre_inventory())?;
        ensure(
            evidence.sources.inventory.runtime_root() == guard.pre_inventory().runtime_root()
                && evidence.sources.inventory.value() == guard.pre_inventory().value(),
            &suffix("activation_binding_subject_mismatch"),
        )?;
        let scope = Rc::new(());
        {
            let mut state = self
                .state
                .try_borrow_mut()
                .map_err(|_| denied("fence_busy"))?;
            state.assert_no_native_transaction()?;
            ensure(
                Rc::ptr_eq(&state.generation, &binding.action.generation)
                    && state
                        .controller
                        .evidence
                        .as_ref()
                        .is_some_and(|current| Rc::ptr_eq(current, &evidence)),
                &suffix("native_transaction_evidence_changed"),
            )?;
            state.native_transaction = Rc::downgrade(&scope);
        }
        let token = RetainedNativeStoreRecoverabilityV1 {
            binding,
            guard,
            evidence,
            scope,
        };
        self.assert_native_store_with_pins(&token, authority, assert_process_pins)?;
        Ok(token)
    }

    pub(super) fn assert_native_store_with_pins<T: MutationAuthorityTransportV1>(
        &self,
        token: &RetainedNativeStoreRecoverabilityV1<'_>,
        authority: &PinnedMutationAuthorityV1<T>,
        assert_process_pins: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let checked = (|| {
            self.assert_native_token(token)?;
            token.guard.assert_during_transaction()?;
            authority.current()?;
            let (projection, source) = self.activation_projection_retained(
                token.guard.pre_inventory(),
                authority,
                &token.binding.action,
            )?;
            ensure(
                projection == token.binding.value && source == token.binding.restore_source,
                &suffix("activation_binding_subject_changed"),
            )?;
            let now = self
                .state
                .try_borrow_mut()
                .map_err(|_| denied("fence_busy"))?
                .controller
                .now()?
                .0;
            let evidence = &token.evidence;
            let original = token.guard.pre_inventory();
            evidence
                .sources
                .source
                .assert_current(original.value(), now)?;
            if let Some(replay) = &evidence.sources.current_replay {
                replay.assert_matches(original, evidence.sources.source.inspection())?;
            }
            // The original resident row was queried and validated before mint.
            // Exact non-target bytes and this held inode preserve that row; do
            // not call ResidentLeaseV1::assert_current or open live SQLite here.
            evidence.resident.assert_inventory_binding(original)?;
            evidence.resident.assert_current(now)?;
            {
                let state = self.state.try_borrow().map_err(|_| denied("fence_busy"))?;
                state
                    .controller
                    .service
                    .assert_observation(&evidence.observation, now)?;
                state.controller.service.online.current()?;
            }
            evidence.observation.assert_current(
                &evidence.sources.source,
                original.value(),
                now,
                0,
            )?;
            assert_process_pins()?;
            token.guard.assert_during_transaction()?;
            self.assert_native_token(token)?;
            let completed = self
                .state
                .try_borrow_mut()
                .map_err(|_| denied("fence_busy"))?
                .controller
                .now()?
                .0;
            // Temporal tail: after all filesystem/signature operations.
            self.assert_native_store_time(token, completed)
        })();
        checked.map_err(|e| self.native_transaction_failure(token, e))
    }

    pub(super) fn assert_native_store_time(
        &self,
        token: &RetainedNativeStoreRecoverabilityV1<'_>,
        now: i64,
    ) -> Result<()> {
        let result = self
            .assert_native_token(token)
            .and_then(|()| self.assert_activation_binding_time(token.binding, now));
        result.map_err(|e| self.native_transaction_failure(token, e))
    }
}

impl
    SharedRecoverabilityEpochFenceV1<
        ProcessStateBackupAuthorityTransportV1,
        ProcessMutationAuthorityTransportV1,
    >
{
    /// Mint before opening the target SQLite connection. This token must outlive
    /// that connection, including rollback, finalization feedback and unwind.
    pub(crate) fn retain_native_store_transaction_v1<'a>(
        &self,
        binding: &'a VerifiedRecoverabilityActivationBindingV1,
        guard: &'a NativeStoreTransactionInventoryGuardV1<'a>,
        authority: &PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>,
    ) -> Result<RetainedNativeStoreRecoverabilityV1<'a>> {
        self.retain_native_store_with_pins(binding, guard, authority, || {
            self.assert_process_subject_current(authority)
        })
    }

    pub(crate) fn assert_native_store_transaction_current_v1(
        &self,
        token: &RetainedNativeStoreRecoverabilityV1<'_>,
        authority: &PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>,
    ) -> Result<()> {
        self.assert_native_store_with_pins(token, authority, || {
            self.assert_process_subject_current(authority)
        })
    }

    /// Only the terminal temporal tail. The owning composition must first run
    /// the full retained currentness check and all other I/O, then sample its
    /// own concrete clock. No raw descriptors are opened or closed here.
    pub(crate) fn assert_native_store_transaction_valid_at_v1(
        &self,
        token: &RetainedNativeStoreRecoverabilityV1<'_>,
        now: i64,
    ) -> Result<()> {
        self.assert_native_store_time(token, now)
    }
}
