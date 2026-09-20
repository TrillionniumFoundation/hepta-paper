//! Read-only preflight for the incumbent `npm test` verification surface.
//!
//! This boundary inventories checked-in Node test sources and the Rust
//! workspace without starting Node, npm, a subprocess, or an external action.
//! Inventory parity is evidence for planning only; it is never accepted as
//! execution parity or a Node-retirement decision.

#![forbid(unsafe_code)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const MAX_REFERENCE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_WALK_ENTRIES: usize = 200_000;
const SHA256_PREFIX: &str = "sha256:";

pub const FULL_SUITE_VERIFICATION_USAGE: &str = r#"{
  "version": 1,
  "kind": "FullSuiteVerificationUsage",
  "usage": "hepta-paper-rust verify-full --workspace-root ABSOLUTE_PATH [--require-parity] [--json]",
  "effects": "read-only",
  "semanticNotReadyExitCode": 2,
  "rustBoundary": "static Node test-manifest/source inventory and Rust workspace provenance only; Node/npm execution and parity acceptance remain fail-closed"
}"#;

#[derive(Clone, Debug, Default)]
pub struct FullSuiteVerificationOptions {
    pub workspace_root: Option<PathBuf>,
    pub require_parity: bool,
    pub json: bool,
    pub help: bool,
}

fn option_value(args: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!("full_suite_verification_{name}_value_required"));
    }
    let value = args[*index + 1].clone();
    if value.is_empty() {
        return Err(format!("full_suite_verification_{name}_value_required"));
    }
    *index += 2;
    Ok(value)
}

/// Parse the intentionally small, strict native command surface.
pub fn parse_full_suite_verification_arguments(
    args: &[String],
) -> Result<FullSuiteVerificationOptions, String> {
    let mut options = FullSuiteVerificationOptions::default();
    let mut seen = BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !seen.insert(flag.to_owned()) {
            return Err(format!("duplicate_cli_option:{flag}"));
        }
        match flag {
            "--help" => options.help = true,
            "--json" => options.json = true,
            "--require-parity" => options.require_parity = true,
            "--workspace-root" => {
                options.workspace_root = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "workspace_root",
                )?));
                continue;
            }
            _ => {
                return Err(format!(
                    "unsupported_full_suite_verification_argument:{flag}"
                ));
            }
        }
        index += 1;
    }
    if options.help {
        return Ok(options);
    }
    let Some(root) = options.workspace_root.as_ref() else {
        return Err("full_suite_verification_workspace_root_required".to_owned());
    };
    if !root.is_absolute() {
        return Err("full_suite_verification_workspace_root_must_be_absolute".to_owned());
    }
    Ok(options)
}

fn digest(bytes: &[u8]) -> String {
    format!("{SHA256_PREFIX}{:x}", Sha256::digest(bytes))
}

fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    if !path.is_absolute() {
        return Err("full_suite_verification_path_must_be_absolute".to_owned());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "full_suite_verification_reference_missing".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err("full_suite_verification_reference_must_be_regular_non_symlink".to_owned());
    }
    if metadata.len() > MAX_REFERENCE_BYTES {
        return Err("full_suite_verification_reference_too_large".to_owned());
    }
    let bytes =
        fs::read(path).map_err(|_| "full_suite_verification_reference_read_failed".to_owned())?;
    let after = fs::symlink_metadata(path)
        .map_err(|_| "full_suite_verification_reference_changed".to_owned())?;
    if after.dev() != metadata.dev()
        || after.ino() != metadata.ino()
        || after.nlink() != metadata.nlink()
        || after.mode() != metadata.mode()
        || after.len() != metadata.len()
        || after.mtime() != metadata.mtime()
        || after.mtime_nsec() != metadata.mtime_nsec()
    {
        return Err("full_suite_verification_reference_changed".to_owned());
    }
    Ok(bytes)
}

fn excluded_component(component: &str) -> bool {
    matches!(component, ".git" | "node_modules" | "target")
}

