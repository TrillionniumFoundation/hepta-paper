//! Linux cgroup-v2 process-set authority for production provider containment.

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-cgroup-containment requires Linux cgroup-v2 semantics");

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use thiserror::Error;

const VERSION: u16 = 1;
const MAX_CONTROL_BYTES: usize = 128;

/// Authority class of the selected hierarchy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CgroupAuthorityModeV1 {
    /// Deterministic source-test fixture; never production eligible.
    LocalFixture,
    /// Real delegated subtree below `/sys/fs/cgroup`.
    ProductionSystem,
}

/// Bounded cgroup-v2 policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CgroupV2PolicyV1 {
    /// Contract version.
    pub version: u16,
    /// Canonical delegated subtree.
    pub delegated_root: PathBuf,
    /// Expected owner UID of the delegated subtree.
    pub owner_uid: u32,
    /// Authority class.
    pub authority_mode: CgroupAuthorityModeV1,
    /// Maximum process count.
    pub pids_max: u64,
    /// Maximum memory in bytes.
    pub memory_max: u64,
    /// CPU quota in microseconds.
    pub cpu_quota_us: u64,
    /// CPU period in microseconds.
    pub cpu_period_us: u64,
    /// Cleanup deadline.
    pub cleanup_timeout_ms: u64,
    /// Cleanup poll interval.
    pub poll_interval_ms: u64,
}

impl CgroupV2PolicyV1 {
    /// Constructs a source-test fixture policy.
    #[must_use]
    pub fn local_fixture(root: PathBuf, owner_uid: u32) -> Self {
        Self {
            version: VERSION,
            delegated_root: root,
            owner_uid,
            authority_mode: CgroupAuthorityModeV1::LocalFixture,
            pids_max: 64,
            memory_max: 512 * 1024 * 1024,
            cpu_quota_us: 100_000,
            cpu_period_us: 100_000,
            cleanup_timeout_ms: 5_000,
            poll_interval_ms: 10,
        }
    }

    /// Constructs a real-system policy. Validation still occurs before use.
    #[must_use]
    pub fn production(root: PathBuf, owner_uid: u32) -> Self {
        let mut value = Self::local_fixture(root, owner_uid);
        value.authority_mode = CgroupAuthorityModeV1::ProductionSystem;
        value
    }

    /// Returns true only for a validated real cgroup-v2 hierarchy.
    pub fn production_eligible(&self) -> Result<bool, CgroupV2Error> {
        self.validate()?;
        Ok(self.authority_mode == CgroupAuthorityModeV1::ProductionSystem)
    }

    fn validate(&self) -> Result<(), CgroupV2Error> {
        if self.version != VERSION
            || self.pids_max == 0
            || self.memory_max == 0
            || self.cpu_quota_us == 0
            || self.cpu_period_us == 0
            || self.cleanup_timeout_ms == 0
            || self.poll_interval_ms == 0
            || self.poll_interval_ms > self.cleanup_timeout_ms
        {
            return Err(CgroupV2Error::InvalidPolicy);
        }
        inspect_root(&self.delegated_root, self.owner_uid)?;
        if self.authority_mode == CgroupAuthorityModeV1::ProductionSystem {
            let canonical = fs::canonicalize(&self.delegated_root)
                .map_err(|_| CgroupV2Error::InvalidHierarchy)?;
            if !canonical.starts_with("/sys/fs/cgroup")
                || !canonical.join("cgroup.controllers").is_file()
                || !canonical.join("cgroup.subtree_control").is_file()
            {
                return Err(CgroupV2Error::InvalidHierarchy);
            }
            let filesystems = fs::read_to_string("/proc/filesystems")
                .map_err(|_| CgroupV2Error::InvalidHierarchy)?;
            if !filesystems
                .lines()
                .any(|line| line.trim_end().ends_with("cgroup2"))
            {
                return Err(CgroupV2Error::InvalidHierarchy);
            }
        }
        Ok(())
    }
}

/// Containment selection exposed to production composition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessContainmentModeV1 {
    /// Legacy process-group supervision. Source fixture only.
    ProcessGroupOnly,
    /// Cgroup-v2 process-set authority.
    CgroupV2(CgroupV2PolicyV1),
}

