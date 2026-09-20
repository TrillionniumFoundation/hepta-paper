//! Rust port of the local `command-surface.mjs` deterministic metadata paths.
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

// The CI matrix is deliberately kept as data.  It has no runtime authority or
// side effects; the command-surface CLI only reports the matrix owned by the
// checked-in command registry.
const CI_COMMAND_MATRIX_JSON: &str = r#"{"pullRequest":[{"id":"static-contracts","npmScripts":["static:check","security:npm-audit"]},{"id":"impacted-tests","npmScripts":["test:impacted"],"shardCount":4,"targetDurationMinutes":5}],"nightly":[{"id":"full-portable","npmScripts":["security:npm-audit","ci:selftest","coverage:architecture","coverage:repository"]},{"id":"formal-cache","npmScripts":["ci:mathlib-cache"]},{"id":"academic-empirical","npmScripts":["test:academic-docker-operational"]},{"id":"typed-numeric","npmScripts":["test:typed-numeric-process-operational"]},{"id":"dynamic-formal","npmScripts":["test:dynamic-formal-kernel-operational"]}]}"#;

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

fn validate_package_root(root: &Path) -> Result<(), CommandSurfaceError> {
    let _: Value = serde_json::from_slice(&fs::read(package_path(root))?)?;
    Ok(())
}

#[derive(Clone, Debug)]
enum OrderedJson {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    /// A JavaScript string's enumerable properties are UTF-16 code units.
    /// Lone surrogate units cannot be represented by Rust's `String`, so the
    /// writer retains them until JSON serialization and emits `\uXXXX`.
    Utf16Unit(u16),
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
            Self::Utf16Unit(value) => Value::String(String::from_utf16_lossy(&[value])),
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
        // `command-surface.mjs` intentionally relies on JavaScript's object
        // spread/Object.entries coercion here.  A malformed `scripts` value
        // (for example an array or string) therefore contributes its own
        // enumerable properties instead of causing a Rust-only parse error.
        // Keep that fail-closed package rewrite behavior byte-compatible with
        // the incumbent before appending the generated aliases.
        let mut entries: Vec<(String, Self)> = javascript_ordered_entries_for_ordered(self)
            .into_iter()
            .filter(|(name, _)| !ROUTED_SCRIPTS.contains(&name.as_str()))
            .collect();
        entries.extend(
            RETAINED_ALIASES
                .iter()
                .map(|(name, command)| ((*name).to_owned(), Self::String((*command).to_owned()))),
        );
        Ok(Self::Object(entries))
    }
}

fn javascript_array_index(name: &str) -> Option<usize> {
    // Object.keys/Object.entries enumerate canonical array indexes first. The
    // 2^32-1 sentinel is intentionally excluded, matching ECMAScript's
    // array-index definition.
    if name == "0" {
        return Some(0);
    }
    if name.is_empty() || name.starts_with('0') || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = name.parse::<u64>().ok()?;
    (value < u32::MAX as u64).then_some(value as usize)
}

fn javascript_ordered_entries(entries: &[(String, OrderedJson)]) -> Vec<(String, OrderedJson)> {
    let mut indexed = Vec::new();
    let mut ordinary = Vec::new();
    for (name, value) in entries {
        if let Some(index) = javascript_array_index(name) {
            indexed.push((index, name.clone(), value.clone()));
        } else {
            ordinary.push((name.clone(), value.clone()));
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, name, value)| (name, value))
        .chain(ordinary)
        .collect()
}

fn javascript_ordered_entries_for_ordered(value: &OrderedJson) -> Vec<(String, OrderedJson)> {
    match value {
        OrderedJson::Object(entries) => javascript_ordered_entries(entries),
        OrderedJson::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        OrderedJson::String(value) => value
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| (index.to_string(), OrderedJson::Utf16Unit(unit)))
            .collect(),
        OrderedJson::Null
        | OrderedJson::Bool(_)
        | OrderedJson::Number(_)
        | OrderedJson::Utf16Unit(_) => Vec::new(),
    }
}

