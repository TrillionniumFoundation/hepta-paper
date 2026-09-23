use super::*;
use hepta_control_plane::ControlPlaneError;

#[test]
fn actual_workflow_worker_failure_survives_typed_source_chain_and_cli_projection() {
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
    let mut definition = LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), binding).unwrap(),
        steps: steps(),
    };
    definition.steps.truncate(1);
    definition.steps[0].job_template = serde_json::json!({"kind":"process", "input":{}});
    let hash = initialize_local_workflow_v1(definition).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
        .arg("advance")
        .arg(temp.state())
        .arg(hash.as_str())
        .args(["1", "1100"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let cli_report: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(
        cli_report["kind"],
        "HeptaServiceControlInspectionRequiredV1"
    );
    assert_eq!(cli_report["inspectionRequired"], true);
    assert_eq!(cli_report["retryable"], false);
    assert_eq!(
        cli_report["diagnostic"]["cause"],
        ControlPlaneError::ExecutionInvalid.to_string()
    );

    let error = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        1200,
    )
    .unwrap_err();
    let report =
        service_control_inspection_report_v1(&error).expect("actual WorkflowError source chain");
    assert_eq!(report, cli_report);
    let WorkflowError::Service(ServiceError::ControlRequiresInspection {
        inspection: Some(inspection),
    }) = &error
    else {
        panic!("actual workflow must preserve the typed service inspection error");
    };
    assert_eq!(
        inspection.cause(),
        Some(ControlPlaneError::ExecutionInvalid)
    );
    assert_eq!(inspection.reservation_ids().len(), 1);
    assert_eq!(fs::read_to_string(cwd.join("invocations")).unwrap(), "1");
    let progress = status(&temp, &hash);
    assert_eq!(progress.committed_steps, 0);
    assert!(progress.pending_step);
}
