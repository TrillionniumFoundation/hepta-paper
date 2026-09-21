//! Retained native control-process observation, not writer admission or host
//! attestation. Production observation starts with the genuine deployment
//! verifier; a diagnostic JSON document cannot construct this capability.
use crate::{
    ProductionDeploymentManifestV1, ProductionServiceRoleV1, ProductionServiceUnitV1,
    VerifiedProductionDeploymentV1,
    sqlite_mutation_coordinator::{Result, error},
    verify_production_deployment_v1,
};
use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::{
        ffi::OsStrExt,
        fs::{FileExt, MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};

mod transaction;
#[allow(unused_imports)]
pub(crate) use transaction::RetainedNativeControlInputsV1;

const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARGUMENT_BYTES: u64 = 512 * 1024;

fn rejected(suffix: &str) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(format!(
        "autonomous_research_online_native_process_{suffix}"
    ))
}

#[derive(Clone, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl FileIdentity {
    fn of(value: &Metadata) -> Self {
        Self {
            device: value.dev(),
            inode: value.ino(),
            mode: value.mode(),
            uid: value.uid(),
            gid: value.gid(),
            links: value.nlink(),
            bytes: value.len(),
            modified: (value.mtime(), value.mtime_nsec()),
            changed: (value.ctime(), value.ctime_nsec()),
        }
    }
}

struct Directory {
    path: PathBuf,
    file: File,
    identity: (u64, u64, u32, u32, u32),
    executable_owner: u32,
}
impl Directory {
    fn identity(value: &Metadata) -> (u64, u64, u32, u32, u32) {
        (
            value.dev(),
            value.ino(),
            value.mode(),
            value.uid(),
            value.gid(),
        )
    }
    fn safe(value: &Metadata, executable_owner: u32) -> bool {
        value.is_dir()
            && value.mode() & 0o022 == 0
            && (value.uid() == 0 || value.uid() == executable_owner)
    }
    fn open(path: &Path, executable_owner: u32) -> Result<Self> {
        let before = fs::symlink_metadata(path).map_err(|_| rejected("directory_invalid"))?;
        if !Self::safe(&before, executable_owner) {
            return Err(rejected("directory_invalid"));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_DIRECTORY)
            .open(path)
            .map_err(|_| rejected("directory_invalid"))?;
        let result = Self {
            path: path.into(),
            file,
            identity: Self::identity(&before),
            executable_owner,
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.path).map_err(|_| rejected("directory_changed"))?;
        let held = self
            .file
            .metadata()
            .map_err(|_| rejected("directory_changed"))?;
        if !Self::safe(&named, self.executable_owner)
            || !Self::safe(&held, self.executable_owner)
            || Self::identity(&named) != self.identity
            || Self::identity(&held) != self.identity
        {
            return Err(rejected("directory_changed"));
        }
        Ok(())
    }
}