fn javascript_ordered_entries_from_value(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(entries)) => entries
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect(),
        Some(Value::Array(values)) => values
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        Some(Value::String(value)) => value
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                // Alias/retired names are never numeric, but keeping the
                // UTF-16 key count matches Object.keys for string values.
                // Valid scalar units remain lossless; lone surrogates are
                // represented by replacement characters in the in-memory
                // diagnostic (JSON.stringify still escapes them on Node).
                (
                    index.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn javascript_scripts_value(package: &Value) -> Option<&Value> {
    package
        .get("scripts")
        .filter(|value| javascript_truthy(value))
}

fn javascript_script_keys(value: Option<&Value>) -> Vec<String> {
    javascript_ordered_entries_from_value(value)
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

fn javascript_script_property(value: Option<&Value>, name: &str) -> Option<Value> {
    match value {
        Some(Value::Object(entries)) => entries.get(name).cloned(),
        Some(Value::Array(entries)) => {
            javascript_array_index(name).and_then(|index| entries.get(index).cloned())
        }
        Some(Value::String(text)) => javascript_array_index(name).and_then(|index| {
            text.encode_utf16()
                .nth(index)
                .map(|unit| Value::String(String::from_utf16_lossy(&[unit])))
        }),
        _ => None,
    }
}

fn javascript_script_has_own(value: Option<&Value>, name: &str) -> bool {
    match value {
        Some(Value::Object(entries)) => entries.contains_key(name),
        Some(Value::Array(entries)) => {
            javascript_array_index(name).is_some_and(|index| index < entries.len())
        }
        Some(Value::String(text)) => {
            javascript_array_index(name).is_some_and(|index| index < text.encode_utf16().count())
        }
        _ => false,
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
        OrderedJson::Number(value) => {
            let number = value.as_f64().ok_or(CommandSurfaceError::InvalidPackage)?;
            let mut buffer = ryu_js::Buffer::new();
            output.push_str(buffer.format(number));
        }
        OrderedJson::String(value) => {
            output.push_str(&serde_json::to_string(value).map_err(CommandSurfaceError::Json)?);
        }
        OrderedJson::Utf16Unit(value) => {
            if (0xd800..=0xdfff).contains(value) {
                output.push_str(&format!(r#""\u{value:04x}""#));
            } else {
                let scalar = char::from_u32(*value as u32)
                    .ok_or(CommandSurfaceError::InvalidPackage)?
                    .to_string();
                output
                    .push_str(&serde_json::to_string(&scalar).map_err(CommandSurfaceError::Json)?);
            }
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
            let entries = javascript_ordered_entries(entries);
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

fn generated_aliases() -> Map<String, Value> {
    RETAINED_ALIASES
        .iter()
        .map(|(name, command)| ((*name).to_owned(), Value::String((*command).to_owned())))
        .collect()
}

/// Return the retained npm aliases in the exact insertion order emitted by
/// `generatedNpmRouteScripts()` in the Node command registry.
pub fn generated_npm_route_scripts_json_v1(root: &Path) -> Result<String, CommandSurfaceError> {
    validate_package_root(root)?;
    let mut output = String::from("{");
    for (index, (name, command)) in RETAINED_ALIASES.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&serde_json::to_string(name).map_err(CommandSurfaceError::Json)?);
        output.push(':');
        output.push_str(&serde_json::to_string(command).map_err(CommandSurfaceError::Json)?);
    }
    output.push('}');
    Ok(output)
}

/// Return the static CI command matrix in the exact key/array order emitted by
/// `heptaPaperCiCommandMatrix()`.
pub fn ci_command_matrix_json_v1(root: &Path) -> Result<String, CommandSurfaceError> {
    validate_package_root(root)?;
    // Parse once so the embedded contract cannot silently become invalid JSON.
    let _: Value = serde_json::from_str(CI_COMMAND_MATRIX_JSON)?;
    Ok(CI_COMMAND_MATRIX_JSON.to_owned())
}

/// Classify the package script names using the checked-in command-registry
/// classification generated from `command-registry-catalog.mjs`.
///
/// This is deliberately a projection only: it does not execute a script or
/// turn an unregistered name into an operator capability.  The output key and
/// array order match `classifyNpmScriptSurface` exactly.
pub fn classify_npm_script_surface_json_v1(root: &Path) -> Result<String, CommandSurfaceError> {
    let package: Value = serde_json::from_slice(&fs::read(package_path(root))?)?;
    let script_names = javascript_script_keys(javascript_scripts_value(&package));
    let classification: std::collections::BTreeMap<String, String> = serde_json::from_str(
        include_str!("data/command-surface-npm-classification.v1.json"),
    )?;
    let mut names = script_names;
    // JavaScript's default Array#sort compares UTF-16 code units.  Sorting the
    // encoded keys keeps the projection byte-compatible for non-BMP names too.
    names.sort_by(|left, right| {
        left.encode_utf16()
            .cmp(right.encode_utf16())
            .then_with(|| left.cmp(right))
    });
    let groups = [
        "operator",
        "verification",
        "maintenance",
        "retirement",
        "compatibility",
        "experimental",
        "internal",
    ];
    let mut grouped = std::collections::BTreeMap::<&str, Vec<&str>>::new();
    for group in groups {
        grouped.insert(group, Vec::new());
    }
    let mut blocked = Vec::new();
    for name in &names {
        let group = classification.get(name).map(String::as_str);
        if group.is_none() {
            blocked.push(name.as_str());
        }
        let group = group.unwrap_or("internal");
        grouped.entry(group).or_default().push(name.as_str());
    }
    let encode = |value: &Value| serde_json::to_string(value).map_err(CommandSurfaceError::Json);
    let mut output = String::from(
        r#"{"version":4,"kind":"NpmCommandSurface","policy":"unregistered scripts default to internal and are blocked from the supported operator surface","groups":{"#,
    );
    for (index, group) in groups.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&encode(&Value::String((*group).to_owned()))?);
        output.push(':');
        let values = grouped
            .get(group)
            .ok_or(CommandSurfaceError::InvalidPackage)?;
        output.push('[');
        for (name_index, name) in values.iter().enumerate() {
            if name_index > 0 {
                output.push(',');
            }
            output.push_str(&encode(&Value::String((*name).to_owned()))?);
        }
        output.push(']');
    }
    output.push_str("},\"blocked\":[");
    for (index, name) in blocked.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&encode(&Value::String((*name).to_owned()))?);
    }
    output.push_str("]}");
    Ok(output)
}

/// Return the checked-in command-registry help artifact.  It is generated from
/// `heptaPaperCommandUsage()` and is read-only metadata, so no Node process is
/// needed at runtime.
pub fn command_usage_json_v1(root: &Path) -> Result<String, CommandSurfaceError> {
    validate_package_root(root)?;
    Ok(include_str!("data/command-surface-usage.v1.json")
        .trim_end_matches('\n')
        .to_owned())
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
    let script_value = javascript_scripts_value(package);
    let aliases = generated_aliases();
    let mismatches: Vec<Value> = RETAINED_ALIASES
        .iter()
        .filter(|(name, expected)| {
            javascript_script_property(script_value, name)
                .and_then(|value| value.as_str().map(str::to_owned))
                .as_deref()
                != Some(*expected)
        })
        .map(|(name, expected)| {
            let actual = javascript_script_property(script_value, name)
                .filter(javascript_truthy)
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
                && javascript_script_has_own(script_value, name)
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
    let mut blocked: Vec<String> = javascript_script_keys(script_value)
        .into_iter()
        .filter(|name| {
            !ROUTED_SCRIPTS.contains(&name.as_str())
                && !known.contains(&name.as_str())
                && !aliases.contains_key(name)
        })
        .collect();
    // `Array#sort()` in the Node registry compares UTF-16 code units.  The
    // distinction is observable when an astral key is compared with a BMP
    // key above U+D7FF, so keep blocked diagnostics on the same ordering.
    blocked.sort_by(|left, right| {
        left.encode_utf16()
            .cmp(right.encode_utf16())
            .then_with(|| left.cmp(right))
    });
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
