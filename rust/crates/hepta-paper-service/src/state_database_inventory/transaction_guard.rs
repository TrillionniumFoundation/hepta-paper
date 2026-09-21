//! Local, fixed-target namespace/content checks while SQLite owns its locks.
//!
//! This is not admission, activation, a permitted SQL plan, or proof of a
//! changeset, origin, generation or finalized head. The upper owning runtime
//! must bind those separately, invalidate its capability on failure, and obtain
//! a complete fresh inventory after the transaction. No caller-selected skip
//! instance, writable connection or serialized readiness claim is accepted.
use super::{ObservedStateDatabaseInventoryV1, Result, ensure, error, files, text, tree};
use serde_json::Value;
use std::{
    cell::RefCell,
    fs::{self, Metadata},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[cfg(test)]
mod tests;

const CHANGED: &str = "autonomous_research_native_store_transaction_inventory_changed";
const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

/// Content, size and timestamps can change on the one SQLite write target;
/// identity, owner and permissions cannot. Directories intentionally do not pin
/// link counts or times: unrelated children of an ancestor such as /tmp are
/// outside the state inventory. Files always require exactly one hard link.
#[derive(Clone, Debug, Eq, PartialEq)]
struct StableIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
}
impl StableIdentity {
    fn of(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            uid: metadata.uid(),
            gid: metadata.gid(),
        }
    }
    fn assert_file(&self, metadata: &Metadata) -> Result<()> {
        ensure(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.nlink() == 1
                && metadata.len() <= files::MAX_FILE_BYTES
                && Self::of(metadata) == *self,
            CHANGED,
        )
    }
}

struct DirectoryPin<'a> {
    directory: &'a files::Directory,
    identity: StableIdentity,
}
impl DirectoryPin<'_> {
    fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        for metadata in [
            self.directory.held.metadata().map_err(|_| error(CHANGED))?,
            fs::symlink_metadata(&self.directory.path).map_err(|_| error(CHANGED))?,
        ] {
            ensure(
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && StableIdentity::of(&metadata) == self.identity,
                CHANGED,
            )?;
        }
        Ok(())
    }
}

struct OwnerPin {
    path: PathBuf,
    uid: u32,
    gid: u32,
}

/// Borrows the original observation, including all its open descriptors. It
/// cannot drop or reopen a descriptor of the target database or a sidecar.
/// Closing even a different raw descriptor for that inode could release the
/// process's POSIX SQLite locks, so transaction checks only use retained fstat /
/// read_at, named lstat, and directory traversal. New sidecars are never opened.
pub(crate) struct NativeStoreTransactionInventoryGuardV1<'a> {
    inventory: &'a ObservedStateDatabaseInventoryV1,
    target_index: usize,
    instance: &'a Value,
    directories: Vec<DirectoryPin<'a>>,
    non_target_owners: Vec<OwnerPin>,
    target_identity: StableIdentity,
    target_sidecars: RefCell<[Option<StableIdentity>; 3]>,
    tree_fingerprint: Value,
}

fn sidecar_path(source: &Path, suffix: &str) -> PathBuf {
    let mut path = source.as_os_str().to_owned();
    path.push(suffix);
    PathBuf::from(path)
}
fn optional_metadata(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(CHANGED)),
    }
}