impl ProcessContainmentModeV1 {
    /// Production mode never treats process groups or fixtures as sufficient.
    pub fn production_eligible(&self) -> Result<bool, CgroupV2Error> {
        match self {
            Self::ProcessGroupOnly => Ok(false),
            Self::CgroupV2(policy) => policy.production_eligible(),
        }
    }
}

/// One exact operation cgroup.
pub struct CgroupV2OperationV1 {
    path: PathBuf,
    policy: CgroupV2PolicyV1,
    cleaned: bool,
}

impl CgroupV2OperationV1 {
    /// Creates an exclusive operation cgroup and installs limits before attachment.
    pub fn create(policy: CgroupV2PolicyV1, operation_id: &str) -> Result<Self, CgroupV2Error> {
        policy.validate()?;
        validate_identifier(operation_id)?;
        let path = policy.delegated_root.join(operation_id);
        fs::create_dir(&path).map_err(|error| CgroupV2Error::Filesystem("create", error.kind()))?;
        if policy.authority_mode == CgroupAuthorityModeV1::LocalFixture {
            create_fixture_controls(&path)?;
        }
        inspect_operation(&path, policy.owner_uid)?;
        write_control(&path.join("pids.max"), &policy.pids_max.to_string())?;
        write_control(&path.join("memory.max"), &policy.memory_max.to_string())?;
        write_control(
            &path.join("cpu.max"),
            &format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
        )?;
        Ok(Self {
            path,
            policy,
            cleaned: false,
        })
    }

    /// Attaches one process. Descendants remain members after `setsid` or double-fork.
    pub fn attach_pid(&self, pid: u32) -> Result<(), CgroupV2Error> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err(CgroupV2Error::InvalidPid(pid));
        }
        write_control(&self.path.join("cgroup.procs"), &pid.to_string())
    }

    /// Kills all members, proves `populated 0`, and removes the exact cgroup.
    pub fn kill_and_cleanup(mut self) -> Result<(), CgroupV2Error> {
        self.cleanup_inner()
    }

    /// Exact operation path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn cleanup_inner(&mut self) -> Result<(), CgroupV2Error> {
        if self.cleaned {
            return Ok(());
        }
        write_control(&self.path.join("cgroup.kill"), "1")?;
        if self.policy.authority_mode == CgroupAuthorityModeV1::LocalFixture {
            write_control(&self.path.join("cgroup.events"), "populated 0\nfrozen 0")?;
        }
        let deadline = Instant::now() + Duration::from_millis(self.policy.cleanup_timeout_ms);
        while read_populated(&self.path.join("cgroup.events"))? {
            if Instant::now() >= deadline {
                return Err(CgroupV2Error::CleanupTimeout);
            }
            thread::sleep(Duration::from_millis(self.policy.poll_interval_ms));
        }
        if self.policy.authority_mode == CgroupAuthorityModeV1::LocalFixture {
            for name in [
                "cgroup.procs",
                "cgroup.events",
                "cgroup.kill",
                "pids.max",
                "memory.max",
                "cpu.max",
            ] {
                fs::remove_file(self.path.join(name))
                    .map_err(|error| CgroupV2Error::Filesystem("fixture_cleanup", error.kind()))?;
            }
        }
        fs::remove_dir(&self.path)
            .map_err(|error| CgroupV2Error::Filesystem("remove", error.kind()))?;
        File::open(&self.policy.delegated_root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| CgroupV2Error::Filesystem("sync_parent", error.kind()))?;
        self.cleaned = true;
        Ok(())
    }
}

impl Drop for CgroupV2OperationV1 {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = self.cleanup_inner();
        }
    }
}

fn inspect_root(path: &Path, owner_uid: u32) -> Result<(), CgroupV2Error> {
    if !path.is_absolute() {
        return Err(CgroupV2Error::InvalidHierarchy);
    }
    let canonical = fs::canonicalize(path).map_err(|_| CgroupV2Error::InvalidHierarchy)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| CgroupV2Error::InvalidHierarchy)?;
    if canonical != path
        || metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o002 != 0
    {
        return Err(CgroupV2Error::InvalidHierarchy);
    }
    Ok(())
}

fn inspect_operation(path: &Path, owner_uid: u32) -> Result<(), CgroupV2Error> {
    let metadata = fs::symlink_metadata(path).map_err(|_| CgroupV2Error::InvalidHierarchy)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != owner_uid {
        return Err(CgroupV2Error::InvalidHierarchy);
    }
    Ok(())
}

