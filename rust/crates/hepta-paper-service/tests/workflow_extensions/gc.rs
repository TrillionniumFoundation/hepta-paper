use super::*;
use hepta_paper_service::maintenance::{LocalGcPlanV1, LocalMaintenanceSessionV1};

pub(super) fn paused() -> (
    Temp,
    hepta_codex_protocol::Sha256Digest,
    hepta_codex_protocol::Sha256Digest,
    u64,
) {
    let (temp, hash) = fixture();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 2 },
        1100,
    )
    .unwrap();
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
    let orphan = ObjectStoreV1::open(&temp.state())
        .unwrap()
        .put(b"disposable unreferenced local bytes")
        .unwrap();
    LocalMaintenanceSessionV1::acquire(&temp.state())
        .unwrap()
        .quiesce()
        .unwrap();
    (temp, hash, orphan, revision + 1)
}
fn plan(
    temp: &Temp,
    hash: &hepta_codex_protocol::Sha256Digest,
    revision: u64,
    pins: BTreeSet<hepta_codex_protocol::Sha256Digest>,
) -> LocalGcPlanV1 {
    LocalMaintenanceSessionV1::acquire(&temp.state())
        .unwrap()
        .plan_gc(hash, revision, pins, &temp.0.join("quarantine"))
        .unwrap()
}
#[test]
fn gc_moves_only_unreferenced_object_and_preserves_workflow_resume() {
    let (temp, hash, orphan, revision) = paused();
    let proposal = plan(&temp, &hash, revision, BTreeSet::new());
    assert_eq!(proposal.quarantine.len(), 1);
    assert_eq!(proposal.quarantine[0].sha256, orphan);
    let receipt = {
        let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
        session
            .apply_gc(&proposal, &proposal.plan_hash().unwrap())
            .unwrap()
    };
    assert_eq!(receipt.quarantined_objects, 1);
    assert!(!receipt.permanent_deletion && !receipt.production_activation);
    let raw = orphan.as_str().strip_prefix("sha256:").unwrap();
    assert!(!temp.state().join("objects").join(raw).exists());
    assert_eq!(
        fs::read(temp.0.join("quarantine/objects").join(raw)).unwrap(),
        b"disposable unreferenced local bytes"
    );
    assert!(!temp.state().join("gc-pending-v1.json").exists());
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Resume {
            expected_revision: revision,
        },
        1200,
    )
    .unwrap();
    assert_eq!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 3 },
            1201
        )
        .unwrap()
        .committed_steps,
        3
    );
}
#[test]
fn gc_retains_explicit_pins_and_hash_references_in_opaque_content() {
    let (temp, hash, orphan, revision) = paused();
    let pinned = plan(&temp, &hash, revision, BTreeSet::from([orphan.clone()]));
    assert!(pinned.quarantine.is_empty());
    let reference = ObjectStoreV1::open(&temp.state())
        .unwrap()
        .put(orphan.as_str().as_bytes())
        .unwrap();
    let proposal = plan(&temp, &hash, revision, BTreeSet::new());
    assert!(!proposal.quarantine.iter().any(|e| e.sha256 == orphan));
    assert!(proposal.quarantine.iter().any(|e| e.sha256 == reference));
}
#[test]
fn gc_rejects_stale_plan_or_new_object_before_any_move() {
    let (temp, hash, _, revision) = paused();
    let proposal = plan(&temp, &hash, revision, BTreeSet::new());
    ObjectStoreV1::open(&temp.state())
        .unwrap()
        .put(b"new object invalidates capture")
        .unwrap();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    assert!(
        session
            .apply_gc(&proposal, &proposal.plan_hash().unwrap())
            .is_err()
    );
    assert!(!temp.0.join("quarantine").exists());
}
#[test]
fn gc_rejects_forged_plan_selecting_committed_artifacts() {
    let (temp, hash, _, revision) = paused();
    let mut proposal = plan(&temp, &hash, revision, BTreeSet::new());
    proposal.quarantine = proposal
        .source_inventory
        .iter()
        .filter(|e| e.path.starts_with("objects/"))
        .cloned()
        .collect();
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .apply_gc(&proposal, &proposal.plan_hash().unwrap())
            .is_err()
    );
    assert!(!temp.0.join("quarantine").exists());
}
fn private_write(path: &Path, bytes: &[u8]) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
}
fn crash_stage(temp: &Temp, proposal: &LocalGcPlanV1, moved: bool) {
    use std::os::unix::fs::DirBuilderExt;
    let dest = &proposal.quarantine_directory;
    fs::DirBuilder::new().mode(0o700).create(dest).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(dest.join("objects"))
        .unwrap();
    let encoded = serde_json::to_vec(proposal).unwrap();
    private_write(&dest.join("plan.json"), &encoded);
    private_write(&temp.state().join("gc-pending-v1.json"), &encoded);
    if moved {
        let entry = &proposal.quarantine[0];
        fs::rename(temp.state().join(&entry.path), dest.join(&entry.path)).unwrap();
    }
}
#[test]
fn interrupted_gc_fences_service_and_reconciles_both_sides_of_move() {
    for moved in [false, true] {
        let (temp, hash, _, revision) = paused();
        let proposal = plan(&temp, &hash, revision, BTreeSet::new());
        crash_stage(&temp, &proposal, moved);
        assert!(ObjectStoreV1::open(&temp.state()).is_err());
        let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
        let db_before = fs::read(temp.state().join("campaign.sqlite")).unwrap();
        assert!(session.quiesce().is_err());
        assert_eq!(
            db_before,
            fs::read(temp.state().join("campaign.sqlite")).unwrap()
        );
        let receipt = session
            .resume_gc(
                &proposal.quarantine_directory,
                &proposal.plan_hash().unwrap(),
            )
            .unwrap();
        assert_eq!(receipt.quarantined_objects, 1);
        let replay = session
            .resume_gc(
                &proposal.quarantine_directory,
                &proposal.plan_hash().unwrap(),
            )
            .unwrap();
        assert_eq!(receipt, replay);
        drop(session);
        assert!(ObjectStoreV1::open(&temp.state()).is_ok());
    }
}
#[test]
fn interrupted_gc_rejects_duplicate_or_corrupt_quarantined_content() {
    for duplicate in [false, true] {
        let (temp, hash, _, revision) = paused();
        let proposal = plan(&temp, &hash, revision, BTreeSet::new());
        crash_stage(&temp, &proposal, true);
        let entry = &proposal.quarantine[0];
        let target = proposal.quarantine_directory.join(&entry.path);
        if duplicate {
            fs::copy(&target, temp.state().join(&entry.path)).unwrap();
        } else {
            fs::write(&target, b"corrupt").unwrap();
        }
        assert!(
            LocalMaintenanceSessionV1::acquire(&temp.state())
                .unwrap()
                .resume_gc(
                    &proposal.quarantine_directory,
                    &proposal.plan_hash().unwrap()
                )
                .is_err()
        );
        assert!(temp.state().join("gc-pending-v1.json").exists());
    }
}
#[test]
fn gc_requires_paused_terminal_and_existing_pins() {
    let (temp, hash) = fixture();
    let session = LocalMaintenanceSessionV1::acquire(&temp.state()).unwrap();
    session.quiesce().unwrap();
    assert!(
        session
            .plan_gc(&hash, 0, BTreeSet::new(), &temp.0.join("quarantine"))
            .is_err()
    );
    drop(session);
    let (temp, hash, _, revision) = paused();
    let absent = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        .parse()
        .unwrap();
    assert!(
        LocalMaintenanceSessionV1::acquire(&temp.state())
            .unwrap()
            .plan_gc(
                &hash,
                revision,
                BTreeSet::from([absent]),
                &temp.0.join("quarantine")
            )
            .is_err()
    );
}

