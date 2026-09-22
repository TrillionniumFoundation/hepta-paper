//! Actual autonomous-research CLI tests using the existing workflow fixtures/owner.
use super::*;
use hepta_control_plane::canonical_hash_v1;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

fn request(temp: &Temp, mut def: LocalWorkflowV1) -> PathBuf {
    let now = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    def.template.observed_at_unix_ms = now;
    def.template.writer_lease.expires_at_unix_ms = now + 600_000;
    def.validate().unwrap();
    let path = temp.0.join("autonomous-workflow.json");
    fs::write(&path, serde_json::to_vec(&def).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    path
}

fn invoke(path: &Path, action: &str, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-research",
            "--campaign-id",
            "campaign-service",
            "--workflow-file",
        ])
        .arg(path)
        .args(["--action", action])
        .args(extra)
        .output()
        .unwrap()
}

fn success(output: std::process::Output) -> Value {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "AutonomousResearchLocalWorkflowReport");
    assert_eq!(report["ready"], true);
    assert_eq!(report["fullResearchReady"], false);
    assert_eq!(report["productionActivation"], false);
    assert_eq!(report["nodeRetirementVerified"], false);
    report
}

#[test]
fn autonomous_prepare_launch_replay_and_converge_use_the_existing_owner() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let prepared = success(invoke(&path, "prepare", &[]));
    assert!(
        !temp.state().exists(),
        "prepare must not initialize or adopt state"
    );
    assert!(prepared["campaignPersisted"].is_null());
    let first = success(invoke(&path, "launch", &["--through-steps", "2"]));
    assert_eq!(first["workflow"]["committedSteps"], 2);
    assert_eq!(first["workflow"]["budgetRemainingMicrousd"], 98);
    let count = attempt_count(&temp);
    // A new executable invocation retries an absolute end point, not two more steps.
    let retry = success(invoke(&path, "launch", &["--through-steps", "2"]));
    assert_eq!(first["workflow"], retry["workflow"]);
    assert_eq!(attempt_count(&temp), count);
    let done = success(invoke(&path, "converge", &["--through-steps", "7"]));
    assert_eq!(done["workflow"]["committedSteps"], 7);
    assert_eq!(done["workflow"]["budgetRemainingMicrousd"], 93);
    assert_eq!(done["definitionHash"], prepared["definitionHash"]);
    let hash = done["definitionHash"].as_str().unwrap();
    let old_cli = Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
        .arg("status")
        .arg(temp.state())
        .arg(hash)
        .output()
        .unwrap();
    assert!(old_cli.status.success());
    let old_progress: Value = serde_json::from_slice(&old_cli.stdout).unwrap();
    assert_eq!(
        done["workflow"], old_progress,
        "both commands must read the same SQLite/CAS owner"
    );
    let count = attempt_count(&temp);
    assert_eq!(
        success(invoke(&path, "converge", &[]))["workflow"],
        old_progress
    );
    assert_eq!(attempt_count(&temp), count);
}

#[test]
fn autonomous_pause_resume_cancel_are_revision_bound_and_terminal() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let first = success(invoke(&path, "launch", &["--through-steps", "1"]));
    let revision = first["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    assert!(
        !invoke(&path, "pause", &["--expected-revision", "9999"])
            .status
            .success()
    );
    assert!(!invoke(&path, "cancel", &[]).status.success());
    let paused = success(invoke(&path, "pause", &["--expected-revision", &revision]));
    let count = attempt_count(&temp);
    assert!(!invoke(&path, "converge", &[]).status.success());
    assert_eq!(count, attempt_count(&temp));
    let revision = paused["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    let resumed = success(invoke(&path, "resume", &["--expected-revision", &revision]));
    let revision = resumed["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    let cancelled = success(invoke(&path, "cancel", &["--expected-revision", &revision]));
    let revision = cancelled["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    assert!(
        !invoke(&path, "resume", &["--expected-revision", &revision])
            .status
            .success()
    );
    assert!(!invoke(&path, "launch", &[]).status.success());
    assert_eq!(count, attempt_count(&temp));
    let hash = cancelled["definitionHash"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        status(&temp, &hash).campaign_state,
        CampaignStateV1::Cancelled
    );
}

#[test]
fn autonomous_rejects_changed_definition_and_foreign_campaign_without_dispatch() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    success(invoke(&path, "launch", &["--through-steps", "1"]));
    let count = attempt_count(&temp);
    let original = fs::read(&path).unwrap();
    let mut value: Value = serde_json::from_slice(&original).unwrap();
    value["steps"][1]["costMicrousd"] = json!(2);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(!invoke(&path, "converge", &[]).status.success());
    assert_eq!(count, attempt_count(&temp));
    fs::write(&path, original).unwrap();
    assert!(
        !invoke(&path, "status", &["--paper-id", "another-paper"])
            .status
            .success()
    );
    assert_eq!(count, attempt_count(&temp));
    success(invoke(&path, "status", &[]));
}

