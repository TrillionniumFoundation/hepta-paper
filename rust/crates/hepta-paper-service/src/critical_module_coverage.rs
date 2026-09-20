//! Read-only preflight for the Node critical-module coverage command.
//!
//! The incumbent command executes a large, isolated Node test/coverage batch.
//! This native boundary intentionally does not re-run that batch or infer
//! coverage from source text. It inventories the checked-in target registry,
//! validates an explicitly pinned Node report when supplied, and remains
//! fail-closed until independently signed Node evidence is available.

#![forbid(unsafe_code)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";

pub const CRITICAL_MODULE_COVERAGE_USAGE: &str = r#"{
  "version": 1,
  "kind": "CriticalModuleCoveragePreflightUsage",
  "usage": "hepta-paper-rust verify-critical [--root ABSOLUTE_PATH] [--runtime-root ABSOLUTE_PATH] [--evidence ABSOLUTE_JSON_PATH --evidence-sha256 sha256:...] [--require-ok] [--json]",
  "effects": "read-only",
  "semanticNotReadyExitCode": 2,
  "rustBoundary": "static target inventory and pinned Node evidence inspection only; Node coverage execution, signature verification, and acceptance remain fail-closed"
}"#;

#[derive(Clone, Debug, Default)]
pub struct CriticalModuleCoverageOptions {
    pub root: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
    pub evidence: Option<PathBuf>,
    pub evidence_sha256: Option<String>,
    pub require_ok: bool,
    pub json: bool,
    pub help: bool,
}

fn option_value(args: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!("critical_module_coverage_{name}_value_required"));
    }
    let value = args[*index + 1].clone();
    if value.is_empty() {
        return Err(format!("critical_module_coverage_{name}_value_required"));
    }
    *index += 2;
    Ok(value)
}

pub fn parse_critical_module_coverage_arguments(
    args: &[String],
) -> Result<CriticalModuleCoverageOptions, String> {
    let mut options = CriticalModuleCoverageOptions::default();
    let mut seen = std::collections::BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !seen.insert(flag.to_owned()) {
            return Err(format!("duplicate_cli_option:{flag}"));
        }
        match flag {
            "--help" => options.help = true,
            "--json" => options.json = true,
            "--require-ok" => options.require_ok = true,
            "--root" => options.root = Some(PathBuf::from(option_value(args, &mut index, "root")?)),
            "--runtime-root" => {
                options.runtime_root = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "runtime_root",
                )?));
            }
            "--evidence" => {
                options.evidence = Some(PathBuf::from(option_value(args, &mut index, "evidence")?));
            }
            "--evidence-sha256" => {
                options.evidence_sha256 = Some(option_value(args, &mut index, "evidence_sha256")?);
            }
            _ => {
                return Err(format!(
                    "unsupported_critical_module_coverage_argument:{flag}"
                ));
            }
        }
        if !matches!(
            flag,
            "--root" | "--runtime-root" | "--evidence" | "--evidence-sha256"
        ) {
            index += 1;
        }
    }
    if options.help {
        return Ok(options);
    }
    if options.evidence.is_some() != options.evidence_sha256.is_some() {
        return Err("critical_module_coverage_evidence_and_hash_must_be_paired".to_owned());
    }
    for (name, path) in [
        ("root", options.root.as_ref()),
        ("runtime_root", options.runtime_root.as_ref()),
        ("evidence", options.evidence.as_ref()),
    ] {
        if let Some(path) = path
            && !path.is_absolute()
        {
            return Err(format!("critical_module_coverage_{name}_must_be_absolute"));
        }
    }
    if options
        .evidence_sha256
        .as_deref()
        .is_some_and(|hash| !valid_sha256(hash))
    {
        return Err("critical_module_coverage_evidence_sha256_invalid".to_owned());
    }
    Ok(options)
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    if !path.is_absolute() {
        return Err("critical_module_coverage_path_must_be_absolute".to_owned());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "critical_module_coverage_reference_missing".to_owned())?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.file_type().is_socket()
    {
        return Err("critical_module_coverage_reference_must_be_regular_non_symlink".to_owned());
    }
    if metadata.len() > MAX_BYTES {
        return Err("critical_module_coverage_reference_too_large".to_owned());
    }
    let bytes =
        fs::read(path).map_err(|_| "critical_module_coverage_reference_read_failed".to_owned())?;
    let after = fs::symlink_metadata(path)
        .map_err(|_| "critical_module_coverage_reference_changed".to_owned())?;
    if after.len() != metadata.len()
        || after.file_type().is_symlink()
        || after.dev() != metadata.dev()
        || after.ino() != metadata.ino()
        || after.nlink() != metadata.nlink()
        || after.mode() != metadata.mode()
        || after.mtime() != metadata.mtime()
        || after.mtime_nsec() != metadata.mtime_nsec()
    {
        return Err("critical_module_coverage_reference_changed".to_owned());
    }
    Ok(bytes)
}