fn collect_test_sources(root: &Path) -> Result<(Vec<String>, Vec<String>), String> {
    let mut tests = Vec::new();
    let mut operational = Vec::new();
    let mut stack = vec![PathBuf::new()];
    let mut entries_seen = 0usize;
    while let Some(relative) = stack.pop() {
        let directory = root.join(&relative);
        let read = fs::read_dir(&directory)
            .map_err(|_| "full_suite_verification_test_inventory_read_failed".to_owned())?;
        for entry in read {
            entries_seen = entries_seen.saturating_add(1);
            if entries_seen > MAX_WALK_ENTRIES {
                return Err("full_suite_verification_test_inventory_too_large".to_owned());
            }
            let entry = entry
                .map_err(|_| "full_suite_verification_test_inventory_read_failed".to_owned())?;
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if excluded_component(&name_text) {
                continue;
            }
            let child = relative.join(&name);
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| "full_suite_verification_test_inventory_read_failed".to_owned())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(child);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if name_text.ends_with(".test.mjs") {
                tests.push(child.to_string_lossy().replace('\\', "/"));
            } else if name_text.ends_with(".operational.mjs") {
                operational.push(child.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    tests.sort();
    operational.sort();
    Ok((tests, operational))
}

fn collect_rust_sources(root: &Path) -> Result<(Vec<String>, Vec<String>), String> {
    let mut sources = Vec::new();
    let mut tests = Vec::new();
    let mut stack = vec![PathBuf::new()];
    let mut entries_seen = 0usize;
    while let Some(relative) = stack.pop() {
        let directory = root.join(&relative);
        let read = fs::read_dir(&directory)
            .map_err(|_| "full_suite_verification_rust_inventory_read_failed".to_owned())?;
        for entry in read {
            entries_seen = entries_seen.saturating_add(1);
            if entries_seen > MAX_WALK_ENTRIES {
                return Err("full_suite_verification_rust_inventory_too_large".to_owned());
            }
            let entry = entry
                .map_err(|_| "full_suite_verification_rust_inventory_read_failed".to_owned())?;
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if excluded_component(&name_text) {
                continue;
            }
            let child = relative.join(&name);
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| "full_suite_verification_rust_inventory_read_failed".to_owned())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(child);
                continue;
            }
            if metadata.is_file() && name_text.ends_with(".rs") {
                let path = child.to_string_lossy().replace('\\', "/");
                if child
                    .components()
                    .any(|component| component.as_os_str() == "tests")
                {
                    tests.push(path.clone());
                }
                sources.push(path);
            }
        }
    }
    sources.sort();
    tests.sort();
    Ok((sources, tests))
}

fn inventory_hash(paths: &[String]) -> String {
    digest(paths.join("\n").as_bytes())
}

fn workspace_members(cargo_toml: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(cargo_toml);
    let mut members = Vec::new();
    let mut in_members = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("members") && trimmed.contains('[') {
            in_members = true;
        }
        if in_members {
            let mut rest = trimmed;
            while let Some(start) = rest.find('"') {
                let after = &rest[start + 1..];
                let Some(end) = after.find('"') else { break };
                members.push(after[..end].to_owned());
                rest = &after[end + 1..];
            }
            if trimmed.contains(']') {
                in_members = false;
            }
        }
    }
    members.sort();
    members.dedup();
    members
}

pub fn full_suite_verification_help_json_v1() -> Value {
    serde_json::from_str(FULL_SUITE_VERIFICATION_USAGE).expect("static full-suite usage JSON")
}

