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

const ROLLBACK_SELECTOR: &str = "online_schema_execution::installed_owner::control::tests::signed_node_early_inverse_crash_and_unknown_boundaries_preserve_exact_family";
#[test]
#[ignore = "requires root solely for private service-owned preimage fixture; no live host effects"]
fn signed_node_early_inverse_crash_and_unknown_boundaries_preserve_exact_family() {
    if nix::unistd::getuid().as_raw() != 0 {
        let output =
            Command::new(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()))
                .args(["-p", "process.execPath"])
                .output()
                .unwrap();
        assert!(output.status.success());
        let node = String::from_utf8(output.stdout).unwrap();
        let node = node.trim();
        assert!(Path::new(node).is_absolute());
        let child = Command::new("sudo")
            .args(["-n", "env"])
            .arg(format!("HEPTA_TEST_NODE={node}"))
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                ROLLBACK_SELECTOR,
                "--ignored",
                "--test-threads=1",
            ])
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{} {}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            String::from_utf8_lossy(&child.stdout)
                .contains("test result: ok. 1 passed; 0 failed; 0 ignored;")
        );
        return;
    }
    for point in [
        "after_inverse_before_retire_empty",
        "after_retire_before_restore",
        "after_restore_before_verify",
        "after_restored_control",
    ] {
        let f = Fixture::new();
        let case = &f.value["cases"][0];
        let (old, pin) = f.control(case);
        f.mirror(&old, case);
        let runtime = f.root.join("runtime");
        let parent = runtime.join("autonomous-research");
        fs::create_dir_all(&parent).unwrap();
        let live = parent.join("online-schema-transition");
        fs::rename(old, &live).unwrap();
        set_service_owner(&live);
        // The actual installed business parent may be service owned too.
        chown(
            &parent,
            Some(Uid::from_raw(65534)),
            Some(Gid::from_raw(65534)),
        )
        .unwrap();
        let original_metadata = metadata(&live).unwrap();
        let original_tree = control_tree_hash(&live).unwrap();
        let final_bytes = fs::read(live.join("FINAL.json")).unwrap();
        let operation = SchemaOperationIdentityV1 {
            runtime_root: runtime,
            transition_id: case["audit"]["transitionId"].as_str().unwrap().into(),
            plan_hash: case["audit"]["planHash"].as_str().unwrap().into(),
            profile_sha256: hash_bytes(b"early-rollback-isolated-profile"),
            barrier_root: f.root.join("maintenance"),
        };
        Directory::open_or_create(&operation.barrier_root.join("execution"), true).unwrap();
        let authority = f.authority();
        let interrupted = restore_control_impl(
            &operation,
            Some(&pin),
            || finalized_predecessor(&operation.runtime_root, Some(&pin), &authority, None),
            &mut |actual| {
                if actual == point {
                    Err(error("test_early_inverse_crash"))
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(interrupted.err().unwrap().code, "test_early_inverse_crash");
        restore_predecessor_control_v2(&operation, Some(&pin), || {
            panic!("selected inverse cannot observe a substitute predecessor")
        })
        .unwrap_or_else(|cause| panic!("recovery at {point}: {cause:?}"));
        assert_eq!(metadata(&live).unwrap(), original_metadata);
        assert_eq!(control_tree_hash(&live).unwrap(), original_tree);
        assert_eq!(fs::read(live.join("FINAL.json")).unwrap(), final_bytes);
        restore_predecessor_control_v2(&operation, Some(&pin), || {
            panic!("completed inverse must not archive the original again")
        })
        .unwrap();
        let retained = operation
            .barrier_root
            .join("execution/rollback-empty-control");
        assert!(retained.is_dir());
        assert!(fs::read_dir(&retained).unwrap().next().is_none());
        let wrong = hash_bytes(b"foreign predecessor");
        assert!(
            restore_predecessor_control_v2(&operation, Some(&wrong), || panic!(
                "wrong selected pin cannot invoke authority"
            ))
            .is_err()
        );
        fs::write(retained.join("new-result"), b"must never delete").unwrap();
        assert!(
            restore_predecessor_control_v2(&operation, Some(&pin), || panic!(
                "new result must survive"
            ))
            .is_err()
        );
        assert_eq!(
            fs::read(retained.join("new-result")).unwrap(),
            b"must never delete"
        );
        assert_eq!(control_tree_hash(&live).unwrap(), original_tree);
    }
    for change in ["kernel-result", "foreign-target", "archive-history"] {
        let f = Fixture::new();
        let case = &f.value["cases"][0];
        let (old, pin) = f.control(case);
        let history = f.mirror(&old, case).file_name().unwrap().to_owned();
        let runtime = f.root.join("runtime");
        let parent = runtime.join("autonomous-research");
        fs::create_dir_all(&parent).unwrap();
        let live = parent.join("online-schema-transition");
        fs::rename(old, &live).unwrap();
        set_service_owner(&live);
        let operation = SchemaOperationIdentityV1 {
            runtime_root: runtime,
            transition_id: case["audit"]["transitionId"].as_str().unwrap().into(),
            plan_hash: case["audit"]["planHash"].as_str().unwrap().into(),
            profile_sha256: hash_bytes(b"early-rollback-isolated-profile"),
            barrier_root: f.root.join("maintenance"),
        };
        Directory::open_or_create(&operation.barrier_root.join("execution"), true).unwrap();
        let authority = f.authority();
        let checkpoint = if change == "foreign-target" {
            "after_retire_before_restore"
        } else {
            "after_inverse_before_retire_empty"
        };
        assert!(
            restore_control_impl(
                &operation,
                Some(&pin),
                || finalized_predecessor(&operation.runtime_root, Some(&pin), &authority, None),
                &mut |p| if p == checkpoint {
                    Err(error("test_early_inverse_crash"))
                } else {
                    Ok(())
                }
            )
            .is_err()
        );
        let archive = operation.barrier_root.join("execution/predecessor-control");
        let modified = match change {
            "kernel-result" => live.join("ACTIVE.new-result.json"),
            "foreign-target" => {
                fs::create_dir(&live).unwrap();
                live.join("foreign")
            }
            _ => archive
                .join("history")
                .join(history)
                .join("MANIFEST.sha256"),
        };
        fs::write(&modified, b"never overwrite or discard unknown bytes").unwrap();
        assert!(
            restore_predecessor_control_v2(&operation, Some(&pin), || panic!(
                "changed family must fail from the immutable inverse"
            ))
            .is_err()
        );
        assert_eq!(
            fs::read(modified).unwrap(),
            b"never overwrite or discard unknown bytes"
        );
        assert!(archive.is_dir());
        assert!(
            restore_predecessor_control_v2(&operation, None, || panic!(
                "ambiguous null legacy memento cannot authorize an inverse"
            ))
            .is_err()
        );
    }
}
