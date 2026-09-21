use super::*;
use crate::CgroupV2OperationV1;
use std::{
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    sandbox: PathBuf,
    policy: CgroupV2PolicyV1,
}

impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .expect("temporary parent")
            .join(format!(
                "hepta-cgroup-io-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&sandbox).expect("sandbox");
        fs::set_permissions(&sandbox, fs::Permissions::from_mode(0o700)).expect("mode");
        let root = sandbox.join("root");
        fs::create_dir(&root).expect("root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        let uid = fs::metadata(&root).expect("metadata").uid();
        Self {
            sandbox,
            policy: CgroupV2PolicyV1::local_fixture(root, uid),
        }
    }

    fn operation(&self) -> CgroupV2OperationV1 {
        CgroupV2OperationV1::create(self.policy.clone(), "operation").expect("fixture operation")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.sandbox);
    }
}

#[test]
fn actual_write_boundary_never_redirects_after_its_namespace_check() {
    for replace_root in [false, true] {
        let fixture = Fixture::new();
        let original = fixture.operation();
        let mut replacement = None;
        let held_path = if replace_root {
            fixture.sandbox.join("held-root/operation")
        } else {
            fixture.policy.delegated_root.join("held-operation")
        };
        let result = original
            .owner
            .write_with_boundary(Control::Procs, "1006", || {
                if replace_root {
                    fs::rename(
                        &fixture.policy.delegated_root,
                        fixture.sandbox.join("held-root"),
                    )
                    .expect("move root at actual I/O boundary");
                    fs::create_dir(&fixture.policy.delegated_root).expect("new root");
                    fs::set_permissions(
                        &fixture.policy.delegated_root,
                        fs::Permissions::from_mode(0o700),
                    )
                    .expect("new root mode");
                } else {
                    fs::rename(original.path(), &held_path)
                        .expect("move operation at actual I/O boundary");
                }
                replacement = Some(fixture.operation());
            });
        assert_eq!(result, Err(CgroupV2Error::NamespaceChanged));
        let replacement = replacement.expect("replacement owner");
        assert!(
            fs::read(replacement.path().join("cgroup.procs"))
                .expect("replacement untouched")
                .is_empty()
        );
        // A failed observation can follow a write to the retained original.
        // This is explicitly not a no-effect/committed=false assertion.
        assert_eq!(
            fs::read(held_path.join("cgroup.procs")).expect("original descriptor target"),
            b"1006"
        );
        drop(original);
        assert_eq!(
            fs::read(replacement.path().join("cgroup.kill")).expect("Drop did not rebase"),
            b"0"
        );
        replacement
            .kill_and_cleanup()
            .expect("replacement explicit cleanup");
    }
}

#[test]
fn actual_cleanup_once_disarms_drop_after_failure() {
    let fixture = Fixture::new();
    let mut original = fixture.operation();
    fs::write(
        original.path().join("cgroup.events"),
        b"populated 0\npopulated 1\n",
    )
    .expect("force actual bounded reader refusal");
    // This private helper is consumed by public kill_and_cleanup and Drop.
    assert_eq!(original.cleanup_once(), Err(CgroupV2Error::EventsMalformed));
    fs::rename(original.path(), fixture.policy.delegated_root.join("held"))
        .expect("substitute after first cleanup refusal");
    let replacement = fixture.operation();
    drop(original);
    assert_eq!(
        fs::read(replacement.path().join("cgroup.kill")).expect("no hidden retry"),
        b"0"
    );
    assert!(replacement.path().is_dir());
    replacement.kill_and_cleanup().expect("replacement cleanup");
}

#[test]
fn ordinary_held_directory_is_not_cgroup2_and_all_owned_directory_fds_close() {
    let fixture = Fixture::new();
    let root = RootOwner::capture(&fixture.policy).expect("actual fixture root owner");
    assert_eq!(
        verify_cgroup2(&root.file),
        Err(CgroupV2Error::InvalidHierarchy)
    );
    let owner = root.create("operation").expect("actual directory owner");
    let root_identity = owner.root.identity();
    let operation_identity = (owner.identity.device, owner.identity.inode);
    let count = || {
        fs::read_dir("/proc/self/fd")
            .expect("this test process descriptors")
            .filter_map(Result::ok)
            .filter_map(|entry| fs::metadata(entry.path()).ok())
            .filter(|metadata| {
                let identity = (metadata.dev(), metadata.ino());
                identity == root_identity || identity == operation_identity
            })
            .count()
    };
    assert_eq!(count(), 2, "only the two original O_PATH owners remain");
    drop(owner);
    assert_eq!(count(), 0, "no leaked operation or root FD");
}
