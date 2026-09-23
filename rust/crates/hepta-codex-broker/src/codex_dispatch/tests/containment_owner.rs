use super::*;
use std::{
    process::{Child, Command, Stdio},
    time::Instant,
};

struct OwnedChild(Child);

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) fn create_record_then_exit(fixture: &Fixture) {
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().expect("actual test executable"))
            .args([
                "--exact",
                "codex_dispatch::tests::containment_owner::create_bound_cgroup_and_exit",
                "--ignored",
            ])
            .env("HEPTA_CGROUP_OWNER_EXIT_ROOT", &fixture.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("owned containment child"),
    );
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("bounded child status") {
            break status;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "child exit timeout"
        );
        thread::sleep(Duration::from_millis(5));
    };
    assert!(status.success(), "containment child failed: {status}");
    assert!(
        fixture
            .root
            .join("codex-containment-dispatch-1.json")
            .is_file(),
        "actual child must publish its durable binding before exiting"
    );
}

#[test]
#[ignore = "owned child fixture invoked by containment recovery tests"]
fn create_bound_cgroup_and_exit() {
    let root = PathBuf::from(
        std::env::var_os("HEPTA_CGROUP_OWNER_EXIT_ROOT").expect("owned fixture root"),
    );
    let uid = fs::metadata(&root).expect("fixture root").uid();
    let store = BrokerJournalStoreV1::open(
        root.join("broker.sqlite"),
        BrokerJournalPolicyV1::strict(uid),
    )
    .expect("actual existing journal");
    let policy = CgroupV2PolicyV1::local_fixture(root.join("cgroups"), uid);
    let operation = CgroupV2OperationV1::create(policy.clone(), "dispatch-1")
        .expect("actual fixture operation owner");
    bind_containment(&store, "dispatch-1", &root, &policy, &operation)
        .expect("durable record from retained identities");
    // Actual process exit skips Rust destructors but the kernel closes every
    // owned descriptor. No mem::forget leak in the parent test process.
    std::process::exit(0);
}

#[test]
fn replacement_root_with_absent_operation_cannot_clear_the_original_record() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let store = fixture.reserved();
    let root = fixture.root.join("cgroups");
    fs::create_dir(&root).expect("fixture hierarchy");
    let policy = CgroupV2PolicyV1::local_fixture(root.clone(), fixture.uid);
    create_record_then_exit(&fixture);
    let record_path = fixture.root.join("codex-containment-dispatch-1.json");
    let record = fs::read(&record_path).expect("original durable record");
    let original = fixture.root.join("original-cgroups");
    fs::rename(&root, &original).expect("substitute ordinary fixture hierarchy");
    fs::create_dir(&root).expect("replacement hierarchy without operation");

    assert!(matches!(
        crate::recover_codex_dispatch_containment(&store, &fixture.root, &policy),
        Err(CodexDispatchError::Containment(
            hepta_codex_runtime::CgroupV2Error::RecoveryIdentityMismatch
        ))
    ));
    assert_eq!(fs::read(&record_path).expect("record retained"), record);
    assert_eq!(
        fs::read(original.join("dispatch-1/cgroup.kill")).expect("old control"),
        b"0"
    );
    assert!(
        fs::read_dir(&root)
            .expect("replacement entries")
            .next()
            .is_none()
    );
    // The original root's identity is restored by the test owner; successful
    // recovery then consumes the same record through the actual public API.
    fs::remove_dir(&root).expect("remove owned empty replacement");
    fs::rename(&original, &root).expect("restore original hierarchy");
    assert_eq!(
        crate::recover_codex_dispatch_containment(&store, &fixture.root, &policy)
            .expect("recover actual original directory"),
        1
    );
    assert!(!record_path.exists());
}

#[test]
fn binding_a_live_replaced_owner_cannot_publish_the_replacement_identity() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let store = fixture.reserved();
    let root = fixture.root.join("cgroups");
    fs::create_dir(&root).expect("fixture hierarchy");
    let policy = CgroupV2PolicyV1::local_fixture(root.clone(), fixture.uid);
    let original =
        CgroupV2OperationV1::create(policy.clone(), "dispatch-1").expect("original owner");
    fs::rename(root.join("dispatch-1"), root.join("original-operation"))
        .expect("ordinary filesystem replacement");
    let replacement =
        CgroupV2OperationV1::create(policy.clone(), "dispatch-1").expect("replacement owner");
    assert!(bind_containment(&store, "dispatch-1", &fixture.root, &policy, &original).is_err());
    assert!(
        !fixture
            .root
            .join("codex-containment-dispatch-1.json")
            .exists()
    );
    drop(original);
    assert_eq!(
        fs::read(replacement.path().join("cgroup.kill")).expect("replacement untouched"),
        b"0"
    );
    replacement
        .kill_and_cleanup()
        .expect("owned replacement cleanup");
}
