//! Differential coverage for the bounded, missing-input external-authority gate.
//!
//! The test intentionally exercises only the passive branch that has no
//! external configuration.  It must never manufacture an authority result.

use hepta_paper_service::external_authority_intake::{
    external_authority_intake_help_json_v1, inspect_external_authority_intake_v1,
};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const NOW: &str = "2026-07-29T04:00:00.000Z";
static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn missing_input_report_matches_node_composition() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let rust = inspect_external_authority_intake_v1(None, None, None, None, NOW)?;
    let node = Command::new("node")
        .current_dir(&root)
        .args([
            "--input-type=module",
            "--eval",
            "import { composeProductionExternalAuthorityIntake } from './paper-composition/automation/production-external-authority-intake-composition.mjs'; process.stdout.write(JSON.stringify(composeProductionExternalAuthorityIntake({ authorConfigPath:null, authorExpectedConfigurationHash:null, releaseAttestorConfigPath:null, releaseAttestorExpectedConfigurationHash:null, environment:{}, now:new Date(process.argv[1]) })));",
            NOW,
        ])
        .output()?;
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let node: Value = serde_json::from_slice(&node.stdout)?;
    assert_eq!(rust, node);
    Ok(())
}

#[test]
fn help_metadata_matches_node() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node = Command::new("node")
        .current_dir(&root)
        .args([
            "paper-core/bin/production-external-authority-intake.mjs",
            "--help",
        ])
        .output()?;
    assert!(node.status.success());
    let node: Value = serde_json::from_slice(&node.stdout)?;
    assert_eq!(external_authority_intake_help_json_v1(), node);
    Ok(())
}

#[test]
fn strict_gate_is_fail_closed_without_external_inputs() -> Result<(), Box<dyn std::error::Error>> {
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    let output = Command::new(binary)
        .args(["external-authority-intake", "--require-ready"])
        .env_remove("HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG")
        .env_remove("HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH")
        .env_remove("HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG")
        .env_remove("HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH")
        .output()?;
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(report["ready"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert_eq!(
        report["blockers"],
        serde_json::json!([
            "autonomous_research_author_identity_configuration_path_missing",
            "research_execution_release_attestor_config_path_missing"
        ])
    );
    Ok(())
}

#[test]
fn configured_paths_are_pinned_and_symlinks_are_rejected() -> Result<(), Box<dyn std::error::Error>>
{
    let root = std::env::temp_dir().join(format!(
        "hepta-external-authority-intake-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root)?;
    let file = root.join("configuration.json");
    let link = root.join("configuration-link.json");
    let bytes = br#"{"version":1}"#;
    fs::write(&file, bytes)?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
    symlink(&file, &link)?;

    let symlink_report =
        inspect_external_authority_intake_v1(Some(&link), None, Some(&link), None, NOW)?;
    assert_eq!(
        symlink_report["author"]["blockers"],
        serde_json::json!(["autonomous_research_author_identity_configuration_file_invalid"])
    );
    assert_eq!(
        symlink_report["releaseAttestor"]["blockers"],
        serde_json::json!(["research_execution_release_attestor_config_not_private_regular_file"])
    );

    let report = inspect_external_authority_intake_v1(Some(&file), None, Some(&file), None, NOW)?;
    assert_eq!(report["author"]["configured"], true);
    assert_eq!(report["releaseAttestor"]["configured"], true);
    assert_eq!(
        report["releaseAttestor"]["observedConfigurationFileHash"],
        "sha256:2430f1a2ad2982d0067885488a4c89e21ad1d7c83b115ba8f1b20acc88dfaea8"
    );
    assert_eq!(report["externalActionPerformed"], false);
    assert_eq!(report["ready"], false);
    fs::remove_dir_all(root)?;
    Ok(())
}
