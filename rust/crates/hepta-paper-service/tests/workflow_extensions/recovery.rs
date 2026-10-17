use super::*;
use hepta_paper_service::maintenance::{
    LocalMaintenanceSessionV1, restore_local_backup_v1, verify_local_backup_recovery_v1,
};

fn advance(temp: &Temp, hash: &hepta_codex_protocol::Sha256Digest, n: usize) {
    operate_local_workflow_v1(
        &temp.state(),
        hash,
        WorkflowActionV1::Advance { through_steps: n },
        1100,
    )
    .unwrap();
}
fn backup(temp: &Temp) -> (PathBuf, hepta_codex_protocol::Sha256Digest) {
    let dest = temp.0.join("backup");
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    session.quiesce().unwrap();
    let receipt = session.backup(&dest).unwrap();
    (dest, receipt.manifest_hash)
}
fn overwrite(temp: &Temp, sql: &str) {
    let result=Command::new("python3").arg("-c").arg(
        "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(sys.argv[2]);c.commit();c.close()"
    ).arg(temp.state().join("campaign.sqlite")).arg(sql).status().unwrap();
    assert!(result.success());
}
fn verify(
    temp: &Temp,
    hash: &hepta_codex_protocol::Sha256Digest,
) -> Result<hepta_paper_service::maintenance::LocalRecoveryReportV1, ServiceError> {
    let session = LocalMaintenanceSessionV1::acquire(&temp.state())?;
    session.quiesce()?;
    session.verify_recovery(hash, 1200)
}
#[test]
fn recovery_replays_real_partial_history_and_creates_no_sidecars() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 4);
    LocalMaintenanceSessionV1::acquire(&temp.state())
        .unwrap()
        .quiesce()
        .unwrap();
    let bytes = fs::read(temp.state().join("campaign.sqlite")).unwrap();
    let report = LocalMaintenanceSessionV1::acquire(&temp.state())
        .unwrap()
        .verify_recovery(&hash, 1200)
        .unwrap();
    assert_eq!(report.committed_steps, 4);
    assert_eq!(report.budget_remaining_microusd, 96);
    assert!(
        report.history_verified
            && report.artifact_bytes_verified
            && report.history_allows_local_resume
    );
    assert!(
        !report.production_activation
            && !report.pending_execution
            && !report.node_retirement_verified
    );
    assert_eq!(
        bytes,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !temp
                .state()
                .join(format!("campaign.sqlite{suffix}"))
                .exists()
        );
    }
}
#[test]
fn completed_recovery_is_not_permission_to_restart_or_renew_a_lease() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 7);
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    session.quiesce().unwrap();
    let report = session.verify_recovery(&hash, 200000).unwrap();
    assert_eq!(report.campaign_state, CampaignStateV1::Completed);
    assert!(!report.lease_current && !report.history_allows_local_resume);
}
#[test]
fn paused_and_resumed_lifecycle_events_are_replayed() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 1);
    let revision = status(&temp, &hash).campaign_revision;
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Pause {
            expected_revision: revision,
        },
        1110,
    )
    .unwrap();
    assert_eq!(
        verify(&temp, &hash).unwrap().campaign_state,
        CampaignStateV1::Paused
    );
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Resume {
            expected_revision: revision + 1,
        },
        1120,
    )
    .unwrap();
    assert_eq!(
        verify(&temp, &hash).unwrap().campaign_revision,
        revision + 2
    );
}
#[test]
fn missing_prepared_or_unmatched_started_is_not_recovery_ready() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 1);
    let file = fs::read_dir(temp.state().join("attempts"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().unwrap() == "prepared")
        .unwrap();
    fs::remove_file(file).unwrap();
    assert!(verify(&temp, &hash).is_err());
}
#[test]
fn pending_plan_is_not_silently_accepted() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 1);
    fs::copy(
        temp.state().join("step-0000.json"),
        temp.state().join("step-0001.json"),
    )
    .unwrap();
    assert!(verify(&temp, &hash).is_err());
}
#[test]
fn materialized_state_and_revision_tampering_are_detected() {
    for sql in [
        "UPDATE campaigns SET state='completed'",
        "UPDATE campaigns SET revision=revision+1",
        "UPDATE campaigns SET budget_remaining_microusd=0",
        "UPDATE campaigns SET cpu_remaining=0",
        "UPDATE campaigns SET updated_at_unix_ms=updated_at_unix_ms+1",
    ] {
        let (temp, hash) = fixture();
        advance(&temp, &hash, 1);
        overwrite(&temp, sql);
        assert!(verify(&temp, &hash).is_err(), "{sql}");
    }
}
#[test]
fn unknown_campaign_or_lease_rotation_cannot_be_hidden_in_recovery() {
    for sql in [
        "UPDATE writer_lease SET generation=generation+1",
        "INSERT INTO campaigns SELECT 'foreign',revision,state,budget_remaining_microusd,cpu_remaining,gpu_remaining,created_at_unix_ms,updated_at_unix_ms FROM campaigns",
    ] {
        let (temp, hash) = fixture();
        overwrite(&temp, sql);
        assert!(verify(&temp, &hash).is_err());
    }
}
#[test]
fn backup_recovery_uses_logical_original_path_without_mutation() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 3);
    let (bundle, manifest) = backup(&temp);
    let before = fs::read(bundle.join("payload/campaign.sqlite")).unwrap();
    fs::rename(temp.state(), temp.0.join("removed-source")).unwrap();
    let report = verify_local_backup_recovery_v1(&bundle, &manifest, &hash, 1200).unwrap();
    assert_eq!(report.committed_steps, 3);
    assert_eq!(
        before,
        fs::read(bundle.join("payload/campaign.sqlite")).unwrap()
    );
    assert!(!temp.state().exists());
}
#[test]
fn original_path_restore_preserves_replay_and_next_commit() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 3);
    let revision = status(&temp, &hash).campaign_revision;
    let (bundle, manifest) = backup(&temp);
    fs::rename(temp.state(), temp.0.join("lost-source")).unwrap();
    let report = restore_local_backup_v1(
        &bundle,
        &temp.state(),
        &temp.0.join("stage"),
        &manifest,
        &hash,
        revision,
        1200,
    )
    .unwrap();
    assert_eq!(report.committed_steps, 3);
    assert!(!temp.0.join("stage").exists());
    let replay = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1250,
    )
    .unwrap();
    assert_eq!(replay.budget_remaining_microusd, 97);
    let next = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 4 },
        1251,
    )
    .unwrap();
    assert_eq!(next.budget_remaining_microusd, 96);
}
#[test]
fn restore_does_not_overwrite_post_backup_history() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 1);
    let (bundle, manifest) = backup(&temp);
    advance(&temp, &hash, 2);
    let before = fs::read(temp.state().join("campaign.sqlite")).unwrap();
    assert!(
        restore_local_backup_v1(
            &bundle,
            &temp.state(),
            &temp.0.join("stage"),
            &manifest,
            &hash,
            1,
            1200
        )
        .is_err()
    );
    assert_eq!(
        before,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
    assert!(!temp.0.join("stage").exists());
}
#[test]
fn stale_backup_is_rejected_against_selected_high_water_revision() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 1);
    let (bundle, manifest) = backup(&temp);
    advance(&temp, &hash, 2);
    let revision = status(&temp, &hash).campaign_revision;
    fs::rename(temp.state(), temp.0.join("newer-state")).unwrap();
    assert!(
        restore_local_backup_v1(
            &bundle,
            &temp.state(),
            &temp.0.join("stage"),
            &manifest,
            &hash,
            revision,
            1200
        )
        .is_err()
    );
    assert!(!temp.state().exists() && !temp.0.join("stage").exists());
}
#[test]
fn restore_refuses_wrong_path_and_existing_staging() {
    let (temp, hash) = fixture();
    let (bundle, manifest) = backup(&temp);
    let dest = temp.0.join("wrong");
    assert!(
        restore_local_backup_v1(
            &bundle,
            &dest,
            &temp.0.join("stage"),
            &manifest,
            &hash,
            0,
            1200
        )
        .is_err()
    );
    fs::rename(temp.state(), temp.0.join("old")).unwrap();
    fs::create_dir(temp.0.join("stage")).unwrap();
    assert!(
        restore_local_backup_v1(
            &bundle,
            &temp.state(),
            &temp.0.join("stage"),
            &manifest,
            &hash,
            0,
            1200
        )
        .is_err()
    );
    assert!(!temp.state().exists());
}
#[test]
fn incomplete_restore_residue_blocks_service_enrollment() {
    let (temp, _) = fixture();
    fs::write(
        temp.state().join("restore-incomplete-v1"),
        b"retained crash residue",
    )
    .unwrap();
    assert!(ObjectStoreV1::open(&temp.state()).is_err());
    assert!(LocalMaintenanceSessionV1::acquire(&temp.state()).is_err());
}
#[test]
fn recovery_rejects_foreign_definition_without_repair() {
    let (temp, hash) = fixture();
    let (other, wrong) = fixture();
    assert_ne!(hash, wrong);
    assert!(verify(&temp, &wrong).is_err());
    drop(other);
    assert!(verify(&temp, &hash).is_ok());
}
#[test]
fn explicit_amendment_budget_and_lease_are_recovered_from_events() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 1);
    let revision = status(&temp, &hash).campaign_revision;
    let receipt = amend_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowAmendmentV1 {
            version: 1,
            operation_id: "recovery-amendment".into(),
            expected_revision: revision,
            additional_budget_microusd: 10,
            lease_expires_at_unix_ms: 200000,
            steps: vec![],
            repair_rejected_review: false,
        },
        1150,
    )
    .unwrap();
    let report = verify(&temp, &receipt.definition_hash).unwrap();
    assert_eq!(report.budget_remaining_microusd, 109);
    assert_eq!(report.campaign_revision, revision + 1);
    assert!(verify(&temp, &hash).is_err());
}