pub fn inspect_full_suite_verification_v1(
    options: &FullSuiteVerificationOptions,
) -> Result<Value, String> {
    let root = options
        .workspace_root
        .as_ref()
        .ok_or_else(|| "full_suite_verification_workspace_root_required".to_owned())?;
    if !root.is_absolute() {
        return Err("full_suite_verification_workspace_root_must_be_absolute".to_owned());
    }
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|_| "full_suite_verification_workspace_root_missing".to_owned())?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err("full_suite_verification_workspace_root_must_be_directory".to_owned());
    }
    let package_path = root.join("package.json");
    let cargo_path = root.join("rust/Cargo.toml");
    let package_bytes = read_regular(&package_path).ok();
    let cargo_bytes = read_regular(&cargo_path).ok();
    let package_json = package_bytes
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok());
    let test_script = package_json
        .as_ref()
        .and_then(|value| value["scripts"]["test"].as_str())
        .map(str::to_owned);
    let (node_tests, node_operational) = collect_test_sources(root)?;
    let rust_root = root.join("rust");
    let (rust_sources, rust_tests) = if cargo_bytes.is_some() {
        collect_rust_sources(&rust_root)?
    } else {
        (Vec::new(), Vec::new())
    };
    let members = cargo_bytes
        .as_deref()
        .map(workspace_members)
        .unwrap_or_default();
    let node_inventory = [node_tests.as_slice(), node_operational.as_slice()].concat();
    let mut blockers = vec![
        "full_suite_node_execution_not_performed_by_rust_boundary".to_owned(),
        "full_suite_rust_execution_parity_not_independently_accepted".to_owned(),
    ];
    if package_bytes.is_none() {
        blockers.push("full_suite_node_package_manifest_missing".to_owned());
    } else if test_script.is_none() {
        blockers.push("full_suite_node_test_script_missing".to_owned());
    }
    if node_inventory.is_empty() {
        blockers.push("full_suite_node_test_inventory_empty".to_owned());
    }
    if cargo_bytes.is_none() {
        blockers.push("full_suite_rust_workspace_manifest_missing".to_owned());
    } else if members.is_empty() {
        blockers.push("full_suite_rust_workspace_members_missing".to_owned());
    }
    if rust_sources.is_empty() {
        blockers.push("full_suite_rust_source_inventory_empty".to_owned());
    }
    blockers.sort();
    blockers.dedup();
    Ok(json!({
        "version": 1,
        "kind": "FullSuiteVerificationPreflightReport",
        "status": "verify_full_blocked",
        "ok": false,
        "ready": false,
        "parityAccepted": false,
        "requireParity": options.require_parity,
        "workspaceRoot": root,
        "nodeExecutionPerformed": false,
        "npmExecutionPerformed": false,
        "externalActionPerformed": false,
        "serviceStateChanged": false,
        "nodeTestManifest": {
            "path": package_path,
            "sha256": package_bytes.as_deref().map(digest),
            "testScript": test_script,
            "testScriptConfigured": package_bytes.is_some() && package_json.is_some() && test_script.is_some(),
            "testFileCount": node_tests.len(),
            "operationalFileCount": node_operational.len(),
            "inventorySha256": inventory_hash(&node_inventory),
        },
        "rustWorkspace": {
            "path": cargo_path,
            "sha256": cargo_bytes.as_deref().map(digest),
            "crateCount": members.len(),
            "members": members,
            "sourceFileCount": rust_sources.len(),
            "testFileCount": rust_tests.len(),
            "inventorySha256": inventory_hash(&rust_sources),
            "testInventorySha256": inventory_hash(&rust_tests),
        },
        "blockers": blockers,
        "rustBoundary": "read-only-static-node-manifest-source-inventory-and-rust-workspace-provenance",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_requires_absolute_workspace_root_and_rejects_unknown_flags() {
        assert!(parse_full_suite_verification_arguments(&[]).is_err());
        assert!(
            parse_full_suite_verification_arguments(&[
                "--workspace-root".into(),
                "relative".into(),
            ])
            .is_err()
        );
        assert!(
            parse_full_suite_verification_arguments(&[
                "--workspace-root".into(),
                "/tmp/workspace".into(),
                "--unknown".into(),
            ])
            .is_err()
        );
    }

    #[test]
    fn inventory_is_blocked_without_executing_node_or_npm() {
        let options = FullSuiteVerificationOptions {
            workspace_root: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")),
            require_parity: true,
            ..FullSuiteVerificationOptions::default()
        };
        let report = inspect_full_suite_verification_v1(&options).unwrap();
        assert_eq!(report["status"], "verify_full_blocked");
        assert_eq!(report["parityAccepted"], false);
        assert_eq!(report["nodeExecutionPerformed"], false);
        assert_eq!(report["npmExecutionPerformed"], false);
        assert!(
            report["nodeTestManifest"]["testFileCount"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(report["rustWorkspace"]["crateCount"].as_u64().unwrap() > 0);
    }
}