#[test]
fn autonomous_local_authority_and_request_bounds_fail_before_state_creation() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let options = hepta_paper_service::autonomous_research::parse_autonomous_research_arguments(&[
        "--campaign-id".into(),
        "campaign-service".into(),
        "--workflow-file".into(),
        path.to_str().unwrap().into(),
        "--action".into(),
        "launch".into(),
    ])
    .unwrap();
    let read_only =
        hepta_paper_service::autonomous_research::inspect_autonomous_research_v1(&options);
    assert_eq!(read_only["ready"], false);
    assert!(
        !temp.state().exists(),
        "direct inspection must not initialize or execute"
    );
    for extra in [
        vec!["--launch-mode", "production-run"],
        vec!["--launch-mode", "golden-bootstrap"],
        vec!["--require-full-ready"],
        vec!["--through-steps", "0"],
        vec!["--through-steps", "129"],
        vec!["--expected-revision", "0"],
        vec!["--workflow-file", "/another/request"],
    ] {
        assert!(!invoke(&path, "launch", &extra).status.success());
        assert!(!temp.state().exists());
    }
    let alias = temp.0.join("alias.json");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    assert!(!invoke(&alias, "launch", &[]).status.success());
    let original = fs::read(&path).unwrap();
    let mut value: Value = serde_json::from_slice(&original).unwrap();
    let mut expired: LocalWorkflowV1 = serde_json::from_slice(&original).unwrap();
    expired.template.observed_at_unix_ms = 1_000;
    expired.template.writer_lease.expires_at_unix_ms = 100_000;
    fs::write(&path, serde_json::to_vec(&expired).unwrap()).unwrap();
    success(invoke(&path, "prepare", &[]));
    let rejected = invoke(&path, "launch", &[]);
    assert!(!rejected.status.success());
    let expired_report: Value = serde_json::from_slice(&rejected.stdout).unwrap();
    assert_eq!(
        expired_report["error"],
        "local_workflow_lifecycle_or_lease_conflict"
    );
    assert!(
        !temp.state().exists(),
        "expired actual lease must refuse before initialization"
    );
    value["unknownPrivateText"] = json!("confidential-marker");
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let rejected = invoke(&path, "launch", &[]);
    assert!(!rejected.status.success());
    assert!(!String::from_utf8_lossy(&rejected.stdout).contains("confidential-marker"));
    assert!(!String::from_utf8_lossy(&rejected.stderr).contains("confidential-marker"));
    fs::write(&path, vec![b' '; 16 * 1024 * 1024 + 1]).unwrap();
    assert!(!invoke(&path, "prepare", &[]).status.success());
    assert!(!temp.state().exists());
}

#[test]
fn autonomous_executes_real_rust_workers_without_claiming_external_observation() {
    let temp = Temp::new();
    let binding = process_binding(
        fs::canonicalize(env!("CARGO_BIN_EXE_hepta-native-business")).unwrap(),
        temp.0.clone(),
        vec![],
    );
    let mut def = LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), binding).unwrap(),
        steps: steps(),
    };
    for step in &mut def.steps {
        step.job_template = json!({"kind":"process", "input":step.job_template["job"]});
        for binding in &mut step.bindings {
            binding.target_pointer = binding.target_pointer.replacen("/job/", "/input/", 1);
        }
    }
    let path = request(&temp, def);
    let done = success(invoke(&path, "launch", &[]));
    assert_eq!(done["workflow"]["committedSteps"], 7);
    assert!(done["providerExecutionPerformed"].is_null());
    assert!(done["externalActionPerformed"].is_null());
    assert!(done["networkActionPerformed"].is_null());
    assert_eq!(done["networkIsolationEnforced"], false);
    let count = attempt_count(&temp);
    let repeated = success(invoke(&path, "launch", &[]));
    assert_eq!(done["workflow"], repeated["workflow"]);
    assert_eq!(count, attempt_count(&temp));
}

