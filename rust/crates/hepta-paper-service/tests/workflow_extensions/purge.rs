use super::*;
use hepta_codex_protocol::Sha256Digest;
use hepta_paper_service::maintenance::{
    LocalGcPlanV1, LocalMaintenanceSessionV1, LocalPurgePlanV1, LocalPurgePolicyV1,
};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

fn policy() -> LocalPurgePolicyV1 {
    LocalPurgePolicyV1 {
        not_before_unix_ms: 2000,
        expires_at_unix_ms: 5000,
        pins: BTreeSet::new(),
    }
}
fn prepared() -> (Temp, Sha256Digest, LocalGcPlanV1, LocalPurgePlanV1) {
    let (temp, hash, _, revision) = gc::paused();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    let gc = session
        .plan_gc(&hash, revision, BTreeSet::new(), &temp.0.join("quarantine"))
        .unwrap();
    session.apply_gc(&gc, &gc.plan_hash().unwrap()).unwrap();
    let plan = session
        .plan_purge(&gc.quarantine_directory, &gc.plan_hash().unwrap(), policy())
        .unwrap();
    drop(session);
    (temp, hash, gc, plan)
}
fn write(path: &Path, data: &[u8]) {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(data)
        .unwrap();
}
fn journal(plan: &LocalPurgePlanV1) -> PathBuf {
    plan.gc_plan.quarantine_directory.join("purge-v1")
}
fn stage(plan: &LocalPurgePlanV1, fence: bool, intent: bool, remove: bool) {
    let root = journal(plan);
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(root.join("intents"))
        .unwrap();
    let encoded = serde_json::to_vec(plan).unwrap();
    write(&root.join("plan.json"), &encoded);
    if fence {
        write(
            &plan.gc_plan.state_directory.join("purge-pending-v1.json"),
            &encoded,
        );
    }
    if intent {
        let entry = &plan.gc_plan.quarantine[0];
        let raw = entry.path.strip_prefix("objects/").unwrap();
        write(
            &root.join("intents").join(format!("{raw}.json")),
            &serde_json::to_vec(&serde_json::json!({
                "version":1,"purgePlanHash":plan.plan_hash().unwrap(),"file":entry
            }))
            .unwrap(),
        );
    }
    if remove {
        fs::remove_file(
            plan.gc_plan
                .quarantine_directory
                .join(&plan.gc_plan.quarantine[0].path),
        )
        .unwrap();
    }
}