struct Executable {
    path: PathBuf,
    file: File,
    directories: Vec<Directory>,
    identity: FileIdentity,
    hash: Sha256Digest,
}
impl Executable {
    fn open(unit: &ProductionServiceUnitV1) -> Result<Self> {
        let path = &unit.executable_path;
        if !path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
            || fs::canonicalize(path).ok().as_ref() != Some(path)
        {
            return Err(rejected("executable_invalid"));
        }
        let mut directories = Vec::new();
        let mut parent = PathBuf::from("/");
        directories.push(Directory::open(&parent, unit.executable_owner_uid)?);
        for part in path
            .parent()
            .ok_or_else(|| rejected("executable_invalid"))?
            .components()
        {
            if let Component::Normal(name) = part {
                parent.push(name);
                directories.push(Directory::open(&parent, unit.executable_owner_uid)?);
            }
        }
        let before = fs::symlink_metadata(path).map_err(|_| rejected("executable_invalid"))?;
        if !before.is_file()
            || before.nlink() != 1
            || before.len() == 0
            || before.len() > MAX_BINARY_BYTES
            || before.mode() & 0o7777 != unit.executable_mode
            || !matches!(unit.executable_mode, 0o555 | 0o755)
            || before.uid() != unit.executable_owner_uid
            || before.gid() != unit.executable_owner_gid
        {
            return Err(rejected("executable_invalid"));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| rejected("executable_invalid"))?;
        let result = Self {
            path: path.clone(),
            file,
            directories,
            identity: FileIdentity::of(&before),
            hash: unit.executable_hash.clone(),
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_namespace(&self) -> Result<()> {
        for directory in &self.directories {
            directory.assert_current()?;
        }
        let held = self
            .file
            .metadata()
            .map_err(|_| rejected("executable_changed"))?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| rejected("executable_changed"))?;
        if FileIdentity::of(&held) != self.identity
            || FileIdentity::of(&named) != self.identity
            || !held.is_file()
            || !named.is_file()
        {
            return Err(rejected("executable_changed"));
        }
        Ok(())
    }
    fn assert_current(&self) -> Result<()> {
        self.assert_namespace()?;
        let mut hash = Sha256::new();
        let mut offset = 0;
        let mut buffer = [0_u8; 65_536];
        while offset < self.identity.bytes {
            let length = usize::try_from((self.identity.bytes - offset).min(buffer.len() as u64))
                .map_err(|_| rejected("executable_changed"))?;
            let count = self
                .file
                .read_at(&mut buffer[..length], offset)
                .map_err(|_| rejected("executable_changed"))?;
            if count == 0 || (offset == 0 && !buffer[..count].starts_with(b"\x7fELF")) {
                return Err(rejected("executable_changed"));
            }
            hash.update(&buffer[..count]);
            offset += count as u64;
        }
        let observed = format!("sha256:{}", hex::encode(hash.finalize()));
        if observed != self.hash.as_str() {
            return Err(rejected("executable_changed"));
        }
        self.assert_namespace()
    }
}

/// No public constructor and no caller-selected current-process facts. The
/// lower primitive is private and is also exercised against a real test process.
struct ProcessObservation {
    unit: ProductionServiceUnitV1,
    executable: Executable,
    running_executable: File,
    pid: u32,
}
impl ProcessObservation {
    fn observe(unit: &ProductionServiceUnitV1) -> Result<Self> {
        let executable = Executable::open(unit)?;
        // This procfs link deliberately follows the kernel's current executable;
        // its opened inode must equal our independently opened canonical path.
        let running_executable = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_CLOEXEC)
            .open("/proc/self/exe")
            .map_err(|_| rejected("current_executable_unavailable"))?;
        let result = Self {
            unit: unit.clone(),
            executable,
            running_executable,
            pid: std::process::id(),
        };
        result.assert_process_identity()?;
        result.executable.assert_current()?;
        result.assert_process_identity()?;
        Ok(result)
    }
    fn assert_kernel_identity(&self) -> Result<()> {
        if std::process::id() != self.pid
            || std::env::current_exe().ok().as_ref() != Some(&self.unit.executable_path)
            || fs::read_link("/proc/self/exe").ok().as_ref() != Some(&self.unit.executable_path)
            || self
                .running_executable
                .metadata()
                .ok()
                .as_ref()
                .map(FileIdentity::of)
                != Some(self.executable.identity.clone())
            || fs::metadata("/proc/self/exe")
                .ok()
                .as_ref()
                .map(FileIdentity::of)
                != Some(self.executable.identity.clone())
        {
            return Err(rejected("current_executable_changed"));
        }
        let users = nix::unistd::getresuid().map_err(|_| rejected("principal_invalid"))?;
        let groups = nix::unistd::getresgid().map_err(|_| rejected("principal_invalid"))?;
        if self.unit.principal_uid == 0
            || self.unit.principal_gid == 0
            || [users.real, users.effective, users.saved]
                .iter()
                .any(|id| id.as_raw() != self.unit.principal_uid)
            || [groups.real, groups.effective, groups.saved]
                .iter()
                .any(|id| id.as_raw() != self.unit.principal_gid)
        {
            return Err(rejected("principal_invalid"));
        }
        Ok(())
    }
    fn assert_process_identity(&self) -> Result<()> {
        self.assert_kernel_identity()?;
        let file =
            File::open("/proc/self/cmdline").map_err(|_| rejected("arguments_unavailable"))?;
        let mut actual = Vec::new();
        file.take(MAX_ARGUMENT_BYTES + 1)
            .read_to_end(&mut actual)
            .map_err(|_| rejected("arguments_unavailable"))?;
        self.assert_arguments(&actual)
    }
    fn assert_arguments(&self, actual: &[u8]) -> Result<()> {
        let mut expected = self.unit.executable_path.as_os_str().as_bytes().to_vec();
        expected.push(0);
        for argument in &self.unit.arguments {
            expected.extend_from_slice(argument.as_bytes());
            expected.push(0);
        }
        if actual.len() as u64 > MAX_ARGUMENT_BYTES || actual != expected {
            return Err(rejected("arguments_changed"));
        }
        Ok(())
    }
    fn assert_current(&self) -> Result<()> {
        self.assert_process_identity()?;
        self.executable.assert_current()?;
        self.assert_process_identity()
    }
}

