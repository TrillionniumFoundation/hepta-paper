//! Native static architecture-boundary conformance inspection.
//!
//! The incumbent command is a Node test file.  This module intentionally does
//! not execute Node or evaluate JavaScript.  It reads the declared entrypoint
//! manifest, resolves the same bounded relative-module candidates, and checks
//! the source/layer invariants that make the production graph safe to retire.
//! The result is diagnostic only; a ready report is not a production or
//! retirement authorization.

use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};
use thiserror::Error;

const CATEGORIES: &[&str] = &[
    "production",
    "compatibility",
    "experimental",
    "verification",
    "maintenance",
    "migrationSupport",
];

const RETIRED_DIRECT_WORKFLOW: &[&str] = &[
    "workflow-kernel/workflow.mjs",
    "paper-application/workflow/workflow-engine.mjs",
    "paper-application/workflow/typed-stage-pipeline.mjs",
    "paper-application/use-cases/paper-stage-handlers.mjs",
    "paper-application/use-cases/local-diagnostic-review-loop.mjs",
    "paper-application/use-cases/local-diagnostic-round-executor.mjs",
    "paper-core/src/workflow-engine.mjs",
];

const RESEARCH_ENTRYPOINTS: &[&str] = &[
    "paper-composition/automation/autonomous-research-campaign-composition.mjs",
    "paper-composition/automation/autonomous-research-supervisor-composition.mjs",
    "paper-composition/automation/autonomous-research-machine-intake-enqueue-composition.mjs",
    "paper-composition/automation/autonomous-research-readiness-composition.mjs",
];

const DISPATCHER_ENTRYPOINTS: &[&str] = &["paper-core/bin/autonomous-submission-dispatcher.mjs"];

const NETWORK_ADAPTER: &str =
    "paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs";
const DISPATCHER_SERVICES: &str =
    "paper-composition/automation/autonomous-submission-dispatcher-services-composition.mjs";
const DISPATCHER_CYCLE_SIGNER: &str =
    "paper-adapters/automation/autonomous-submission-dispatcher-cycle-signer.mjs";

