//! Local retention of the complete genuine deployment and actual process.
//! Mint before opening SQLite. The owning writer must keep this scope and its
//! borrowed process/inventory alive until that connection closes, on success,
//! rejection and unwind. This is not native admission or external qualification.
use super::*;
use crate::{
    ProductionWritableRootV1,
    deployment::production_deployment_identity_hash_v1,
    state_database_inventory::{
        NativeStoreTransactionInventoryGuardV1, ObservedStateDatabaseInventoryV1,
    },
};
use std::collections::BTreeMap;

/// The original verified producer and observed inventory cannot be substituted
/// by another same-report value. No arbitrary manifest or path list can create
/// this type; its only producer starts with the genuine deployment/process.
pub(crate) struct RetainedNativeControlInputsV1<'a> {
    native: &'a RetainedNativeControlProcessV1,
    inventory: InventoryOrigin<'a>,
    files: RetainedDeploymentFiles,
    arguments: RetainedArguments,
}
impl RetainedNativeControlProcessV1 {
    /// Full revalidation may open and close files, including a substituted path
    /// that aliases a database. Therefore this must precede Connection::open,
    /// not merely BEGIN. The returned scope never repeats that full I/O path.
    pub(crate) fn retain_for_native_store_transaction_v1<'a>(
        &'a self,
        inventory: &'a ObservedStateDatabaseInventoryV1,
    ) -> Result<RetainedNativeControlInputsV1<'a>> {
        self.assert_current()?;
        let inventory = InventoryOrigin::capture(inventory)?;
        let files = RetainedDeploymentFiles::capture(&self.manifest.services)?;
        let arguments = RetainedArguments::capture(&self.process)?;
        self.assert_current()?;
        inventory.value.assert_current()?;
        let result = RetainedNativeControlInputsV1 {
            native: self,
            inventory,
            files,
            arguments,
        };
        result.assert_retained_inputs()?;
        Ok(result)
    }
}
impl RetainedNativeControlInputsV1<'_> {
    pub(crate) fn assert_current(
        &self,
        expected_native: &RetainedNativeControlProcessV1,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
    ) -> Result<()> {
        if !std::ptr::eq(self.native, expected_native) {
            return Err(rejected("transaction_subject_changed"));
        }
        self.inventory.assert_current(guard)?;
        self.assert_retained_inputs()?;
        self.inventory.assert_current(guard)
    }
    fn assert_retained_inputs(&self) -> Result<()> {
        if production_deployment_identity_hash_v1(&self.native.manifest)
            .map_err(|_| rejected("deployment_changed"))?
            != *self.native.deployment.identity_hash()
        {
            return Err(rejected("deployment_changed"));
        }
        self.arguments.assert_current(&self.native.process)?;
        self.files.assert_current()?;
        self.native.process.executable.assert_current()?;
        self.arguments.assert_current(&self.native.process)
    }
}

/// Actual original observation, never an inventory report or skipped role.
struct InventoryOrigin<'a> {
    value: &'a ObservedStateDatabaseInventoryV1,
}
impl<'a> InventoryOrigin<'a> {
    fn capture(value: &'a ObservedStateDatabaseInventoryV1) -> Result<Self> {
        value.assert_current()?;
        Ok(Self { value })
    }
    fn assert_current(&self, guard: &NativeStoreTransactionInventoryGuardV1<'_>) -> Result<()> {
        guard.assert_bound_to(self.value)
    }
}

/// This lower I/O primitive is not a verified deployment constructor. Tests can
/// exercise actual user-owned ELF files here without manufacturing production
/// qualification; the outer producer still requires the unchanged full verifier.
struct RetainedDeploymentFiles {
    executables: BTreeMap<PathBuf, Executable>,
    roots: Vec<WritableDirectory>,
}
impl RetainedDeploymentFiles {
    fn capture(services: &[ProductionServiceUnitV1]) -> Result<Self> {
        let mut declarations: BTreeMap<&Path, &ProductionServiceUnitV1> = BTreeMap::new();
        let mut executables = BTreeMap::new();
        let mut roots = Vec::new();
        for service in services {
            if let Some(previous) = declarations.get(service.executable_path.as_path()) {
                // Several isolated roles legitimately share one native broker.
                // Only executable declarations, not role/principal/argv, agree.
                if previous.executable_hash != service.executable_hash
                    || previous.executable_owner_uid != service.executable_owner_uid
                    || previous.executable_owner_gid != service.executable_owner_gid
                    || previous.executable_mode != service.executable_mode
                {
                    return Err(rejected("deployment_changed"));
                }
            } else {
                let executable = Executable::open(service)?;
                declarations.insert(&service.executable_path, service);
                executables.insert(service.executable_path.clone(), executable);
            }
            for root in &service.writable_roots {
                roots.push(WritableDirectory::capture(root)?);
            }
        }
        let result = Self { executables, roots };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        // Every regular-file handle here was opened during capture. Never open,
        // clone or drop a temporary file, including on an early rejection: the
        // rejected pathname might now hardlink the live SQLite main or sidecar.
        for executable in self.executables.values() {
            executable.assert_current()?;
        }
        for root in &self.roots {
            root.assert_current()?;
        }
        Ok(())
    }
}

