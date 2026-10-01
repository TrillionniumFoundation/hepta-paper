//! Root-owned persistent stop barriers. Errors and process death retain every
//! published marker/drop-in; no Drop implementation restarts a writer.
use super::{SchemaOperationIdentityV1, installation::ObservedInstalledSchemaProfileV1};
use crate::{
    sqlite_mutation_coordinator::authority::files::Snapshot,
    sqlite_mutation_coordinator::{Result, error, hash_bytes},
    state_recoverability::publication::Directory,
};
use nix::{
    fcntl::{Flock, FlockArg, OFlag, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, Metadata},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

pub(super) const DROP_IN_NAME: &str = "90-hepta-paper-native-schema-maintenance.conf";
pub(super) const AUTHORITY_DROP_IN_NAME: &str = "92-hepta-paper-native-schema-authority-stop.conf";
const MARKER: &str = "BLOCKED";
const CODE: &str = "autonomous_research_installed_schema_barrier_changed_or_unsafe";

fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(CODE)
}

/// The shared publisher retains inode identity. The installed barrier also
/// requires every ancestor to exclude non-root renames and durably syncs all
/// directory entries before migration can begin.
pub(super) struct ProtectedDirectory {
    directory: Directory,
    ancestors: Vec<(PathBuf, File, Metadata)>,
}
impl std::ops::Deref for ProtectedDirectory {
    type Target = Directory;
    fn deref(&self) -> &Directory {
        &self.directory
    }
}
fn protected(metadata: &Metadata) -> bool {
    metadata.is_dir() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0
}
impl ProtectedDirectory {
    pub(super) fn open_or_create(path: &Path, create: bool) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|p| !matches!(p, Component::RootDir | Component::Normal(_)))
        {
            return Err(invalid());
        }
        // Check existing ancestry before asking the shared owner to create any
        // missing directory. Fixed system paths never allow sticky exceptions.
        for parent in path.ancestors() {
            match fs::symlink_metadata(parent) {
                Ok(m) if protected(&m) && !m.is_symlink() => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => (),
                _ => return Err(invalid()),
            }
        }
        let directory = Directory::open_or_create(path, create)?;
        let mut file = File::open("/").map_err(|_| invalid())?;
        let mut current = PathBuf::from("/");
        let mut ancestors = vec![(
            current.clone(),
            file.try_clone().map_err(|_| invalid())?,
            file.metadata().map_err(|_| invalid())?,
        )];
        for part in path.components() {
            let Component::Normal(name) = part else {
                continue;
            };
            file = File::from(
                openat(
                    file.as_fd(),
                    Path::new(name),
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| invalid())?,
            );
            current.push(name);
            let metadata = file.metadata().map_err(|_| invalid())?;
            if !protected(&metadata) {
                return Err(invalid());
            }
            ancestors.push((
                current.clone(),
                file.try_clone().map_err(|_| invalid())?,
                metadata,
            ));
        }
        let value = Self {
            directory,
            ancestors,
        };
        value.assert_current()?;
        // Child metadata and then each parent directory entry are durable,
        // including directories newly created by open_or_create.
        for (_, file, _) in value.ancestors.iter().rev() {
            file.sync_all().map_err(|_| invalid())?;
        }
        value.assert_current()?;
        Ok(value)
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        let projection = |m: &Metadata| (m.dev(), m.ino(), m.uid(), m.gid(), m.mode());
        for (path, file, original) in &self.ancestors {
            let held = file.metadata().map_err(|_| invalid())?;
            let named = fs::symlink_metadata(path).map_err(|_| invalid())?;
            if !protected(&held)
                || !protected(&named)
                || named.is_symlink()
                || projection(&held) != projection(original)
                || projection(&named) != projection(original)
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

pub(super) struct Barrier {
    parent: ProtectedDirectory,
    operation: ProtectedDirectory,
    lock: Flock<File>,
    lock_path: PathBuf,
    lock_identity: (u64, u64),
    marker: Snapshot,
    drop_ins: Vec<(ProtectedDirectory, Snapshot)>,
}
impl Barrier {
    pub(super) fn any_published(
        profile: &ObservedInstalledSchemaProfileV1,
        operation: &SchemaOperationIdentityV1,
    ) -> Result<bool> {
        profile.assert_current()?;
        let mut paths = profile
            .source_units()
            .iter()
            .map(|u| {
                PathBuf::from("/etc/systemd/system")
                    .join(format!("{}.d", u.unit))
                    .join(DROP_IN_NAME)
            })
            .collect::<Vec<_>>();
        paths.push(operation.barrier_root.join(MARKER));
        for path in paths {
            match fs::symlink_metadata(path) {
                Ok(_) => return Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(invalid()),
            }
        }
        profile.assert_current()?;
        Ok(false)
    }
    pub(super) fn acquire_with_preparation(
        profile: &ObservedInstalledSchemaProfileV1,
        operation: &SchemaOperationIdentityV1,
        prepare: impl FnOnce(&Directory) -> Result<()>,
    ) -> Result<Self> {
        profile.assert_current()?;
        if operation.runtime_root != profile.runtime_root()
            || operation.profile_sha256 != profile.profile_sha256()
            || operation.barrier_root.parent()
                != Some(Path::new("/var/lib/hepta-paper-maintenance/schema-v1"))
            || operation.barrier_root.file_name().and_then(|n| n.to_str())
                != operation.transition_id.strip_prefix("sha256:")
        {
            return Err(invalid());
        }
        let parent = ProtectedDirectory::open_or_create(
            operation.barrier_root.parent().ok_or_else(invalid)?,
            true,
        )?;
        let lock_path = parent.path.join(".owner.lock");
        let file = File::from(
            openat(
                parent.held.as_fd(),
                Path::new(".owner.lock"),
                OFlag::O_RDWR
                    | OFlag::O_CREAT
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC
                    | OFlag::O_NONBLOCK,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| invalid())?,
        );
        let metadata = file.metadata().map_err(|_| invalid())?;
        if !metadata.is_file()
            || metadata.uid() != 0
            || metadata.mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
            || metadata.len() != 0
        {
            return Err(invalid());
        }
        let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock)
            .map_err(|_| error("autonomous_research_installed_schema_maintenance_locked"))?;
        let lock_identity = (metadata.dev(), metadata.ino());
        let selected = ProtectedDirectory::open_or_create(&operation.barrier_root, true)?;
        let evidence = Directory::open_or_create(&selected.path.join("execution"), true)?;
        // Capture original facts and durably pin them under this same global
        // lock before publishing any persistent fence or stopping a writer.
        prepare(&evidence)?;
        selected.assert_current()?;
        let payload = serde_json::to_vec(&json!({"version":1,"kind":"InstalledSchemaMaintenanceBarrierV1",
            "runtimeRoot":operation.runtime_root,"transitionId":operation.transition_id,
            "planHash":operation.plan_hash,"profileSha256":operation.profile_sha256,
            "sourceUnits":profile.source_units().iter().map(|unit| &unit.unit).collect::<Vec<_>>(),
            "authorityScope":"schema_maintenance_only","releaseAuthority":false,"submissionAuthority":false}))
            .map_err(|_| invalid())?;
        let marker = publish_exact(&selected, MARKER, &payload)?;
        let directive = format!(
            "[Unit]\nConditionPathExists=!{}\n",
            selected.path.join(MARKER).display()
        );
        let mut drop_ins = Vec::new();
        for unit in profile.source_units() {
            let directory = ProtectedDirectory::open_or_create(
                &PathBuf::from("/etc/systemd/system").join(format!("{}.d", unit.unit)),
                true,
            )?;
            let snapshot = publish_exact(&directory, DROP_IN_NAME, directive.as_bytes())?;
            drop_ins.push((directory, snapshot));
        }
        let result = Self {
            parent,
            operation: selected,
            lock,
            lock_path,
            lock_identity,
            marker,
            drop_ins,
        };
        result.assert_current()?;
        profile.assert_current()?;
        Ok(result)
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.parent.assert_current()?;
        self.operation.assert_current()?;
        let named = std::fs::symlink_metadata(&self.lock_path).map_err(|_| invalid())?;
        let held = self.lock.metadata().map_err(|_| invalid())?;
        for metadata in [&named, &held] {
            if !metadata.is_file()
                || metadata.uid() != 0
                || metadata.nlink() != 1
                || metadata.mode() & 0o7777 != 0o600
                || metadata.len() != 0
                || (metadata.dev(), metadata.ino()) != self.lock_identity
            {
                return Err(invalid());
            }
        }
        self.marker.assert_current()?;
        for (directory, file) in &self.drop_ins {
            directory.assert_current()?;
            file.assert_current()?;
        }
        Ok(())
    }
    /// The global Flock remains held by self throughout release/restart.
    /// Every removed file was exact, original-absent and root-pinned. A failure
    /// is followed by reinstate before the ordinary owner returns an error.
    pub(super) fn release_for_early_rollback(&mut self) -> Result<()> {
        self.assert_current()?;
        for (directory, file) in &self.drop_ins {
            directory.assert_current()?;
            file.assert_current()?;
            self.marker.assert_current()?;
            nix::unistd::unlinkat(
                directory.held.as_fd(),
                Path::new(DROP_IN_NAME),
                nix::unistd::UnlinkatFlags::NoRemoveDir,
            )
            .map_err(|_| invalid())?;
            directory.held.sync_all().map_err(|_| invalid())?;
        }
        self.operation.assert_current()?;
        self.marker.assert_current()?;
        nix::unistd::unlinkat(
            self.operation.held.as_fd(),
            Path::new(MARKER),
            nix::unistd::UnlinkatFlags::NoRemoveDir,
        )
        .map_err(|_| invalid())?;
        self.operation.held.sync_all().map_err(|_| invalid())?;
        self.operation.assert_current()?;
        Ok(())
    }
    pub(super) fn reinstate(&mut self) -> Result<()> {
        self.parent.assert_current()?;
        self.operation.assert_current()?;
        self.marker = publish_exact(&self.operation, MARKER, self.marker.bytes())?;
        for (directory, file) in &mut self.drop_ins {
            directory.assert_current()?;
            *file = publish_exact(directory, DROP_IN_NAME, file.bytes())?;
        }
        self.assert_current()
    }
    pub(super) fn marker_path(&self) -> PathBuf {
        self.operation.path.join(MARKER)
    }
    pub(super) fn drop_in_paths(&self) -> Vec<String> {
        self.drop_ins
            .iter()
            .map(|(directory, _)| directory.path.join(DROP_IN_NAME).display().to_string())
            .collect()
    }
    pub(super) fn diagnostics(&self) -> Value {
        json!({"markerPath":self.marker_path(),"dropInPaths":self.drop_in_paths(),
            "persistentBarrier":true,"kernelLockHeld":true,"automaticRestartOnDrop":false,
            "errorAndCrashRetainBarrier":true})
    }
}

