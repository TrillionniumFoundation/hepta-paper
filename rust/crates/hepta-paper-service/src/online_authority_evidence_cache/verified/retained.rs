//! Fixed cache-file retention for a future owning native-store transaction.
//! This never records/renews authority, opens a source database, grants native
//! scope or converts a cached JSON document into verified active evidence.
use super::*;
use crate::{
    online_writer_static::RetainedWriterStaticInputsV1,
    state_database_inventory::NativeStoreTransactionInventoryGuardV1,
};
#[cfg(test)]
#[path = "retained/tests.rs"]
mod tests;

pub(crate) struct RetainedVerifiedAuthorityCacheV1<'a> {
    proof: &'a VerifiedAuthorityCacheWriteV1,
    inventory: &'a ObservedStateDatabaseInventoryV1,
    source: &'a VerifiedWriterStaticCoverageV1,
    active: &'a VerifiedActiveAuthorityEvidenceV1,
    directory: files::Directory,
    parents: files::RetainedParentIdentities,
    file: files::FileEntry,
    inventory_hash: String,
    source_hash: String,
    document: Value,
}
impl VerifiedAuthorityCacheWriteV1 {
    /// All constructors must finish before the owning SQLite connection is
    /// opened. Keep the result until that connection has closed on every path.
    pub(crate) fn retain_for_native_store_transaction_v1<'a, T: MutationAuthorityTransportV1>(
        &'a self,
        authority: &PinnedMutationAuthorityV1<T>,
        active: &'a VerifiedActiveAuthorityEvidenceV1,
        inventory: &'a ObservedStateDatabaseInventoryV1,
        source: &'a VerifiedWriterStaticCoverageV1,
        clock: &mut dyn MutationClockV1,
    ) -> Result<RetainedVerifiedAuthorityCacheV1<'a>> {
        let mut previous = None;
        let mut clock = || {
            let now = clock.now_millis()?;
            crate::sqlite_mutation_coordinator::clock::iso(now)?;
            if previous.is_some_and(|last| now < last) {
                return Err(failure("verified_evidence_expired"));
            }
            previous = Some(now);
            Ok(now)
        };
        self.assert_current(authority, active, inventory, source, &mut clock)?;
        let directory = files::Directory::open(&self.root, false)?;
        let parents = directory.retain_parent_identities()?;
        let file = directory
            .read("current.json", MAXIMUM_BYTES, 0o400, 1)?
            .ok_or_else(|| failure("missing"))?;
        let document = file.json()?;
        contract::assert_cache_v1(
            &document,
            Some(text(inventory.value(), "databaseScopeHash")?),
            Some(text(authority.trust(), "writerManifestHash")?),
            None,
        )?;
        if document["cacheHash"] != self.receipt["cacheHash"]
            || document["activeRefreshReceiptHash"] != self.evidence_hash
        {
            return Err(failure("verified_cache_changed"));
        }
        self.assert_current(authority, active, inventory, source, &mut clock)?;
        file.assert_retained_bytes(&directory, "current.json")?;
        parents.assert_current(&directory)?;
        let inventory_hash = text(inventory.value(), "inventoryHash")?.into();
        let source_hash = text(source.value(), "astGateReceiptHash")?.into();
        let completed = clock.now_millis()?;
        if timestamp(&self.receipt["expiresAt"]).is_none_or(|end| completed >= end) {
            return Err(failure("verified_evidence_expired"));
        }
        current_time(authority, active, completed)?;
        Ok(RetainedVerifiedAuthorityCacheV1 {
            proof: self,
            inventory,
            source,
            active,
            directory,
            parents,
            file,
            inventory_hash,
            source_hash,
            document,
        })
    }
}
impl RetainedVerifiedAuthorityCacheV1<'_> {
    /// Bind an aggregate to this exact original opaque cache producer. An
    /// independently verified same-subject or same-receipt object is distinct.
    pub(crate) fn assert_bound_to(&self, expected: &VerifiedAuthorityCacheWriteV1) -> Result<()> {
        if !std::ptr::eq(self.proof, expected) {
            return Err(failure("verified_evidence_subject_changed"));
        }
        Ok(())
    }
    /// Bound to the original actual source/active/inventory objects and their
    /// original hashes. The guard replaces only target-byte currentness;
    /// signatures, cache bytes, source membership and final expiry remain live.
    pub(crate) fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        retained_source: &RetainedWriterStaticInputsV1<'_>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        if !std::ptr::eq(self.inventory, retained_source.inventory())
            || !std::ptr::eq(self.source, retained_source.source())
            || !std::ptr::eq(self.active, retained_source.active())
            || self.inventory.value()["inventoryHash"] != self.inventory_hash
            || self.source.value()["astGateReceiptHash"] != self.source_hash
            || self.inventory.runtime_root() != self.proof.root
            || authority.configuration_hash() != self.proof.authority_configuration_hash
            || self.active.receipt_hash()? != self.proof.evidence_hash
        {
            return Err(failure("verified_evidence_subject_changed"));
        }
        guard.assert_bound_to(self.inventory)?;
        self.parents.assert_current(&self.directory)?;
        self.file
            .assert_retained_bytes(&self.directory, "current.json")?;
        self.parents.assert_current(&self.directory)?;
        contract::assert_cache_v1(
            &self.document,
            Some(text(self.inventory.value(), "databaseScopeHash")?),
            Some(text(authority.trust(), "writerManifestHash")?),
            None,
        )?;
        if self.document["cacheHash"] != self.proof.receipt["cacheHash"]
            || self.document["activeRefreshReceiptHash"] != self.proof.evidence_hash
        {
            return Err(failure("verified_cache_changed"));
        }
        let before = clock.now_millis()?;
        self.active.assert_retained_for_native_store_transaction(
            authority,
            self.inventory,
            self.source,
            retained_source,
            guard,
            before,
        )?;
        self.file
            .assert_retained_bytes(&self.directory, "current.json")?;
        guard.assert_bound_to(self.inventory)?;
        self.parents.assert_current(&self.directory)?;
        let after = clock.now_millis()?;
        if after < before
            || after >= expires(self.active)?
            || timestamp(&self.proof.receipt["expiresAt"]).is_none_or(|end| after >= end)
        {
            return Err(failure("verified_evidence_expired"));
        }
        current_time(authority, self.active, after)
    }
}
