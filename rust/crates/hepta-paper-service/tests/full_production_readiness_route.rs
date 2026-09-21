use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
};

fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn temp_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "hepta-full-production-readiness-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn help_matches_bounded_native_route() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["full-production-readiness", "--help"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "FullProductionReadinessUsage");
    assert_eq!(report["externalAction"], "never");
}

#[test]
fn pinned_references_still_fail_closed_without_external_authority() {
    let root = temp_root();
    let trust = root.join("OWNER_TRUST_STORE.json");
    let acceptance = root.join("CAPABILITY_OWNER_ACCEPTANCE.json");
    let command = root.join("package-readiness-helper");
    let trust_bytes = br#"{}"#;
    let acceptance_bytes = br#"{}"#;
    let command_bytes = b"#!/bin/sh\nexit 0\n";
    fs::write(&trust, trust_bytes).unwrap();
    fs::write(&acceptance, acceptance_bytes).unwrap();
    File::create(&command).unwrap();
    fs::write(&command, command_bytes).unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o555)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "full-production-readiness",
            "--owner-trust-store",
            trust.to_str().unwrap(),
            "--owner-trust-store-sha256",
            &hash(trust_bytes),
            "--owner-acceptance-document",
            acceptance.to_str().unwrap(),
            "--owner-acceptance-document-sha256",
            &hash(acceptance_bytes),
            "--package-recovery-readiness-command",
            command.to_str().unwrap(),
            "--package-recovery-readiness-command-sha256",
            &hash(command_bytes),
            "--root",
            root.to_str().unwrap(),
            "--runtime-root",
            root.to_str().unwrap(),
            "--require-full-production",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["fullProductionReady"], false);
    assert_eq!(
        report["references"]["packageRecoveryReadinessCommand"]["hashMatches"],
        true
    );
    assert_eq!(report["packageRetentionRecoveryReady"], false);
    assert!(
        report["inspectionErrors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "full_production_package_readiness_command_reference_invalid")
    );
    assert!(
        !report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "rust_full_production_package_recovery_execution_not_ported")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn omitted_roots_use_the_node_compiled_workspace_siblings() {
    let root = temp_root();
    let trust = root.join("OWNER_TRUST_STORE.json");
    let acceptance = root.join("CAPABILITY_OWNER_ACCEPTANCE.json");
    let command = root.join("package-readiness-helper");
    let trust_bytes = br#"{}"#;
    let acceptance_bytes = br#"{}"#;
    let command_bytes = b"#!/bin/sh\nexit 0\n";
    fs::write(&trust, trust_bytes).unwrap();
    fs::write(&acceptance, acceptance_bytes).unwrap();
    fs::write(&command, command_bytes).unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o555)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .current_dir(&root)
        .env_remove("HEPTA_WORKSPACE_ROOT")
        .env_remove("HEPTA_PAPER_ASSET_ROOT")
        .env_remove("HEPTA_PAPER_RUNTIME_ROOT")
        .args([
            "full-production-readiness",
            "--owner-trust-store",
            trust.to_str().unwrap(),
            "--owner-trust-store-sha256",
            &hash(trust_bytes),
            "--owner-acceptance-document",
            acceptance.to_str().unwrap(),
            "--owner-acceptance-document-sha256",
            &hash(acceptance_bytes),
            "--package-recovery-readiness-command",
            command.to_str().unwrap(),
            "--package-recovery-readiness-command-sha256",
            &hash(command_bytes),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let parent = workspace.parent().unwrap();
    assert_eq!(
        report["root"],
        parent.join("hepta-paper-assets").to_string_lossy().as_ref()
    );
    assert_eq!(
        report["runtimeRoot"],
        parent
            .join("hepta-paper-runtime/native-runtime")
            .to_string_lossy()
            .as_ref()
    );
    let _ = fs::remove_dir_all(root);
}