#[test]
fn actual_gc_cli_uses_exact_raw_plan_and_retains_quarantine_bytes() {
    let (temp, hash, _, revision) = paused();
    let binary = env!("CARGO_BIN_EXE_hepta-local-maintenance");
    let pins = temp.0.join("pins.json");
    private_write(&pins, b"[]");
    let quarantine = temp.0.join("cli-quarantine");
    let output = Command::new(binary)
        .args([
            "gc-plan",
            temp.state().to_str().unwrap(),
            hash.as_str(),
            &revision.to_string(),
            pins.to_str().unwrap(),
            quarantine.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let wrapper: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let plan = temp.0.join("plan.json");
    private_write(&plan, &serde_json::to_vec(&wrapper["plan"]).unwrap());
    let expected = wrapper["planHash"].as_str().unwrap();
    let output = Command::new(binary)
        .args([
            "gc-apply",
            temp.state().to_str().unwrap(),
            plan.to_str().unwrap(),
            expected,
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["permanentDeletion"], false);
    assert_eq!(receipt["quarantinedObjects"], 1);
    assert_eq!(fs::read_dir(quarantine.join("objects")).unwrap().count(), 1);
    let replay = Command::new(binary)
        .args([
            "gc-resume",
            temp.state().to_str().unwrap(),
            quarantine.to_str().unwrap(),
            expected,
        ])
        .output()
        .unwrap();
    assert!(replay.status.success());
    assert_eq!(
        receipt,
        serde_json::from_slice::<serde_json::Value>(&replay.stdout).unwrap()
    );
}