#[test]
fn autonomous_worker_crash_is_not_reexecuted_after_cli_restart() {
    let temp = Temp::new();
    let cwd = temp.0.join("crash-child");
    fs::create_dir(&cwd).unwrap();
    fs::set_permissions(&cwd, fs::Permissions::from_mode(0o700)).unwrap();
    let binding = process_binding(
        std::env::current_exe().unwrap(),
        cwd.clone(),
        vec![
            "--exact".into(),
            "crashing_worker_process".into(),
            "--nocapture".into(),
        ],
    );
    let mut def = LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), binding).unwrap(),
        steps: steps(),
    };
    def.steps.truncate(1);
    def.steps[0].job_template = json!({"kind":"process", "input":{}});
    let path = request(&temp, def);
    for action in ["launch", "launch", "converge"] {
        let output = invoke(&path, action, &[]);
        assert!(!output.status.success());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["reconciliationRequired"], true);
    }
    assert_eq!(fs::read_to_string(cwd.join("invocations")).unwrap(), "1");
    let observed = success(invoke(&path, "status", &[]));
    assert_eq!(observed["workflow"]["committedSteps"], 0);
    assert_eq!(observed["workflow"]["pendingStep"], true);
}

fn private_json<T: serde::Serialize>(temp: &Temp, name: &str, value: &T) -> PathBuf {
    let path = temp.0.join(name);
    fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    path
}

fn amended_input(
    temp: &Temp,
    original: &Path,
    request: &WorkflowAmendmentV1,
    receipt: &WorkflowAmendmentReceiptV1,
) -> PathBuf {
    let mut next: LocalWorkflowV1 = serde_json::from_slice(&fs::read(original).unwrap()).unwrap();
    if request.repair_rejected_review {
        next.steps
            .truncate(usize::try_from(receipt.committed_steps).unwrap());
    }
    next.steps.extend(request.steps.clone());
    next.template.snapshot.budget_microusd += request.additional_budget_microusd;
    next.template.frontier.snapshot_hash = next.template.snapshot.snapshot_hash().unwrap();
    next.template.writer_lease.expires_at_unix_ms = request.lease_expires_at_unix_ms;
    next.validate().unwrap();
    assert_eq!(canonical_hash_v1(&next).unwrap(), receipt.definition_hash);
    private_json(temp, "amended-autonomous-workflow.json", &next)
}

#[test]
fn autonomous_amendment_renews_once_and_continues_through_the_same_writer() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let before = success(invoke(&path, "launch", &["--through-steps", "3"]));
    let definition: LocalWorkflowV1 = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut change = amendment(before["workflow"]["campaignRevision"].as_u64().unwrap());
    change.lease_expires_at_unix_ms = definition.template.writer_lease.expires_at_unix_ms + 300_000;
    let change_path = private_json(&temp, "renewal.json", &change);
    let original_bytes = fs::read(temp.state().join("workflow.json")).unwrap();
    let attempts = attempt_count(&temp);
    let applied = success(invoke(
        &path,
        "amend",
        &["--amendment-file", change_path.to_str().unwrap()],
    ));
    let receipt: WorkflowAmendmentReceiptV1 =
        serde_json::from_value(applied["amendment"].clone()).unwrap();
    assert_eq!(receipt.committed_steps, 3);
    assert_eq!(receipt.applied_revision, change.expected_revision + 1);
    assert!(receipt.recorded_at_unix_ms >= definition.template.observed_at_unix_ms);
    assert_eq!(applied["previousDefinitionHash"], before["definitionHash"]);
    assert_eq!(
        applied,
        success(invoke(
            &path,
            "amend",
            &["--amendment-file", change_path.to_str().unwrap()]
        ))
    );
    assert_eq!(attempt_count(&temp), attempts);
    let progress = status(&temp, &receipt.definition_hash);
    assert_eq!(progress.amendment_count, 1);
    assert_eq!(progress.budget_remaining_microusd, 147);
    assert_eq!(
        serde_json::to_value(&progress.artifacts_by_step).unwrap(),
        before["workflow"]["artifactsByStep"]
    );
    let serialized = serde_json::to_string(&applied).unwrap();
    assert!(!serialized.contains("writerLease"));
    assert!(!serialized.contains("jobTemplate"));
    assert_eq!(applied["providerExecutionPerformed"], false);
    assert_eq!(applied["networkActionPerformed"], false);
    let current = amended_input(&temp, &path, &change, &receipt);
    assert!(!invoke(&path, "converge", &[]).status.success());
    let done = success(invoke(&current, "converge", &[]));
    assert_eq!(done["workflow"]["committedSteps"], 7);
    assert_eq!(done["workflow"]["budgetRemainingMicrousd"], 143);
    assert_eq!(done["workflow"]["amendmentCount"], 1);
    assert_eq!(
        fs::read(temp.state().join("workflow.json")).unwrap(),
        original_bytes
    );
    let attempts = attempt_count(&temp);
    // A lost-response retry still returns only the original operation receipt,
    // even after completion; it must not attempt status with the old definition.
    assert_eq!(
        applied,
        success(invoke(
            &path,
            "amend",
            &["--amendment-file", change_path.to_str().unwrap()]
        ))
    );
    assert_eq!(attempt_count(&temp), attempts);
    change.additional_budget_microusd += 1;
    private_json(&temp, "renewal.json", &change);
    assert!(
        !invoke(
            &path,
            "amend",
            &["--amendment-file", change_path.to_str().unwrap()]
        )
        .status
        .success()
    );
    let progress = status(&temp, &receipt.definition_hash);
    assert_eq!(progress.amendment_count, 1);
    assert_eq!(progress.budget_remaining_microusd, 143);
}

