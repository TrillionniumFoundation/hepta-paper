use super::*;
use hepta_control_plane::{ControlPlaneError, ControlPlaneRunFailurePhaseV1, select_plan_v1};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn process_configuration(temp: &Temp) -> ServiceRunV1 {
    let cwd = temp.0.join("inspection-worker");
    fs::create_dir(&cwd).unwrap();
    fs::set_permissions(&cwd, fs::Permissions::from_mode(0o700)).unwrap();
    // Pin a private copy, without changing the shared Cargo executable's mode.
    let executable = cwd.join("pinned-worker");
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o500)).unwrap();
    let executable_hash = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(&executable).unwrap()))
    )
    .parse()
    .unwrap();
    let binding = WorkerBindingV1::Process {
        executable,
        executable_hash,
        arguments: vec![
            "--exact".into(),
            "inspection::marker_worker".into(),
            "--ignored".into(),
        ],
        code_files: BTreeMap::new(),
        working_directory: cwd,
        timeout_ms: 10_000,
        implementation_language: "rust".into(),
        network_declared: false,
    };
    let mut config = configuration_with_worker(temp, binding);
    let mut second = config.frontier.candidates[0].clone();
    second.candidate_id = "unstarted-second-action".into();
    second.decision_group = "second-group".into();
    config.frontier.candidates.push(second);
    config
}

#[test]
#[ignore = "private actual worker spawned by the inspection regression"]
fn marker_worker() {
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(
        cwd.file_name().and_then(|s| s.to_str()),
        Some("inspection-worker")
    );
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(cwd.join("invocations"))
        .unwrap();
    file.write_all(b"invoked\n").unwrap();
    file.sync_all().unwrap();
    // A real worker process exits after its durable test effect. It never emits
    // a prepared result, so the service must retain the uncertainty diagnosis.
    std::process::exit(23);
}

fn assert_inspection(error: &ServiceError, config: &ServiceRunV1) {
    let ServiceError::ControlRequiresInspection {
        inspection: Some(inspection),
    } = error
    else {
        panic!("expected actual runtime inspection diagnostic");
    };
    assert_eq!(inspection.phase(), ControlPlaneRunFailurePhaseV1::Execution);
    assert_eq!(
        inspection.cause(),
        Some(ControlPlaneError::ExecutionInvalid)
    );
    assert_eq!(
        inspection.snapshot_hash(),
        &config.snapshot.snapshot_hash().unwrap()
    );
    let plan = select_plan_v1(
        &config.snapshot,
        &config.frontier,
        &config.hard_policy,
        &config.planner_policy,
    )
    .unwrap();
    assert_eq!(inspection.plan_hash(), &plan.plan_hash);
    assert_eq!(inspection.reservation_ids().len(), 2);
    assert_eq!(
        inspection.reservation_ids(),
        &[
            format!("{}:reservation:1", plan.plan_hash.as_str()),
            format!("{}:reservation:2", plan.plan_hash.as_str()),
        ]
    );
    let report = service_control_inspection_report_v1(error).unwrap();
    assert_eq!(report["code"], "service_control_requires_inspection");
    assert_eq!(report["inspectionRequired"], true);
    assert_eq!(report["retryable"], false);
    assert_eq!(
        report["diagnostic"]["cause"],
        ControlPlaneError::ExecutionInvalid.to_string()
    );
    assert!(report.get("committed").is_none());
    assert!(report.get("authorityOutcome").is_none());
}

#[test]
fn actual_marker_worker_error_retains_service_diagnostic_and_does_not_repeat_worker() {
    let temp = Temp::new();
    let config = process_configuration(&temp);
    let first = run_service_v1(config.clone()).unwrap_err();
    assert_inspection(&first, &config);
    let second = run_service_v1(config.clone()).unwrap_err();
    assert_inspection(&second, &config);
    assert_eq!(
        fs::read(temp.0.join("inspection-worker/invocations")).unwrap(),
        b"invoked\n"
    );
    let paths = fs::read_dir(temp.0.join("attempts"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0].extension().unwrap(), "started");
    // This proves existing per-attempt started-record refusal, not persistence
    // of the two resource charges in the copied service diagnostic.
}

#[test]
fn serve_first_inspection_failure_stops_before_the_next_input() {
    let failed = Temp::new();
    let failed_config = process_configuration(&failed);
    let untouched = Temp::new();
    let untouched_config = configuration(&untouched);
    let mut input = serde_json::to_vec(&failed_config).unwrap();
    input.push(b'\n');
    input.extend(serde_json::to_vec(&untouched_config).unwrap());
    input.push(b'\n');
    let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let report: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(report["kind"], "HeptaServiceControlInspectionRequiredV1");
    assert_eq!(report["inspectionRequired"], true);
    assert_eq!(
        report["diagnostic"]["reservationIds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        fs::read(failed.0.join("inspection-worker/invocations")).unwrap(),
        b"invoked\n"
    );
    assert!(!untouched.0.join("campaign.sqlite").exists());
    assert_eq!(
        fs::read_dir(untouched.0.join("attempts")).unwrap().count(),
        0
    );
}

#[test]
fn pre_dispatch_control_error_preserves_old_service_and_cli_error_bytes() {
    let temp = Temp::new();
    let mut config = configuration(&temp);
    config.frontier.version = 0;
    let error = run_service_v1(config.clone()).unwrap_err();
    assert!(matches!(error, ServiceError::Control));
    assert_eq!(error.to_string(), "control-plane operation rejected");
    assert!(service_control_inspection_report_v1(&error).is_none());
    let path = temp.0.join("bad-run.json");
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(path)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"hepta-paper-rust: control-plane operation rejected\n"
    );
    assert_eq!(fs::read_dir(temp.0.join("attempts")).unwrap().count(), 0);
}

#[test]
fn unrelated_workflow_and_maintenance_cli_errors_keep_their_original_bytes() {
    for (executable, message) in [
        (
            env!("CARGO_BIN_EXE_hepta-local-workflow"),
            "local workflow command rejected; inspect private retained state\n",
        ),
        (
            env!("CARGO_BIN_EXE_hepta-local-maintenance"),
            "local maintenance rejected; preserve private state and reconcile\n",
        ),
    ] {
        let output = Command::new(executable)
            .arg("unsupported-command")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, message.as_bytes());
    }
}