impl ObservedStateDatabaseInventoryV1 {
    /// Mint before opening the owning SQLite connection, after all other full
    /// inventory observations have completed. The full preflight intentionally
    /// opens and closes raw source/sidecar descriptors: even an idle WAL
    /// connection can retain POSIX SHM locks that such closes would release.
    /// During the transaction use only the returned guard, retaining its source
    /// inventory until SQLite has completed commit/rollback and closed handles.
    pub(crate) fn native_store_transaction_guard_v1(
        &self,
    ) -> Result<NativeStoreTransactionInventoryGuardV1<'_>> {
        self.assert_current()?;
        let mut targets = self.report["instances"]
            .as_array()
            .ok_or_else(|| error(CHANGED))?
            .iter()
            .filter(|row| row["role"] == "native-store");
        let instance = targets.next().ok_or_else(|| error(CHANGED))?;
        ensure(targets.next().is_none(), CHANGED)?;
        let id = text(instance, "instanceId")?;
        let mut matches = self
            .databases
            .iter()
            .enumerate()
            .filter(|(_, (candidate, _))| candidate == id);
        let (target_index, (_, target)) = matches.next().ok_or_else(|| error(CHANGED))?;
        ensure(matches.next().is_none(), CHANGED)?;
        ensure(
            self.runtime_root
                .join(text(instance, "sourceRelativePath")?)
                == target.source.path,
            CHANGED,
        )?;
        let target_identity =
            StableIdentity::of(&target.source.file.metadata().map_err(|_| error(CHANGED))?);
        let directories = self
            .ancestors
            .iter()
            .chain(self.databases.iter().flat_map(|(_, db)| &db.parents))
            .map(|directory| {
                Ok(DirectoryPin {
                    directory,
                    identity: StableIdentity::of(
                        &directory.held.metadata().map_err(|_| error(CHANGED))?,
                    ),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut non_target_owners = Vec::new();
        for (index, (_, database)) in self.databases.iter().enumerate() {
            if index == target_index {
                continue;
            }
            for path in std::iter::once(database.source.path.clone()).chain(
                SIDECARS
                    .iter()
                    .map(|suffix| sidecar_path(&database.source.path, suffix)),
            ) {
                if let Some(metadata) = optional_metadata(&path)? {
                    non_target_owners.push(OwnerPin {
                        path,
                        uid: metadata.uid(),
                        gid: metadata.gid(),
                    });
                }
            }
        }
        let mut sidecars = [None, None, None];
        for (index, suffix) in SIDECARS.iter().enumerate() {
            sidecars[index] = optional_metadata(&sidecar_path(&target.source.path, suffix))?
                .as_ref()
                .map(StableIdentity::of);
        }
        let root = self.ancestors.last().ok_or_else(|| error(CHANGED))?;
        let (rows, blockers) = tree::collect(root, &self.manifest, false)?;
        ensure(blockers.is_empty(), CHANGED)?;
        let guard = NativeStoreTransactionInventoryGuardV1 {
            inventory: self,
            target_index,
            instance,
            directories,
            non_target_owners,
            target_identity,
            target_sidecars: RefCell::new(sidecars),
            tree_fingerprint: tree::fingerprint(&rows, &blockers),
        };
        // Bind all metadata captured above to the actual complete observation,
        // not a later replacement or a caller-supplied manifest projection.
        self.assert_current()?;
        guard.assert_during_transaction()?;
        Ok(guard)
    }
}

impl NativeStoreTransactionInventoryGuardV1<'_> {
    /// The genuine preconnection observation borrowed by this guard. Callers
    /// may bind retained evidence to it; this cannot create a new observation.
    pub(crate) fn pre_inventory(&self) -> &ObservedStateDatabaseInventoryV1 {
        self.inventory
    }

    pub(crate) fn instance(&self) -> &Value {
        self.instance
    }

    /// Bind an in-crate retained evidence check to this exact preconnection
    /// observation. Even an independently observed identical report cannot
    /// substitute for the borrowed origin. This still grants no write authority.
    pub(crate) fn assert_bound_to(
        &self,
        expected: &ObservedStateDatabaseInventoryV1,
    ) -> Result<()> {
        ensure(std::ptr::eq(self.inventory, expected), CHANGED)?;
        self.assert_during_transaction()
    }

    fn assert_tree(&self) -> Result<()> {
        let root = self
            .inventory
            .ancestors
            .last()
            .ok_or_else(|| error(CHANGED))?;
        let (rows, blockers) = tree::collect(root, &self.inventory.manifest, false)?;
        ensure(
            tree::fingerprint(&rows, &blockers) == self.tree_fingerprint,
            CHANGED,
        )
    }

    fn assert_target(&self) -> Result<()> {
        let target = &self.inventory.databases[self.target_index].1;
        self.target_identity
            .assert_file(&target.source.file.metadata().map_err(|_| error(CHANGED))?)?;
        self.target_identity
            .assert_file(&fs::symlink_metadata(&target.source.path).map_err(|_| error(CHANGED))?)?;
        ensure(self.target_identity.mode & 0o022 == 0, CHANGED)?;

        let parent = target
            .parents
            .last()
            .or_else(|| self.inventory.ancestors.last())
            .ok_or_else(|| error(CHANGED))?;
        let basename = target
            .source
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| error(CHANGED))?;
        let sqlite_prefix = format!("{basename}-");
        let allowed = SIDECARS.map(|suffix| format!("{basename}{suffix}"));
        // Only directory descriptors are opened here. Dot siblings such as the
        // external cutover enrollment marker are neither interpreted nor made
        // trusted by this primitive; their owning binding must validate them.
        for (index, entry) in fs::read_dir(parent.fd_path())
            .map_err(|_| error(CHANGED))?
            .enumerate()
        {
            ensure(index < 10_000, CHANGED)?;
            let name = entry.map_err(|_| error(CHANGED))?.file_name();
            let name = name.to_str().ok_or_else(|| error(CHANGED))?;
            ensure(
                !name.starts_with(&sqlite_prefix) || allowed.iter().any(|v| v == name),
                CHANGED,
            )?;
        }

        let mut sidecars = self.target_sidecars.borrow_mut();
        for (index, suffix) in SIDECARS.iter().enumerate() {
            let metadata = optional_metadata(&sidecar_path(&target.source.path, suffix))?;
            match (&sidecars[index], metadata) {
                (Some(identity), Some(metadata)) => identity.assert_file(&metadata)?,
                (Some(_), None) => return Err(error(CHANGED)),
                (None, Some(metadata)) => {
                    let identity = StableIdentity::of(&metadata);
                    identity.assert_file(&metadata)?;
                    sidecars[index] = Some(identity);
                }
                (None, None) => continue,
            }
            let identity = sidecars[index].as_ref().ok_or_else(|| error(CHANGED))?;
            ensure(
                identity.device == self.target_identity.device
                    && identity.uid == self.target_identity.uid
                    && identity.gid == self.target_identity.gid
                    && identity.mode & 0o022 == 0,
                CHANGED,
            )?;
        }
        // Existing observed WAL/SHM descriptors also have to remain linked to
        // the same safe inode. No new descriptor is opened or cloned.
        for (index, held) in [(0, target.wal.as_ref()), (1, target.shm.as_ref())] {
            if let Some(held) = held {
                sidecars[index]
                    .as_ref()
                    .ok_or_else(|| error(CHANGED))?
                    .assert_file(&held.file.metadata().map_err(|_| error(CHANGED))?)?;
            }
        }
        Ok(())
    }

    /// Checks the fixed native-store write target's safe namespace while all
    /// other database bytes, sidecars, candidate membership and blockers remain
    /// exactly bound to the original observation. No target content parity is
    /// claimed. This method and this guard's Drop never open/close a raw target
    /// or SQLite sidecar descriptor, invoke SQLite, or resolve a full inventory.
    ///
    /// Once observed, a sidecar must remain at that same inode for the duration
    /// of the transaction. Commit/rollback may delete sidecars afterwards; the
    /// caller then obtains a full fresh observation rather than reusing this
    /// guard across transactions.
    pub(crate) fn assert_during_transaction(&self) -> Result<()> {
        for directory in &self.directories {
            directory.assert_current()?;
        }
        self.assert_tree()?;
        self.assert_target()?;
        for (index, (_, database)) in self.inventory.databases.iter().enumerate() {
            if index != self.target_index {
                // Reads existing descriptors with read_at; never opens a file.
                database.assert_current()?;
            }
        }
        for pin in &self.non_target_owners {
            let metadata = fs::symlink_metadata(&pin.path).map_err(|_| error(CHANGED))?;
            ensure(
                metadata.uid() == pin.uid && metadata.gid() == pin.gid,
                CHANGED,
            )?;
        }
        self.assert_target()?;
        self.assert_tree()?;
        for directory in &self.directories {
            directory.assert_current()?;
        }
        Ok(())
    }
}
