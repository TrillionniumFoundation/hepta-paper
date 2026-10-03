//! Cross-bind a concrete recoverability epoch to actual initial-runtime inputs.
//! This remains crate-private evidence, not native writer authorization or an
//! activated runtime. No transaction may waive the inventory checks below.
use super::*;
use crate::{
    sqlite_mutation_coordinator::{
        authority::{PinnedMutationAuthorityV1, ProcessMutationAuthorityTransportV1},
        manifest::writer_manifest_hash_v1,
    },
    state_backup_authority::{
        ProcessStateBackupAuthorityTransportV1, manifest::state_database_manifest_hash_v1,
    },
    state_database_inventory::ObservedStateDatabaseInventoryV1,
};

const ACTION: &str = "sqlite_online_mutation";

#[allow(dead_code)]
#[path = "activation_binding/native_transaction.rs"]
mod native_transaction;
pub(crate) use native_transaction::RetainedNativeStoreRecoverabilityV1;

/// Only the originating shared controller can renew/check this proof. Its JSON
/// fields are diagnostics and cannot be deserialized into a capability.
pub(crate) struct VerifiedRecoverabilityActivationBindingV1 {
    action: VerifiedRecoverabilityActionV1,
    value: Value,
    restore_source: Value,
}
impl VerifiedRecoverabilityActivationBindingV1 {
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }
    pub(crate) fn restore_source_inspection(&self) -> &Value {
        &self.restore_source
    }
}