/// Retains the verified deployment and the actual current native process. This
/// does not establish external qualification, a cutover epoch or write scope.
/// Environment/cgroup/host facts and loaded libraries are not measured here.
pub(crate) struct RetainedNativeControlProcessV1 {
    deployment: VerifiedProductionDeploymentV1,
    manifest: ProductionDeploymentManifestV1,
    process: ProcessObservation,
}
impl RetainedNativeControlProcessV1 {
    pub(crate) fn observe(
        deployment: &VerifiedProductionDeploymentV1,
        manifest: &ProductionDeploymentManifestV1,
    ) -> Result<Self> {
        let fresh = verify_production_deployment_v1(manifest)
            .map_err(|_| rejected("deployment_invalid"))?;
        if &fresh != deployment {
            return Err(rejected("deployment_mismatch"));
        }
        let mut controls = manifest
            .services
            .iter()
            .filter(|unit| unit.role == ProductionServiceRoleV1::ControlPlane);
        let unit = controls
            .next()
            .ok_or_else(|| rejected("control_unit_missing"))?;
        if controls.next().is_some() {
            return Err(rejected("control_unit_missing"));
        }
        let process = ProcessObservation::observe(unit)?;
        let result = Self {
            deployment: fresh,
            manifest: manifest.clone(),
            process,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.process.assert_current()?;
        if verify_production_deployment_v1(&self.manifest)
            .map_err(|_| rejected("deployment_changed"))?
            != self.deployment
        {
            return Err(rejected("deployment_changed"));
        }
        // Finish with the retained current-process checks after deployment I/O.
        self.process.assert_current()
    }
    pub(crate) fn executable_hash(&self) -> &Sha256Digest {
        &self.process.executable.hash
    }
    pub(crate) fn deployment(&self) -> &VerifiedProductionDeploymentV1 {
        &self.deployment
    }
    pub(crate) fn control_unit(&self) -> &ProductionServiceUnitV1 {
        &self.process.unit
    }
}

/// Closed source-owned identity of the reconciliation kernels and fixed online
/// statement registry. This deliberately differs from native worker identity.
/// The separately signed actual ELF binds the complete compiled dependency
/// graph; this digest is not a reproducible-build or external authority claim.
pub(crate) fn native_reconciliation_implementation_hash_v1() -> Sha256Digest {
    const SOURCES: &[(&str, &[u8])] = &[
        (
            "automation_runtime_reconciliation.rs",
            include_bytes!("../../automation_runtime_reconciliation.rs"),
        ),
        (
            "automation_runtime_reconciliation/offline_execution.rs",
            include_bytes!("../../automation_runtime_reconciliation/offline_execution.rs"),
        ),
        (
            "automation_runtime_reconciliation/offline_execution/online.rs",
            include_bytes!("../../automation_runtime_reconciliation/offline_execution/online.rs"),
        ),
        (
            "automation_runtime_reconciliation/legacy_terminal_residue.rs",
            include_bytes!("../../automation_runtime_reconciliation/legacy_terminal_residue.rs"),
        ),
        (
            "automation_runtime_reconciliation/legacy_terminal_residue/online.rs",
            include_bytes!(
                "../../automation_runtime_reconciliation/legacy_terminal_residue/online.rs"
            ),
        ),
        (
            "automation_runtime_reconciliation/online_execution.rs",
            include_bytes!("../../automation_runtime_reconciliation/online_execution.rs"),
        ),
        (
            "automation_runtime_reconciliation/sqlite_number.rs",
            include_bytes!("../../automation_runtime_reconciliation/sqlite_number.rs"),
        ),
        (
            "sqlite_mutation_plan.rs",
            include_bytes!("../../sqlite_mutation_plan.rs"),
        ),
        (
            "online_mutation_composition/operation-plans.v1.json",
            include_bytes!("../operation-plans.v1.json"),
        ),
        (
            "online_mutation_composition/activation/native_process.rs",
            include_bytes!("native_process.rs"),
        ),
        (
            "online_mutation_composition/activation/native_process/transaction.rs",
            include_bytes!("native_process/transaction.rs"),
        ),
        (
            "online_mutation_composition/activation.rs",
            include_bytes!("../activation.rs"),
        ),
        (
            "online_mutation_composition/activation/admission.rs",
            include_bytes!("admission.rs"),
        ),
        (
            "online_mutation_composition/activation/admission_hashes.rs",
            include_bytes!("admission_hashes.rs"),
        ),
        (
            "online_mutation_composition/activation/execution.rs",
            include_bytes!("execution.rs"),
        ),
        (
            "online_mutation_composition/activation/transaction.rs",
            include_bytes!("transaction.rs"),
        ),
        (
            "online_mutation_composition/activation/temporal.rs",
            include_bytes!("temporal.rs"),
        ),
        (
            "online_mutation_composition/activation/transfer.rs",
            include_bytes!("transfer.rs"),
        ),
        (
            "online_mutation_composition/activation/signing_preview.rs",
            include_bytes!("signing_preview.rs"),
        ),
    ];
    let mut hash = Sha256::new();
    hash.update(b"HeptaNativeReconciliationImplementationV1\0");
    for (path, bytes) in SOURCES {
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path.as_bytes());
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    format!("sha256:{}", hex::encode(hash.finalize()))
        .parse()
        .expect("SHA-256 encoding")
}

#[cfg(test)]
mod tests;