fn publish_exact(directory: &ProtectedDirectory, name: &str, bytes: &[u8]) -> Result<Snapshot> {
    let path = directory.path.join(name);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => directory.write_new(name, bytes)?,
        Ok(_) => (),
        Err(_) => return Err(invalid()),
    }
    let snapshot = Snapshot::load(&path, &hash_bytes(bytes), 64 * 1024, CODE)?;
    let metadata = snapshot.file.metadata().map_err(|_| invalid())?;
    if metadata.uid() != 0 || metadata.mode() & 0o7777 != 0o600 {
        return Err(invalid());
    }
    directory.assert_current()?;
    snapshot.assert_current()?;
    Ok(snapshot)
}

/// The authority also stays stopped across a publisher crash and host reboot.
/// Its condition is independent from the four persistent business barriers.
pub(super) struct AuthorityBarrier {
    directory: ProtectedDirectory,
    marker: Snapshot,
    drop_in_directory: ProtectedDirectory,
    drop_in: Snapshot,
}
impl AuthorityBarrier {
    pub(super) fn acquire(operation: &SchemaOperationIdentityV1) -> Result<Self> {
        let directory = ProtectedDirectory::open_or_create(&operation.barrier_root, false)?;
        let bytes = serde_json::to_vec(
            &json!({"version":1,"kind":"InstalledAuthorityJournalStopBarrierV1",
            "transitionId":operation.transition_id,"planHash":operation.plan_hash,
            "profileSha256":operation.profile_sha256}),
        )
        .map_err(|_| invalid())?;
        let marker = publish_exact(&directory, "AUTHORITY_STOPPED", &bytes)?;
        let drop_in_directory = ProtectedDirectory::open_or_create(
            &PathBuf::from("/etc/systemd/system")
                .join(format!("{}.d", super::installation::AUTHORITY_UNIT_V1)),
            true,
        )?;
        let directive = format!("[Unit]\nConditionPathExists=!{}\n", marker.path.display());
        let drop_in = publish_exact(
            &drop_in_directory,
            AUTHORITY_DROP_IN_NAME,
            directive.as_bytes(),
        )?;
        let value = Self {
            directory,
            marker,
            drop_in_directory,
            drop_in,
        };
        value.assert_current()?;
        Ok(value)
    }
    pub(super) fn marker_path(&self) -> &Path {
        &self.marker.path
    }
    pub(super) fn drop_in_path(&self) -> &Path {
        &self.drop_in.path
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        self.marker.assert_current()?;
        self.drop_in_directory.assert_current()?;
        self.drop_in.assert_current()
    }
    pub(super) fn release_after_verified_publication(self) -> Result<()> {
        self.assert_current()?;
        nix::unistd::unlinkat(
            self.directory.held.as_fd(),
            Path::new("AUTHORITY_STOPPED"),
            nix::unistd::UnlinkatFlags::NoRemoveDir,
        )
        .map_err(|_| invalid())?;
        self.directory.held.sync_all().map_err(|_| invalid())?;
        self.directory.assert_current()?;
        self.drop_in_directory.assert_current()?;
        self.drop_in.assert_current()
    }
}