fn create_fixture_controls(path: &Path) -> Result<(), CgroupV2Error> {
    for (name, contents) in [
        ("cgroup.procs", "0"),
        ("cgroup.events", "populated 0\nfrozen 0"),
        ("cgroup.kill", "0"),
        ("pids.max", "max"),
        ("memory.max", "max"),
        ("cpu.max", "max 100000"),
    ] {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path.join(name))
            .map_err(|error| CgroupV2Error::Filesystem("fixture_control", error.kind()))?;
        file.write_all(contents.as_bytes())
            .map_err(|error| CgroupV2Error::Filesystem("fixture_control", error.kind()))?;
    }
    Ok(())
}

fn write_control(path: &Path, value: &str) -> Result<(), CgroupV2Error> {
    if value.is_empty() || value.len() > MAX_CONTROL_BYTES || value.as_bytes().contains(&0) {
        return Err(CgroupV2Error::InvalidControlValue);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| CgroupV2Error::Filesystem("control_write", error.kind()))?;
    file.write_all(value.as_bytes())
        .map_err(|error| CgroupV2Error::Filesystem("control_write", error.kind()))
}

fn read_populated(path: &Path) -> Result<bool, CgroupV2Error> {
    let mut contents = String::new();
    File::open(path)
        .and_then(|mut file| file.read_to_string(&mut contents))
        .map_err(|error| CgroupV2Error::Filesystem("events_read", error.kind()))?;
    contents
        .lines()
        .find_map(|line| line.strip_prefix("populated "))
        .map(|value| value == "1")
        .ok_or(CgroupV2Error::EventsMalformed)
}

fn validate_identifier(value: &str) -> Result<(), CgroupV2Error> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(CgroupV2Error::InvalidOperationId);
    }
    Ok(())
}

/// Cgroup policy, hierarchy, or cleanup failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CgroupV2Error {
    /// Policy limits or version are invalid.
    #[error("cgroup-v2 policy is invalid")]
    InvalidPolicy,
    /// Hierarchy is not canonical, delegated, or cgroup-v2.
    #[error("cgroup-v2 hierarchy is invalid")]
    InvalidHierarchy,
    /// Operation identifier is invalid.
    #[error("cgroup-v2 operation id is invalid")]
    InvalidOperationId,
    /// PID is outside the supported range.
    #[error("cgroup-v2 pid is invalid: {0}")]
    InvalidPid(u32),
    /// Control value is invalid.
    #[error("cgroup-v2 control value is invalid")]
    InvalidControlValue,
    /// `cgroup.events` is malformed.
    #[error("cgroup-v2 events are malformed")]
    EventsMalformed,
    /// The cgroup remained populated after kill.
    #[error("cgroup-v2 cleanup timed out")]
    CleanupTimeout,
    /// Filesystem operation failed.
    #[error("cgroup-v2 filesystem operation {0} failed: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn fixture() -> (PathBuf, u32) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-cgroup-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("fixture root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
        let uid = fs::metadata(&root).expect("metadata").uid();
        (root, uid)
    }

    #[test]
    fn process_group_and_fixture_never_qualify_production() {
        assert!(
            !ProcessContainmentModeV1::ProcessGroupOnly
                .production_eligible()
                .expect("process-group decision")
        );
        let (root, uid) = fixture();
        let fixture_mode =
            ProcessContainmentModeV1::CgroupV2(CgroupV2PolicyV1::local_fixture(root.clone(), uid));
        assert!(
            !fixture_mode
                .production_eligible()
                .expect("fixture decision")
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn fixture_records_pid_and_proves_empty_cleanup() {
        let (root, uid) = fixture();
        let operation = CgroupV2OperationV1::create(
            CgroupV2PolicyV1::local_fixture(root.clone(), uid),
            "operation-1",
        )
        .expect("operation cgroup");
        operation
            .attach_pid(std::process::id())
            .expect("attach pid");
        assert_eq!(
            fs::read_to_string(operation.path().join("cgroup.procs")).expect("procs"),
            std::process::id().to_string()
        );
        operation.kill_and_cleanup().expect("cleanup");
        assert!(fs::read_dir(&root).expect("root listing").next().is_none());
        fs::remove_dir(root).expect("remove root");
    }
}
