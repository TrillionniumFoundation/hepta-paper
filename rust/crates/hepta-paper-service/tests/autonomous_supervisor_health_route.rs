use serde_json::Value;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-supervisor-route-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    root
}

#[test]
fn health_route_reports_read_only_missing_instance_and_execution_stays_blocked() {
    let root = root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-supervisor",
            "--action",
            "health",
            "--runtime-root",
        ])
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "autonomous_research_supervisor_instance_missing")
    );

    let execution = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-supervisor", "--action", "run", "--runtime-root"])
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(execution.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&execution.stderr)
            .contains("rust_autonomous_supervisor_execution_not_ported")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn health_route_help_is_json_and_does_not_touch_runtime() {
    let root = root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-supervisor", "--help", "--runtime-root"])
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["mutation"], "none");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unified_route_external_qualification_option_matches_node_parser_errors() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor.mjs");
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    for (args, code) in [
        (
            vec!["autonomous-supervisor", "--external-qualification-config"],
            "missing_cli_option_value:--external-qualification-config",
        ),
        (
            vec![
                "autonomous-supervisor",
                "--external-qualification-config",
                "/tmp/a",
                "--external-qualification-config",
                "/tmp/b",
            ],
            "duplicate_cli_option:--external-qualification-config",
        ),
        (
            vec!["autonomous-supervisor", "--external-qualification-config="],
            "empty_cli_option_value:--external-qualification-config",
        ),
    ] {
        let node = Command::new("node")
            .arg(&script)
            .args(&args[1..])
            .output()
            .unwrap();
        let rust = Command::new(binary).args(args).output().unwrap();
        assert_eq!(node.status.code(), Some(1), "{code}: node");
        assert_eq!(rust.status.code(), Some(1), "{code}: rust");
        assert!(
            String::from_utf8_lossy(&node.stderr).contains(code),
            "{code}: node"
        );
        assert!(
            String::from_utf8_lossy(&rust.stderr).contains(code),
            "{code}: rust"
        );
    }
}