struct NamespaceDirectory {
    path: PathBuf,
    file: File,
    identity: (u64, u64, u32, u32, u32),
}
impl NamespaceDirectory {
    fn capture(path: &Path) -> Result<Self> {
        let before = fs::symlink_metadata(path).map_err(|_| rejected("writable_root_invalid"))?;
        if !before.is_dir() || before.is_symlink() {
            return Err(rejected("writable_root_invalid"));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| rejected("writable_root_invalid"))?;
        let result = Self {
            path: path.into(),
            file,
            identity: Directory::identity(&before),
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        let held = self
            .file
            .metadata()
            .map_err(|_| rejected("writable_root_changed"))?;
        let named =
            fs::symlink_metadata(&self.path).map_err(|_| rejected("writable_root_changed"))?;
        if !held.is_dir()
            || !named.is_dir()
            || named.is_symlink()
            || Directory::identity(&held) != self.identity
            || Directory::identity(&named) != self.identity
        {
            return Err(rejected("writable_root_changed"));
        }
        Ok(())
    }
}
struct WritableDirectory {
    root: ProductionWritableRootV1,
    directories: Vec<NamespaceDirectory>,
}
impl WritableDirectory {
    fn capture(root: &ProductionWritableRootV1) -> Result<Self> {
        if !root.path.is_absolute()
            || root
                .path
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
            || fs::canonicalize(&root.path).ok().as_ref() != Some(&root.path)
            || root.mode != 0o700
        {
            return Err(rejected("writable_root_invalid"));
        }
        let mut directories = Vec::new();
        let mut path = PathBuf::from("/");
        directories.push(NamespaceDirectory::capture(&path)?);
        for part in root.path.components() {
            if let Component::Normal(name) = part {
                path.push(name);
                directories.push(NamespaceDirectory::capture(&path)?);
            }
        }
        let result = Self {
            root: root.clone(),
            directories,
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        for directory in &self.directories {
            directory.assert_current()?;
        }
        let leaf = self
            .directories
            .last()
            .ok_or_else(|| rejected("writable_root_changed"))?;
        let held = leaf
            .file
            .metadata()
            .map_err(|_| rejected("writable_root_changed"))?;
        let named =
            fs::symlink_metadata(&leaf.path).map_err(|_| rejected("writable_root_changed"))?;
        for metadata in [&held, &named] {
            if metadata.uid() != self.root.owner_uid
                || metadata.gid() != self.root.owner_gid
                || metadata.mode() & 0o7777 != self.root.mode
                || metadata.nlink() < 2
            {
                return Err(rejected("writable_root_changed"));
            }
        }
        // These are writable directories: timestamps and the number of child
        // subdirectories may legitimately change. Namespace and permissions may not.
        Ok(())
    }
}

/// procfs reports cmdline st_size=0 despite actual readable bytes. Retain the
/// original kernel file, bound its PID/inode and use bounded positional reads.
struct RetainedArguments {
    file: File,
    identity: (u64, u64, u32, u32, u32),
    pid: u32,
}
impl RetainedArguments {
    fn capture(process: &ProcessObservation) -> Result<Self> {
        process.assert_kernel_identity()?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open("/proc/self/cmdline")
            .map_err(|_| rejected("arguments_unavailable"))?;
        let metadata = file
            .metadata()
            .map_err(|_| rejected("arguments_unavailable"))?;
        if !metadata.is_file() {
            return Err(rejected("arguments_unavailable"));
        }
        let result = Self {
            file,
            identity: Directory::identity(&metadata),
            pid: process.pid,
        };
        result.assert_current(process)?;
        Ok(result)
    }
    fn assert_identity(&self, process: &ProcessObservation) -> Result<()> {
        process.assert_kernel_identity()?;
        let held = self
            .file
            .metadata()
            .map_err(|_| rejected("arguments_changed"))?;
        let named = fs::symlink_metadata("/proc/self/cmdline")
            .map_err(|_| rejected("arguments_changed"))?;
        if process.pid != self.pid
            || !held.is_file()
            || !named.is_file()
            || Directory::identity(&held) != self.identity
            || Directory::identity(&named) != self.identity
        {
            return Err(rejected("arguments_changed"));
        }
        Ok(())
    }
    fn assert_current(&self, process: &ProcessObservation) -> Result<()> {
        self.assert_identity(process)?;
        let mut actual = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let remaining = MAX_ARGUMENT_BYTES + 1 - actual.len() as u64;
            if remaining == 0 {
                return Err(rejected("arguments_changed"));
            }
            let count = self
                .file
                .read_at(
                    &mut buffer[..remaining.min(4096) as usize],
                    actual.len() as u64,
                )
                .map_err(|_| rejected("arguments_unavailable"))?;
            if count == 0 {
                break;
            }
            actual.extend_from_slice(&buffer[..count]);
        }
        process.assert_arguments(&actual)?;
        self.assert_identity(process)
    }
}

#[cfg(test)]
mod tests;
