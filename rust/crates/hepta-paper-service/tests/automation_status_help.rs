//! Differential coverage for the bounded `automation-status --help` route.
//!
//! The incumbent command performs readiness probes and optional external
//! actions. This test covers only its deterministic help metadata; it does not
//! treat that metadata as a readiness or activation implementation.

use serde_json::Value;
use std::{path::PathBuf, process::Command};

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn run_node(arguments: &[&str]) -> std::process::Output {
    let root = repository_root();
    Command::new("node")
        .current_dir(&root)
        .arg("paper-core/bin/automation-status.mjs")
        .args(arguments)
        .env_remove("HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG")
        .env_remove("HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG")
        .env_remove("HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG")
        .output()
        .expect("Node automation-status --help")
}

fn run_rust(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["automation-status"])
        .args(arguments)
        .output()
        .expect("Rust automation-status --help")
}

#[test]
fn help_metadata_matches_node_for_plain_and_json_forms() -> Result<(), Box<dyn std::error::Error>> {
    for arguments in [["--help"].as_slice(), ["--json", "--help"].as_slice()] {
        let node = run_node(arguments);
        assert!(
            node.status.success(),
            "Node failed: {}",
            String::from_utf8_lossy(&node.stderr)
        );
        let rust = run_rust(arguments);
        assert!(
            rust.status.success(),
            "Rust failed: {}",
            String::from_utf8_lossy(&rust.stderr)
        );
        assert_eq!(
            rust.stdout, node.stdout,
            "help bytes diverged for {arguments:?}"
        );
        let node_json: Value = serde_json::from_slice(&node.stdout)?;
        let rust_json: Value = serde_json::from_slice(&rust.stdout)?;
        assert_eq!(rust_json, node_json);
        assert_eq!(node_json["version"], 2);
        assert_eq!(node_json["kind"], "AutomationStatusUsage");
    }
    Ok(())
}

#[test]
fn unsupported_readiness_mode_fails_closed_without_claiming_implementation() {
    let output = run_rust(&["--require-full-research"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("bounded help metadata"));
}
