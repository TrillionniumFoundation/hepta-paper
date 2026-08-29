use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use crate::BrokerServiceErrorV2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CgroupAuthorityModeV2 {
    LocalFixture,
    DelegatedProduction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CgroupPolicyV2 {
    pub root: PathBuf,
    pub owner_uid: u32,
    pub authority_mode: CgroupAuthorityModeV2,
    pub maximum_pids: u32,
    pub maximum_memory_bytes: u64,
    pub cpu_quota_micros: u64,
    pub cpu_period_micros: u64,
    pub cleanup_timeout_ms: u64,
    pub poll_interval_ms: u64,
}

impl CgroupPolicyV2 {
    pub fn validate(&self) -> Result<(), BrokerServiceErrorV2> {
        if !self.root.is_absolute()
            || self.maximum_pids == 0
            || self.maximum_memory_bytes == 0
            || self.cpu_quota_micros == 0
            || self.cpu_period_micros == 0
            || self.cpu_quota_micros > self.cpu_period_micros
            || self.cleanup_timeout_ms == 0
            || self.cleanup_timeout_ms > 60_000
            || self.poll_interval_ms == 0
            || self.poll_interval_ms > 1_000
        {
            return Err(BrokerServiceErrorV2::InvalidPolicy);
        }
        let canonical = fs::canonicalize(&self.root)
            .map_err(|error| BrokerServiceErrorV2::Filesystem("cgroup_root", error.kind()))?;
        let metadata = fs::symlink_metadata(&self.root)
            .map_err(|error| BrokerServiceErrorV2::Filesystem("cgroup_root", error.kind()))?;
        if canonical != self.root
            || metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != self.owner_uid
            || metadata.mode() & 0o022 != 0
        {
            return Err(BrokerServiceErrorV2::CgroupAuthorityInvalid);
        }
        if self.authority_mode == CgroupAuthorityModeV2::DelegatedProduction {
            verify_cgroup2_mount(&self.root)?;
        }
        verify_controllers(&self.root)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CgroupIdentityV2 {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}

pub struct CgroupContainmentV2 {
    policy: CgroupPolicyV2,
    root_identity: CgroupIdentityV2,
}

impl CgroupContainmentV2 {
    pub fn open(policy: CgroupPolicyV2) -> Result<Self, BrokerServiceErrorV2> {
        policy.validate()?;
        let root_identity = identity(&policy.root)?;
        Ok(Self {
            policy,
            root_identity,
        })
    }

    #[must_use]
    pub fn production_eligible(&self) -> bool {
        self.policy.authority_mode == CgroupAuthorityModeV2::DelegatedProduction
    }

    pub fn create_operation(
        &self,
        operation_id: &str,
    ) -> Result<CgroupOperationV2, BrokerServiceErrorV2> {
        validate_identifier(operation_id)?;
        self.revalidate_root()?;
        let path = self.policy.root.join(operation_id);
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(BrokerServiceErrorV2::CgroupOperationExists);
            }
            Err(error) => {
                return Err(BrokerServiceErrorV2::Filesystem(
                    "cgroup_create",
                    error.kind(),
                ));
            }
        }
        if self.policy.authority_mode == CgroupAuthorityModeV2::LocalFixture {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(|error| {
                BrokerServiceErrorV2::Filesystem("cgroup_permissions", error.kind())
            })?;
            for (name, initial) in [
                ("cgroup.procs", ""),
                ("cgroup.events", "populated 0\n"),
                ("cgroup.kill", ""),
                ("pids.max", ""),
                ("memory.max", ""),
                ("cpu.max", ""),
            ] {
                fs::write(path.join(name), initial).map_err(|error| {
                    BrokerServiceErrorV2::Filesystem("cgroup_fixture", error.kind())
                })?;
            }
        }
        let operation = CgroupOperationV2 {
            path,
            identity: identity(&self.policy.root.join(operation_id))?,
            policy: self.policy.clone(),
            removed: false,
        };
        operation.write_control("pids.max", &self.policy.maximum_pids.to_string())?;
        operation.write_control(
            "memory.max",
            &self.policy.maximum_memory_bytes.to_string(),
        )?;
        operation.write_control(
            "cpu.max",
            &format!(
                "{} {}",
                self.policy.cpu_quota_micros, self.policy.cpu_period_micros
            ),
        )?;
        operation.revalidate()?;
        Ok(operation)
    }

    fn revalidate_root(&self) -> Result<(), BrokerServiceErrorV2> {
        if identity(&self.policy.root)? != self.root_identity {
            return Err(BrokerServiceErrorV2::CgroupIdentityChanged);
        }
        Ok(())
    }
}

pub struct CgroupOperationV2 {
    path: PathBuf,
    identity: CgroupIdentityV2,
    policy: CgroupPolicyV2,
    removed: bool,
}

impl CgroupOperationV2 {
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn attach_pid(&self, pid: u32) -> Result<(), BrokerServiceErrorV2> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err(BrokerServiceErrorV2::InvalidPolicy);
        }
        self.revalidate()?;
        self.write_control("cgroup.procs", &pid.to_string())?;
        if self.policy.authority_mode == CgroupAuthorityModeV2::DelegatedProduction
            && !self.contains_pid(pid)?
        {
            return Err(BrokerServiceErrorV2::CgroupIdentityChanged);
        }
        Ok(())
    }

    pub fn contains_pid(&self, pid: u32) -> Result<bool, BrokerServiceErrorV2> {
        self.revalidate()?;
        let contents = fs::read_to_string(self.path.join("cgroup.procs")).map_err(|error| {
            BrokerServiceErrorV2::Filesystem("cgroup_procs_read", error.kind())
        })?;
        Ok(contents
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .any(|observed| observed == pid))
    }

    pub fn kill_and_remove(mut self) -> Result<(), BrokerServiceErrorV2> {
        self.revalidate()?;
        self.write_control("cgroup.kill", "1")?;
        if self.policy.authority_mode == CgroupAuthorityModeV2::LocalFixture {
            fs::write(self.path.join("cgroup.events"), "populated 0\n").map_err(|error| {
                BrokerServiceErrorV2::Filesystem("cgroup_fixture_events", error.kind())
            })?;
        }
        let deadline = Instant::now() + Duration::from_millis(self.policy.cleanup_timeout_ms);
        while Instant::now() < deadline {
            if !self.populated()? {
                self.remove_exact()?;
                self.removed = true;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(self.policy.poll_interval_ms));
        }
        Err(BrokerServiceErrorV2::CgroupCleanupTimeout)
    }

    fn populated(&self) -> Result<bool, BrokerServiceErrorV2> {
        self.revalidate()?;
        let events = fs::read_to_string(self.path.join("cgroup.events")).map_err(|error| {
            BrokerServiceErrorV2::Filesystem("cgroup_events", error.kind())
        })?;
        events
            .lines()
            .find_map(|line| line.strip_prefix("populated "))
            .map(|value| value.trim() == "1")
            .ok_or(BrokerServiceErrorV2::CgroupIdentityChanged)
    }

    fn write_control(&self, name: &str, value: &str) -> Result<(), BrokerServiceErrorV2> {
        self.revalidate()?;
        let path = self.path.join(name);
        let mut options = OpenOptions::new();
        options.write(true);
        if self.policy.authority_mode == CgroupAuthorityModeV2::LocalFixture {
            options.truncate(true).mode(0o600);
        }
        let mut file = options.open(&path).map_err(|error| {
            BrokerServiceErrorV2::Filesystem("cgroup_control", error.kind())
        })?;
        file.write_all(value.as_bytes()).map_err(|error| {
            BrokerServiceErrorV2::Filesystem("cgroup_control", error.kind())
        })?;
        Ok(())
    }

    fn remove_exact(&self) -> Result<(), BrokerServiceErrorV2> {
        self.revalidate()?;
        if self.policy.authority_mode == CgroupAuthorityModeV2::LocalFixture {
            for name in [
                "cgroup.procs",
                "cgroup.events",
                "cgroup.kill",
                "pids.max",
                "memory.max",
                "cpu.max",
            ] {
                fs::remove_file(self.path.join(name)).map_err(|error| {
                    BrokerServiceErrorV2::Filesystem("cgroup_fixture_remove", error.kind())
                })?;
            }
        }
        fs::remove_dir(&self.path)
            .map_err(|error| BrokerServiceErrorV2::Filesystem("cgroup_remove", error.kind()))?;
        File::open(&self.policy.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| BrokerServiceErrorV2::Filesystem("cgroup_root_sync", error.kind()))
    }

    fn revalidate(&self) -> Result<(), BrokerServiceErrorV2> {
        if identity(&self.path)? != self.identity {
            return Err(BrokerServiceErrorV2::CgroupIdentityChanged);
        }
        Ok(())
    }
}