impl<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>
    SharedRecoverabilityEpochFenceV1<B, O>
{
    pub(crate) fn assert_owner_inputs_with<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        check: impl FnOnce(
            &PinnedMutationAuthorityV1<T>,
            &PinnedMutationAuthorityV1<O>,
            &crate::state_backup_authority::PinnedStateBackupAuthorityV1<B>,
        ) -> Result<()>,
    ) -> Result<()> {
        let state = self.state.try_borrow().map_err(|_| denied("fence_busy"))?;
        check(
            authority,
            &state.controller.service.online,
            &state.controller.service.backup,
        )
    }

    fn activation_projection<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        action: &VerifiedRecoverabilityActionV1,
    ) -> Result<(Value, Value)> {
        self.assert_no_native_transaction()?;
        inventory.assert_current()?;
        authority.current()?;
        self.activation_projection_retained(inventory, authority, action)
    }

    // Pure subject projection. Its callers must separately establish either
    // full preflight currentness or the fixed native transaction guard.
    fn activation_projection_retained<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        action: &VerifiedRecoverabilityActionV1,
    ) -> Result<(Value, Value)> {
        let state = self.state.try_borrow().map_err(|_| denied("fence_busy"))?;
        let service = &state.controller.service;
        let evidence = state
            .controller
            .evidence
            .as_ref()
            .ok_or_else(|| denied("epoch_reconciliation_required"))?;
        let source = evidence.sources.source.inspection();
        let observed = inventory.value();
        let writer_hash = writer_manifest_hash_v1(&service.options.writer_manifest)?;
        let manifest_hash =
            state_database_manifest_hash_v1(&service.options.state_database_manifest)?;
        ensure(
            inventory.runtime_root() == service.options.runtime_root
                && evidence.sources.inventory.runtime_root() == inventory.runtime_root()
                && evidence.sources.inventory.value() == observed
                && observed["manifestHash"] == manifest_hash
                && source["manifestHash"] == manifest_hash
                && source["manifestId"] == observed["manifestId"]
                && authority.configuration_hash() == service.online.configuration_hash()
                && service.backup.online_mutation_configuration_hash()
                    == Some(authority.configuration_hash())
                && authority.trust()["databaseScopeHash"] == observed["databaseScopeHash"]
                && source["databaseScopeHash"] == observed["databaseScopeHash"]
                && authority.trust()["writerManifestHash"] == writer_hash
                && service.online.trust()["writerManifestHash"] == writer_hash
                && source["headSequence"] == action.value()["globalSequence"]
                && source["headHash"] == action.value()["globalHash"],
            &suffix("activation_binding_subject_mismatch"),
        )?;
        let value = json!({
            "version": 1,
            "kind": "AutonomousResearchRecoverabilityActivationBinding",
            "runtimeRoot": inventory.runtime_root(),
            "inventoryHash": observed["inventoryHash"],
            "databaseScopeHash": observed["databaseScopeHash"],
            "stateDatabaseManifestHash": manifest_hash,
            "writerManifestHash": writer_hash,
            "onlineAuthorityConfigurationHash": authority.configuration_hash(),
            "backupAuthorityConfigurationHash": service.backup.configuration_hash(),
            "restoreDrillReceiptHash": source["restoreDrillReceiptHash"],
            "restoreSourceInspectionHash": hash("AutonomousResearchStateBackupSourcesInspection", source)?,
            "globalSequence": action.value()["globalSequence"],
            "globalHash": action.value()["globalHash"],
        });
        Ok((value, source.clone()))
    }

    // The crate-visible generic core accepts only a caller-supplied retained
    // owner-currentness check. Product composition supplies either the exact
    // process pins or the installed socket/deployment pins; fixtures can provide
    // synthetic signed brokers only inside this module's tests.
    pub(crate) fn observe_activation_binding_with_pins<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        assert_process_pins: impl FnOnce() -> Result<()>,
    ) -> Result<VerifiedRecoverabilityActivationBindingV1> {
        let action = self.observe_action(ACTION)?;
        let (value, restore_source) = self.activation_projection(inventory, authority, &action)?;
        assert_process_pins()?;
        // File hashing and process-pin checks may consume evidence validity.
        // The concrete controller samples its clock again after that work.
        self.assert_action_current(&action, ACTION)?;
        Ok(VerifiedRecoverabilityActivationBindingV1 {
            action,
            value,
            restore_source,
        })
    }

    pub(crate) fn assert_activation_binding_with_pins<T: MutationAuthorityTransportV1>(
        &self,
        binding: &VerifiedRecoverabilityActivationBindingV1,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        assert_process_pins: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        self.assert_action_current(&binding.action, ACTION)?;
        let (value, source) = self.activation_projection(inventory, authority, &binding.action)?;
        ensure(
            value == binding.value && source == binding.restore_source,
            &suffix("activation_binding_subject_changed"),
        )?;
        assert_process_pins()?;
        self.assert_action_current(&binding.action, ACTION)
    }

    // Temporal tail only. The owning composition must first perform the full
    // currentness check above, finish all other I/O, then supply its own final
    // clock sample. This never rereads files, verifies signatures or calls RPC.
    pub(crate) fn assert_activation_binding_time(
        &self,
        binding: &VerifiedRecoverabilityActivationBindingV1,
        now: i64,
    ) -> Result<()> {
        if !std::rc::Rc::ptr_eq(&self.origin, &binding.action.origin) {
            return Err(denied("fence_origin_mismatch"));
        }
        if binding.action.value()["action"].as_str() != Some(ACTION) {
            return Err(denied("fence_action_mismatch"));
        }
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| denied("fence_busy"))?;
        if !std::rc::Rc::ptr_eq(&state.generation, &binding.action.generation) {
            return Err(denied("fence_generation_changed"));
        }
        let controller = &mut state.controller;
        controller.check_fatal()?;
        if controller.verified.is_none()
            || controller.dirty.is_some()
            || !controller.requirements.is_empty()
            || controller.evidence.is_none()
        {
            return Err(denied("epoch_reconciliation_required"));
        }
        if crate::sqlite_mutation_coordinator::clock::iso(now).is_err()
            || controller.last_clock.is_none_or(|last| now < last)
        {
            return Err(controller.enter_fatal(vec![suffix("clock_invalid")]));
        }
        // Even a sample that discovers expiry advances the high water. A later
        // earlier sample cannot make the expired evidence current again.
        controller.last_clock = Some(now);
        let evidence = controller
            .evidence
            .as_ref()
            .ok_or_else(|| denied("epoch_reconciliation_required"))?;
        let source = evidence.sources.source.inspection();
        let head = controller
            .verified
            .as_ref()
            .ok_or_else(|| denied("epoch_reconciliation_required"))?;
        ensure(
            source == &binding.restore_source
                && source["headSequence"] == binding.value["globalSequence"]
                && source["headHash"] == binding.value["globalHash"]
                && head["globalSequence"] == binding.value["globalSequence"]
                && head["globalHash"] == binding.value["globalHash"],
            &suffix("activation_binding_subject_changed"),
        )?;
        evidence.resident.assert_valid_at(now)?;
        evidence.observation.assert_valid_at(now, 0)?;
        let performed = timestamp(&source["restoreDrillPerformedAt"])
            .ok_or_else(|| denied("restore_source_stale"))?;
        ensure(
            now.checked_sub(performed)
                .is_some_and(|age| (0..=86_400_000).contains(&age)),
            "autonomous_research_state_backup_restore_source_stale",
        )
    }
}

impl
    SharedRecoverabilityEpochFenceV1<
        ProcessStateBackupAuthorityTransportV1,
        ProcessMutationAuthorityTransportV1,
    >
{
    pub(crate) fn assert_process_inputs_current_v1(&self) -> Result<()> {
        let state = self.state.try_borrow().map_err(|_| denied("fence_busy"))?;
        state
            .controller
            .service
            .online
            .assert_process_current_v1()?;
        state.controller.service.backup.assert_process_current_v1()
    }

    fn assert_process_subject_current(
        &self,
        authority: &PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>,
    ) -> Result<()> {
        authority.assert_process_current_v1()?;
        self.assert_process_inputs_current_v1()?;
        let state = self.state.try_borrow().map_err(|_| denied("fence_busy"))?;
        ensure(
            authority.process_configuration_hash()
                == state.controller.service.online.process_configuration_hash(),
            &suffix("activation_binding_process_subject_mismatch"),
        )
    }
}

#[cfg(test)]
#[path = "activation_binding_tests.rs"]
mod tests;