fn inventory_from_policy_source(source: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(source);
    let mut entries = BTreeMap::<String, bool>::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find("target('") {
        let start = cursor + offset + "target('".len();
        let Some(end) = text[start..].find("'") else {
            break;
        };
        let path = &text[start..start + end];
        let tail_start = start + end;
        let tail_end = text[tail_start..]
            .find(')')
            .map_or(tail_start, |value| tail_start + value);
        let trust = text[tail_start..tail_end].contains(", true");
        if path.ends_with(".mjs")
            && !path.starts_with('/')
            && !path.split('/').any(|part| part == "..")
        {
            entries
                .entry(path.to_owned())
                .and_modify(|value| *value |= trust)
                .or_insert(trust);
        }
        cursor = tail_start.saturating_add(1);
        if cursor >= text.len() {
            break;
        }
    }
    entries
        .into_iter()
        .map(|(path, trust_boundary)| json!({"path": path, "trustBoundary": trust_boundary}))
        .collect()
}

fn inspect_evidence(path: Option<&Path>, expected_hash: Option<&str>, targets: &[Value]) -> Value {
    let Some(path) = path else {
        return json!({
            "provided": false,
            "path": Value::Null,
            "valid": false,
            "signatureVerified": false,
            "status": "missing",
        });
    };
    let bytes = read_regular(path).ok();
    let observed = bytes.as_deref().map(digest);
    let hash_matches =
        expected_hash.is_some_and(valid_sha256) && observed.as_deref() == expected_hash;
    let parsed = bytes
        .as_deref()
        .and_then(|value| serde_json::from_slice::<Value>(value).ok());
    let shape_valid = parsed.as_ref().is_some_and(|value| {
        value["kind"] == "CriticalModuleCoverageReport"
            && value["ok"].is_boolean()
            && value["modules"].is_array()
            && value["failures"].is_array()
    });
    let expected_paths = targets
        .iter()
        .filter_map(|entry| entry["path"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let module_paths = parsed
        .as_ref()
        .and_then(|value| value["modules"].as_array())
        .map(|modules| {
            modules
                .iter()
                .filter_map(|entry| entry["relative"].as_str())
                .collect::<std::collections::BTreeSet<_>>()
        });
    let target_inventory_matches = module_paths
        .as_ref()
        .is_some_and(|paths| expected_paths.is_subset(paths));
    let report_ok = parsed.as_ref().is_some_and(|value| value["ok"] == true)
        && parsed
            .as_ref()
            .and_then(|value| value["failures"].as_array())
            .is_some_and(Vec::is_empty);
    let valid = hash_matches && shape_valid && target_inventory_matches && report_ok;
    json!({
        "provided": true,
        "path": path,
        "expectedSha256": expected_hash,
        "observedSha256": observed,
        "hashMatches": hash_matches,
        "shapeValid": shape_valid,
        "targetInventoryMatches": target_inventory_matches,
        "reportOk": report_ok,
        "signatureVerified": false,
        "valid": valid,
        "status": if valid { "unsigned_valid" } else { "invalid" },
    })
}

pub fn critical_module_coverage_help_json_v1() -> Value {
    serde_json::from_str(CRITICAL_MODULE_COVERAGE_USAGE).expect("static critical usage JSON")
}

pub fn inspect_critical_module_coverage_v1(
    options: &CriticalModuleCoverageOptions,
    workspace_root: &Path,
) -> Result<Value, String> {
    if !workspace_root.is_absolute() {
        return Err("critical_module_coverage_workspace_root_must_be_absolute".to_owned());
    }
    let root = options
        .root
        .clone()
        .unwrap_or_else(|| workspace_root.to_path_buf());
    let runtime_root = options
        .runtime_root
        .clone()
        .unwrap_or_else(|| workspace_root.join("runtime"));
    let policy_path = root.join("paper-core/verification/critical-module-coverage-policy.mjs");
    let source = read_regular(&policy_path).ok();
    let targets = source
        .as_deref()
        .map(inventory_from_policy_source)
        .unwrap_or_default();
    let evidence = inspect_evidence(
        options.evidence.as_deref(),
        options.evidence_sha256.as_deref(),
        &targets,
    );
    let mut blockers = vec![
        "critical_module_coverage_node_execution_not_ported".to_owned(),
        "critical_module_coverage_node_evidence_signature_verification_not_ported".to_owned(),
    ];
    if source.is_none() {
        blockers.push("critical_module_coverage_target_registry_source_missing".to_owned());
    } else if targets.is_empty() {
        blockers.push("critical_module_coverage_target_registry_empty".to_owned());
    }
    if evidence["provided"] != true {
        blockers.push("critical_module_coverage_node_evidence_required".to_owned());
    } else if evidence["valid"] != true {
        blockers.push("critical_module_coverage_node_evidence_invalid".to_owned());
    }
    blockers.sort();
    blockers.dedup();
    Ok(json!({
        "version": 1,
        "kind": "CriticalModuleCoveragePreflightReport",
        "status": "critical_module_coverage_blocked",
        "ok": false,
        "ready": false,
        "root": root,
        "runtimeRoot": runtime_root,
        "targetRegistry": {
            "path": policy_path,
            "sourceSha256": source.as_deref().map(digest),
            "targets": targets,
            "targetCount": targets.len(),
        },
        "nodeEvidence": evidence,
        "nodeExecutionPerformed": false,
        "externalActionPerformed": false,
        "serviceStateChanged": false,
        "blockers": blockers,
        "rustBoundary": "read-only-static-inventory-and-pinned-evidence-inspection",
    }))
}

pub fn execute_critical_module_coverage_v1(
    options: &CriticalModuleCoverageOptions,
    workspace_root: &Path,
) -> Result<Value, String> {
    inspect_critical_module_coverage_v1(options, workspace_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_rejects_unpaired_evidence_and_relative_roots() {
        assert!(
            parse_critical_module_coverage_arguments(&[
                "--evidence".into(),
                "/tmp/evidence.json".into(),
            ])
            .is_err()
        );
        assert!(
            parse_critical_module_coverage_arguments(&["--root".into(), "relative".into(),])
                .is_err()
        );
    }

    #[test]
    fn missing_node_evidence_is_explicitly_blocked() {
        let report = inspect_critical_module_coverage_v1(
            &CriticalModuleCoverageOptions::default(),
            Path::new("/tmp/workspace"),
        )
        .unwrap();
        assert_eq!(report["ok"], false);
        assert!(
            report["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "critical_module_coverage_node_evidence_required")
        );
    }

    #[test]
    fn inventory_extracts_trust_targets_without_claiming_coverage() {
        let inventory = inventory_from_policy_source(b"target('a.mjs'), target('b.mjs', true)");
        assert_eq!(inventory.len(), 2);
        assert_eq!(inventory[1]["trustBoundary"], true);
    }
}
