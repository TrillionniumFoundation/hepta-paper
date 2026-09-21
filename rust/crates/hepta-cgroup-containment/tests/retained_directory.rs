//! Ordinary-filesystem namespace regressions. These fixtures never qualify a
//! production cgroup and never attach or signal a real process.

use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use hepta_cgroup_containment::{CgroupV2Error, CgroupV2OperationV1, CgroupV2PolicyV1};
use nix::{sys::stat::Mode, unistd::mkfifo};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    sandbox: PathBuf,
    root: PathBuf,
    uid: u32,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .expect("temporary parent")
            .join(format!(
                "hepta-cgroup-owner-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&sandbox).expect("owned sandbox");
        fs::set_permissions(&sandbox, fs::Permissions::from_mode(0o700)).expect("sandbox mode");
        let root = sandbox.join("delegated");
        fs::create_dir(&root).expect("fixture root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        let uid = fs::metadata(&root).expect("root metadata").uid();
        Self { sandbox, root, uid }
    }

    fn policy(&self) -> CgroupV2PolicyV1 {
        CgroupV2PolicyV1::local_fixture(self.root.clone(), self.uid)
    }

    fn operation(&self) -> CgroupV2OperationV1 {
        CgroupV2OperationV1::create(self.policy(), "operation").expect("actual fixture owner")
    }

    fn replace_operation(&self) -> CgroupV2OperationV1 {
        fs::rename(self.root.join("operation"), self.root.join("original-held"))
            .expect("substitute operation name");
        self.operation()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.sandbox);
    }
}

fn controls(path: &Path) -> Vec<Vec<u8>> {
    [
        "cgroup.procs",
        "cgroup.events",
        "cgroup.kill",
        "pids.max",
        "memory.max",
        "cpu.max",
    ]
    .iter()
    .map(|name| fs::read(path.join(name)).expect("fixture control bytes"))
    .collect()
}

#[test]
fn live_operation_replacement_is_terminal_and_never_written_or_deleted() {
    let fixture = Fixture::new();
    let original = fixture.operation();
    let replacement = fixture.replace_operation();
    let before = controls(replacement.path());
    assert_eq!(
        original.attach_pid(1001),
        Err(CgroupV2Error::NamespaceChanged)
    );
    assert_eq!(
        original.directory_identity(),
        Err(CgroupV2Error::OwnerRequiresInspection)
    );
    assert_eq!(
        original.root_directory_identity(),
        Err(CgroupV2Error::OwnerRequiresInspection)
    );
    assert_eq!(
        original.kill_and_cleanup(),
        Err(CgroupV2Error::OwnerRequiresInspection)
    );
    assert_eq!(controls(replacement.path()), before);
    assert!(fixture.root.join("original-held").is_dir());
    replacement
        .kill_and_cleanup()
        .expect("replacement owner cleans only itself");
}

#[test]
fn namespace_change_found_by_drop_preserves_both_original_and_replacement() {
    let fixture = Fixture::new();
    let original = fixture.operation();
    let replacement = fixture.replace_operation();
    let before = controls(replacement.path());
    let old = controls(&fixture.root.join("original-held"));
    drop(original);
    assert_eq!(controls(replacement.path()), before);
    assert_eq!(controls(&fixture.root.join("original-held")), old);
    replacement.kill_and_cleanup().expect("replacement cleanup");
}

#[test]
fn root_replacement_cannot_redirect_the_live_owner() {
    let fixture = Fixture::new();
    let original = fixture.operation();
    fs::rename(&fixture.root, fixture.sandbox.join("old-root")).expect("move original hierarchy");
    fs::create_dir(&fixture.root).expect("replacement hierarchy");
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700))
        .expect("replacement mode");
    let replacement = fixture.operation();
    let before = controls(replacement.path());
    assert_eq!(
        original.attach_pid(1002),
        Err(CgroupV2Error::NamespaceChanged)
    );
    drop(original);
    assert_eq!(controls(replacement.path()), before);
    assert!(fixture.sandbox.join("old-root/operation").is_dir());
    replacement
        .kill_and_cleanup()
        .expect("new root owner cleanup");
}

