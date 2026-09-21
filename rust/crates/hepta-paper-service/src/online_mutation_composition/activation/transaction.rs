//! Check original opaque evidence during a fixed native-store transaction.
//! This remains an internal prerequisite: it has no writable connection,
//! coordinator accessor, admission producer, permitted changeset or native
//! cutover grant. The owning writer must retain every scope until SQLite closes.
use super::*;
use crate::{
    online_authority_evidence_cache::verified::RetainedVerifiedAuthorityCacheV1,
    online_writer_static::RetainedWriterStaticInputsV1,
    state_database_inventory::NativeStoreTransactionInventoryGuardV1,
    state_recoverability::controller::RetainedNativeStoreRecoverabilityV1,
};

impl PreparedInitialOnlineMutationCompositionV1 {
    pub(super) fn assert_retained_evidence_for_native_store_transaction(
        &self,
        source: &RetainedWriterStaticInputsV1<'_>,
        cache: &RetainedVerifiedAuthorityCacheV1<'_>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
        recovery: &RetainedNativeStoreRecoverabilityV1<'_>,
    ) -> Result<()> {
        let mut clock = CompositionClock(&self.checked_at);
        let inventory = self.startup.post_inventory();
        guard.assert_bound_to(inventory)?;
        cache.assert_bound_to(&self.cache)?;
        self.package
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        self.manifest.assert_current()?;
        self.verifier.assert_process_current_v1()?;
        self.startup.assert_retained_for_native_store_transaction(
            &self.initial_inventory,
            &self.verifier,
            guard,
            &mut clock,
        )?;
        self.schema.assert_retained_for_native_store_transaction(
            inventory,
            &self.source,
            &self.active,
            &self.finalized,
            &self.verifier,
            source,
            guard,
            &mut clock,
        )?;
        self.finalized
            .assert_retained_for_native_store_transaction(
                inventory,
                &self.verifier,
                &self.source,
                &self.active,
                source,
                guard,
                &mut clock,
            )?;
        self.inspection
            .assert_retained_for_native_store_transaction(
                &self.verifier,
                inventory,
                &self.source,
                &self.active,
                source,
                guard,
                &mut clock,
            )?;
        cache.assert_current(&self.verifier, source, guard, &mut clock)?;
        self.fence
            .assert_native_store_transaction_current_v1(recovery, &self.verifier)?;
        self.coordinator.assert_configuration_current()?;
        self.package
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        guard.assert_bound_to(inventory)?;
        let completed = clock.now_millis()?;
        self.assert_evidence_valid_at(completed)?;
        self.fence
            .assert_native_store_transaction_valid_at_v1(recovery, completed)
    }
}
