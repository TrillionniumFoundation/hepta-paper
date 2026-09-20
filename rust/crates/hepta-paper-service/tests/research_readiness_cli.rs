//! The native research-readiness route is deliberately bounded to passive,
//! local state-safety observation. It must produce a diagnostic report even
//! when the runtime is not provisioned, and its strict flag must fail closed.
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn command(root: &Path, runtime: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
    command
        .arg("research-readiness")
        .arg("--workspace-root")
        .arg(root)
        .arg("--runtime-root")
        .arg(runtime)
        .arg("--working-directory")
        .arg(root)
        .arg("--now")
        .arg("1789560000000")
        .env_remove("HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG")
        .env_remove("HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG")
        .env_remove("HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG");
    command
}

#[test]
fn passive_route_reports_blocked_runtime_without_authority_or_mutation()
-> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let runtime = std::env::temp_dir().join(format!(
        "hepta-research-readiness-cli-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&runtime)?;

    let output = command(&root, &runtime).output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(report["status"], "autonomous_research_state_safety_blocked");
    assert_eq!(report["ready"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert!(report["blockers"].as_array().is_some_and(|v| !v.is_empty()));

    // Invoke the original composition, not a reconstructed model of its report.
    let node = Command::new("node")
        .current_dir(&root)
        .args([
            "--input-type=module",
            "--eval",
            "import { inspectAutonomousResearchStateSafety } from './paper-composition/automation/autonomous-research-state-safety-inspection.mjs'; process.stdout.write(JSON.stringify(inspectAutonomousResearchStateSafety({workspaceRoot: process.argv[1], runtimeRoot: process.argv[2], now: new Date(1789560000000), environment: {}})));",
        ])
        .arg(fs::canonicalize(&root)?)
        .arg(&runtime)
        .output()?;
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let original: Value = serde_json::from_slice(&node.stdout)?;
    assert_eq!(report, original);
    assert_eq!(fs::read_dir(&runtime)?.count(), 0);

    let strict = {
        let mut command = command(&root, &runtime);
        command.arg("--require-ready");
        command.output()?
    };
    assert_eq!(strict.status.code(), Some(1));
    let strict_report: Value = serde_json::from_slice(&strict.stdout)?;
    assert_eq!(strict_report, report);
    assert!(
        String::from_utf8_lossy(&strict.stderr)
            .contains("research readiness state-safety inspection is blocked")
    );

    let help = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["research-readiness", "--help"])
        .output()?;
    assert!(help.status.success());
    let usage: Value = serde_json::from_slice(&help.stdout)?;
    assert_eq!(usage["kind"], "ResearchReadinessUsage");
    assert_eq!(usage["externalAction"], "none");

    fs::remove_dir_all(runtime)?;
    Ok(())
}