#[test]
fn autonomous_amendment_replays_expired_original_subject_without_reviving_it() {
    let (temp, hash) = fixture();
    let path = private_json(&temp, "historical-workflow.json", &definition(&temp));
    let mut change = amendment(status(&temp, &hash).campaign_revision);
    let applied = amend_local_workflow_v1(&temp.state(), &hash, change.clone(), 1200).unwrap();
    let change_path = private_json(&temp, "historical-amendment.json", &change);
    let response = success(invoke(
        &path,
        "amend",
        &["--amendment-file", change_path.to_str().unwrap()],
    ));
    assert_eq!(
        response["amendment"],
        serde_json::to_value(&applied).unwrap()
    );
    let current = amended_input(&temp, &path, &change, &applied);
    change.operation_id = "new-expired-renewal".into();
    change.expected_revision = applied.applied_revision;
    private_json(&temp, "historical-amendment.json", &change);
    assert!(
        !invoke(
            &current,
            "amend",
            &["--amendment-file", change_path.to_str().unwrap()]
        )
        .status
        .success()
    );
    let progress = status(&temp, &applied.definition_hash);
    assert_eq!(progress.amendment_count, 1);
    assert_eq!(progress.budget_remaining_microusd, 150);
    assert_eq!(attempt_count(&temp), 0);
}

#[test]
fn autonomous_amendment_rejects_unsafe_requests_and_never_initializes_or_dispatches() {
    let temp = Temp::new();
    let path = request(&temp, definition(&temp));
    let def: LocalWorkflowV1 = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut change = amendment(0);
    change.lease_expires_at_unix_ms = def.template.writer_lease.expires_at_unix_ms + 300_000;
    let change_path = private_json(&temp, "amendment.json", &change);
    let args = ["--amendment-file", change_path.to_str().unwrap()];
    assert!(!invoke(&path, "amend", &args).status.success());
    assert!(!temp.state().exists());
    let options = autonomous_research::parse_autonomous_research_arguments(&[
        "--campaign-id".into(),
        "campaign-service".into(),
        "--workflow-file".into(),
        path.to_str().unwrap().into(),
        "--action".into(),
        "amend".into(),
        "--amendment-file".into(),
        change_path.to_str().unwrap().into(),
    ])
    .unwrap();
    assert_eq!(
        autonomous_research::inspect_autonomous_research_v1(&options)["ready"],
        false
    );
    assert!(!temp.state().exists());
    let before = success(invoke(&path, "launch", &["--through-steps", "1"]));
    change.expected_revision = before["workflow"]["campaignRevision"].as_u64().unwrap();
    private_json(&temp, "amendment.json", &change);
    let attempts = attempt_count(&temp);
    assert!(!invoke(&path, "amend", &[]).status.success());
    for extra in [
        vec!["--through-steps", "2"],
        vec!["--expected-revision", "1"],
        vec!["--require-full-ready"],
        vec!["--launch-mode", "production-run"],
    ] {
        let mut supplied = args.to_vec();
        supplied.extend(extra);
        assert!(!invoke(&path, "amend", &supplied).status.success());
    }
    for action in ["prepare", "launch", "status"] {
        assert!(!invoke(&path, action, &args).status.success());
    }
    let mut wrong = options.clone();
    wrong.campaign_id = Some("foreign-campaign".into());
    assert_eq!(
        autonomous_research::execute_autonomous_research_v1(&wrong)["ready"],
        false
    );
    let alias = temp.0.join("amendment-alias.json");
    std::os::unix::fs::symlink(&change_path, &alias).unwrap();
    assert!(
        !invoke(
            &path,
            "amend",
            &["--amendment-file", alias.to_str().unwrap()]
        )
        .status
        .success()
    );
    fs::set_permissions(&change_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!invoke(&path, "amend", &args).status.success());
    fs::set_permissions(&change_path, fs::Permissions::from_mode(0o600)).unwrap();
    let mut malformed = serde_json::to_value(&change).unwrap();
    malformed["untrustedSecret"] = json!("DO-NOT-ECHO-AMENDMENT-CONTENT");
    private_json(&temp, "amendment.json", &malformed);
    let rejected = invoke(&path, "amend", &args);
    assert!(!rejected.status.success());
    assert!(!String::from_utf8_lossy(&rejected.stdout).contains("DO-NOT-ECHO-AMENDMENT-CONTENT"));
    assert!(!String::from_utf8_lossy(&rejected.stderr).contains("DO-NOT-ECHO-AMENDMENT-CONTENT"));
    fs::write(&change_path, vec![b' '; 16 * 1024 * 1024 + 1]).unwrap();
    assert!(!invoke(&path, "amend", &args).status.success());
    assert_eq!(attempt_count(&temp), attempts);
    let hash = before["definitionHash"].as_str().unwrap().parse().unwrap();
    let progress = status(&temp, &hash);
    assert_eq!(progress.amendment_count, 0);
    assert_eq!(progress.budget_remaining_microusd, 99);
}

