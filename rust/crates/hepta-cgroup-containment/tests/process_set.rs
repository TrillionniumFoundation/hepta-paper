use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_cgroup_containment::{CgroupV2OperationV1, CgroupV2PolicyV1, ProcessContainmentModeV1};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn fixture() -> (PathBuf, u32) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "hepta-cgroup-process-set-{}-{nonce}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).expect("fixture root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
    let uid = fs::metadata(&root).expect("metadata").uid();
    (root, uid)
}

#[test]
fn process_set_membership_is_not_a_process_group_identity() {
    assert!(
        !ProcessContainmentModeV1::ProcessGroupOnly
            .production_eligible()
            .expect("process-group decision")
    );
    let (root, uid) = fixture();
    let operation = CgroupV2OperationV1::create(
        CgroupV2PolicyV1::local_fixture(root.clone(), uid),
        "daemonization-fixture",
    )
    .expect("operation");
    operation.attach_pid(1001).expect("session leader");
    operation.attach_pid(1002).expect("setsid descendant");
    operation.attach_pid(1003).expect("double-fork descendant");
    let members = fs::read_to_string(operation.path().join("cgroup.procs")).expect("process set");
    assert_eq!(
        members.lines().collect::<Vec<_>>(),
        ["1001", "1002", "1003"]
    );
    operation.kill_and_cleanup().expect("cleanup");
    fs::remove_dir(root).expect("remove root");
}