impl Drop for CgroupOperationV2 {
    fn drop(&mut self) {
        // Deliberately no implicit kill. A caller must record durable disposition before cleanup.
        let _ = self.removed;
    }
}

fn verify_controllers(root: &Path) -> Result<(), BrokerServiceErrorV2> {
    let controllers = fs::read_to_string(root.join("cgroup.controllers")).map_err(|error| {
        BrokerServiceErrorV2::Filesystem("cgroup_controllers", error.kind())
    })?;
    for required in ["cpu", "memory", "pids"] {
        if !controllers.split_whitespace().any(|value| value == required) {
            return Err(BrokerServiceErrorV2::CgroupControllerUnavailable(
                required.to_owned(),
            ));
        }
    }
    Ok(())
}

fn verify_cgroup2_mount(root: &Path) -> Result<(), BrokerServiceErrorV2> {
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|error| BrokerServiceErrorV2::Filesystem("mountinfo", error.kind()))?;
    let root_text = root
        .to_str()
        .ok_or(BrokerServiceErrorV2::CgroupAuthorityInvalid)?;
    let mut best_match = 0_usize;
    let mut cgroup2 = false;
    for line in mountinfo.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let fields = left.split_whitespace().collect::<Vec<_>>();
        let Some(mount_point) = fields.get(4) else {
            continue;
        };
        if !(root_text == *mount_point
            || root_text
                .strip_prefix(*mount_point)
                .is_some_and(|suffix| suffix.starts_with('/')))
        {
            continue;
        }
        if mount_point.len() >= best_match {
            best_match = mount_point.len();
            cgroup2 = right.split_whitespace().next() == Some("cgroup2");
        }
    }
    if best_match == 0 || !cgroup2 {
        return Err(BrokerServiceErrorV2::CgroupAuthorityInvalid);
    }
    Ok(())
}

