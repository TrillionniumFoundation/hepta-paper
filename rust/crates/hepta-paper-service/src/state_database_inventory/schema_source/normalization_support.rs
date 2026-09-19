//! Private physical work used only by the typed maintenance executor. The guard
//! is its real complete-scope/signature/clock revalidation, not public user input.
use super::*;
use nix::{
    fcntl::{OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use std::fs::File;

impl SchemaSource {
    pub(crate) fn root_matches(&self, other: &Self) -> bool {
        self.root_identity == other.root_identity
    }
    pub(crate) fn original_root_identity(&self) -> &Value {
        &self.root_identity
    }
    pub(crate) fn normalization_state(&self) -> Value {
        let mut value = self.description.clone();
        value["sidecarsPresent"] =
            json!(self.database.wal.is_some() || self.database.shm.is_some());
        value
    }
    pub(crate) fn assert_registered_namespace(
        &self,
        manifest: &Value,
        expected: &Value,
    ) -> Result<()> {
        for parent in &self.ancestors {
            parent.assert_current()?;
        }
        let root = self.ancestors.last().ok_or_else(files::changed)?;
        ensure(
            root_identity(root)? == self.root_identity,
            "autonomous_research_online_schema_transition_runtime_root_identity_changed",
        )?;
        let (actual, blockers) = super::super::tree::collect(root, manifest, false)?;
        let expected = expected.as_array().ok_or_else(files::changed)?;
        ensure(
            blockers.is_empty()
                && actual.len() == expected.len()
                && actual.iter().all(|candidate| {
                    expected.iter().any(|row| {
                        row["databaseRole"] == candidate.definition["role"]
                            && row["schemaContractId"] == candidate.definition["schemaContractId"]
                            && row["sourceRelativePath"].as_str() == candidate.relative.to_str()
                    })
                }),
            "autonomous_research_online_schema_transition_normalization_scope_changed",
        )?;
        root.assert_current()
    }
    fn stable_source(&self) -> Result<()> {
        for parent in self.ancestors.iter().chain(&self.database.parents) {
            parent.assert_current()?;
        }
        ensure(
            root_identity(self.ancestors.last().ok_or_else(files::changed)?)? == self.root_identity,
            "autonomous_research_online_schema_transition_runtime_root_identity_changed",
        )?;
        let named =
            std::fs::symlink_metadata(&self.database.source.path).map_err(|_| files::changed())?;
        let held = self
            .database
            .source
            .file
            .metadata()
            .map_err(|_| files::changed())?;
        let expected = &self.database.source.metadata;
        for metadata in [&named, &held] {
            ensure(
                metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.nlink() == 1
                    && files::identity(metadata)["device"] == expected["device"]
                    && files::identity(metadata)["inode"] == expected["inode"]
                    && files::identity(metadata)["mode"] == expected["mode"],
                "autonomous_research_online_schema_transition_database_identity_changed",
            )?;
        }
        Ok(())
    }
}
fn present(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(files::changed()),
    }
}
fn sidecar(source: &SchemaSource, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", source.database.source.path.display()))
}
fn remove_stale_shm(
    source: &SchemaSource,
    guard: &mut dyn FnMut() -> Result<()>,
    fault: &mut dyn FnMut(&str) -> Result<()>,
) -> Result<()> {
    let path = sidecar(source, "-shm");
    if !present(&path)? {
        return Ok(());
    }
    guard()?;
    source.stable_source()?;
    ensure(
        !present(&sidecar(source, "-wal"))?,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe",
    )?;
    let directory = source
        .database
        .parents
        .last()
        .or_else(|| source.ancestors.last())
        .ok_or_else(files::changed)?;
    let name = path.file_name().ok_or_else(files::changed)?;
    let before = std::fs::symlink_metadata(&path).map_err(|_| files::changed())?;
    ensure(
        before.is_file() && !before.file_type().is_symlink() && before.nlink() == 1,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe",
    )?;
    let held = File::from(
        openat(
            &directory.held,
            Path::new(name),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| files::changed())?,
    );
    let identity = files::identity(&before);
    ensure(
        files::identity(&held.metadata().map_err(|_| files::changed())?) == identity,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe",
    )?;
    // Guard may read all sources and public-key pins; recheck the exact SHM
    // after that I/O, immediately before the identity-bound removal.
    guard()?;
    source.stable_source()?;
    ensure(
        !present(&sidecar(source, "-wal"))?
            && files::identity(&held.metadata().map_err(|_| files::changed())?) == identity
            && files::identity(&std::fs::symlink_metadata(&path).map_err(|_| files::changed())?)
                == identity,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe",
    )?;
    // Moving the entry first lets us inspect the inode actually removed from
    // the shared name. Direct stat-then-unlink could delete a replacement.
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| files::changed())?;
    let temporary = format!(".hepta-schema-shm-{}", hex::encode(random));
    mkdirat(
        &directory.held,
        temporary.as_str(),
        Mode::from_bits_truncate(0o700),
    )
    .map_err(|_| files::changed())?;
    let private = File::from(
        openat(
            &directory.held,
            temporary.as_str(),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| files::changed())?,
    );
    let private_before = private.metadata().map_err(|_| files::changed())?;
    ensure(
        private_before.is_dir()
            && private_before.nlink() == 2
            && private_before.uid() == nix::unistd::geteuid().as_raw()
            && private_before.mode() & 0o777 == 0o700,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe",
    )?;
    // A crash may leave this private artifact. It is never trusted as authority
    // or recursively deleted by recovery.
    fault("before_stale_shm_quarantine")?;
    // A checkpoint may block or observe outside work; do not carry its old
    // lease sample or WAL-absence observation across that callback.
    guard()?;
    source.stable_source()?;
    ensure(
        !present(&sidecar(source, "-wal"))?,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe",
    )?;
    renameat2(
        &directory.held,
        Path::new(name),
        &private,
        "entry",
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|_| files::changed())?;
    let moved = openat(
        &private,
        "entry",
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .ok()
    .map(File::from);
    let matches = moved
        .as_ref()
        .and_then(|f| f.metadata().ok())
        .is_some_and(|m| {
            m.is_file()
                && m.dev() == before.dev()
                && m.ino() == before.ino()
                && m.mode() == before.mode()
                && m.uid() == before.uid()
                && m.gid() == before.gid()
                && m.nlink() == 1
                && m.size() == before.size()
                && m.mtime() == before.mtime()
                && m.mtime_nsec() == before.mtime_nsec()
        });
    if !matches || present(&sidecar(source, "-wal"))? {
        // Never overwrite a newer shared-name entry and never delete the moved
        // foreign inode. If restoring is impossible, retain the quarantine.
        let _ = renameat2(
            &private,
            "entry",
            &directory.held,
            Path::new(name),
            RenameFlags::RENAME_NOREPLACE,
        );
        directory.held.sync_all().map_err(|_| files::changed())?;
        return Err(error(
            "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe",
        ));
    }
    unlinkat(&private, "entry", UnlinkatFlags::NoRemoveDir).map_err(|_| files::changed())?;
    private.sync_all().map_err(|_| files::changed())?;
    // Leave the empty private directory as harmless crash/audit evidence. No
    // cleanup follows attacker-controlled names or recursively removes entries.
    ensure(
        !present(&path)?,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_failed",
    )?;
    directory.held.sync_all().map_err(|_| files::changed())?;
    source.stable_source()
}
/// Called solely after a live typed reservation and its required source bindings
/// have passed. The caller reobserves the exact signed projection after return.
/// Errors never claim rollback of a checkpoint that SQLite already performed.
pub(crate) fn normalize_step(
    source: &SchemaSource,
    guard: &mut dyn FnMut() -> Result<()>,
    fault: &mut dyn FnMut(&str) -> Result<()>,
) -> Result<()> {
    guard()?;
    source.assert_current()?;
    let database = Connection::open_with_flags(
        &source.database.source.path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    // This remains a named-path SQLite VFS guarded before/after by held source
    // identity. It does not claim protection against every same-user ABA race.
    source.stable_source()?;
    // A quiesced source must not wait on another SQLite writer. A fixed busy
    // wait could obtain its write lock only after the signed lease expired.
    database.busy_timeout(std::time::Duration::ZERO)?;
    let initial: String = database.query_row("PRAGMA journal_mode;", [], |row| row.get(0))?;
    if present(&sidecar(source, "-wal"))? && initial == "delete" {
        guard()?;
        source.stable_source()?;
        let mode: String = database.query_row("PRAGMA journal_mode=WAL;", [], |row| row.get(0))?;
        ensure(
            mode == "wal",
            "autonomous_research_online_schema_transition_stale_sidecar_cleanup_failed",
        )?;
    }
    guard()?;
    source.stable_source()?;
    let busy: i64 = database.query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |row| row.get(0))?;
    ensure(
        busy == 0,
        "autonomous_research_online_schema_transition_checkpoint_busy",
    )?;
    fault("after_journal_checkpoint")?;
    guard()?;
    source.stable_source()?;
    let mode: String = database.query_row("PRAGMA journal_mode=DELETE;", [], |row| row.get(0))?;
    ensure(
        mode == "delete",
        "autonomous_research_online_schema_transition_journal_mode_normalization_failed",
    )?;
    database.execute_batch("PRAGMA synchronous=FULL;")?;
    drop(database);
    source.stable_source()?;
    remove_stale_shm(source, guard, fault)?;
    ensure(
        !present(&sidecar(source, "-wal"))? && !present(&sidecar(source, "-shm"))?,
        "autonomous_research_online_schema_transition_wal_or_shm_present",
    )?;
    source
        .database
        .source
        .file
        .sync_all()
        .map_err(|_| files::changed())?;
    guard()?;
    source.stable_source()
}

#[cfg(test)]
mod tests;
