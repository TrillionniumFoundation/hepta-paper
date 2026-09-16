//! Rust port of the local `command-surface.mjs --write-package` maintenance path.
//!
//! The operator routes themselves remain external workflows. This module only
//! owns the deterministic package-script synchronization step and never runs a
//! route or invokes Node.

use serde_json::{Map, Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
use thiserror::Error;

const ROUTED_SCRIPTS: &[&str] = &[
    "workspace:status",
    "store:status",
    "store:migrate",
    "store:backup",
    "automation:status",
    "automation:external-authority-intake",
    "automation:capability-matrix",
    "gpu:personal-gate",
    "personal:readiness",
    "automation:journal-connector-coverage",
    "automation:portal-target-qualification",
    "automation:generic-domain-capability-evidence",
    "automation:autonomous-research-supervisor-health",
    "automation:nested-runtime-platform-qualification",
    "automation:autonomous-research-intake-authority-rotation",
    "automation:autonomous-research-state-backup",
    "automation:runtime-reproducibility",
    "automation:runtime-r-source-cas",
    "automation:research-status",
    "automation:autonomous-research-readiness",
    "automation:autonomous-research-one-shot-campaign-attempt",
    "automation:local-golden-dataset-provision",
    "automation:strict-full-auto-acceptance",
    "automation:autonomous-empirical-plugin-release",
    "automation:advanced-numerical-plugin",
    "automation:autonomous-submission-dispatcher",
    "automation:autonomous-submission-dispatcher-challenge",
    "automation:autonomous-research-supervisor",
    "automation:reconcile",
    "automation:reconcile:execute",
    "paper:campaign",
    "paper:batch",
    "paper:submission-handoff",
    "automation:autonomous-research-state-provision",
    "automation:autonomous-research-state-partial-root-maintenance",
    "automation:autonomous-research-online-schema-transition",
    "scripts:sync",
    "paper:architecture-selftest",
    "coverage:critical-modules",
    "store:logical-integrity",
    "assets:repository-status",
    "automation:full-production-status",
    "paper:submission-handoff-export",
    "release:verify",
    "release:trust-gate",
    "operational:status",
    "owner:status",
    "release:attest",
    "release:key",
    "test",
    "migration:retirement-status",
    "legacy:reference-verify",
    "migration:capability-matrix-v3",
    "legacy:deletion-drill",
];

/// The retained aliases are ordered as the JavaScript route registry emits them.
const RETAINED_ALIASES: &[(&str, &str)] = &[
    (
        "gpu:personal-gate",
        "node paper-core/bin/personal-gpu-operational-gate.mjs",
    ),
    (
        "personal:readiness",
        "node paper-core/bin/personal-self-hosted-readiness.mjs",
    ),
    (
        "coverage:critical-modules",
        "node paper-core/bin/run-isolated-command.mjs node paper-core/bin/critical-module-coverage.mjs",
    ),
    (
        "store:logical-integrity",
        "node paper-core/bin/hepta-store-logical-integrity.mjs",
    ),
    (
        "release:verify",
        "npm run static:check && npm run security:source-gate -- --deployment-profile=systemd-host && npm run security:npm-audit && npm run release:state-check -- --require-state release_ready && node paper-core/bin/run-isolated-verification.mjs release",
    ),
    (
        "release:trust-gate",
        "node paper-core/bin/release-trust-gate.mjs",
    ),
    (
        "test",
        "npm run static:check && node paper-core/bin/run-isolated-verification.mjs test",
    ),
    (
        "migration:retirement-status",
        "npm run legacy:reference-verify && npm run migration:matrix-integrity",
    ),
    (
        "legacy:reference-verify",
        "node migration/bin/verify-retirement-source-snapshot.mjs",
    ),
    (
        "migration:capability-matrix-v3",
        "node paper-core/bin/run-isolated-command.mjs sh -lc 'node migration/bin/verify-capabilities.mjs && node migration/tests/capability-matrix-v3.mjs --release-profile'",
    ),
    (
        "legacy:deletion-drill",
        "node paper-core/bin/legacy-deletion-drill.mjs",
    ),
];

#[derive(Debug, Error)]
pub enum CommandSurfaceError {
    #[error("package.json is invalid or missing scripts")]
    InvalidPackage,
    #[error("package.json filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("package.json JSON is invalid")]
    Json(#[from] serde_json::Error),
}

fn package_path(root: &Path) -> PathBuf {
    root.join("package.json")
}

fn scripts(package: &Value) -> Result<&Map<String, Value>, CommandSurfaceError> {
    package
        .get("scripts")
        .and_then(Value::as_object)
        .ok_or(CommandSurfaceError::InvalidPackage)
}

fn generated_aliases() -> Map<String, Value> {
    RETAINED_ALIASES
        .iter()
        .map(|(name, command)| ((*name).to_owned(), Value::String((*command).to_owned())))
        .collect()
}

fn inspection(package: &Value) -> Result<Value, CommandSurfaceError> {
    let script_map = scripts(package)?;
    let aliases = generated_aliases();
    let mismatches: Vec<Value> = RETAINED_ALIASES.iter().filter(|(name, expected)| {
        script_map.get(*name).and_then(Value::as_str) != Some(*expected)
    }).map(|(name, expected)| json!({
            "name": name, "expected": expected, "actual": script_map.get(*name).and_then(Value::as_str),
        })).collect();
    let mut retired: Vec<String> = ROUTED_SCRIPTS
        .iter()
        .filter(|name| {
            !RETAINED_ALIASES.iter().any(|(kept, _)| *kept == **name)
                && script_map.contains_key(**name)
        })
        .map(|name| (*name).to_owned())
        .collect();
    retired.sort();
    // The registry classifies unregistered scripts as internal and blocks them.
    // This port preserves the check for the package synchronization path by
    // treating only route aliases and ordinary npm lifecycle/support scripts as
    // registered; unknown entries remain visible and fail closed.
    // Historical npm identifiers are data, never executable dependencies.
    let known: Vec<&str> =
        serde_json::from_str(include_str!("data/legacy-command-script-registry.v1.json"))?;
    let mut blocked: Vec<String> = script_map
        .keys()
        .filter(|name| {
            !ROUTED_SCRIPTS.contains(&name.as_str())
                && !known.contains(&name.as_str())
                && !aliases.contains_key(*name)
        })
        .cloned()
        .collect();
    blocked.sort();
    Ok(json!({
        "version": 2,
        "kind": "NpmScriptRegistryInspection",
        "ready": mismatches.is_empty() && retired.is_empty() && blocked.is_empty(),
        "generatedAliases": aliases,
        "aliasMismatches": mismatches,
        "retiredAliases": retired,
        "blocked": blocked,
    }))
}

/// Inspect or synchronize the package script registry. `write_package` mirrors
/// the Node `--write-package` mutation; false is read-only.
pub fn synchronize_command_surface_v1(
    root: &Path,
    write_package: bool,
) -> Result<Value, CommandSurfaceError> {
    let path = package_path(root);
    let mut package: Value = serde_json::from_slice(&fs::read(&path)?)?;
    if write_package {
        let scripts = package
            .get_mut("scripts")
            .and_then(Value::as_object_mut)
            .ok_or(CommandSurfaceError::InvalidPackage)?;
        for name in ROUTED_SCRIPTS {
            scripts.remove(*name);
        }
        for (name, command) in RETAINED_ALIASES {
            scripts.insert((*name).to_owned(), Value::String((*command).to_owned()));
        }
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&package)?),
        )?;
    }
    inspection(&package)
}
