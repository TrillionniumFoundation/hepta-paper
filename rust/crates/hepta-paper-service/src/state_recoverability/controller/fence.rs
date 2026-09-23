//! Shared, concrete recoverability observations for explicitly named actions.
//! This is not an Active runtime, a distributed lease, or business authorization.
use super::*;
use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

#[path = "activation_binding.rs"]
mod activation_binding;
#[allow(unused_imports)]
pub(crate) use activation_binding::RetainedNativeStoreRecoverabilityV1;
pub(crate) use activation_binding::VerifiedRecoverabilityActivationBindingV1;

struct State<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1> {
    controller: StateRecoverabilityControllerV1<B, O>,
    generation: Rc<()>,
    native_transaction: Weak<()>,
}

/// An action observation minted only by a concrete recoverability controller.
/// JSON projections cannot construct or restore it. It must be checked again by
/// the originating fence immediately before its caller's independently authorized
/// action. It is deliberately neither serializable nor a standalone permission.
///
/// ```compile_fail
/// use hepta_paper_service::state_recoverability::controller::VerifiedRecoverabilityActionV1;
/// let _: VerifiedRecoverabilityActionV1 =
///     serde_json::from_value(serde_json::json!({"ready": true})).unwrap();
/// ```
#[derive(Debug)]
pub struct VerifiedRecoverabilityActionV1 {
    permit: RecoverabilityEpochPermitV1,
    origin: Rc<()>,
    generation: Rc<()>,
}
impl VerifiedRecoverabilityActionV1 {
    /// Diagnostic projection only; copying this value does not copy the proof.
    pub fn value(&self) -> &Value {
        self.permit.value()
    }
}

/// Shares one concrete controller between its owner and coordinator feedback.
/// Clones use the same origin, generation, clocks and observed files. No public
/// getter exposes the controller or permits replacing its evidence with JSON.
///
/// This follows the existing single-threaded transport/clock contract. A future
/// production composition must own its real clock and authority transports.
/// Supplying an arbitrary implementation of `RecoverabilityEpochFenceV1` cannot
/// construct this handle or an action proof.
///
/// While the internal fixed native-store transaction scope is retained, all
/// clones reject full observe/assert/reconcile operations before filesystem I/O.
/// Memory-only finalization/reconciliation feedback remains available and can
/// invalidate the scope. This is per-origin sequencing, not a process-global
/// guard against unrelated code opening or closing database descriptors.
pub struct SharedRecoverabilityEpochFenceV1<
    B: StateBackupAuthorityTransportV1,
    O: MutationAuthorityTransportV1,
