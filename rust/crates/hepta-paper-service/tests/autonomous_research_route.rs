use serde_json::Value;
use std::process::Command;

#[test]
fn help_and_prepare_are_truthful_fail_closed_reports() {
    let help = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-research", "--help"])
        .output()
        .unwrap();
    assert_eq!(help.status.code(), Some(0));
    let usage: Value = serde_json::from_slice(&help.stdout).unwrap();
    assert_eq!(usage["kind"], "AutonomousResearchCampaignUsage");
    assert_eq!(usage["safety"]["externalSubmissionEnabled"], false);

    let report = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-research",
            "--action",
            "prepare",
            "--paper-id",
            "paper-1",
        ])
        .output()
        .unwrap();
    assert_eq!(report.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&report.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(report["campaignPersisted"], false);
    assert_eq!(report["providerExecutionPerformed"], false);
    assert_eq!(report["externalActionPerformed"], false);
}

#[test]
fn launch_mode_and_identity_are_strict() {
    let missing = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-research"])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&missing.stderr)
            .contains("autonomous_research_paper_or_campaign_id_required")
    );

    let bad_mode = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-research",
            "--paper-id",
            "paper-1",
            "--launch-mode",
            "production",
        ])
        .output()
        .unwrap();
    assert_eq!(bad_mode.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&bad_mode.stderr)
            .contains("autonomous_research_launch_mode_invalid")
    );
}


#[test]
fn run_config_is_local_only_and_never_enables_production_mode() {
    let rejected = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-research",
            "--action",
            "launch",
            "--paper-id",
            "paper-1",
            "--launch-mode",
            "production-run",
            "--run-config",
            "/tmp/nonexistent-run.json",
        ])
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&rejected.stderr)
            .contains("autonomous_research_run_config_requires_local_launch_or_resume")
    );

    let prepare = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-research",
            "--action",
            "prepare",
            "--paper-id",
            "paper-1",
            "--run-config",
            "/tmp/nonexistent-run.json",
        ])
        .output()
        .unwrap();
    assert_eq!(prepare.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&prepare.stderr)
            .contains("autonomous_research_run_config_requires_local_launch_or_resume")
    );
}