#[test]
fn autonomous_repair_keeps_rejection_until_a_fresh_same_policy_review() {
    let temp = Temp::new();
    let mut def = definition(&temp);
    def.steps[3].job_template["job"]["title"] = json!("FORBIDDEN");
    def.steps[4].job_template["job"]["policy"]["forbiddenMarkers"] = json!(["FORBIDDEN"]);
    let path = request(&temp, def);
    assert!(!invoke(&path, "launch", &[]).status.success());
    let observed = success(invoke(&path, "status", &[]));
    let before = status(
        &temp,
        &observed["definitionHash"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    );
    assert_eq!(before.committed_steps, 5);
    assert!(before.gate_rejected);
    let old: LocalWorkflowV1 = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut change = repair_request(before.campaign_revision);
    change.lease_expires_at_unix_ms = old.template.writer_lease.expires_at_unix_ms + 300_000;
    let mut weakened = change.clone();
    weakened.steps[1].job_template["job"]["policy"]["forbiddenMarkers"] = json!([]);
    let change_path = private_json(&temp, "repair.json", &weakened);
    assert!(
        !invoke(
            &path,
            "amend",
            &["--amendment-file", change_path.to_str().unwrap()]
        )
        .status
        .success()
    );
    assert_eq!(
        status(&temp, &canonical_hash_v1(&old).unwrap()).amendment_count,
        0
    );
    private_json(&temp, "repair.json", &change);
    let amended = success(invoke(
        &path,
        "amend",
        &["--amendment-file", change_path.to_str().unwrap()],
    ));
    let applied: WorkflowAmendmentReceiptV1 =
        serde_json::from_value(amended["amendment"].clone()).unwrap();
    let current = amended_input(&temp, &path, &change, &applied);
    let author = success(invoke(&current, "converge", &["--through-steps", "6"]));
    assert_eq!(author["workflow"]["gateRejected"], true);
    assert!(author["workflow"]["artifactsByStep"].get("build").is_none());
    let done = success(invoke(&current, "converge", &[]));
    assert_eq!(done["workflow"]["committedSteps"], 9);
    assert_eq!(done["workflow"]["gateRejected"], false);
    assert_eq!(done["workflow"]["budgetRemainingMicrousd"], 141);
    assert_eq!(done["scientificAcceptance"], false);
    for (id, values) in before.artifacts_by_step {
        assert_eq!(
            done["workflow"]["artifactsByStep"][id],
            serde_json::to_value(values).unwrap()
        );
    }
    assert_ne!(
        done["workflow"]["artifactsByStep"]["author"],
        done["workflow"]["artifactsByStep"]["author-revised"]
    );
    assert_eq!(
        amended,
        success(invoke(
            &path,
            "amend",
            &["--amendment-file", change_path.to_str().unwrap()]
        ))
    );
}