> {
    state: Rc<RefCell<State<B, O>>>,
    origin: Rc<()>,
}
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1> Clone
    for SharedRecoverabilityEpochFenceV1<B, O>
{
    fn clone(&self) -> Self {
        Self {
            state: Rc::clone(&self.state),
            origin: Rc::clone(&self.origin),
        }
    }
}
fn denied(reason: &str) -> SqliteMutationCoordinatorError {
    let mut e = error(suffix(reason));
    e.state_recoverability_deferred = true;
    e.retryable = true;
    e
}
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    SharedRecoverabilityEpochFenceV1<B, O>
{
    pub fn new(controller: StateRecoverabilityControllerV1<B, O>) -> Self {
        Self {
            state: Rc::new(RefCell::new(State {
                controller,
                generation: Rc::new(()),
                native_transaction: Weak::new(),
            })),
            origin: Rc::new(()),
        }
    }
    pub fn epoch_status(&self) -> Result<Value> {
        self.state
            .try_borrow()
            .map(|s| s.controller.epoch_status())
            .map_err(|_| denied("fence_busy"))
    }
    // Rotate even when a transition fails or returns a deferred diagnostic.
    // Existing tokens keep their allocation alive, so address reuse cannot make
    // an old token current, and a same-head reconcile never revives old tokens.
    fn transition(
        &self,
        apply: impl FnOnce(&mut StateRecoverabilityControllerV1<B, O>) -> Result<Value>,
    ) -> Result<Value> {
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| denied("fence_busy"))?;
        state.generation = Rc::new(());
        apply(&mut state.controller)
    }
    pub fn reconcile_with_validity(&self, required_validity_ms: i64) -> Result<Value> {
        self.assert_no_native_transaction()?;
        self.transition(|c| c.reconcile_with_validity(required_validity_ms))
    }
    pub fn mark_finalized(&self, head: &Value) -> Result<Value> {
        self.transition(|c| c.mark_finalized(head))
    }
    pub fn require_reconciliation(&self, requirement: &Value) -> Result<Value> {
        self.transition(|c| c.require_reconciliation(requirement))
    }
    pub fn observe_action(&self, action: &str) -> Result<VerifiedRecoverabilityActionV1> {
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| denied("fence_busy"))?;
        state.assert_no_native_transaction()?;
        let permit = state.observe(action)?;
        Ok(VerifiedRecoverabilityActionV1 {
            permit,
            origin: Rc::clone(&self.origin),
            generation: Rc::clone(&state.generation),
        })
    }
    /// Re-observes the real sources, live inventory, resident lease and pins.
    /// This does not execute the action or substitute for its business policy.
    pub fn assert_action_current(
        &self,
        token: &VerifiedRecoverabilityActionV1,
        action: &str,
    ) -> Result<()> {
        if !Rc::ptr_eq(&self.origin, &token.origin) {
            return Err(denied("fence_origin_mismatch"));
        }
        if token.value()["action"].as_str() != Some(action) {
            return Err(denied("fence_action_mismatch"));
        }
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| denied("fence_busy"))?;
        state.assert_no_native_transaction()?;
        if !Rc::ptr_eq(&state.generation, &token.generation) {
            return Err(denied("fence_generation_changed"));
        }
        let current = state.observe(action)?;
        if current.value() != token.value() {
            state.generation = Rc::new(());
            return Err(denied("fence_head_changed"));
        }
        Ok(())
    }

    fn assert_no_native_transaction(&self) -> Result<()> {
        self.state
            .try_borrow()
            .map_err(|_| denied("fence_busy"))?
            .assert_no_native_transaction()
    }
}
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1> State<B, O> {
    fn assert_no_native_transaction(&self) -> Result<()> {
        if self.native_transaction.upgrade().is_some() {
            return Err(denied("native_transaction_full_observation_forbidden"));
        }
        Ok(())
    }
    fn observe(&mut self, action: &str) -> Result<RecoverabilityEpochPermitV1> {
        self.assert_no_native_transaction()?;
        let result = self.observe_checked(action);
        if let Err(mut e) = result {
            self.generation = Rc::new(());
            self.controller.dirty = Some(json!({"globalSequence":null,"globalHash":null}));
            self.controller.evidence = None;
            if !e.state_recoverability_fatal {
                e.state_recoverability_deferred = true;
                e.retryable = true;
            }
            return Err(e);
        }
        result
    }
    fn observe_checked(&mut self, action: &str) -> Result<RecoverabilityEpochPermitV1> {
        let permit = self.controller.assert_for_action(action)?;
        let at = self
            .controller
            .last_clock
            .ok_or_else(|| denied("clock_invalid"))?;
        let evidence = self
            .controller
            .evidence
            .as_ref()
            .ok_or_else(|| denied("epoch_reconciliation_required"))?;
        // Repeat the actual file/pin checks after the inner controller's final
        // clock callback. Generic transports' private state is not observed here;
        // the production process transport independently pins itself on invoke.
        evidence.sources.assert_current(at)?;
        evidence.resident.assert_current(at)?;
        self.controller
            .service
            .assert_observation(&evidence.observation, at)?;
        self.controller.service.online.current()?;
        evidence.observation.assert_current(
            &evidence.sources.source,
            evidence.sources.inventory.value(),
            at,
            0,
        )?;
        // Last sample is after all I/O. The following checks only inspect memory.
        // These are explicit observation boundaries, not an atomic filesystem
        // transaction. An arbitrary malicious clock callback cannot be made safe
        // by an unbounded clock/IO loop; production composition must own a clock.
        let completed = self.controller.now()?.0;
        let evidence = self
            .controller
            .evidence
            .as_ref()
            .ok_or_else(|| denied("epoch_reconciliation_required"))?;
        evidence.resident.assert_valid_at(completed)?;
        evidence.observation.assert_valid_at(completed, 0)?;
        // This field comes from the private, verified source, not a caller value.
        // Keep the same inclusive 24h source-age boundary as assert_current.
        let performed = timestamp(&evidence.sources.source.inspection()["restoreDrillPerformedAt"])
            .ok_or_else(|| denied("restore_source_stale"))?;
        ensure(
            completed
                .checked_sub(performed)
                .is_some_and(|age| (0..=86_400_000).contains(&age)),
            "autonomous_research_state_backup_restore_source_stale",
        )?;
        Ok(permit)
    }
}
// Existing low-level coordinator compatibility is feedback only. Neither Node
// nor Rust implicitly adds per-SQL epoch authorization through this trait.
impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1> RecoverabilityEpochFenceV1
    for SharedRecoverabilityEpochFenceV1<B, O>
{
    fn mark_mutation_finalized(&mut self, head: &Value) -> Result<()> {
        self.mark_finalized(head).map(|_| ())
    }
    fn mark_mutation_reconciliation_required(&mut self, value: &Value) -> Result<()> {
        self.require_reconciliation(value).map(|_| ())
    }
    fn assert_current(&mut self) -> Result<Value> {
        self.observe_action("sqlite_online_mutation")
            .map(|v| v.value().clone())
    }
    fn reconcile(&mut self) -> Result<Value> {
        self.reconcile_with_validity(0)
    }
}
