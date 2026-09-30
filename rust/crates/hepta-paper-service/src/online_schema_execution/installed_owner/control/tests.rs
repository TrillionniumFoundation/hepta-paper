//! Isolated root fixture only. No installed path, unit, bus or SQLite is touched.
use super::*;
use crate::online_schema_execution::cli::{finalized_predecessor, node_history::tests::Fixture};
use nix::unistd::{Gid, Uid, chown};
use std::process::Command;
const SELECTOR: &str = "online_schema_execution::installed_owner::control::tests::signed_node_control_memento_crash_boundaries_preserve_exact_history_and_refuse_changes";
fn set_service_owner(path: &Path) {
    if path.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            set_service_owner(&entry.unwrap().path());
        }
    }
    chown(path, Some(Uid::from_raw(65534)), Some(Gid::from_raw(65534))).unwrap();
}
#[test]
#[ignore = "requires root solely for private service-owned preimage fixture; no live host effects"]
fn signed_node_control_memento_crash_boundaries_preserve_exact_history_and_refuse_changes() {
    if nix::unistd::getuid().as_raw() != 0 {
        let node = std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into());
        let discovered = Command::new(node)
            .args(["-p", "process.execPath"])
            .output()
            .expect("discover the actual configured Node executable");
        assert!(
            discovered.status.success(),
            "Node executable discovery failed"
        );
        let node = String::from_utf8(discovered.stdout).unwrap();
        let node = node.trim();
        assert!(
            Path::new(node).is_absolute(),
            "Node executable must be explicit"
        );
        let child = Command::new("sudo")
            .args(["-n", "env"])
            .arg(format!("HEPTA_TEST_NODE={node}"))
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", SELECTOR, "--ignored", "--test-threads=1"])
            .output()
            .expect("the isolated service-owned control fixture requires sudo");
        assert!(
            child.status.success(),
            "actual root fixture failed: stdout={} stderr={}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            String::from_utf8_lossy(&child.stdout)
                .contains("test result: ok. 1 passed; 0 failed; 0 ignored;"),
            "sudo child must execute exactly one actual fixture: {}",
            String::from_utf8_lossy(&child.stdout)
        );
        return;
    }
    assert_eq!(
        nix::unistd::getuid().as_raw(),
        0,
        "run this isolated fixture as root"
    );
    for point in [
        "before_memento",
        "after_memento_before_rename",
        "after_rename_before_new_control",
        "after_new_control",
    ] {
        let f = Fixture::new();
        let case = &f.value["cases"][0];
        let (old, pin) = f.control(case);
        f.mirror(&old, case);
        let runtime = f.root.join("runtime");
        let parent = runtime.join("autonomous-research");
        fs::create_dir_all(&parent).unwrap();
        let control = parent.join("online-schema-transition");
        fs::rename(old, &control).unwrap();
        set_service_owner(&control);
        let original_metadata = metadata(&control).unwrap();
        let active = fs::read(control.join("ACTIVE.json")).unwrap();
        let final_bytes = fs::read(control.join("FINAL.json")).unwrap();
        let history = fs::read_dir(control.join("history"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name();
        let manifest = fs::read(
            control
                .join("history")
                .join(&history)
                .join("MANIFEST.sha256"),
        )
        .unwrap();
        let operation = SchemaOperationIdentityV1 {
            runtime_root: runtime,
            transition_id: case["audit"]["transitionId"].as_str().unwrap().into(),
            plan_hash: case["audit"]["planHash"].as_str().unwrap().into(),
            profile_sha256: hash_bytes(b"isolated-test-profile"),
            barrier_root: f.root.join("maintenance"),
        };
        Directory::open_or_create(&operation.barrier_root.join("execution"), true).unwrap();
        let authority = f.authority();
        let guard =
            finalized_predecessor(&operation.runtime_root, Some(&pin), &authority, None).unwrap();
        assert_eq!(
            archive_control_impl(&operation, &guard, &mut |actual| if actual == point {
                Err(error("test_private_control_crash"))
            } else {
                Ok(())
            })
            .err()
            .unwrap()
            .code,
            "test_private_control_crash"
        );
        drop(guard);
        let wrong_pin = hash_bytes(b"another predecessor is not the selected preimage");
        assert!(
            recover_control_handoff_v1(&operation, Some(&wrong_pin), || {
                finalized_predecessor(&operation.runtime_root, Some(&pin), &authority, None)
            })
            .is_err()
        );
        recover_control_handoff_v1(&operation, Some(&pin), || {
            finalized_predecessor(&operation.runtime_root, Some(&pin), &authority, None)
        })
        .unwrap();
        let archive = operation.barrier_root.join("execution/predecessor-control");
        assert_eq!(metadata(&archive).unwrap(), original_metadata);
        assert_eq!(fs::read(archive.join("ACTIVE.json")).unwrap(), active);
        assert_eq!(fs::read(archive.join("FINAL.json")).unwrap(), final_bytes);
        assert_eq!(
            fs::read(
                archive
                    .join("history")
                    .join(&history)
                    .join("MANIFEST.sha256")
            )
            .unwrap(),
            manifest
        );
        assert_eq!(fs::metadata(&control).unwrap().uid(), 0);
        recover_control_handoff_v1(&operation, Some(&pin), || {
            panic!("completed handoff must not reobserve new control as predecessor")
        })
        .unwrap();
        fs::write(archive.join("ACTIVE.json"), b"changed active").unwrap();
        assert!(
            recover_control_handoff_v1(&operation, Some(&pin), || {
                panic!("archive ACTIVE change must fail from its selected tree pin")
            })
            .is_err()
        );
        fs::write(archive.join("ACTIVE.json"), &active).unwrap();
        let manifest_path = archive
            .join("history")
            .join(&history)
            .join("MANIFEST.sha256");
        fs::write(&manifest_path, b"changed history mirror").unwrap();
        assert!(
            recover_control_handoff_v1(&operation, Some(&pin), || {
                panic!("history change must fail from its selected tree pin")
            })
            .is_err()
        );
        fs::write(manifest_path, &manifest).unwrap();
        fs::write(archive.join("FINAL.json"), b"changed").unwrap();
        assert!(
            recover_control_handoff_v1(&operation, Some(&pin), || panic!(
                "archive change must fail without observing current control"
            ))
            .is_err()
        );
    }
}
