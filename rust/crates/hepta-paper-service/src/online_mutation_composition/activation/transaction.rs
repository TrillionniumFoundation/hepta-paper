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

// A borrowed view keeps the coordinator out of callback captures, allowing its
// exclusive mutable borrow without unsafe code or interior-mutability escape.
pub(super) struct NativeTransactionEvidenceV1<'a> {
    pub(super) manifest: &'a ManifestFile,
    pub(super) initial_inventory: &'a ObservedStateDatabaseInventoryV1,
    pub(super) startup: &'a VerifiedStartupReconciliationSetV1,
    pub(super) schema: &'a RetainedSchemaEvidenceV1,
    pub(super) source: &'a VerifiedWriterStaticCoverageV1,
    pub(super) active: &'a VerifiedActiveAuthorityEvidenceV1,
    pub(super) finalized: &'a VerifiedFinalizedInventoryV1,
    pub(super) inspection: &'a VerifiedOnlineAuthorityInspectionV1,
    pub(super) cache: &'a VerifiedAuthorityCacheWriteV1,
    pub(super) fence: &'a Fence,
    pub(super) verifier: &'a Online,
    pub(super) installed_authority: Option<&'a RetainedInstalledAuthorityV2>,
    pub(super) checked_at: &'a Cell<i64>,
    pub(super) package: &'a PackageDeletionWriterGuard,
}
impl<'a> From<&'a PreparedInitialOnlineMutationCompositionV1> for NativeTransactionEvidenceV1<'a> {
    fn from(value: &'a PreparedInitialOnlineMutationCompositionV1) -> Self {
        Self {
            manifest: &value.manifest,
            initial_inventory: &value.initial_inventory,
            startup: &value.startup,
            schema: &value.schema,
            source: &value.source,
            active: &value.active,
            finalized: &value.finalized,
            inspection: &value.inspection,
            cache: &value.cache,
            fence: &value.fence,
            verifier: &value.verifier,
            installed_authority: value.installed_authority.as_ref(),
            checked_at: &value.checked_at,
            package: &value.package,
        }
    }
}
impl PreparedInitialOnlineMutationCompositionV1 {
    pub(super) fn assert_retained_evidence_for_native_store_transaction(
        &self,
        source: &RetainedWriterStaticInputsV1<'_>,
        cache: &RetainedVerifiedAuthorityCacheV1<'_>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
        recovery: &RetainedNativeStoreRecoverabilityV1<'_>,
    ) -> Result<()> {
        self.coordinator.assert_configuration_current()?;
        NativeTransactionEvidenceV1::from(self).assert_current(source, cache, guard, recovery)
    }
}
impl NativeTransactionEvidenceV1<'_> {
    pub(super) fn assert_current(
        &self,
        source: &RetainedWriterStaticInputsV1<'_>,
        cache: &RetainedVerifiedAuthorityCacheV1<'_>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
        recovery: &RetainedNativeStoreRecoverabilityV1<'_>,
    ) -> Result<()> {
        let mut clock = CompositionClock(self.checked_at);
        let inventory = self.startup.post_inventory();
        guard.assert_bound_to(inventory)?;
        cache.assert_bound_to(self.cache)?;
        self.package
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        self.manifest.assert_current()?;
        self.verifier
            .assert_transport_current_v1(OnlineAuthorityTransportV1::assert_current)?;
        self.startup.assert_retained_for_native_store_transaction(
            self.initial_inventory,
            self.verifier,
            guard,
            &mut clock,
        )?;
        self.schema.assert_retained_for_native_store_transaction(
            inventory,
            self.source,
            self.active,
            self.finalized,
            self.verifier,
            source,
            guard,
            &mut clock,
        )?;
        self.finalized
            .assert_retained_for_native_store_transaction(
                inventory,
                self.verifier,
                self.source,
                self.active,
                source,
                guard,
                &mut clock,
            )?;
        self.inspection
            .assert_retained_for_native_store_transaction(
                self.verifier,
                inventory,
                self.source,
                self.active,
                source,
                guard,
                &mut clock,
            )?;
        cache.assert_current(self.verifier, source, guard, &mut clock)?;
        self.fence
            .assert_native_store_with_pins(recovery, self.verifier, || {
                assert_product_owner_current(self.installed_authority, self.fence, self.verifier)
            })?;
        self.package
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        guard.assert_bound_to(inventory)?;
        let completed = clock.now_millis()?;
        self.assert_evidence_valid_at(completed)?;
        self.fence.assert_native_store_time(recovery, completed)
    }
}
