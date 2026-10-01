use super::{
    Owner, ReleaseAttestationPolicyReplayRequestV4, SUITES, SourceGraph, digest, error,
    private_tree::PrivateTree,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path},
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Reference {
    pub version: u16,
    pub kind: String,
    pub archive_basename: String,
    pub archive_sha256: String,
    pub matrix_path: String,
    pub matrix_sha256: String,
    pub source_file_count: usize,
    pub source_of_truth: String,
    pub live_legacy_root_required: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Matrix {
    pub version: u16,
    pub kind: String,
    pub policy: Value,
    pub entries: Vec<Row>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Row {
    pub id: String,
    pub priority: String,
    pub migration_action: String,
    pub semantic_scope: Scope,
    pub source: SymbolFile,
    pub target: SymbolFile,
    pub behavior_tests: Vec<Evidence>,
    #[serde(default)]
    pub evidence_artifacts: Vec<Evidence>,
    pub verification_class: String,
    #[serde(default)]
    pub capability_family: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Scope {
    pub status: String,
    pub covered: Vec<String>,
    pub open: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SymbolFile {
    pub path: String,
    pub sha256: String,
    pub symbols: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Evidence {
    pub id: String,
    pub path: String,
    pub sha256: String,
}
pub(super) fn sha(value: &str, prefix: bool) -> bool {
    let v = if prefix {
        match value.strip_prefix("sha256:") {
            Some(v) => v,
            None => return false,
        }
    } else {
        value
    };
    v.len() == 64
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_/.-".contains(&c))
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && value
            .split('/')
            .all(|v| !v.is_empty() && v != "." && v != "..")
}
fn symbol(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn has_symbol(bytes: &[u8], name: &str) -> bool {
    bytes.windows(name.len()).enumerate().any(|(i, v)| {
        v == name.as_bytes()
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_')
            && (i + v.len() == bytes.len()
                || !bytes[i + v.len()].is_ascii_alphanumeric() && bytes[i + v.len()] != b'_')
    })
}
pub(super) fn validate_contract(
    m: &Matrix,
    r: &Reference,
    bytes: &[u8],
    request: &ReleaseAttestationPolicyReplayRequestV4,
) -> Result<(), String> {
    if m.version != 2
        || m.kind != "LegacySemanticMigrationMatrix"
        || m.entries.len() != 263
        || r.version != 1
        || r.kind != "ImmutableLegacyMatrixReference"
        || r.source_file_count != 263
        || r.live_legacy_root_required
        || r.source_of_truth != "immutable_archive_plus_hash_bound_matrix"
        || r.matrix_path != "migration/legacy-semantic-migration-matrix.json"
        || r.archive_basename != "paper-factory-control-plane-reference.tar.gz"
        || r.archive_sha256 != request.archive_sha256
        || r.matrix_sha256 != digest(bytes)
    {
        return Err(error("policy_contract_invalid"));
    }
    // Existing native matrix policy admits dispositions, never automatic migration
    // or publication claims. Every mandatory policy bit must be literally true.
    for key in [
        "filePresenceIsNotMigrationEvidence",
        "automaticClaimsForbidden",
        "completeSemanticScopeRequired",
        "partialRowsRemainBlocking",
        "sharedBehaviorTestsExecuteOncePerAudit",
        "retirementVerificationIsNotBehavioralMigration",
    ] {
        if m.policy[key] != true {
            return Err(error("policy_authority_contract_invalid"));
        }
    }
    let expected = BTreeSet::from_iter(SUITES.iter().map(|(s, _)| *s));
    let mut tests = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut behavioral = 0;
    let mut retired = 0;
    for row in &m.entries {
        if row.id.is_empty()
            || row.id.len() > 256
            || !ids.insert(&row.id)
            || !paths.insert(&row.source.path)
            || !relative(&row.source.path)
            || !relative(&row.target.path)
            || !row.target.path.starts_with("hepta-paper-workspace/")
            || !sha(&row.source.sha256, false)
            || !sha(&row.target.sha256, false)
            || !matches!(row.priority.as_str(), "P0" | "P1")
            || row.migration_action.is_empty()
            || row.semantic_scope.status != "complete"
            || !row.semantic_scope.open.is_empty()
            || row.semantic_scope.covered.is_empty()
            || row.behavior_tests.is_empty()
            || row.behavior_tests.len() > 10
            || row.source.symbols.is_empty()
            || row.target.symbols.is_empty()
            || row.source.symbols.len() > 256
            || row.target.symbols.len() > 256
            || row
                .source
                .symbols
                .iter()
                .chain(&row.target.symbols)
                .any(|v| !symbol(v))
            || row
                .capability_family
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 256)
        {
            return Err(error("policy_row_contract_invalid"));
        }
        match row.verification_class.as_str() {
            "behavioral_replacement" => behavioral += 1,
            "explicit_retirement" => retired += 1,
            _ => return Err(error("policy_verification_class_invalid")),
        }
        let mut row_tests = BTreeSet::new();
        for test in &row.behavior_tests {
            if test.id.is_empty()
                || !relative(&test.path)
                || !expected.contains(test.path.as_str())
                || !sha(&test.sha256, false)
                || !row_tests.insert(&test.path)
            {
                return Err(error("policy_fixed_test_contract_invalid"));
            }
            tests.insert(test.path.as_str());
        }
        if row.evidence_artifacts.len() > 16
            || row
                .evidence_artifacts
                .iter()
                .any(|a| a.id.is_empty() || !relative(&a.path) || !sha(&a.sha256, false))
        {
            return Err(error("policy_artifact_contract_invalid"));
        }
    }
    if tests != expected || behavioral != 14 || retired != 249 {
        return Err(error("policy_scope_contract_invalid"));
    }
    Ok(())
}
const ROOTS: &[&str] = &[
    "paper-core",
    "paper-adapters",
    "paper-domain",
    "paper-ports",
    "paper-composition",
    "workflow-kernel",
    "migration",
    "paper-application",
    "store",
    "numerical-plugins",
    "provider-sandbox",
];
pub(super) fn graph_paths(owner: &mut Owner<'_>) -> Result<Vec<String>, String> {
    let root = owner.request.source.workspace_root.clone();
    struct Selection {
        files: BTreeSet<String>,
        entries: usize,
        dirs: usize,
    }
    let mut selected = Selection {
        files: BTreeSet::new(),
        entries: 0,
        dirs: 0,
    };
    fn walk(
        owner: &Owner<'_>,
        root: &Path,
        path: &Path,
        depth: usize,
        selected: &mut Selection,
        all_regular_inputs: bool,
    ) -> Result<(), String> {
        owner.remaining()?;
        selected.dirs += 1;
        if depth > 32 || selected.dirs > 4096 {
            return Err(error("policy_graph_directory_budget"));
        }
        let before = fs::symlink_metadata(path).map_err(|_| error("policy_graph_unsafe"))?;
        if !before.is_dir() || before.is_symlink() {
            return Err(error("policy_graph_unsafe"));
        }
        let mut children = Vec::new();
        for e in fs::read_dir(path).map_err(|_| error("policy_graph_unsafe"))? {
            owner.remaining()?;
            selected.entries += 1;
            if selected.entries > 200_000 {
                return Err(error("policy_graph_entry_budget"));
            }
            children.push(e.map_err(|_| error("policy_graph_unsafe"))?);
        }
        children.sort_by_key(|e| e.file_name());
        for entry in children {
            owner.remaining()?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| error("policy_graph_path_invalid"))?;
            if matches!(name.as_str(), "node_modules" | "__pycache__" | ".git") {
                if all_regular_inputs {
                    return Err(error("policy_node_package_namespace_invalid"));
                }
                continue;
            }
            let p = entry.path();
            let metadata = fs::symlink_metadata(&p).map_err(|_| error("policy_graph_unsafe"))?;
            if metadata.is_symlink() {
                return Err(error("policy_graph_unsafe"));
            }
            if metadata.is_dir() {
                walk(owner, root, &p, depth + 1, selected, all_regular_inputs)?;
            } else if metadata.is_file() {
                let extension = p.extension().and_then(|v| v.to_str());
                if all_regular_inputs
                    || matches!(
                        extension,
                        Some("mjs" | "js" | "json" | "sql" | "py" | "yml" | "yaml")
                    )
                {
                    let rel = p
                        .strip_prefix(root)
                        .map_err(|_| error("policy_graph_path_invalid"))?
                        .to_str()
                        .ok_or_else(|| error("policy_graph_path_invalid"))?
                        .to_owned();
                    if !relative(&rel) || !selected.files.insert(rel) || selected.files.len() > 4096
                    {
                        return Err(error("policy_graph_path_budget"));
                    }
                }
            } else {
                return Err(error("policy_graph_unsafe"));
            }
        }
        let after = fs::symlink_metadata(path).map_err(|_| error("policy_graph_changed"))?;
        if !super::super::same(&before, &after) {
            return Err(error("policy_graph_changed"));
        }
        Ok(())
    }
    for name in ROOTS {
        walk(owner, &root, &root.join(name), 0, &mut selected, false)?;
    }
    for name in super::node_packages::ROOTS {
        walk(owner, &root, &root.join(name), 0, &mut selected, true)?;
    }
    for name in super::node_assets::ROOTS {
        walk(owner, &root, &root.join(name), 0, &mut selected, true)?;
    }
    let mut files = selected.files;
    super::node_packages::validate_paths(&files)?;
    super::node_assets::validate_paths(&files)?;
    // The fixture archive is also opened by the fixed differential observers.
    files.insert("migration/fixtures/legacy-differential-reference-v1.tar.gz".into());
    files.insert("package.json".into());
    files.insert("package-lock.json".into());
    Ok(files.into_iter().collect())
}
pub(super) fn inspect_rows(
    owner: &mut Owner<'_>,
    graph: &mut SourceGraph,
    matrix: &Matrix,
    tree: &PrivateTree,
) -> Result<Vec<Value>, String> {
    let mut cache = BTreeMap::new();
    let mut rows = Vec::new();
    fn workspace(
        owner: &mut Owner<'_>,
        graph: &mut SourceGraph,
        cache: &mut BTreeMap<String, Vec<u8>>,
        path: &str,
    ) -> Result<Vec<u8>, String> {
        if let Some(bytes) = cache.get(path) {
            return Ok(bytes.clone());
        }
        let bytes = graph.read_input(owner, path)?;
        cache.insert(path.to_owned(), bytes.clone());
        Ok(bytes)
    }
    for row in &matrix.entries {
        owner.remaining()?;
        let source = tree.read_source(&row.source.path, owner)?;
        let target_path = row
            .target
            .path
            .strip_prefix("hepta-paper-workspace/")
            .ok_or_else(|| error("policy_target_path_invalid"))?;
        let target = workspace(owner, graph, &mut cache, target_path)?;
        if digest(&source) != format!("sha256:{}", row.source.sha256)
            || digest(&target) != format!("sha256:{}", row.target.sha256)
            || row.source.symbols.iter().any(|s| !has_symbol(&source, s))
            || row.target.symbols.iter().any(|s| !has_symbol(&target, s))
        {
            return Err(format!(
                "{}:{}",
                error("policy_source_target_binding_failed"),
                row.id
            ));
        }
        let mut tests = Vec::new();
        for test in &row.behavior_tests {
            let bytes = workspace(owner, graph, &mut cache, &test.path)?;
            if digest(&bytes) != format!("sha256:{}", test.sha256) {
                return Err(error("policy_behavior_test_hash_mismatch"));
            }
            tests.push(
                json!({"id":test.id,"path":test.path,"sha256":format!("sha256:{}",test.sha256)}),
            );
        }
        let mut artifacts = Vec::new();
        for a in &row.evidence_artifacts {
            let bytes = workspace(owner, graph, &mut cache, &a.path)?;
            if digest(&bytes) != format!("sha256:{}", a.sha256) {
                return Err(error("policy_evidence_artifact_hash_mismatch"));
            }
            artifacts.push(json!({"id":a.id,"path":a.path,"sha256":format!("sha256:{}",a.sha256)}));
        }
        rows.push(json!({"id":row.id,"sourcePath":row.source.path,"sourceSha256":digest(&source),"targetPath":target_path,"targetSha256":digest(&target),"sourceSymbols":row.source.symbols,"targetSymbols":row.target.symbols,"semanticScopeStatus":row.semantic_scope.status,"verificationClass":row.verification_class,"behaviorTests":tests,"evidenceArtifacts":artifacts,"status":"native_matrix_source_verified_observers_pending","verified":false}));
    }
    Ok(rows)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_process_limits_preserve_kernel_caps_and_small_profile_tail() {
        for output in [1, 4096, 64 * 1024, 64 * 1024 * 1024] {
            let limits = super::super::process_limits(1000, 22_506_525, output).unwrap();
            assert_eq!(limits.maximum_stdin_bytes, 64 * 1024 * 1024);
            assert_eq!(limits.maximum_stdout_bytes, output);
            assert!(limits.maximum_tail_bytes as u64 <= output);
            assert!(limits.maximum_tail_bytes as u64 <= limits.maximum_stderr_bytes);
        }
        assert!(super::super::process_limits(1000, 64 * 1024 * 1024 + 1, 4096).is_err());
        assert!(super::super::process_limits(1000, 0, 64 * 1024 * 1024 + 1).is_err());
        assert!(super::super::process_limits(1000, 0, 0).is_err());
    }
    #[test]
    fn source_member_contract_rejects_tar_options_traversal_and_ambiguous_components() {
        for path in [
            "/tmp/outside",
            "../outside",
            "bin/../outside",
            "bin//paperctl",
            "bin/./paperctl",
            "--checkpoint-action=exec=sh",
            "bin/a\nfile",
            "bin/a\\file",
        ] {
            assert!(!relative(path), "{path}");
        }
        assert!(relative("plugins/core/substantive-referee/plugin.yaml"));
        assert!(!has_symbol(b"mainland main_extra", "main"));
        assert!(has_symbol(b"def main(args):", "main"));
    }
    #[test]
    fn real_matrix_requires_exact_policy_classes_fixed_suite_set_and_closed_fields() {
        let bytes =
            include_bytes!("../../../../../../../migration/legacy-semantic-migration-matrix.json");
        let r = include_bytes!(
            "../../../../../../../migration/fixtures/legacy-matrix-reference-v1.json"
        );
        let reference: Reference = serde_json::from_slice(r).unwrap();
        let mut request:ReleaseAttestationPolicyReplayRequestV4=serde_json::from_value(json!({"version":4,"kind":"ReleaseAttestationPolicyReplayRequest","replay":{"version":3,"kind":"ReleaseAttestationReplayRequest","source":{"version":2,"kind":"ReleaseAttestationSourceRequest","workspaceRoot":"/private","gitExecutable":"/usr/bin/git","gitExecutableSha256":format!("sha256:{}","0".repeat(64)),"expectedCommit":"0".repeat(40),"expectedTree":"0".repeat(40),"expectedReleaseStateSnapshotHash":format!("sha256:{}","0".repeat(64)),"timeoutMs":600000},"nodeExecutable":"/private/node","nodeExecutableSha256":format!("sha256:{}","0".repeat(64)),"timeoutMs":600000},"archivePath":"/private/archive.tar.gz","archiveSha256":reference.archive_sha256})).unwrap();
        let matrix: Matrix = serde_json::from_slice(bytes).unwrap();
        validate_contract(&matrix, &reference, bytes, &request).unwrap();
        request.archive_sha256 = format!("sha256:{}", "0".repeat(64));
        assert!(validate_contract(&matrix, &reference, bytes, &request).is_err());
        request.archive_sha256 = reference.archive_sha256.clone();
        for field in [
            "verificationClass",
            "semanticScope",
            "source",
            "behaviorTests",
        ] {
            let mut bad: Value = serde_json::from_slice(bytes).unwrap();
            match field {
                "verificationClass" => bad["entries"][0][field] = json!("automatic_completed"),
                "semanticScope" => bad["entries"][0][field]["open"] = json!(["unimplemented"]),
                "source" => bad["entries"][0][field]["path"] = json!("../outside"),
                _ => bad["entries"][0][field][0]["path"] = json!("arbitrary-command.mjs"),
            };
            let bad_bytes = serde_json::to_vec(&bad).unwrap();
            let mut bound_reference: Reference = serde_json::from_slice(r).unwrap();
            bound_reference.matrix_sha256 = digest(&bad_bytes);
            let bad_matrix: Matrix = serde_json::from_slice(&bad_bytes).unwrap();
            assert!(
                validate_contract(&bad_matrix, &bound_reference, &bad_bytes, &request).is_err(),
                "{field}"
            );
        }
        let mut extra: Value = serde_json::from_slice(bytes).unwrap();
        extra["entries"][0]["callerVerified"] = json!(true);
        assert!(serde_json::from_value::<Matrix>(extra).is_err());
    }
}