#[test]
fn sibling_changes_do_not_revoke_a_retained_root() {
    let fixture = Fixture::new();
    let operation = fixture.operation();
    let root_identity = operation.root_directory_identity().expect("root identity");
    let sibling =
        CgroupV2OperationV1::create(fixture.policy(), "sibling").expect("independent sibling");
    assert_eq!(
        operation
            .root_directory_identity()
            .expect("same root with new child"),
        root_identity
    );
    sibling.kill_and_cleanup().expect("remove sibling");
    operation
        .attach_pid(1003)
        .expect("same owner after nlink and ctime changes");
    operation.kill_and_cleanup().expect("ordinary cleanup");
    assert!(
        fs::read_dir(&fixture.root)
            .expect("root listing")
            .next()
            .is_none()
    );
}

#[test]
fn deleted_original_is_not_replaced_by_a_same_named_directory() {
    let fixture = Fixture::new();
    let original = fixture.operation();
    // Ordinary-FS analogue of an empty removed object, not a kernel cgroup test.
    fs::remove_dir_all(original.path()).expect("remove original fixture files and directory");
    let replacement = fixture.operation();
    let before = controls(replacement.path());
    assert_eq!(
        original.directory_identity(),
        Err(CgroupV2Error::NamespaceChanged)
    );
    drop(original);
    assert_eq!(controls(replacement.path()), before);
    replacement.kill_and_cleanup().expect("new owner cleanup");
}

#[test]
fn expected_root_is_checked_before_missing_operation_is_accepted() {
    let fixture = Fixture::new();
    let metadata = fs::metadata(&fixture.root).expect("original root");
    let expected_root = (metadata.dev(), metadata.ino());
    fs::rename(&fixture.root, fixture.sandbox.join("old-root")).expect("remove original root name");
    fs::create_dir(&fixture.root).expect("replacement root");
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).expect("mode");
    assert!(matches!(
        CgroupV2OperationV1::recover_existing_with_root_identity(
            fixture.policy(),
            "absent",
            expected_root,
            (0, 0, 0, 0)
        ),
        Err(CgroupV2Error::RecoveryIdentityMismatch)
    ));
    fs::remove_dir(&fixture.root).expect("remove empty replacement");
    fs::rename(fixture.sandbox.join("old-root"), &fixture.root).expect("restore original root");
    assert!(
        CgroupV2OperationV1::recover_existing_with_root_identity(
            fixture.policy(),
            "absent",
            expected_root,
            (0, 0, 0, 0)
        )
        .expect("absence in the actual expected root")
        .is_none()
    );
}

#[test]
fn recovered_owner_retains_its_original_directory_after_factory_return() {
    let fixture = Fixture::new();
    let original = fixture.operation();
    let expected_root = original.root_directory_identity().expect("root identity");
    let expected_operation = original.directory_identity().expect("operation identity");
    // A failed explicit cleanup leaves actual state for recovery without leaking
    // an owner or pretending this in-process setup is a crash qualification.
    fs::write(
        original.path().join("cgroup.events"),
        b"populated 0\npopulated 1\n",
    )
    .expect("malformed fixture events");
    assert_eq!(
        original.kill_and_cleanup(),
        Err(CgroupV2Error::EventsMalformed)
    );
    fs::write(
        fixture.root.join("operation/cgroup.events"),
        b"populated 0\nfrozen 0",
    )
    .expect("repair fixture input");
    let recovered = CgroupV2OperationV1::recover_existing_with_root_identity(
        fixture.policy(),
        "operation",
        expected_root,
        expected_operation,
    )
    .expect("actual bound reopen")
    .expect("present");
    let replacement = fixture.replace_operation();
    let before = controls(replacement.path());
    assert_eq!(
        recovered.kill_and_cleanup(),
        Err(CgroupV2Error::NamespaceChanged)
    );
    assert_eq!(controls(replacement.path()), before);
    replacement.kill_and_cleanup().expect("replacement cleanup");
}

