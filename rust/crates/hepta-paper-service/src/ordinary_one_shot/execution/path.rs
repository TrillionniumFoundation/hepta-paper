//! Leaf identity rules only. Directory traversal/admission remain owned by the
//! existing held-chain Directory; SQLite alone owns transaction recovery.
use super::*;
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    os::{fd::AsFd, unix::fs::MetadataExt},
};
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const INVALID: &str = "campaign_one_shot_attempt_journal_file_invalid";
const CHANGED: &str = "campaign_one_shot_attempt_journal_path_identity_changed";
#[cfg(test)]
#[derive(Clone, Copy)]
pub(super) enum ReopenSwap {
    Leaf,
    ControlRoot,
    AncestorSibling,
}

pub(super) fn private_directory(directory: &Directory) -> Result<(), String> {
    directory.assert_current().map_err(|e| e.to_string())?;
    let m = directory.held.metadata().map_err(|_| CHANGED)?;
    if m.mode() & 0o777 != 0o700 {
        return Err("campaign_one_shot_attempt_control_root_invalid".into());
    }
    Ok(())
}
fn valid(m: &Metadata) -> bool {
    m.is_file()
        && m.nlink() == 1
        && m.uid() == nix::unistd::getuid().as_raw()
        && m.mode() & 0o777 == 0o600
        && m.len() <= MAX_BYTES
}
fn stable(a: &Metadata, b: &Metadata) -> bool {
    valid(a)
        && valid(b)
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
}
fn exact(a: &Metadata, b: &Metadata) -> bool {
    stable(a, b)
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
pub(super) fn open_file(directory: &Directory) -> Result<File, String> {
    private_directory(directory)?;
    let flags = OFlag::O_RDWR | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK;
    let opened = openat(
        directory.held.as_fd(),
        super::super::JOURNAL_NAME,
        flags,
        Mode::empty(),
    );
    let file = match opened {
        Ok(fd) => File::from(fd),
        Err(nix::errno::Errno::ENOENT) => {
            // O_EXCL never adopts a concurrently installed foreign leaf.
            directory
                .write_new(super::super::JOURNAL_NAME, &[])
                .map_err(|e| e.to_string())?;
            directory.sync_with_parents().map_err(|e| e.to_string())?;
            File::from(
                openat(
                    directory.held.as_fd(),
                    super::super::JOURNAL_NAME,
                    flags,
                    Mode::empty(),
                )
                .map_err(|_| INVALID)?,
            )
        }
        Err(_) => return Err(INVALID.into()),
    };
    let held = file.metadata().map_err(|_| INVALID)?;
    let named = fs::symlink_metadata(directory.path.join(super::super::JOURNAL_NAME))
        .map_err(|_| INVALID)?;
    if !exact(&held, &named) {
        return Err(INVALID.into());
    }
    private_directory(directory)?;
    Ok(file)
}
impl OneShotJournalV1<'_> {
    #[cfg(test)]
    fn reopen_paths(
        &self,
        kind: ReopenSwap,
    ) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
        let base = self.directory.path.parent().ok_or(CHANGED)?;
        Ok((
            match kind {
                ReopenSwap::Leaf => self.directory.path.join(super::super::JOURNAL_NAME),
                ReopenSwap::ControlRoot => self.directory.path.clone(),
                ReopenSwap::AncestorSibling => return Err(CHANGED.into()),
            },
            base.join("test-foreign"),
            base.join("test-original"),
        ))
    }
    #[cfg(test)]
    fn reopen_swap_before(&self) -> Result<(), String> {
        if let Some(kind) = self.reopen_swap.get() {
            if matches!(kind, ReopenSwap::AncestorSibling) {
                let sibling = self
                    .directory
                    .path
                    .parent()
                    .ok_or(CHANGED)?
                    .join("test-unrelated-sibling");
                fs::create_dir(&sibling).map_err(|e| e.to_string())?;
                fs::remove_dir(&sibling).map_err(|e| e.to_string())?;
                return Ok(());
            }
            let (named, foreign, original) = self.reopen_paths(kind)?;
            fs::rename(&named, &original).map_err(|e| e.to_string())?;
            if let Err(e) = fs::rename(&foreign, &named) {
                fs::rename(&original, &named).map_err(|e| e.to_string())?;
                return Err(e.to_string());
            }
        }
        Ok(())
    }
    #[cfg(test)]
    fn reopen_swap_after(&self) -> Result<(), String> {
        if let Some(kind) = self.reopen_swap.take() {
            if matches!(kind, ReopenSwap::AncestorSibling) {
                return Ok(());
            }
            let (named, foreign, original) = self.reopen_paths(kind)?;
            fs::rename(&named, &foreign).map_err(|e| e.to_string())?;
            fs::rename(&original, &named).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn reopen_namespace(&self) -> Result<Vec<Vec<u8>>, String> {
        let mut directory = nix::dir::Dir::openat(
            self.directory.held.as_fd(),
            Path::new("."),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| CHANGED)?;
        let mut names = Vec::new();
        let mut bytes = 0usize;
        let mut seen = false;
        for entry in directory.iter() {
            self.control.checkpoint().map_err(|e| e.to_string())?;
            let entry = entry.map_err(|_| CHANGED)?;
            let name = entry.file_name().to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            if names.len() >= 4096 {
                return Err("campaign_one_shot_attempt_journal_namespace_limit_exceeded".into());
            }
            bytes = bytes
                .checked_add(name.len())
                .filter(|n| *n <= 1024 * 1024)
                .ok_or("campaign_one_shot_attempt_journal_namespace_limit_exceeded")?;
            seen |= name == super::super::JOURNAL_NAME.as_bytes();
            // Original private roots may contain retained unknown sibling
            // artifacts. Observe their names, never open, adopt or clean them.
            names.push(name.to_vec());
        }
        if !seen {
            return Err(CHANGED.into());
        }
        names.sort();
        Ok(names)
    }
    pub(super) fn assert_identity(&self) -> Result<Metadata, String> {
        self.control.checkpoint().map_err(|e| e.to_string())?;
        self.runtime
            .require_control_context_v1(&self.control.cancelled, self.control.deadline)?;
        self.runtime.assert_current()?;
        private_directory(&self.directory)?;
        let held = self.file.metadata().map_err(|_| CHANGED)?;
        let named = fs::symlink_metadata(self.directory.path.join(super::super::JOURNAL_NAME))
            .map_err(|_| CHANGED)?;
        if !stable(&self.epoch, &held) || !exact(&held, &named) {
            return Err(CHANGED.into());
        }
        Ok(held)
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        if self.poisoned.get() {
            return Err("campaign_one_shot_attempt_journal_commit_outcome_unknown".into());
        }
        let current = self.assert_identity()?;
        if !exact(&self.epoch, &current) {
            return Err(CHANGED.into());
        }
        Ok(())
    }
    pub(super) fn accept_own_mutation(&mut self) -> Result<(), String> {
        // Only called after fixed schema and exact requested records were
        // independently observed. Never called on an unknown/foreign outcome.
        self.epoch = self.assert_identity()?;
        self.assert_current()
    }
    pub(super) fn sidecars_absent(&self) -> Result<(), String> {
        for suffix in ["-journal", "-wal", "-shm"] {
            match fs::symlink_metadata(
                self.directory
                    .path
                    .join(format!("{}{suffix}", super::super::JOURNAL_NAME)),
            ) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err("campaign_one_shot_attempt_journal_sidecar_forbidden".into()),
            }
        }
        Ok(())
    }
    fn reopen_retry_current(
        &self,
        entered: &Metadata,
        namespace: &[Vec<u8>],
        continuity: &super::reopen_continuity::NamedReopenContinuityV1<'_>,
    ) -> Result<(), String> {
        let result = (|| {
            continuity.assert_current()?;
            let current = self.assert_identity()?;
            if !exact(entered, &current) || self.reopen_namespace()? != namespace {
                return Err(CHANGED.into());
            }
            self.sidecars_absent()?;
            continuity.assert_current()
        })();
        if result.is_err() {
            self.poisoned.set(true);
        }
        result
    }
    pub(super) fn open_connection(&self, writable: bool) -> Result<Connection, String> {
        self.assert_identity()?;
        self.sidecars_absent()?;
        let continuity = super::reopen_continuity::NamedReopenContinuityV1::observe(
            &self.directory,
            &self.control,
        )?;
        // Repin initial leaf and namespace only after every kernel watch is
        // registered. The same observation covers all subsequent reopen tries.
        let entered = self.assert_identity()?;
        let namespace = self.reopen_namespace()?;
        continuity.assert_current()?;
        let mut accepted = None;
        let mut refused = CHANGED.to_owned();
        // A transient full-ancestor epoch can be invalidated by an unrelated
        // sibling. Retry only before any PRAGMA or transaction, under positive
        // kernel continuity for every selected component and the private root.
        // Each accepted connection must pass the original full reopen epoch.
        for _ in 0..3 {
            self.control.checkpoint().map_err(|e| e.to_string())?;
            let epoch = match self.directory.observe_reopen_epoch_v1() {
                Ok(epoch) => epoch,
                Err(error) => {
                    refused = error.to_string();
                    self.reopen_retry_current(&entered, &namespace, &continuity)?;
                    continue;
                }
            };
            #[cfg(test)]
            self.reopen_swap_before()?;
            let opened = Connection::open_with_flags(
                self.directory.path.join(super::super::JOURNAL_NAME),
                (if writable {
                    OpenFlags::SQLITE_OPEN_READ_WRITE
                } else {
                    OpenFlags::SQLITE_OPEN_READ_ONLY
                }) | OpenFlags::SQLITE_OPEN_NOFOLLOW
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            );
            #[cfg(test)]
            self.reopen_swap_after()?;
            let current = epoch.assert_current();
            self.reopen_retry_current(&entered, &namespace, &continuity)?;
            match current {
                Ok(()) => {
                    accepted = Some(opened.map_err(|e| e.to_string())?);
                    break;
                }
                Err(error) => {
                    // The connection has not executed a PRAGMA or query.
                    // Closing it grants no action; the journal epoch is never
                    // rebased, and a relevant event poisons the original owner.
                    drop(opened);
                    refused = error.to_string();
                }
            }
        }
        let connection = accepted.ok_or_else(|| {
            self.poisoned.set(true);
            refused
        })?;
        self.control
            .install(&connection)
            .map_err(|e| e.to_string())?;
        if writable {
            connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;")
                .map_err(|e|self.control.map_database(e).to_string())?;
            let size: i64 = connection
                .query_row("PRAGMA page_size", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if size < 512 {
                return Err("campaign_one_shot_attempt_journal_pragma_invalid".into());
            }
            connection
                .pragma_update(None, "max_page_count", (MAX_BYTES as i64) / size)
                .map_err(|e| e.to_string())?;
        } else {
            connection
                .execute_batch("PRAGMA foreign_keys=ON; PRAGMA query_only=ON;")
                .map_err(|e| self.control.map_database(e).to_string())?;
        }
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let fk: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if mode != "delete" || fk != 1 {
            return Err("campaign_one_shot_attempt_journal_pragma_invalid".into());
        }
        self.assert_identity()?;
        self.sidecars_absent()?;
        Ok(connection)
    }
}
