//! Fault injection restores only the SQLite pre-commit bytes after a real native
//! dispatch. Actual prepared artifacts and plan bytes survive, as at a crash.
use super::*;
use hepta_codex_protocol::Sha256Digest;
use hepta_paper_service::maintenance::{LocalMaintenanceSessionV1, PreparedReconciliationPlanV1};
use std::{io::Write, os::unix::fs::OpenOptionsExt};

fn staged() -> (Temp, Sha256Digest, Vec<u8>) {
    let (temp, hash) = fixture();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 2 },
        1100,
    )
    .unwrap();
    LocalMaintenanceSessionV1::acquire(&temp.state())
        .unwrap()
        .quiesce()
        .unwrap();
    let before = fs::read(temp.state().join("campaign.sqlite")).unwrap();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1200,
    )
    .unwrap();
    LocalMaintenanceSessionV1::acquire(&temp.state())
        .unwrap()
        .quiesce()
        .unwrap();
    // Disposable fixture only: retain prepared/plan bytes, simulate absent COMMIT.
    fs::write(temp.state().join("campaign.sqlite"), &before).unwrap();
    (temp, hash, before)
}
fn proposal(temp: &Temp, hash: &Sha256Digest) -> PreparedReconciliationPlanV1 {
    LocalMaintenanceSessionV1::acquire(&temp.state())
        .unwrap()
        .plan_prepared_reconciliation(hash)
        .unwrap()
}
fn pending_prepared(temp: &Temp, plan: &PreparedReconciliationPlanV1) -> PathBuf {
    fs::read_dir(temp.state().join("attempts"))
        .unwrap()
        .filter_map(|e| {
            let path = e.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("prepared") {
                return None;
            }
            let r: PreparedResultV1 = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            (r.result_hash().unwrap() == plan.prepared_result_hash).then_some(path)
        })
        .next()
        .unwrap()
}
#[test]
fn prepared_reconciliation_commits_actual_cached_output_once_without_execution() {
    let (temp, hash, before) = staged();
    let plan = proposal(&temp, &hash);
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    assert!(session.verify_recovery(&hash, 1300).is_err());
    assert_eq!(
        before,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
    let result = session
        .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 1300)
        .unwrap();
    assert!(result.commit_receipt.newly_committed);
    assert!(result.source_preimage_verified);
    assert!(
        !result.worker_execution_performed
            && !result.provider_action_performed
            && !result.production_activation
    );
    let recovered = session.verify_recovery(&hash, 1300).unwrap();
    assert_eq!(recovered.committed_steps, 3);
    let after = fs::read(temp.state().join("campaign.sqlite")).unwrap();
    let duplicate = session
        .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 200_000)
        .unwrap();
    assert!(!duplicate.commit_receipt.newly_committed);
    assert!(!duplicate.source_preimage_verified);
    assert_eq!(
        duplicate.commit_receipt.result_hash,
        result.commit_receipt.result_hash
    );
    assert_eq!(
        after,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
    drop(session);
    let next = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 4 },
        1400,
    )
    .unwrap();
    assert_eq!(next.committed_steps, 4);
}
#[test]
fn merely_started_work_is_never_reexecuted_by_reconciliation() {
    let (temp, hash, before) = staged();
    let plan = proposal(&temp, &hash);
    fs::remove_file(pending_prepared(&temp, &plan)).unwrap();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    assert!(session.plan_prepared_reconciliation(&hash).is_err());
    assert!(
        session
            .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 1300)
            .is_err()
    );
    assert_eq!(
        before,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
}
#[test]
fn missing_or_altered_actual_artifact_rejects_cached_prepared_result() {
    for remove in [false, true] {
        let (temp, hash, before) = staged();
        let plan = proposal(&temp, &hash);
        let result: PreparedResultV1 =
            serde_json::from_slice(&fs::read(pending_prepared(&temp, &plan)).unwrap()).unwrap();
        let artifact = temp.state().join("objects").join(
            result.artifact_hashes[0]
                .as_str()
                .trim_start_matches("sha256:"),
        );
        if remove {
            fs::remove_file(artifact).unwrap();
        } else {
            fs::write(artifact, b"corrupt").unwrap();
        }
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 1300)
                .is_err()
        );
        assert_eq!(
            before,
            fs::read(temp.state().join("campaign.sqlite")).unwrap()
        );
    }
}
#[test]
fn stale_inventory_and_wrong_request_hash_cannot_commit() {
    let (temp, hash, before) = staged();
    let plan = proposal(&temp, &hash);
    let wrong = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        .parse()
        .unwrap();
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .apply_prepared_reconciliation(&plan, &wrong, 1300)
            .is_err()
    );
    ObjectStoreV1::open(&temp.state())
        .unwrap()
        .put(b"extra object changes exact inventory")
        .unwrap();
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 1300)
            .is_err()
    );
    assert_eq!(
        before,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
}
#[test]
fn expired_lease_and_clock_rollback_do_not_debit_pending_work() {
    for now in [0, 1199, 100_000, u64::MAX] {
        let (temp, hash, before) = staged();
        let plan = proposal(&temp, &hash);
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), now)
                .is_err()
        );
        assert_eq!(
            before,
            fs::read(temp.state().join("campaign.sqlite")).unwrap()
        );
    }
}
#[test]
fn extra_attempt_and_future_plan_residue_cannot_be_ignored() {
    for extra_plan in [false, true] {
        let (temp, hash, before) = staged();
        let path = if extra_plan {
            temp.state().join("step-0099.json")
        } else {
            temp.state().join(
                "attempts/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.started",
            )
        };
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .unwrap()
            .write_all(b"{}")
            .unwrap();
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .plan_prepared_reconciliation(&hash)
                .is_err()
        );
        assert_eq!(
            before,
            fs::read(temp.state().join("campaign.sqlite")).unwrap()
        );
    }
}
#[test]
fn forged_attempt_or_external_effect_flag_is_not_an_accepted_result() {
    for external in [false, true] {
        let (temp, hash, before) = staged();
        let plan = proposal(&temp, &hash);
        let path = pending_prepared(&temp, &plan);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if external {
            value["externalActionMayHaveStarted"] = true.into();
        } else {
            value["attemptId"] = "forged".into();
        }
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 1300)
                .is_err()
        );
        assert_eq!(
            before,
            fs::read(temp.state().join("campaign.sqlite")).unwrap()
        );
    }
}
#[test]
fn stale_or_foreign_plan_configuration_cannot_change_payload_or_clock() {
    let (temp, hash, before) = staged();
    let plan = proposal(&temp, &hash);
    let path = temp.state().join("step-0002.json");
    let mut config: ServiceRunV1 = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config.snapshot.budget_microusd += 1;
    fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 1300)
            .is_err()
    );
    assert_eq!(
        before,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
}
#[test]
fn planning_completed_work_does_not_create_new_work_or_authority() {
    let (temp, hash) = fixture();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    session.quiesce().unwrap();
    assert!(session.plan_prepared_reconciliation(&hash).is_err());
}
#[test]
fn prepared_commit_cli_consumes_a_hash_bound_raw_plan() {
    let (temp, hash, _) = staged();
    let bin = env!("CARGO_BIN_EXE_hepta-local-maintenance");
    let output = Command::new(bin)
        .args([
            "prepared-plan",
            temp.state().to_str().unwrap(),
            hash.as_str(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let wrapper: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let file = temp.0.join("reconcile.json");
    fs::write(&file, serde_json::to_vec(&wrapper["plan"]).unwrap()).unwrap();
    let output = Command::new(bin)
        .args([
            "prepared-commit",
            temp.state().to_str().unwrap(),
            file.to_str().unwrap(),
            wrapper["requestHash"].as_str().unwrap(),
            "1300",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let r: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(r["workerExecutionPerformed"], false);
    assert_eq!(r["commitReceipt"]["newlyCommitted"], true);
}

#[test]
fn receipt_replay_still_binds_original_configuration_and_revision() {
    let (temp, hash, _) = staged();
    let plan = proposal(&temp, &hash);
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    session
        .apply_prepared_reconciliation(&plan, &plan.request_hash().unwrap(), 1300)
        .unwrap();
    let after = fs::read(temp.state().join("campaign.sqlite")).unwrap();
    for wrong_revision in [true, false] {
        let mut forged = plan.clone();
        if wrong_revision {
            forged.campaign_revision += 1;
        } else {
            forged.configuration_hash =
                "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                    .parse()
                    .unwrap();
        }
        assert!(
            session
                .apply_prepared_reconciliation(&forged, &forged.request_hash().unwrap(), 200_000)
                .is_err()
        );
    }
    assert_eq!(
        after,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
}
