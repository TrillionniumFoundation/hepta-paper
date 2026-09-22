//! Actual autonomous-research CLI tests using the existing workflow fixtures/owner.
use super::*;
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
