//! Linux cgroup-v2 process-set authority for production provider containment.

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-cgroup-containment requires Linux cgroup-v2 semantics");

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

mod owner;

use owner::{Control, OperationOwner, RootOwner};
use thiserror::Error;

const VERSION: u16 = 1;
const MAX_CONTROL_BYTES: usize = 128;
const MAX_FIXTURE_PROCESS_SET_BYTES: usize = 8 * 1024;

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
        let _observed = RootOwner::capture(self)?;
        Ok(self.authority_mode == CgroupAuthorityModeV1::ProductionSystem)
    }

    fn validate_limits(&self) -> Result<(), CgroupV2Error> {
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

/// One retained operation cgroup. This owner does not prevent namespace revocation.
/// Name creation/removal requires cooperating ownership of the delegated namespace.
pub struct CgroupV2OperationV1 {
    path: PathBuf,
    policy: CgroupV2PolicyV1,
    owner: OperationOwner,
    fixture_members: Option<Mutex<BTreeSet<u32>>>,
    cleanup_armed: bool,
}

impl CgroupV2OperationV1 {
    /// Creates a retained operation and installs limits before attachment.
    /// Partial initialization errors leave the name for inspection, not blind removal.
    pub fn create(policy: CgroupV2PolicyV1, operation_id: &str) -> Result<Self, CgroupV2Error> {
        let root = RootOwner::capture(&policy)?;
        validate_identifier(operation_id)?;
        let owner = root.create(operation_id)?;
        if policy.authority_mode == CgroupAuthorityModeV1::LocalFixture {
            owner.create_fixture_controls()?;
        }
        owner.write(Control::PidsMax, &policy.pids_max.to_string())?;
        owner.write(Control::MemoryMax, &policy.memory_max.to_string())?;
        owner.write(
            Control::CpuMax,
            &format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
        )?;
        owner.assert_current()?;
        Ok(Self::from_owner(policy, operation_id, owner))
    }

    /// Reopens the expected operation under a newly observed retained root.
    /// Use the root-bound variant when a durable record also specifies root identity.
    pub fn recover_existing(
        policy: CgroupV2PolicyV1,
        operation_id: &str,
        expected_device: u64,
        expected_inode: u64,
        expected_changed_seconds: i64,
        expected_changed_nanoseconds: i64,
    ) -> Result<Option<Self>, CgroupV2Error> {
        Self::recover_inner(
            policy,
            operation_id,
            None,
            (
                expected_device,
                expected_inode,
                expected_changed_seconds,
                expected_changed_nanoseconds,
            ),
        )
    }

    /// Checks the actual retained root before observing operation absence or
    /// arming cleanup. Neither a replacement root nor operation is adopted.
    pub fn recover_existing_with_root_identity(
        policy: CgroupV2PolicyV1,
        operation_id: &str,
        expected_root: (u64, u64),
        expected_operation: (u64, u64, i64, i64),
    ) -> Result<Option<Self>, CgroupV2Error> {
        Self::recover_inner(
            policy,
            operation_id,
            Some(expected_root),
            expected_operation,
        )
    }

    fn recover_inner(
        policy: CgroupV2PolicyV1,
        operation_id: &str,
        expected_root: Option<(u64, u64)>,
        expected_operation: (u64, u64, i64, i64),
    ) -> Result<Option<Self>, CgroupV2Error> {
        let root = RootOwner::capture(&policy)?;
        validate_identifier(operation_id)?;
        if expected_root.is_some_and(|expected| expected != root.identity()) {
            return Err(CgroupV2Error::RecoveryIdentityMismatch);
        }
        root.recover(operation_id, expected_operation)
            .map(|owner| owner.map(|owner| Self::from_owner(policy, operation_id, owner)))
    }

    fn from_owner(policy: CgroupV2PolicyV1, operation_id: &str, owner: OperationOwner) -> Self {
        let fixture_members = (policy.authority_mode == CgroupAuthorityModeV1::LocalFixture)
            .then(|| Mutex::new(BTreeSet::new()));
        Self {
            path: policy.delegated_root.join(operation_id),
            policy,
            owner,
            fixture_members,
            cleanup_armed: true,
        }
    }

    /// Observes the actual held operation for durable recovery. Namespace drift
    /// makes this owner terminal; observations do not grant continued authority.
    pub fn directory_identity(&self) -> Result<(u64, u64, i64, i64), CgroupV2Error> {
        self.owner.directory_identity()
    }

    /// Observes the root retained by the same operation owner, never a new baseline.
    pub fn root_directory_identity(&self) -> Result<(u64, u64), CgroupV2Error> {
        self.owner.root_identity()
    }

    /// Attaches to the retained cgroup only. A failing observation may follow a
    /// write to the original object, and must not be interpreted as no effect.
    pub fn attach_pid(&self, pid: u32) -> Result<(), CgroupV2Error> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err(CgroupV2Error::InvalidPid(pid));
        }
        self.owner.assert_current()?;
        if let Some(fixture_members) = &self.fixture_members {
            let mut members = fixture_members
                .lock()
                .map_err(|_| self.owner.invalidate(CgroupV2Error::FixtureStatePoisoned))?;
            let maximum =
                usize::try_from(self.policy.pids_max).map_err(|_| CgroupV2Error::InvalidPolicy)?;
            if !members.contains(&pid) && members.len() >= maximum {
                return Err(CgroupV2Error::PidLimitExceeded);
            }
            let mut next = members.clone();
            next.insert(pid);
            let value = next
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            if value.len() > MAX_FIXTURE_PROCESS_SET_BYTES {
                return Err(CgroupV2Error::InvalidControlValue);
            }
            self.owner.write(Control::Procs, &value)?;
            self.owner.write(Control::Events, "populated 1\nfrozen 0")?;
            *members = next;
            return Ok(());
        }
        let value = pid.to_string();
        if value.len() > MAX_CONTROL_BYTES {
            return Err(CgroupV2Error::InvalidControlValue);
        }
        self.owner.write(Control::Procs, &value)
    }

    /// Attempts kill, bounded empty observation and cooperating name removal once.
    /// Errors require inspection; Drop does not retry this explicit attempt.
    pub fn kill_and_cleanup(mut self) -> Result<(), CgroupV2Error> {
        self.cleanup_once()
    }

    fn cleanup_once(&mut self) -> Result<(), CgroupV2Error> {
        self.cleanup_armed = false;
        self.cleanup_inner()
    }

    /// Caller-visible path for display only; I/O uses retained descriptors.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read_populated(&self) -> Result<bool, CgroupV2Error> {
        let bytes = self.owner.events()?;
        parse_populated(&bytes).map_err(|error| self.owner.invalidate(error))
    }

    fn cleanup_inner(&self) -> Result<(), CgroupV2Error> {
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(self.policy.cleanup_timeout_ms))
            .ok_or(CgroupV2Error::InvalidPolicy)?;
        // Validate bounded input before the first cleanup effect. Fixture event
        // updates below simulate population only; they are not kernel evidence.
        self.read_populated()?;
        self.owner.write(Control::Kill, "1")?;
        if self.policy.authority_mode == CgroupAuthorityModeV1::LocalFixture {
            self.owner.write(Control::Events, "populated 0\nfrozen 0")?;
        }
        while self.read_populated()? {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| self.owner.invalidate(CgroupV2Error::CleanupTimeout))?;
            thread::sleep(Duration::from_millis(self.policy.poll_interval_ms).min(remaining));
        }
        self.owner.remove()
    }
}