#[test]
fn maintenance_cli_verifies_restores_and_continues_real_workflow() {
    let (temp, hash) = fixture();
    advance(&temp, &hash, 3);
    let binary = env!("CARGO_BIN_EXE_hepta-local-maintenance");
    let run = |args: &[&str]| -> serde_json::Value {
        let result = Command::new(binary).args(args).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice(&result.stdout).unwrap()
    };
    let state = temp.state();
    run(&["quiesce", state.to_str().unwrap()]);
    let report = run(&[
        "recovery-readiness",
        state.to_str().unwrap(),
        hash.as_str(),
        "1200",
    ]);
    assert_eq!(report["historyVerified"], true);
    assert_eq!(report["productionActivation"], false);
    let bundle = temp.0.join("cli-backup");
    let byte_receipt = run(&["backup", state.to_str().unwrap(), bundle.to_str().unwrap()]);
    assert_eq!(byte_receipt["semanticRecoveryVerified"], false);
    let manifest = byte_receipt["manifestHash"].as_str().unwrap();
    let verified = run(&[
        "verify-recovery",
        bundle.to_str().unwrap(),
        manifest,
        hash.as_str(),
        "1200",
    ]);
    assert_eq!(verified["committedSteps"], 3);
    let revision = verified["campaignRevision"].as_u64().unwrap().to_string();
    let staging = temp.0.join("cli-stage");
    let argv = [
        "restore",
        bundle.to_str().unwrap(),
        state.to_str().unwrap(),
        staging.to_str().unwrap(),
        manifest,
        hash.as_str(),
        &revision,
        "1200",
    ];
    let denied = Command::new(binary).args(argv).output().unwrap();
    assert!(!denied.status.success() && denied.stdout.is_empty());
    assert!(!staging.exists());
    fs::rename(&state, temp.0.join("old-state-retained-by-test")).unwrap();
    let restored = run(&argv);
    assert_eq!(restored["inventoryHash"], verified["inventoryHash"]);
    assert_eq!(restored["nodeRetirementVerified"], false);
    let progress = operate_local_workflow_v1(
        &state,
        &hash,
        WorkflowActionV1::Advance { through_steps: 4 },
        1300,
    )
    .unwrap();
    assert_eq!(progress.committed_steps, 4);
    assert_eq!(progress.budget_remaining_microusd, 96);
}