fn identity(path: &Path) -> Result<CgroupIdentityV2, BrokerServiceErrorV2> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("cgroup_identity", error.kind()))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("cgroup_identity", error.kind()))?;
    if canonical != path || metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(BrokerServiceErrorV2::CgroupIdentityChanged);
    }
    Ok(CgroupIdentityV2 {
        device: metadata.dev(),
        inode: metadata.ino(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        mode: metadata.mode(),
    })
}

fn validate_identifier(value: &str) -> Result<(), BrokerServiceErrorV2> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(BrokerServiceErrorV2::InvalidIdentifier);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::MetadataExt,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "hepta-cgroup-v2-{}-{nonce}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).expect("root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
            fs::write(root.join("cgroup.controllers"), "cpu memory pids\n")
                .expect("controllers");
            Self(root)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn policy(fixture: &Fixture, mode: CgroupAuthorityModeV2) -> CgroupPolicyV2 {
        CgroupPolicyV2 {
            root: fixture.0.clone(),
            owner_uid: fs::metadata(&fixture.0).expect("metadata").uid(),
            authority_mode: mode,
            maximum_pids: 64,
            maximum_memory_bytes: 512 * 1024 * 1024,
            cpu_quota_micros: 50_000,
            cpu_period_micros: 100_000,
            cleanup_timeout_ms: 1_000,
            poll_interval_ms: 5,
        }
    }

    #[test]
    fn fixture_operation_binds_limits_pid_and_exact_cleanup() {
        let fixture = Fixture::new();
        let containment = CgroupContainmentV2::open(policy(
            &fixture,
            CgroupAuthorityModeV2::LocalFixture,
        ))
        .expect("containment");
        assert!(!containment.production_eligible());
        let operation = containment.create_operation("operation-1").expect("operation");
        operation.attach_pid(1234).expect("attach");
        assert!(operation.contains_pid(1234).expect("contains"));
        assert_eq!(
            fs::read_to_string(operation.path().join("pids.max")).expect("pids"),
            "64"
        );
        operation.kill_and_remove().expect("cleanup");
        assert!(!fixture.0.join("operation-1").exists());
    }

    #[test]
    fn production_mode_rejects_an_ordinary_filesystem() {
        let fixture = Fixture::new();
        assert!(matches!(
            CgroupContainmentV2::open(policy(
                &fixture,
                CgroupAuthorityModeV2::DelegatedProduction,
            )),
            Err(BrokerServiceErrorV2::CgroupAuthorityInvalid)
        ));
    }

    #[test]
    fn missing_controller_and_path_traversal_fail_closed() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("cgroup.controllers"), "cpu memory\n")
            .expect("controllers");
        assert!(matches!(
            CgroupContainmentV2::open(policy(
                &fixture,
                CgroupAuthorityModeV2::LocalFixture,
            )),
            Err(BrokerServiceErrorV2::CgroupControllerUnavailable(value)) if value == "pids"
        ));
        fs::write(fixture.0.join("cgroup.controllers"), "cpu memory pids\n")
            .expect("controllers");
        let containment = CgroupContainmentV2::open(policy(
            &fixture,
            CgroupAuthorityModeV2::LocalFixture,
        ))
        .expect("containment");
        assert!(matches!(
            containment.create_operation("../escape"),
            Err(BrokerServiceErrorV2::InvalidIdentifier)
        ));
    }
}
