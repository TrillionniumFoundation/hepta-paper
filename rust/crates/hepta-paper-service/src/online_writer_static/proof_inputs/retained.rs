//! Retain actual complete source files before opening the owning SQLite
//! connection. Transaction checks never reopen a source pathname: even a
//! rejected replacement could alias SQLite and release its POSIX locks on close.
use super::*;
use crate::{
    online_runtime_activation::active_refresh::VerifiedActiveAuthorityEvidenceV1,
    sqlite_mutation_coordinator::{
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::{MutationClockV1, iso},
        contracts::live,
    },
    state_database_inventory::{
        NativeStoreTransactionInventoryGuardV1, ObservedStateDatabaseInventoryV1,
    },
};

#[cfg(test)]
#[path = "retained/tests.rs"]
mod tests;

/// Local source retention, not active evidence, admission or a write scope.
/// Construction borrows genuine opaque source/inventory/active producers;
/// callers cannot select a file subset, change limits or supply trusted JSON.
pub(crate) struct RetainedWriterStaticInputsV1<'a> {
    source: &'a VerifiedWriterStaticCoverageV1,
    inventory: &'a ObservedStateDatabaseInventoryV1,
    active: &'a VerifiedActiveAuthorityEvidenceV1,
    authority_hash: String,
    source_hash: String,
    active_hash: String,
    inventory_hash: String,
    files: RetainedFiles<'a>,
}

struct RetainedFiles<'a> {
    inputs: &'a CompleteStaticInputs,
    files: BTreeMap<PathBuf, File>,
}
impl CompleteStaticInputs {
    fn retain_files(&self) -> Result<RetainedFiles<'_>> {
        self.assert_current()?;
        if self.files.len() > MAX_FILES
            || self.directories.len() > MAX_DIRECTORIES
            || self.bytes > MAX_BYTES
        {
            return Err(invalid());
        }
        let mut files = BTreeMap::new();
        for (path, input) in &self.files {
            let parent = &self.directories[&input.parent];
            parent.current()?;
            let file = File::from(
                openat(
                    &parent.file,
                    Path::new(&input.name),
                    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                    Mode::empty(),
                )
                .map_err(|_| changed())?,
            );
            assert_file(input, &file)?;
            files.insert(path.clone(), file);
        }
        let retained = RetainedFiles {
            inputs: self,
            files,
        };
        retained.assert_current()?;
        self.assert_current()?;
        retained.assert_current()?;
        Ok(retained)
    }
}

fn assert_file(input: &FileInput, file: &File) -> Result<()> {
    // No regular file opens, descriptor clones or temporary File values here.
    // Named identity is checked before and after hashing the retained handle.
    for after_hash in [false, true] {
        let named = fs::symlink_metadata(&input.source.path).map_err(|_| changed())?;
        let held = file.metadata().map_err(|_| changed())?;
        if !named.is_file()
            || named.is_symlink()
            || identity(&named) != input.source.identity
            || identity(&held) != input.source.identity
            || named.uid() != input.uid
            || named.gid() != input.gid
            || held.uid() != input.uid
            || held.gid() != input.gid
        {
            return Err(changed());
        }
        if !after_hash {
            let (current, uid, gid) = read_file(&input.source.path, file)?;
            if current.identity != input.source.identity
                || current.hash != input.source.hash
                || uid != input.uid
                || gid != input.gid
            {
                return Err(changed());
            }
        }
    }
    Ok(())
}
impl RetainedFiles<'_> {
    fn assert_current(&self) -> Result<()> {
        if self.files.len() != self.inputs.files.len() {
            return Err(changed());
        }
        for directory in self.inputs.directories.values() {
            directory.current()?;
        }
        for path in &self.inputs.absent {
            if !matches!(fs::symlink_metadata(path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
            {
                return Err(changed());
            }
        }
        for (path, input) in &self.inputs.files {
            assert_file(input, self.files.get(path).ok_or_else(changed)?)?;
        }
        for directory in self.inputs.directories.values() {
            directory.current()?;
        }
        Ok(())
    }
}

impl VerifiedWriterStaticCoverageV1 {
    /// Must run before opening this process's owning SQLite connection, even
    /// before an idle WAL connection: full preflight may close raw SHM handles.
    /// Keep the returned object until that connection is closed on every path.
    pub(crate) fn retain_for_native_store_transaction_v1<'a, T: MutationAuthorityTransportV1>(
        &'a self,
        inventory: &'a ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        active: &'a VerifiedActiveAuthorityEvidenceV1,
        clock: &mut dyn MutationClockV1,
    ) -> Result<RetainedWriterStaticInputsV1<'a>> {
        let before = clock.now_millis()?;
        iso(before)?;
        inventory.assert_current()?;
        active.assert_current(authority, inventory.value(), self, before)?;
        let files = self.inputs.retain_files()?;
        inventory.assert_current()?;
        files.assert_current()?;
        authority.current()?;
        let source_hash = self.value()["astGateReceiptHash"]
            .as_str()
            .ok_or_else(changed)?
            .into();
        let active_hash = active.receipt_hash()?;
        let inventory_hash = inventory.value()["inventoryHash"]
            .as_str()
            .ok_or_else(changed)?
            .into();
        let after = clock.now_millis()?;
        iso(after)?;
        if after < before
            || [
                ("currentHead", "observedAt"),
                ("activeChallenge", "challengedAt"),
                ("brokerScope", "observedAt"),
            ]
            .iter()
            .any(|(kind, field)| {
                !live(
                    &active.value()["authorityEvidence"][kind]["receipt"],
                    authority.trust(),
                    field,
                    after,
                )
            })
        {
            return Err(changed());
        }
        Ok(RetainedWriterStaticInputsV1 {
            source: self,
            inventory,
            active,
            authority_hash: authority.configuration_hash().into(),
            source_hash,
            active_hash,
            inventory_hash,
            files,
        })
    }
}
impl RetainedWriterStaticInputsV1<'_> {
    pub(crate) fn source(&self) -> &VerifiedWriterStaticCoverageV1 {
        self.source
    }
    pub(crate) fn inventory(&self) -> &ObservedStateDatabaseInventoryV1 {
        self.inventory
    }
    pub(crate) fn active(&self) -> &VerifiedActiveAuthorityEvidenceV1 {
        self.active
    }
    /// Checks only retained local source bytes and exact opaque subject
    /// bindings. The active-evidence owner must still verify signatures and its
    /// final time; success here is never an authority or mutation capability.
    pub(crate) fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        source: &VerifiedWriterStaticCoverageV1,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        active: &VerifiedActiveAuthorityEvidenceV1,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
    ) -> Result<()> {
        if !std::ptr::eq(source, self.source)
            || !std::ptr::eq(inventory, self.inventory)
            || !std::ptr::eq(active, self.active)
            || authority.configuration_hash() != self.authority_hash
            || source.value()["astGateReceiptHash"] != self.source_hash
            || inventory.value()["inventoryHash"] != self.inventory_hash
            || active.receipt_hash()? != self.active_hash
        {
            return Err(changed());
        }
        guard.assert_bound_to(inventory)?;
        self.files.assert_current()?;
        authority.current()?;
        guard.assert_bound_to(inventory)
    }
}