#[test]
fn purge_unlinks_only_hash_selected_quarantine_and_retains_audit_records() {
    let (temp, hash, gc, plan) = prepared();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    let before = session.inspect().unwrap();
    let receipt = session
        .apply_purge(&plan, &plan.plan_hash().unwrap(), 2100)
        .unwrap();
    assert_eq!(receipt.unlinked_objects, 1);
    assert_eq!(receipt.unlinked_payload_bytes, gc.quarantine[0].bytes);
    assert!(
        !receipt.production_activation
            && !receipt.node_retirement_verified
            && !receipt.secure_erasure_verified
    );
    assert_eq!(before, session.inspect().unwrap());
    assert!(gc.quarantine_directory.join("plan.json").is_file());
    assert!(gc.quarantine_directory.join("receipt.json").is_file());
    assert!(journal(&plan).join("receipt.json").is_file());
    assert_eq!(
        fs::read_dir(gc.quarantine_directory.join("objects"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        session
            .resume_purge(&gc.quarantine_directory, &plan.plan_hash().unwrap(), 6000)
            .unwrap(),
        receipt
    );
    drop(session);
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Resume {
            expected_revision: gc.campaign_revision,
        },
        2200,
    )
    .unwrap();
    assert_eq!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 3 },
            2201
        )
        .unwrap()
        .committed_steps,
        3
    );
}
#[test]
fn purge_planning_has_no_write_side_effect() {
    let (temp, _, gc, plan) = prepared();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    let before = session.inspect().unwrap();
    let q_before: Vec<_> = fs::read_dir(&gc.quarantine_directory)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        session
            .plan_purge(&gc.quarantine_directory, &gc.plan_hash().unwrap(), policy())
            .unwrap(),
        plan
    );
    assert_eq!(before, session.inspect().unwrap());
    assert_eq!(
        q_before,
        fs::read_dir(&gc.quarantine_directory)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<Vec<_>>()
    );
    assert!(!journal(&plan).exists());
}
#[test]
fn purge_refuses_early_expired_and_wrong_hash_without_arming() {
    for now in [0, 1999, 5000, u64::MAX] {
        let (temp, _, _, plan) = prepared();
        let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
        assert!(
            session
                .apply_purge(&plan, &plan.plan_hash().unwrap(), now)
                .is_err()
        );
        assert!(!journal(&plan).exists());
    }
    let (temp, _, _, plan) = prepared();
    let wrong = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        .parse()
        .unwrap();
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .apply_purge(&plan, &wrong, 2100)
            .is_err()
    );
    assert!(!journal(&plan).exists());
}
#[test]
fn pins_on_quarantine_deny_instead_of_disappearing_from_pin_inventory() {
    let (temp, _, gc, _) = prepared();
    let mut p = policy();
    p.pins.insert(gc.quarantine[0].sha256.clone());
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .plan_purge(&gc.quarantine_directory, &gc.plan_hash().unwrap(), p)
            .is_err()
    );
}
#[test]
fn changed_source_inventory_invalidates_the_purge_before_unlink() {
    let (temp, _, _, plan) = prepared();
    ObjectStoreV1::open(&temp.state())
        .unwrap()
        .put(b"new pinned or unpinned object changes source")
        .unwrap();
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .apply_purge(&plan, &plan.plan_hash().unwrap(), 2100)
            .is_err()
    );
    assert!(!journal(&plan).exists());
    assert!(
        plan.gc_plan
            .quarantine_directory
            .join(&plan.gc_plan.quarantine[0].path)
            .exists()
    );
}
#[test]
fn changed_campaign_revision_and_running_state_prevent_purge() {
    let (temp, hash, gc, plan) = prepared();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Resume {
            expected_revision: gc.campaign_revision,
        },
        1200,
    )
    .unwrap();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    session.quiesce().unwrap();
    assert!(
        session
            .apply_purge(&plan, &plan.plan_hash().unwrap(), 2100)
            .is_err()
    );
}
#[test]
fn missing_payload_without_an_intent_is_not_counted_as_success() {
    let (temp, _, _, plan) = prepared();
    stage(&plan, true, false, true);
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .resume_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.plan_hash().unwrap(),
                2100
            )
            .is_err()
    );
    assert!(temp.state().join("purge-pending-v1.json").exists());
}
#[test]
fn crash_before_and_after_unlink_reconciles_only_durable_intents() {
    for remove in [false, true] {
        let (temp, _, _, plan) = prepared();
        stage(&plan, true, true, remove);
        assert!(ObjectStoreV1::open(&temp.state()).is_err());
        let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
        let before = fs::read(temp.state().join("campaign.sqlite")).unwrap();
        assert!(session.quiesce().is_err());
        assert_eq!(
            before,
            fs::read(temp.state().join("campaign.sqlite")).unwrap()
        );
        assert!(session.inspect().is_err());
        let result = session
            .resume_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.plan_hash().unwrap(),
                2100,
            )
            .unwrap();
        assert_eq!(result.unlinked_objects, 1);
        assert!(!temp.state().join("purge-pending-v1.json").exists());
        drop(session);
        assert!(ObjectStoreV1::open(&temp.state()).is_ok());
    }
}
#[test]
fn pre_arm_crash_can_resume_only_empty_intent_history() {
    let (temp, _, _, plan) = prepared();
    stage(&plan, false, false, false);
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .resume_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.plan_hash().unwrap(),
                2100
            )
            .is_ok()
    );
    let (temp, _, _, plan) = prepared();
    stage(&plan, false, true, false);
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .resume_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.plan_hash().unwrap(),
                2100
            )
            .is_err()
    );
}
#[test]
fn expiry_allows_only_receipt_finalization_after_all_unlinks() {
    for removed in [false, true] {
        let (temp, _, _, plan) = prepared();
        stage(&plan, true, true, removed);
        let result = LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .resume_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.plan_hash().unwrap(),
                5001,
            );
        assert_eq!(result.is_ok(), removed);
    }
}
#[test]
fn corrupt_tombstone_or_pending_marker_keeps_work_fenced() {
    for marker in [false, true] {
        let (temp, _, _, plan) = prepared();
        stage(&plan, true, true, false);
        let path = if marker {
            temp.state().join("purge-pending-v1.json")
        } else {
            journal(&plan).join("intents").join(format!(
                "{}.json",
                plan.gc_plan.quarantine[0]
                    .sha256
                    .as_str()
                    .trim_start_matches("sha256:")
            ))
        };
        fs::write(path, b"corrupt").unwrap();
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .resume_purge(
                    &plan.gc_plan.quarantine_directory,
                    &plan.plan_hash().unwrap(),
                    2100
                )
                .is_err()
        );
        assert!(
            plan.gc_plan
                .quarantine_directory
                .join(&plan.gc_plan.quarantine[0].path)
                .exists()
        );
    }
}
#[test]
fn corrupt_payload_and_hardlink_are_rejected_without_deleting_alias() {
    for hardlink in [false, true] {
        let (temp, _, _, plan) = prepared();
        let path = plan
            .gc_plan
            .quarantine_directory
            .join(&plan.gc_plan.quarantine[0].path);
        if hardlink {
            fs::hard_link(&path, temp.0.join("alias")).unwrap();
        } else {
            fs::write(&path, b"altered").unwrap();
        }
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .apply_purge(&plan, &plan.plan_hash().unwrap(), 2100)
                .is_err()
        );
        assert!(path.exists());
    }
}
#[test]
fn symlink_payload_and_foreign_quarantine_content_are_never_followed_or_deleted() {
    for symbolic in [false, true] {
        let (temp, _, _, plan) = prepared();
        if symbolic {
            let path = plan
                .gc_plan
                .quarantine_directory
                .join(&plan.gc_plan.quarantine[0].path);
            fs::remove_file(&path).unwrap();
            write(&temp.0.join("untouched"), b"keep");
            std::os::unix::fs::symlink(temp.0.join("untouched"), path).unwrap();
        } else {
            write(&plan.gc_plan.quarantine_directory.join("foreign"), b"keep");
        }
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .apply_purge(&plan, &plan.plan_hash().unwrap(), 2100)
                .is_err()
        );
        if symbolic {
            assert_eq!(fs::read(temp.0.join("untouched")).unwrap(), b"keep");
        }
    }
}
#[test]
fn unknown_or_wrong_plan_intent_is_rejected() {
    let (temp, _, _, plan) = prepared();
    stage(&plan, true, false, false);
    write(&journal(&plan).join("intents/foreign.json"), b"{}");
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .resume_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.plan_hash().unwrap(),
                2100
            )
            .is_err()
    );
}
#[test]
fn false_receipt_cannot_hide_existing_payloads() {
    let (temp, _, _, plan) = prepared();
    stage(&plan, true, true, false);
    write(&journal(&plan).join("receipt.json"), b"{}");
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .resume_purge(
                &plan.gc_plan.quarantine_directory,
                &plan.plan_hash().unwrap(),
                2100
            )
            .is_err()
    );
}
#[test]
fn malformed_authority_and_duplicate_rows_cannot_form_a_plan_hash() {
    let (_, _, _, plan) = prepared();
    let mut v = plan.clone();
    v.production_activation = true;
    assert!(v.plan_hash().is_err());
    let mut v = plan.clone();
    v.policy.expires_at_unix_ms = v.policy.not_before_unix_ms;
    assert!(v.plan_hash().is_err());
    let mut v = plan.clone();
    v.gc_plan.quarantine.push(v.gc_plan.quarantine[0].clone());
    v.gc_plan_hash = v.gc_plan.plan_hash().unwrap();
    assert!(v.plan_hash().is_err());
    let mut v = serde_json::to_value(&plan).unwrap();
    v["productionAuthority"] = true.into();
    assert!(serde_json::from_value::<LocalPurgePlanV1>(v).is_err());
}
#[test]
fn actual_cli_requires_raw_purge_plan_and_explicit_execution_hash() {
    let (temp, _, gc, plan) = prepared();
    let bin = env!("CARGO_BIN_EXE_hepta-local-maintenance");
    let policy_file = temp.0.join("policy.json");
    write(&policy_file, &serde_json::to_vec(&policy()).unwrap());
    let output = Command::new(bin)
        .args([
            "purge-plan",
            temp.state().to_str().unwrap(),
            gc.quarantine_directory.to_str().unwrap(),
            gc.plan_hash().unwrap().as_str(),
            policy_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let wrapper: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let file = temp.0.join("purge.json");
    write(&file, &serde_json::to_vec(&wrapper["plan"]).unwrap());
    let output = Command::new(bin)
        .args([
            "purge-apply",
            temp.state().to_str().unwrap(),
            file.to_str().unwrap(),
            plan.plan_hash().unwrap().as_str(),
            "2100",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["unlinkedObjects"], 1);
    assert_eq!(result["secureErasureVerified"], false);
}

#[test]
fn finished_purge_still_rejects_clock_before_retention_floor() {
    let (temp, _, gc, plan) = prepared();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    session
        .apply_purge(&plan, &plan.plan_hash().unwrap(), 2100)
        .unwrap();
    assert!(
        session
            .resume_purge(&gc.quarantine_directory, &plan.plan_hash().unwrap(), 1999)
            .is_err()
    );
    assert!(!temp.state().join("purge-pending-v1.json").exists());
}