impl Drop for CgroupV2OperationV1 {
    fn drop(&mut self) {
        if self.cleanup_armed && !self.owner.failed() {
            let _ = self.cleanup_once();
        }
    }
}

fn parse_populated(bytes: &[u8]) -> Result<bool, CgroupV2Error> {
    let text = std::str::from_utf8(bytes).map_err(|_| CgroupV2Error::EventsMalformed)?;
    let mut keys = BTreeSet::new();
    let mut populated = None;
    for line in text.lines() {
        let mut fields = line.split_ascii_whitespace();
        let key = fields.next().ok_or(CgroupV2Error::EventsMalformed)?;
        let value = fields.next().ok_or(CgroupV2Error::EventsMalformed)?;
        if fields.next().is_some()
            || !keys.insert(key)
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            || value.is_empty()
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || value.parse::<u64>().is_err()
        {
            return Err(CgroupV2Error::EventsMalformed);
        }
        if key == "populated" {
            populated = Some(match value {
                "0" => false,
                "1" => true,
                _ => return Err(CgroupV2Error::EventsMalformed),
            });
        }
    }
    populated.ok_or(CgroupV2Error::EventsMalformed)
}

fn validate_identifier(value: &str) -> Result<(), CgroupV2Error> {
    if value.is_empty()
        || !value.as_bytes()[0].is_ascii_alphanumeric()
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
    /// The durable operation directory has been replaced.
    #[error("cgroup-v2 recovery directory identity mismatch")]
    RecoveryIdentityMismatch,
    /// The retained directory no longer has the observed namespace or authority.
    #[error("cgroup-v2 retained directory namespace changed")]
    NamespaceChanged,
    /// This owner observed a failure and cannot establish a new baseline.
    #[error("cgroup-v2 owner requires inspection")]
    OwnerRequiresInspection,
    /// A control is not an eligible kernel or private regular fixture file.
    #[error("cgroup-v2 control file is invalid")]
    InvalidControlFile,
    /// Operation identifier is invalid.
    #[error("cgroup-v2 operation id is invalid")]
    InvalidOperationId,
    /// PID is outside the supported range.
    #[error("cgroup-v2 pid is invalid: {0}")]
    InvalidPid(u32),
    /// The configured fixture process limit was reached.
    #[error("cgroup-v2 pid limit was reached")]
    PidLimitExceeded,
    /// Fixture membership state was poisoned by a prior panic.
    #[error("cgroup-v2 fixture membership state is poisoned")]
    FixtureStatePoisoned,
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