#[test]
fn fixture_symlink_and_hardlink_controls_cannot_truncate_another_file() {
    for hardlink in [false, true] {
        let fixture = Fixture::new();
        let operation = fixture.operation();
        let sentinel = fixture.sandbox.join("sentinel");
        fs::write(&sentinel, b"keep these bytes").expect("sentinel");
        fs::set_permissions(&sentinel, fs::Permissions::from_mode(0o600)).expect("sentinel mode");
        let procs = operation.path().join("cgroup.procs");
        fs::remove_file(&procs).expect("replace fixture control");
        if hardlink {
            fs::hard_link(&sentinel, &procs).expect("fixture hardlink");
        } else {
            symlink(&sentinel, &procs).expect("fixture symlink");
        }
        assert!(operation.attach_pid(1004).is_err());
        drop(operation);
        assert_eq!(
            fs::read(&sentinel).expect("unchanged sentinel"),
            b"keep these bytes"
        );
    }
}

#[test]
fn events_are_actually_bounded_and_require_one_valid_populated_field() {
    for bytes in [
        b"populated 0\npopulated 1\n".to_vec(),
        b"populated 2\n".to_vec(),
        b"frozen 0\n".to_vec(),
        b"populated 0 trailing\n".to_vec(),
        vec![b'x'; 4097],
    ] {
        let fixture = Fixture::new();
        let operation = fixture.operation();
        fs::write(operation.path().join("cgroup.events"), bytes).expect("invalid fixture events");
        assert_eq!(
            operation.kill_and_cleanup(),
            Err(CgroupV2Error::EventsMalformed)
        );
        assert_eq!(
            fs::read(fixture.root.join("operation/cgroup.kill"))
                .expect("no kill write before refusal"),
            b"0"
        );
    }
}

#[test]
fn fifo_events_and_wrong_control_permissions_refuse_without_cleanup_effects() {
    for fifo in [false, true] {
        let fixture = Fixture::new();
        let operation = fixture.operation();
        let events = operation.path().join("cgroup.events");
        if fifo {
            fs::remove_file(&events).expect("remove regular events");
            mkfifo(&events, Mode::S_IRUSR | Mode::S_IWUSR).expect("owned FIFO");
        } else {
            fs::set_permissions(&events, fs::Permissions::from_mode(0o644))
                .expect("invalid fixture mode");
        }
        let started = Instant::now();
        assert_eq!(
            operation.kill_and_cleanup(),
            Err(CgroupV2Error::InvalidControlFile)
        );
        assert!(
            started.elapsed().as_secs() < 2,
            "FIFO must not block the reader"
        );
        assert_eq!(
            fs::read(fixture.root.join("operation/cgroup.kill")).expect("preserved kill fixture"),
            b"0"
        );
    }
}

#[test]
fn changed_directory_permissions_are_terminal_even_after_restoration() {
    let fixture = Fixture::new();
    let operation = fixture.operation();
    let path = operation.path().to_owned();
    let initial = fs::metadata(&path)
        .expect("initial directory mode")
        .permissions();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750))
        .expect("change authority metadata");
    assert_eq!(
        operation.attach_pid(1005),
        Err(CgroupV2Error::NamespaceChanged)
    );
    fs::set_permissions(&path, initial).expect("restore permissions");
    assert_eq!(
        operation.attach_pid(1005),
        Err(CgroupV2Error::OwnerRequiresInspection)
    );
    drop(operation);
    assert_eq!(
        fs::read(path.join("cgroup.kill")).expect("no implicit retry"),
        b"0"
    );
}