#[derive(Debug, Error)]
pub enum ArchitectureConformanceError {
    #[error("architecture workspace root is not a directory")]
    RootInvalid,
    #[error("architecture source file read failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("architecture JSON document is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("architecture manifest invariant is invalid: {0}")]
    ManifestInvariant(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchitectureConformanceModeV1 {
    /// Run all checks whose inputs are present and report their blockers.
    Strict,
}

#[derive(Clone, Debug)]
struct GraphReport {
    entrypoints: Vec<String>,
    modules: BTreeSet<String>,
    dependencies: BTreeMap<String, BTreeSet<String>>,
    invalid_entrypoints: BTreeSet<String>,
    missing_entrypoints: BTreeSet<String>,
    escaped_paths: BTreeSet<String>,
    unreadable_modules: BTreeSet<String>,
    unresolved_imports: Vec<Value>,
}

impl GraphReport {
    fn new() -> Self {
        Self {
            entrypoints: Vec::new(),
            modules: BTreeSet::new(),
            dependencies: BTreeMap::new(),
            invalid_entrypoints: BTreeSet::new(),
            missing_entrypoints: BTreeSet::new(),
            escaped_paths: BTreeSet::new(),
            unreadable_modules: BTreeSet::new(),
            unresolved_imports: Vec::new(),
        }
    }

    fn blocked(&self) -> bool {
        !self.invalid_entrypoints.is_empty()
            || !self.missing_entrypoints.is_empty()
            || !self.escaped_paths.is_empty()
            || !self.unreadable_modules.is_empty()
            || !self.unresolved_imports.is_empty()
    }

    fn to_json(&self) -> Value {
        json!({
            "entrypoints": self.entrypoints,
            "modules": self.modules,
            "moduleCount": self.modules.len(),
            "dependencies": self.dependencies,
            "invalidEntrypoints": self.invalid_entrypoints,
            "missingEntrypoints": self.missing_entrypoints,
            "escapedPaths": self.escaped_paths,
            "unreadableModules": self.unreadable_modules,
            "unresolvedImports": self.unresolved_imports,
        })
    }
}

fn posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn relative(root: &Path, path: &Path) -> String {
    posix(path.strip_prefix(root).unwrap_or(path))
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.strip_prefix(root).map(|_| true).unwrap_or(false)
}

/// Normalize a path lexically before checking the workspace boundary.
///
/// `Path::absolute` preserves `..` components.  Checking that spelling with
/// `strip_prefix` would therefore accept a not-yet-existing path such as
/// `<root>/entry/../../../outside`; an attacker could use that to turn an
/// escaped import into an ordinary unresolved import.  Keep the check purely
/// lexical (the target may not exist yet), but reject attempts to walk above
/// the absolute root before the canonical symlink check below.
fn normalize_lexical(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    Some(normalized)
}

fn normalize_entry(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.starts_with('/') || raw.contains('\0') {
        return None;
    }
    let path = Path::new(raw);
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(posix(path).trim_start_matches("./").to_owned())
}

fn resolve_import(root: &Path, importer: &Path, specifier: &str) -> (Option<PathBuf>, bool) {
    let lexical = importer.parent().unwrap_or(importer).join(specifier);
    let Some(lexical) = normalize_lexical(&std::path::absolute(&lexical).unwrap_or(lexical)) else {
        return (None, true);
    };
    let candidates = [
        lexical.clone(),
        lexical.with_extension("mjs"),
        lexical.join("index.mjs"),
    ];
    for candidate in candidates {
        let absolute = normalize_lexical(&candidate).unwrap_or(candidate);
        if !is_within(root, &absolute) {
            return (None, true);
        }
        if absolute.is_file() {
            let canonical = absolute.canonicalize().unwrap_or(absolute);
            if !is_within(root, &canonical) {
                return (None, true);
            }
            return (Some(canonical), false);
        }
    }
    (None, false)
}

/// Extract relative `import`, `export … from`, and dynamic `import()` strings.
/// The scanner deliberately follows the incumbent tokenizer's bounded surface:
/// comments and template literals are skipped before looking for specifiers.
fn relative_module_specifiers(source: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if ch.is_whitespace() {
            index += 1;
            continue;
        }
        if ch == '/' && next == Some('/') {
            index += 2;
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if ch == '/' && next == Some('*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                index += 1;
            }
            index = (index + 2).min(chars.len());
            continue;
        }
        if ch == '\'' || ch == '"' {
            let quote = ch;
            let mut value = String::new();
            let mut escaped = false;
            index += 1;
            while index < chars.len() {
                let current = chars[index];
                if escaped {
                    value.push('\\');
                    value.push(current);
                    escaped = false;
                    index += 1;
                    continue;
                }
                if current == '\\' {
                    escaped = true;
                    index += 1;
                    continue;
                }
                if current == quote {
                    index += 1;
                    break;
                }
                value.push(current);
                index += 1;
            }
            tokens.push(("string", value));
            continue;
        }
        if ch == '`' {
            index += 1;
            let mut escaped = false;
            while index < chars.len() {
                let current = chars[index];
                if escaped {
                    escaped = false;
                } else if current == '\\' {
                    escaped = true;
                } else if current == '`' {
                    index += 1;
                    break;
                }
                index += 1;
            }
            tokens.push(("template", String::new()));
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' || ch == '$' {
            let start = index;
            index += 1;
            while index < chars.len()
                && (chars[index].is_ascii_alphanumeric()
                    || chars[index] == '_'
                    || chars[index] == '$')
            {
                index += 1;
            }
            tokens.push(("identifier", chars[start..index].iter().collect()));
            continue;
        }
        tokens.push(("punctuator", ch.to_string()));
        index += 1;
    }
    let mut found = BTreeSet::new();
    for (index, (kind, value)) in tokens.iter().enumerate() {
        if *kind != "identifier" || (value != "import" && value != "export") {
            continue;
        }
        if value == "import" {
            if let Some(("string", candidate)) = tokens.get(index + 1).map(|(k, v)| (*k, v)) {
                if candidate.starts_with('.') {
                    found.insert(candidate.clone());
                }
                continue;
            }
            if tokens.get(index + 1).map(|(_, v)| v.as_str()) == Some("(") {
                if let Some(("string", candidate)) = tokens.get(index + 2).map(|(k, v)| (*k, v))
                    && candidate.starts_with('.')
                    && tokens.get(index + 3).map(|(_, v)| v.as_str()) == Some(")")
                {
                    found.insert(candidate.clone());
                }
                continue;
            }
        }
        let mut cursor = index + 1;
        while cursor < tokens.len() {
            if tokens[cursor].1 == ";" {
                break;
            }
            if tokens[cursor].0 == "identifier"
                && (tokens[cursor].1 == "import" || tokens[cursor].1 == "export")
            {
                break;
            }
            if tokens[cursor].0 == "identifier" && tokens[cursor].1 == "from" {
                if let Some(("string", candidate)) = tokens.get(cursor + 1).map(|(k, v)| (*k, v))
                    && candidate.starts_with('.')
                {
                    found.insert(candidate.clone());
                }
                break;
            }
            cursor += 1;
        }
    }
    found.into_iter().collect()
}

fn extract_array(source: &str, key: &str) -> Option<Vec<String>> {
    let marker = format!("{key}: Object.freeze([");
    let start = source.find(&marker)? + marker.len();
    let chars: Vec<char> = source.chars().collect();
    let mut index = source[..start].chars().count();
    let mut depth = 1usize;
    let mut end = None;
    let mut quote = None;
    let mut escaped = false;
    while index < chars.len() {
        let ch = chars[index];
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == q {
                quote = None;
            }
            index += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch == '[' {
            depth += 1;
        } else if ch == ']' {
            depth -= 1;
            if depth == 0 {
                end = Some(index);
                break;
            }
        }
        index += 1;
    }
    let body = &chars[(source[..start].chars().count())..end?];
    let mut values = Vec::new();
    let mut cursor = 0;
    while cursor < body.len() {
        if body[cursor] == '\'' || body[cursor] == '"' {
            let quote = body[cursor];
            cursor += 1;
            let mut value = String::new();
            let mut escaped = false;
            while cursor < body.len() {
                let ch = body[cursor];
                cursor += 1;
                if escaped {
                    value.push(ch);
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == quote {
                    break;
                } else {
                    value.push(ch);
                }
            }
            if !value.is_empty() {
                values.push(value);
            }
        } else {
            cursor += 1;
        }
    }
    Some(values)
}

fn inspect_graph(root: &Path, raw_entries: &[String]) -> GraphReport {
    let mut report = GraphReport::new();
    let mut entries = BTreeSet::new();
    let mut pending = Vec::new();
    for raw in raw_entries {
        let Some(entry) = normalize_entry(raw) else {
            report.invalid_entrypoints.insert(raw.clone());
            continue;
        };
        entries.insert(entry.clone());
        let absolute = root.join(&entry);
        if !absolute.is_file() {
            report.missing_entrypoints.insert(entry);
        } else {
            pending.push(absolute);
        }
    }
    report.entrypoints = entries.into_iter().collect();
    let root = root.to_path_buf();
    while let Some(absolute) = pending.pop() {
        let relative_path = relative(&root, &absolute);
        if report.modules.contains(&relative_path) {
            continue;
        }
        let canonical = match absolute.canonicalize() {
            Ok(path) => path,
            Err(_) => {
                report.unreadable_modules.insert(relative_path);
                continue;
            }
        };
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        if !is_within(&canonical_root, &canonical) {
            report.escaped_paths.insert(relative_path);
            continue;
        }
        let source = match fs::read_to_string(&absolute) {
            Ok(value) => value,
            Err(_) => {
                report.unreadable_modules.insert(relative_path);
                continue;
            }
        };
        report.modules.insert(relative_path.clone());
        let mut dependencies = BTreeSet::new();
        for specifier in relative_module_specifiers(&source) {
            let (resolved, escaped) = resolve_import(&root, &absolute, &specifier);
            if escaped {
                report
                    .escaped_paths
                    .insert(format!("{relative_path}->{specifier}"));
            } else if let Some(resolved) = resolved {
                let dependency = relative(&root, &resolved);
                dependencies.insert(dependency.clone());
                pending.push(resolved);
            } else {
                report.unresolved_imports.push(json!({
                    "importer": relative_path,
                    "specifier": specifier,
                }));
            }
        }
        report.dependencies.insert(relative_path, dependencies);
    }
    report
        .unresolved_imports
        .sort_by_key(|left| left.to_string());
    report
}

fn array_json(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

fn scan_forbidden_source(
    root: &Path,
    modules: &BTreeSet<String>,
    patterns: &[(&str, &str)],
) -> Vec<Value> {
    let mut violations = Vec::new();
    for module in modules {
        let path = root.join(module);
        let Ok(source) = fs::read_to_string(&path) else {
            violations.push(json!({"path": module, "rule": "read_failed"}));
            continue;
        };
        for (rule, pattern) in patterns {
            if source.contains(pattern) {
                violations.push(json!({"path": module, "rule": rule}));
            }
        }
    }
    violations
}

fn collect_mjs_files(root: &Path, directory: &str) -> Vec<String> {
    fn walk(root: &Path, current: &Path, output: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                walk(root, &path, output);
            } else if kind.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("mjs")
            {
                output.push(relative(root, &path));
            }
        }
    }
    let mut files = Vec::new();
    walk(root, &root.join(directory), &mut files);
    files.sort();
    files
}

fn inspect_layer_sources(root: &Path) -> Vec<Value> {
    let roots = [
        "paper-core/src",
        "paper-application",
        "paper-composition",
        "paper-adapters",
        "paper-domain",
        "paper-ports",
        "workflow-kernel",
    ];
    let mut files = BTreeSet::new();
    for directory in roots {
        files.extend(collect_mjs_files(root, directory));
    }
    let production_files: BTreeSet<String> = files
        .iter()
        .filter(|path| {
            !path.ends_with("selftest.mjs")
                && !path.contains("/tests/")
                && !path.starts_with("paper-core/tests/")
        })
        .cloned()
        .collect();
    let mut violations = Vec::new();
    for path in &production_files {
        let Ok(source) = fs::read_to_string(root.join(path)) else {
            violations.push(json!({"path": path, "rule": "read_failed"}));
            continue;
        };
        let patterns = [
            ("sqlite3_process_primitive", "spawnSync('sqlite3"),
            ("sqlite3_process_primitive", "spawn('sqlite3"),
            ("sqlite3_process_primitive", "spawnSync(\"sqlite3"),
            ("sqlite3_process_primitive", "spawn(\"sqlite3"),
            (
                "autopilot_acceptance_receipt",
                "RefereeAutopilotAcceptanceReceipt",
            ),
            (
                "autopilot_acceptance_constant",
                "AUTOPILOT_ACCEPTANCE_RECEIPT",
            ),
            ("research_ready_shortcut", "researchReady"),
            ("paperctl_merge_queue", "./bin/paperctl merge-queue"),
            ("core_hash_facade", "../../core/src/hash-utils.mjs"),
        ];
        for (rule, pattern) in patterns {
            if source.contains(pattern) {
                violations.push(json!({"path": path, "rule": rule}));
            }
        }
        if path.starts_with("paper-domain/") {
            for (rule, pattern) in [
                ("domain_filesystem_import", "node:fs"),
                ("domain_path_import", "node:path"),
                ("domain_filesystem_observation", "readFileSync("),
                ("domain_filesystem_observation", "readdirSync("),
                ("domain_implicit_wall_clock", "Date.now("),
                ("domain_implicit_wall_clock", "new Date()"),
            ] {
                if source.contains(pattern) {
                    violations.push(json!({"path": path, "rule": rule}));
                }
            }
            if source.contains("paper-core/") {
                violations.push(json!({"path": path, "rule": "domain_core_dependency"}));
            }
        }
        if path.starts_with("paper-adapters/") {
            if source.contains("paper-application/") {
                violations.push(json!({"path": path, "rule": "adapter_application_dependency"}));
            }
            if source.contains("paper-core/src/") {
                violations.push(json!({"path": path, "rule": "adapter_core_dependency"}));
            }
        }
        if path.starts_with("paper-application/") {
            for (rule, pattern) in [
                ("application_core_dependency", "paper-core/src/"),
                ("application_store_port_dependency", "store-port.mjs"),
                ("application_sql_dependency", "SELECT "),
                ("application_sql_dependency", "INSERT INTO "),
                ("application_sql_dependency", "UPDATE "),
                ("application_sql_dependency", "DELETE FROM "),
            ] {
                if source.contains(pattern) {
                    violations.push(json!({"path": path, "rule": rule}));
                }
            }
            if source.contains(".query(") {
                violations.push(json!({"path": path, "rule": "application_query_dependency"}));
            }
            if source.contains("services.paperStageAdapters") {
                violations
                    .push(json!({"path": path, "rule": "application_stage_adapter_dependency"}));
            }
        }
        if (path.starts_with("paper-domain/governance/")
            || path.starts_with("paper-adapters/governance/"))
            && source.contains("migration/")
        {
            violations.push(json!({"path": path, "rule": "governance_migration_dependency"}));
        }
    }
    violations
}

fn inspect_layer_rules(root: &Path, production: &GraphReport) -> Vec<Value> {
    let mut violations = scan_forbidden_source(
        root,
        &production.modules,
        &[
            ("sqlite3_process_primitive", "spawnSync('sqlite3'"),
            (
                "autopilot_acceptance_receipt",
                "RefereeAutopilotAcceptanceReceipt",
            ),
            (
                "autopilot_acceptance_constant",
                "AUTOPILOT_ACCEPTANCE_RECEIPT",
            ),
            ("research_ready_shortcut", "researchReady"),
            ("paperctl_merge_queue", "./bin/paperctl merge-queue"),
            ("core_hash_facade", "../../core/src/hash-utils.mjs"),
        ],
    );
    for module in &production.modules {
        if module.starts_with("core/src/") || module == "core/src" {
            violations.push(json!({"path": module, "rule": "reference_core_reached"}));
        }
    }
    let domain: BTreeSet<String> = production
        .modules
        .iter()
        .filter(|path| path.starts_with("paper-domain/") && path.ends_with(".mjs"))
        .cloned()
        .collect();
    violations.extend(scan_forbidden_source(
        root,
        &domain,
        &[
            ("domain_filesystem_import", "from 'node:fs"),
            ("domain_filesystem_import", "from \"node:fs"),
            ("domain_path_import", "from 'node:path"),
            ("domain_path_import", "from \"node:path"),
            ("domain_filesystem_observation", "readFileSync("),
            ("domain_filesystem_observation", "readdirSync("),
            ("domain_implicit_wall_clock", "Date.now("),
            ("domain_implicit_wall_clock", "new Date()"),
            (
                "domain_wall_clock_facade",
                "workflow-kernel/runtime/time-utils.mjs",
            ),
        ],
    ));
    violations
}

fn inspect_compatibility_manifest(
    root: &Path,
    production: &GraphReport,
) -> Result<Vec<Value>, ArchitectureConformanceError> {
    let mut violations = Vec::new();
    let package: Value = serde_json::from_slice(&fs::read(root.join("package.json"))?)?;
    let reference = package
        .pointer("/heptaPaper/referencePackages")
        .and_then(Value::as_array)
        .and_then(|rows| rows.iter().find(|row| row["path"] == "core"));
    if reference.is_none()
        || reference.is_some_and(|row| {
            row["classification"] != "pinned_submodule_reference"
                || row["productionImportPolicy"] != "forbidden"
        })
    {
        violations.push(json!({"rule": "reference_package_policy"}));
    }
    if production
        .modules
        .iter()
        .any(|path| path == "core/src" || path.starts_with("core/src/"))
    {
        violations.push(json!({"rule": "reference_package_reached"}));
    }
    let manifest_path = package
        .pointer("/heptaPaper/compatibilityManifest")
        .and_then(Value::as_str)
        .unwrap_or("migration/compatibility-support.v1.json");
    let manifest: Value = serde_json::from_slice(&fs::read(root.join(manifest_path))?)?;
    let rows = [
        "hashBoundCompatibility",
        "deprecatedCompatibility",
        "migrationSupport",
        "historicalTranslationSupport",
    ];
    let mut seen = BTreeSet::new();
    for key in rows {
        if let Some(items) = manifest.get(key).and_then(Value::as_array) {
            for item in items {
                let Some(path) = item.get("path").and_then(Value::as_str) else {
                    violations
                        .push(json!({"rule": "compatibility_row_path_missing", "category": key}));
                    continue;
                };
                if !seen.insert(path.to_owned()) {
                    violations.push(json!({"rule": "compatibility_row_duplicate", "path": path}));
                }
                if !root.join(path).exists() {
                    violations.push(json!({"rule": "compatibility_row_missing", "path": path}));
                }
                if item.get("productionReachability").and_then(Value::as_str) == Some("forbidden")
                    && production.modules.contains(path)
                {
                    violations
                        .push(json!({"rule": "forbidden_compatibility_reached", "path": path}));
                }
                if item.get("retired").and_then(Value::as_bool) == Some(true)
                    && let Some(replacement) = item.get("replacement").and_then(Value::as_str)
                    && (root.join(path).exists() || !root.join(replacement).exists())
                {
                    violations.push(json!({"rule": "retired_code_present_or_replacement_missing", "path": path, "replacement": replacement}));
                }
            }
        }
    }
    if let Some(items) = manifest.get("retiredCode").and_then(Value::as_array) {
        for item in items {
            let Some(path) = item.get("path").and_then(Value::as_str) else {
                violations.push(json!({"rule": "retired_code_path_missing"}));
                continue;
            };
            if root.join(path).exists() {
                violations.push(json!({"rule": "retired_code_present", "path": path}));
            }
            if let Some(replacement) = item.get("replacement").and_then(Value::as_str)
                && !root.join(replacement).exists()
            {
                violations.push(json!({
                    "rule": "retired_code_replacement_missing",
                    "path": path,
                    "replacement": replacement,
                }));
            }
        }
    }
    Ok(violations)
}

/// Inspect the incumbent static architecture boundary without starting Node.
pub fn inspect_architecture_conformance_v1(
    workspace_root: &Path,
    _mode: ArchitectureConformanceModeV1,
) -> Result<Value, ArchitectureConformanceError> {
    if !workspace_root.is_dir() {
        return Err(ArchitectureConformanceError::RootInvalid);
    }
    let workspace_root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let manifest_path = workspace_root.join("paper-core/src/architecture-entrypoint-manifest.mjs");
    let manifest_source = fs::read_to_string(manifest_path)?;
    let mut arrays = BTreeMap::new();
    let mut manifest_blockers = Vec::new();
    for category in CATEGORIES {
        match extract_array(&manifest_source, category) {
            Some(values) if !values.is_empty() => {
                arrays.insert((*category).to_owned(), values);
            }
            Some(_) => manifest_blockers
                .push(json!({"rule": "manifest_category_empty", "category": category})),
            None => manifest_blockers
                .push(json!({"rule": "manifest_category_missing", "category": category})),
        }
    }
    let mut duplicate_entries = BTreeMap::<String, Vec<String>>::new();
    for (category, entries) in &arrays {
        for entry in entries {
            duplicate_entries
                .entry(entry.clone())
                .or_default()
                .push(category.clone());
        }
    }
    let duplicates: Vec<Value> = duplicate_entries
        .into_iter()
        .filter(|(_, categories)| categories.len() > 1)
        .map(|(entry, categories)| json!({"entry": entry, "categories": categories}))
        .collect();
    let mut graphs = BTreeMap::new();
    for category in CATEGORIES {
        let entries = arrays.get(*category).cloned().unwrap_or_default();
        graphs.insert(
            (*category).to_owned(),
            inspect_graph(&workspace_root, &entries),
        );
    }
    let production =
        graphs
            .get("production")
            .ok_or(ArchitectureConformanceError::ManifestInvariant(
                "production graph missing",
            ))?;
    let compatibility =
        graphs
            .get("compatibility")
            .ok_or(ArchitectureConformanceError::ManifestInvariant(
                "compatibility graph missing",
            ))?;
    let retired_present: Vec<String> = RETIRED_DIRECT_WORKFLOW
        .iter()
        .filter(|path| workspace_root.join(path).exists())
        .map(|path| (*path).to_owned())
        .collect();
    let mut blockers = manifest_blockers;
    if !duplicates.is_empty() {
        blockers.push(json!({"rule": "manifest_duplicate_entry", "entries": duplicates}));
    }
    for (category, graph) in &graphs {
        if graph.blocked() {
            blockers.push(json!({"rule": "graph_resolution", "category": category, "report": graph.to_json()}));
        }
    }
    if !retired_present.is_empty() {
        blockers.push(json!({"rule": "retired_direct_workflow_present", "paths": retired_present}));
    }
    blockers.extend(inspect_layer_rules(&workspace_root, production));
    blockers.extend(inspect_layer_sources(&workspace_root));
    blockers.extend(inspect_compatibility_manifest(&workspace_root, production)?);
    let research = inspect_graph(
        &workspace_root,
        &RESEARCH_ENTRYPOINTS
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
    );
    let dispatcher = inspect_graph(
        &workspace_root,
        &DISPATCHER_ENTRYPOINTS
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
    );
    for path in [
        NETWORK_ADAPTER,
        DISPATCHER_SERVICES,
        DISPATCHER_CYCLE_SIGNER,
    ] {
        if research.modules.contains(path) {
            blockers.push(json!({"rule": "research_reaches_submission_network", "path": path}));
        }
    }
    for path in [
        NETWORK_ADAPTER,
        DISPATCHER_SERVICES,
        DISPATCHER_CYCLE_SIGNER,
    ] {
        if !dispatcher.modules.contains(path) {
            blockers.push(json!({"rule": "dispatcher_missing_submission_boundary", "path": path}));
        }
    }
    let status = if blockers.is_empty() {
        "architecture_conformance_ready"
    } else {
        "architecture_conformance_blocked"
    };
    let graph_json: BTreeMap<String, Value> = graphs
        .iter()
        .map(|(key, value)| (key.clone(), value.to_json()))
        .collect();
    Ok(json!({
        "version": 1,
        "kind": "NativeArchitectureConformanceReport",
        "status": status,
        "ready": blockers.is_empty(),
        "workspaceRoot": workspace_root,
        "manifest": {
            "categories": arrays.keys().cloned().collect::<Vec<_>>(),
            "entrypointCount": arrays.values().map(Vec::len).sum::<usize>(),
            "duplicateEntries": duplicates,
        },
        "graphs": graph_json,
        "researchGraph": research.to_json(),
        "dispatcherGraph": dispatcher.to_json(),
        "blockers": blockers,
        "nativeChecker": {
            "executesNode": false,
            "readsManifestSource": true,
            "resolvesRelativeImports": true,
            "productionAuthorization": false,
            "nodeRetirementAuthorization": false,
        },
        "arrayEncoding": array_json(&CATEGORIES.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>()),
        "compatibilityGraphModuleCount": compatibility.modules.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{extract_array, inspect_graph, relative_module_specifiers};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn scanner_matches_static_and_dynamic_relative_imports() {
        let source = r#"
            // import './ignored.mjs'
            import './one.mjs';
            import { value as imported } from './braced.mjs';
            export { value } from "./two.mjs";
            const x = import('./three.mjs');
            const text = `import './ignored-template.mjs'`;
        "#;
        assert_eq!(
            relative_module_specifiers(source),
            vec!["./braced.mjs", "./one.mjs", "./three.mjs", "./two.mjs"]
        );
    }

    #[test]
    fn manifest_array_parser_ignores_nested_arrays_and_strings() {
        let source = "const x={production: Object.freeze(['a.mjs', 'b.mjs']), compatibility: Object.freeze([])};";
        assert_eq!(
            extract_array(source, "production").unwrap(),
            vec!["a.mjs", "b.mjs"]
        );
        assert_eq!(
            extract_array(source, "compatibility").unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn graph_fixture_fails_closed_for_missing_and_escaped_imports() {
        let root = PathBuf::from(format!(
            "{}/hepta-architecture-fixture-{}-{}",
            std::env::temp_dir().display(),
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("entry.mjs"),
            "import './missing.mjs'; import '../../../outside.mjs';\n",
        )
        .unwrap();
        let report = inspect_graph(&root, &["entry.mjs".to_owned()]);
        assert!(report.blocked());
        assert_eq!(report.missing_entrypoints.len(), 0);
        assert_eq!(report.unresolved_imports.len(), 1);
        assert_eq!(report.escaped_paths.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
