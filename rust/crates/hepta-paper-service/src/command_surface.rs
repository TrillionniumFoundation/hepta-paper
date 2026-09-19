//! Rust port of the local `command-surface.mjs --write-package` maintenance path.
//!
//! The operator routes themselves remain external workflows. This module only
//! owns the deterministic package-script synchronization step and never runs a
//! route or invokes Node.

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value, json};
use std::fmt;
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

#[derive(Clone, Debug)]
enum OrderedJson {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

struct OrderedJsonVisitor;

impl<'de> Visitor<'de> for OrderedJsonVisitor {
    type Value = OrderedJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(OrderedJson::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(OrderedJson::Number(Number::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(OrderedJson::Number(Number::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(OrderedJson::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(OrderedJson::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(OrderedJson::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(OrderedJson::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(OrderedJson::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }

    fn visit_seq<A>(self, mut access: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = access.next_element()? {
            values.push(value);
        }
        Ok(OrderedJson::Array(values))
    }

    fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut entries = Vec::new();
        while let Some(key) = access.next_key::<String>()? {
            let value = access.next_value()?;
            if let Some((_, existing)) = entries.iter_mut().find(|(name, _)| name == &key) {
                *existing = value;
            } else {
                entries.push((key, value));
            }
        }
        Ok(OrderedJson::Object(entries))
    }
}

impl<'de> Deserialize<'de> for OrderedJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(OrderedJsonVisitor)
    }
}

impl OrderedJson {
    fn into_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(value),
            Self::Number(value) => Value::Number(value),
            Self::String(value) => Value::String(value),
            Self::Array(values) => Value::Array(values.into_iter().map(Self::into_value).collect()),
            Self::Object(entries) => Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, value.into_value()))
                    .collect(),
            ),
        }
    }

    fn scripts_for_node(&self) -> Result<Self, CommandSurfaceError> {
        let mut entries = match self {
            Self::Object(entries) => entries
                .iter()
                .filter(|(name, _)| !ROUTED_SCRIPTS.contains(&name.as_str()))
                .cloned()
                .collect(),
            Self::Null => Vec::new(),
            _ => return Err(CommandSurfaceError::InvalidPackage),
        };
        entries.extend(
            RETAINED_ALIASES
                .iter()
                .map(|(name, command)| ((*name).to_owned(), Self::String((*command).to_owned()))),
        );
        Ok(Self::Object(entries))
    }
}

fn write_ordered_json_pretty(
    value: &OrderedJson,
    output: &mut String,
    depth: usize,
) -> Result<(), CommandSurfaceError> {
    match value {
        OrderedJson::Null => output.push_str("null"),
        OrderedJson::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        OrderedJson::Number(value) => output.push_str(&value.to_string()),
        OrderedJson::String(value) => {
            output.push_str(&serde_json::to_string(value).map_err(CommandSurfaceError::Json)?);
        }
        OrderedJson::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index == 0 {
                    output.push('\n');
                } else {
                    output.push_str(",\n");
                }
                output.push_str(&"  ".repeat(depth + 1));
                write_ordered_json_pretty(value, output, depth + 1)?;
            }
            if !values.is_empty() {
                output.push('\n');
                output.push_str(&"  ".repeat(depth));
            }
            output.push(']');
        }
        OrderedJson::Object(entries) => {
            output.push('{');
            for (index, (key, value)) in entries.iter().enumerate() {
                if index == 0 {
                    output.push('\n');
                } else {
                    output.push_str(",\n");
                }
                output.push_str(&"  ".repeat(depth + 1));
                output.push_str(&serde_json::to_string(key).map_err(CommandSurfaceError::Json)?);
                output.push_str(": ");
                write_ordered_json_pretty(value, output, depth + 1)?;
            }
            if !entries.is_empty() {
                output.push('\n');
                output.push_str(&"  ".repeat(depth));
            }
            output.push('}');
        }
    }
    Ok(())
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

fn javascript_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn inspection(package: &Value) -> Result<Value, CommandSurfaceError> {
    let script_map = scripts(package)?;
    let aliases = generated_aliases();
    let mismatches: Vec<Value> = RETAINED_ALIASES
        .iter()
        .filter(|(name, expected)| script_map.get(*name).and_then(Value::as_str) != Some(*expected))
        .map(|(name, expected)| {
            let actual = script_map
                .get(*name)
                .filter(|value| javascript_truthy(value))
                .cloned()
                .unwrap_or(Value::Null);
            json!({
                "name": name,
                "expected": expected,
                "actual": actual,
            })
        })
        .collect();
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
        let mut ordered: OrderedJson = serde_json::from_slice(&fs::read(&path)?)?;
        let scripts = match &ordered {
            OrderedJson::Object(entries) => entries
                .iter()
                .find(|(name, _)| name == "scripts")
                .map(|(_, value)| value)
                .cloned()
                .unwrap_or(OrderedJson::Null),
            _ => return Err(CommandSurfaceError::InvalidPackage),
        };
        let replacement = scripts.scripts_for_node()?;
        if let OrderedJson::Object(entries) = &mut ordered {
            if let Some((_, value)) = entries.iter_mut().find(|(name, _)| name == "scripts") {
                *value = replacement;
            } else {
                entries.push(("scripts".to_owned(), replacement));
            }
        }
        let mut bytes = String::new();
        write_ordered_json_pretty(&ordered, &mut bytes, 0)?;
        bytes.push('\n');
        fs::write(&path, bytes.as_bytes())?;
        package = ordered.into_value();
    }
    inspection(&package)
}

/// Serialize the inspection with the same insertion order as Node's
/// JSON.stringify. serde_json::Map is intentionally sorted in this workspace,
/// so the CLI uses this ordered serializer for byte-compatible output while
/// the library API continues to return Value.
pub fn synchronize_command_surface_json_v1(
    root: &Path,
    write_package: bool,
) -> Result<String, CommandSurfaceError> {
    let value = synchronize_command_surface_v1(root, write_package)?;
    let encode = |value: &Value| serde_json::to_string(value).map_err(CommandSurfaceError::Json);
    let mut output = String::from(r#"{"version":2,"kind":"NpmScriptRegistryInspection","ready":"#);
    output.push_str(&encode(&value["ready"])?);
    output.push_str(r#","generatedAliases":{"#);
    for (index, (name, command)) in RETAINED_ALIASES.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&encode(&Value::String((*name).to_owned()))?);
        output.push(':');
        output.push_str(&encode(&Value::String((*command).to_owned()))?);
    }
    output.push_str(r#"},"aliasMismatches":["#);
    if let Some(mismatches) = value["aliasMismatches"].as_array() {
        for (index, mismatch) in mismatches.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            output.push_str("{\"name\":");
            output.push_str(&encode(&mismatch["name"])?);
            output.push_str(",\"expected\":");
            output.push_str(&encode(&mismatch["expected"])?);
            output.push_str(",\"actual\":");
            output.push_str(&encode(&mismatch["actual"])?);
            output.push('}');
        }
    }
    output.push_str(r#"],"retiredAliases":"#);
    output.push_str(&encode(&value["retiredAliases"])?);
    output.push_str(r#","blocked":"#);
    output.push_str(&encode(&value["blocked"])?);
    output.push('}');
    Ok(output)
}
