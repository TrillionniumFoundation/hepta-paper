//! Read-only retirement capability matrix inspection.
//!
//! This is the native, bounded source inspection for the incumbent
//! `migration:capability-matrix-v3` route.  It deliberately stops before
//! executing capability conformance/operational receipts or granting owner or
//! retirement authority.  The resulting report is therefore a useful local
//! migration inventory, never a retirement decision.

use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};
use thiserror::Error;

const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MATRIX_ENTRIES: usize = 4096;
const MAX_PATH_COMPONENTS: usize = 64;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

const PERMANENT_RETIREMENT_ACTIONS: &[&str] = &[
    "extract_review_heuristics_into_referee_review",
    "replace_plugin_wrapper_with_native_paper_adapter",
    "retire_generated_control_evidence_surface",
    "retire_generated_referee_control_evidence_surface",
    "retired_generated_build_misclassified_control_evidence_surface",
    "retired_generated_submission_control_evidence_surface",
    "retired_synthetic_submission_input_authority",
    "retired_legacy_direct_source_mutation_executor",
    "retired_research_local_e2e_smoke_harness",
    "retired_research_smoke_fixture",
];
const SUPERSEDED_ACTIONS: &[&str] = &[
    "retired_legacy_submission_schema_superseded_by_native_lifecycle",
    "retired_legacy_research_source_mutation_or_patch_queue_control_plane",
];

const CAPABILITY_TARGETS: &[(&str, &str, &str)] = &[
    (
        "research.claim-registry",
        "research",
        "paper-domain/research/claim-registry.mjs",
    ),
    (
        "research.gap-planner",
        "research",
        "paper-domain/research/gap-planner.mjs",
    ),
    (
        "research.evidence-ingestor",
        "research",
        "paper-domain/research/evidence-ingestor.mjs",
    ),
    (
        "research.evidence-quality-gate",
        "research",
        "paper-domain/research/evidence-quality-gate.mjs",
    ),
    (
        "research.experiment-registry",
        "research",
        "paper-domain/research/experiment-registry.mjs",
    ),
    (
        "research.formal-verifier",
        "research",
        "paper-ports/formal-verifier-port.mjs",
    ),
    (
        "research.gpu-pde-solver",
        "research",
        "paper-composition/automation/pde-poisson-2d-gpu-composition.mjs",
    ),
    (
        "research.gpu-deep-learning-training",
        "research",
        "paper-composition/automation/deep-learning-gpu-training-composition.mjs",
    ),
    (
        "research.change-proposal",
        "research",
        "paper-domain/research/change-proposal.mjs",
    ),
    (
        "runtime.sandboxed-worker-runner",
        "runtime",
        "paper-ports/worker-runner-port.mjs",
    ),
    (
        "runtime.artifact-repository",
        "runtime",
        "paper-ports/artifact-repository-port.mjs",
    ),
    (
        "runtime.job-receipt-store",
        "runtime",
        "paper-ports/job-receipt-store-port.mjs",
    ),
    (
        "submission.executor-port",
        "submission",
        "paper-ports/submission-executor-port.mjs",
    ),
    (
        "submission.delivery-runtime",
        "submission",
        "paper-domain/submission/delivery-runtime.mjs",
    ),
    (
        "submission.release-lock",
        "submission",
        "paper-domain/submission/release-lock.mjs",
    ),
    (
        "repair.safe-apply",
        "repair",
        "paper-adapters/referee-revise/repair-executor.mjs",
    ),
];

#[derive(Debug, Error)]
#[error("{0}")]
pub struct RetirementMatrixError(String);

type Result<T> = std::result::Result<T, RetirementMatrixError>;

fn error(code: impl Into<String>) -> RetirementMatrixError {
    RetirementMatrixError(code.into())
}

struct SourceSnapshot {
    bytes: Vec<u8>,
    paths: Vec<(PathBuf, Metadata)>,
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

impl SourceSnapshot {
    fn assert_current(&self) -> Result<()> {
        for (index, (path, expected)) in self.paths.iter().enumerate() {
            let current = fs::symlink_metadata(path)
                .map_err(|_| error("retirement_matrix_source_changed"))?;
            if current.is_symlink()
                || current.dev() != expected.dev()
                || current.ino() != expected.ino()
                || current.file_type() != expected.file_type()
                || (index + 1 == self.paths.len() && !same_file(expected, &current))
            {
                return Err(error("retirement_matrix_source_changed"));
            }
        }
        Ok(())
    }
}

fn relative_source_path(relative: &str) -> Result<()> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(relative).is_absolute()
    {
        return Err(error("retirement_matrix_source_path_invalid"));
    }
    if relative.split('/').count() > MAX_PATH_COMPONENTS {
        return Err(error("retirement_matrix_source_path_too_deep"));
    }
    Ok(())
}

fn source_fields(source: &serde_json::Map<String, Value>) -> Result<(&str, &str)> {
    let source_path = source
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| error("retirement_matrix_source_path_invalid"))?;
    relative_source_path(source_path)?;
    let declared_source_hash = source
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| error("retirement_matrix_source_hash_invalid"))?;
    Ok((source_path, declared_source_hash))
}

fn validate_explicit_entry_count(count: usize) -> Result<()> {
    if count == 0 {
        return Err(error("retirement_matrix_explicit_entries_required"));
    }
    if count > MAX_MATRIX_ENTRIES {
        return Err(error("retirement_matrix_entry_count_exceeded"));
    }
    Ok(())
}

// Open every component through its pinned parent descriptor. Neither a root
// alias, an intermediate symlink nor a concurrently replaced leaf is followed.
fn read_source(root: &Path, relative: &str) -> Result<SourceSnapshot> {
    relative_source_path(relative)?;
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || root.components().count() > MAX_PATH_COMPONENTS
    {
        return Err(error("retirement_matrix_source_path_invalid"));
    }
    let mut directory = File::from(
        open(
            Path::new("/"),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error("retirement_matrix_source_read_failed"))?,
    );
    let mut cursor = PathBuf::from("/");
    let mut paths = vec![(
        cursor.clone(),
        directory
            .metadata()
            .map_err(|_| error("retirement_matrix_source_read_failed"))?,
    )];
    let path = root.join(relative);
    let mut components = path
        .components()
        .filter_map(|part| {
            if let Component::Normal(part) = part {
                Some(part)
            } else {
                None
            }
        })
        .peekable();
    let mut selected = None;
    while let Some(part) = components.next() {
        let last = components.peek().is_none();
        let flags = OFlag::O_RDONLY
            | OFlag::O_NOFOLLOW
            | OFlag::O_CLOEXEC
            | OFlag::O_NONBLOCK
            | if last {
                OFlag::empty()
            } else {
                OFlag::O_DIRECTORY
            };
        let file = File::from(
            openat(directory.as_fd(), Path::new(part), flags, Mode::empty())
                .map_err(|_| error("retirement_matrix_source_read_failed"))?,
        );
        cursor.push(part);
        paths.push((
            cursor.clone(),
            file.metadata()
                .map_err(|_| error("retirement_matrix_source_read_failed"))?,
        ));
        if last {
            selected = Some(file);
        } else {
            directory = file;
        }
    }
    let mut file = selected.ok_or_else(|| error("retirement_matrix_source_unsafe"))?;
    let before = file
        .metadata()
        .map_err(|_| error("retirement_matrix_source_read_failed"))?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_INPUT_BYTES {
        return Err(error("retirement_matrix_source_unsafe"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("retirement_matrix_source_read_failed"))?;
    if bytes.len() as u64 != before.len()
        || !same_file(
            &before,
            &file
                .metadata()
                .map_err(|_| error("retirement_matrix_source_read_failed"))?,
        )
    {
        return Err(error("retirement_matrix_source_changed"));
    }
    let snapshot = SourceSnapshot { bytes, paths };
    snapshot.assert_current()?;
    Ok(snapshot)
}

fn decision(action: &str) -> &'static str {
    if PERMANENT_RETIREMENT_ACTIONS.contains(&action) {
        "permanent_retirement"
    } else if SUPERSEDED_ACTIONS.contains(&action) {
        "superseded_with_coverage"
    } else {
        // The Node matrix intentionally defaults all unrecognised migration
        // actions to retirement.  Keep that conservative rule here.
        "permanent_retirement"
    }
}

fn capability_ids(source: &str, business_decision: &str) -> Vec<&'static str> {
    if business_decision == "permanent_retirement" {
        return Vec::new();
    }
    if source.contains("runner_execution_contract") {
        return vec!["runtime.job-receipt-store", "runtime.artifact-repository"];
    }
    if source.contains("external_submission_handoff_bundle") {
        return vec!["submission.executor-port", "submission.delivery-runtime"];
    }
    if [
        "external_submission",
        "portal_capability",
        "submission_handoff",
        "submission_lifecycle",
        "submission_intake",
        "external_auth",
        "release_lock",
    ]
    .iter()
    .any(|v| source.contains(v))
    {
        return vec!["submission.delivery-runtime", "submission.release-lock"];
    }
    if ["formal_verifier", "theorem_proof", "lean_"]
        .iter()
        .any(|v| source.contains(v))
    {
        return vec![
            "research.formal-verifier",
            "runtime.sandboxed-worker-runner",
            "runtime.artifact-repository",
        ];
    }
    if [
        "source_apply",
        "patch_queue",
        "manuscript_patch",
        "merge",
        "candidate_note",
        "source_gate",
        "source_authorization",
        "source_post_apply",
    ]
    .iter()
    .any(|v| source.contains(v))
    {
        return vec![
            "research.change-proposal",
            "repair.safe-apply",
            "runtime.artifact-repository",
        ];
    }
    if ["experiment", "benchmark", "dataset"]
        .iter()
        .any(|v| source.contains(v))
    {
        return vec![
            "research.experiment-registry",
            "research.evidence-quality-gate",
        ];
    }
    if ["evidence", "certificate"]
        .iter()
        .any(|v| source.contains(v))
    {
        return vec![
            "research.evidence-ingestor",
            "research.evidence-quality-gate",
            "runtime.artifact-repository",
        ];
    }
    if ["gap", "bridge", "claim", "candidate", "planner", "plan"]
        .iter()
        .any(|v| source.contains(v))
    {
        return vec![
            "research.claim-registry",
            "research.gap-planner",
            "runtime.job-receipt-store",
        ];
    }
    if source.contains("research_compute_executor") {
        return vec![
            "runtime.sandboxed-worker-runner",
            "runtime.job-receipt-store",
        ];
    }
    vec!["research.claim-registry", "research.evidence-quality-gate"]
}

fn retain_snapshot(
    snapshot: SourceSnapshot,
    snapshots: &mut Vec<SourceSnapshot>,
) -> Result<String> {
    let retained = snapshots
        .iter()
        .map(|snapshot| snapshot.bytes.len())
        .try_fold(snapshot.bytes.len(), usize::checked_add)
        .ok_or_else(|| error("retirement_matrix_snapshot_budget_exceeded"))?;
    if retained > MAX_SNAPSHOT_BYTES {
        return Err(error("retirement_matrix_snapshot_budget_exceeded"));
    }
    let digest = format!("{:x}", Sha256::digest(&snapshot.bytes));
    snapshots.push(snapshot);
    Ok(digest)
}

fn target_record(
    workspace_root: &Path,
    id: &str,
    snapshots: &mut Vec<SourceSnapshot>,
) -> Result<Value> {
    let Some((_, bounded_context, relative)) = CAPABILITY_TARGETS
        .iter()
        .find(|(candidate, _, _)| *candidate == id)
    else {
        return Ok(json!({"id": id, "target": null, "exists": false, "sha256": null}));
    };
    let digest = match read_source(workspace_root, relative) {
        Ok(snapshot) => Some(retain_snapshot(snapshot, snapshots)?),
        Err(_) => None,
    };
    Ok(
        json!({"id": id, "boundedContext": bounded_context, "target": relative, "exists": digest.is_some(), "sha256": digest}),
    )
}

/// Inspect the V2 migration matrix and current source/target identities.
///
/// This function is intentionally partial.  `implementation_verified` and
/// `operationally_proven` are always false here because native receipt replay,
/// external owner signatures and retirement authority are separate gates.
pub fn inspect_retirement_matrix_v1(workspace_root: &Path, runtime_root: &Path) -> Result<Value> {
    if !workspace_root.is_absolute() || !runtime_root.is_absolute() {
        return Err(error("retirement_matrix_absolute_roots_required"));
    }
    let matrix_snapshot = read_source(
        workspace_root,
        "migration/legacy-semantic-migration-matrix.json",
    )
    .map_err(|_| error("retirement_matrix_source_invalid"))?;
    let matrix: Value = serde_json::from_slice(&matrix_snapshot.bytes)
        .map_err(|_| error("retirement_matrix_source_invalid"))?;
    let mut snapshots = vec![matrix_snapshot];
    if matrix["version"] != 2 || matrix["kind"] != "LegacySemanticMigrationMatrix" {
        return Err(error("retirement_matrix_source_version_invalid"));
    }
    let rows = matrix["entries"]
        .as_array()
        .ok_or_else(|| error("retirement_matrix_entries_invalid"))?;
    let explicit_entry_count = rows
        .iter()
        .filter(|row| row["verificationClass"] == "explicit_retirement")
        .count();
    validate_explicit_entry_count(explicit_entry_count)?;
    let mut entries = Vec::new();
    let mut source_hash_verified = 0usize;
    let mut source_hash_pending = 0usize;
    let mut target_hash_bound = 0usize;
    let mut target_hash_pending = 0usize;
    let mut target_hash_not_applicable = 0usize;
    let mut by_decision = serde_json::Map::new();
    for row in rows
        .iter()
        .filter(|row| row["verificationClass"] == "explicit_retirement")
    {
        let id = row["id"]
            .as_str()
            .ok_or_else(|| error("retirement_matrix_entry_id_invalid"))?;
        let action = row["migrationAction"]
            .as_str()
            .ok_or_else(|| error("retirement_matrix_migration_action_invalid"))?;
        let source = row["source"]
            .as_object()
            .ok_or_else(|| error("retirement_matrix_source_record_invalid"))?;
        let (source_path, declared_source_hash) = source_fields(source)?;
        let current_source_hash = match read_source(workspace_root, source_path) {
            Ok(snapshot) => Some(retain_snapshot(snapshot, &mut snapshots)?),
            Err(_) => None,
        };
        let hash_matches = current_source_hash.as_deref() == Some(declared_source_hash);
        if hash_matches {
            source_hash_verified += 1;
        } else {
            source_hash_pending += 1;
        }
        let business_decision = decision(action);
        let ids = capability_ids(source_path, business_decision);
        let targets: Vec<Value> = ids
            .iter()
            .map(|id| target_record(workspace_root, id, &mut snapshots))
            .collect::<Result<_>>()?;
        if targets.is_empty() {
            target_hash_not_applicable += 1;
        } else if targets.iter().all(|target| target["exists"] == true) {
            target_hash_bound += 1;
        } else {
            target_hash_pending += 1;
        }
        let count = by_decision
            .entry(business_decision.to_owned())
            .or_insert(json!(0));
        *count = json!(count.as_u64().unwrap_or(0) + 1);
        entries.push(json!({
            "id": format!("v3-{id}"),
            "legacyMatrixEntryId": id,
            "source": {"path": source_path, "declaredSha256": declared_source_hash, "currentSha256": current_source_hash, "hashMatches": hash_matches},
            "priorDisposition": action,
            "businessDecision": business_decision,
            "capabilityIds": ids,
            "capabilityTargets": targets,
            "decisionMapped": true,
            "contractDefined": business_decision == "permanent_retirement"
                || targets.iter().all(|target| target["exists"] == true),
            "implementationVerified": false,
            "implementationStatus": if business_decision == "permanent_retirement" { "not_applicable_permanent_retirement" } else { "native_receipts_not_evaluated" },
            "operationallyProven": false,
            "operationalStatus": if business_decision == "permanent_retirement" { "not_applicable_permanent_retirement" } else { "external_operational_proof_required" },
            "ownerAcceptanceStatus": "imported_summary_only",
        }));
    }
    let owner_acceptance =
        crate::owner_status::inspect_owner_acceptance_status_v1(workspace_root, runtime_root)
            .map_err(|owner_error| error(owner_error.to_string()))?;
    for snapshot in snapshots {
        snapshot.assert_current()?;
    }
    let mut blockers = vec![
        "retirement_matrix_read_only_projection".to_owned(),
        "native_capability_conformance_receipts_not_evaluated".to_owned(),
        "production_operational_proofs_not_evaluated".to_owned(),
        "independent_owner_acceptance_and_retirement_authority_required".to_owned(),
    ];
    if source_hash_pending > 0 {
        blockers.push("legacy_source_hash_drift_or_missing".to_owned());
    }
    if target_hash_pending > 0 {
        blockers.push("capability_target_missing_or_unbound".to_owned());
    }
    if owner_acceptance["ownerAcceptancePending"]
        .as_u64()
        .unwrap_or(0)
        > 0
    {
        blockers.push("owner_acceptance_pending".to_owned());
    }
    let status = if source_hash_pending == 0
        && target_hash_pending == 0
        && owner_acceptance["ownerAcceptancePending"] == 0
    {
        "retirement_matrix_partial_source_verified"
    } else {
        "retirement_matrix_partial_blocked"
    };
    Ok(json!({
        "version": 1,
        "kind": "LegacyCapabilityMigrationMatrixReadOnly",
        "status": status,
        "readOnly": true,
        "authorityGranted": false,
        "productionActivation": false,
        "nodeRetirement": false,
        "sourceMatrixVersion": matrix["version"],
        "summary": {
            "entryCount": entries.len(),
            "byDecision": by_decision,
            "decisionMapped": entries.len(),
            "sourceHashVerified": source_hash_verified,
            "sourceHashPending": source_hash_pending,
            "targetHashBoundEntries": target_hash_bound,
            "targetHashPendingEntries": target_hash_pending,
            "targetHashNotApplicableEntries": target_hash_not_applicable,
            "implementationVerified": 0,
            "operationallyProven": 0,
            "ownerAcceptancePending": owner_acceptance["ownerAcceptancePending"],
        },
        "ownerAcceptance": owner_acceptance,
        "blockers": blockers,
        "entries": entries,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_INPUT_BYTES, MAX_MATRIX_ENTRIES, inspect_retirement_matrix_v1, read_source,
        relative_source_path, source_fields, validate_explicit_entry_count,
    };
    use serde_json::{Map, Value};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-retirement-matrix-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn malformed_source_fields_and_escape_paths_fail_closed() {
        let mut missing_path = Map::new();
        missing_path.insert("sha256".into(), Value::String("0".repeat(64)));
        assert!(source_fields(&missing_path).is_err());
        let mut invalid_hash = Map::new();
        invalid_hash.insert("path".into(), Value::String("source.json".into()));
        assert!(source_fields(&invalid_hash).is_err());
        invalid_hash.insert("sha256".into(), Value::String("not-a-hash".into()));
        assert!(source_fields(&invalid_hash).is_err());
        for path in ["../outside", "/tmp/outside", "a//b", "a/../b", "a/./b"] {
            assert!(relative_source_path(path).is_err(), "{path}");
        }
        let deep = std::iter::repeat_n("segment", 65)
            .collect::<Vec<_>>()
            .join("/");
        assert!(relative_source_path(&deep).is_err());
        assert_eq!(
            validate_explicit_entry_count(0).unwrap_err().to_string(),
            "retirement_matrix_explicit_entries_required"
        );
        assert_eq!(
            validate_explicit_entry_count(MAX_MATRIX_ENTRIES + 1)
                .unwrap_err()
                .to_string(),
            "retirement_matrix_entry_count_exceeded"
        );
    }

    #[test]
    fn source_reader_rejects_parent_and_leaf_symlinks() {
        use std::os::unix::fs::symlink;
        let root = temporary_root("symlink");
        fs::create_dir(root.join("safe")).unwrap();
        fs::write(root.join("safe/data.json"), b"{}\n").unwrap();
        symlink(root.join("safe"), root.join("alias")).unwrap();
        symlink(root.join("safe/data.json"), root.join("leaf.json")).unwrap();
        assert!(read_source(&root, "safe/data.json").is_ok());
        assert!(read_source(&root, "alias/data.json").is_err());
        assert!(read_source(&root, "leaf.json").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_snapshot_rejects_rebinding_and_oversized_sparse_files() {
        let root = temporary_root("snapshot");
        fs::create_dir(root.join("parent")).unwrap();
        fs::write(root.join("parent/input"), b"original").unwrap();
        let snapshot = read_source(&root, "parent/input").unwrap();
        fs::rename(root.join("parent"), root.join("moved")).unwrap();
        fs::create_dir(root.join("parent")).unwrap();
        fs::write(root.join("parent/input"), b"foreign").unwrap();
        assert!(snapshot.assert_current().is_err());
        assert_eq!(fs::read(root.join("parent/input")).unwrap(), b"foreign");
        fs::File::create(root.join("large"))
            .unwrap()
            .set_len(MAX_INPUT_BYTES + 1)
            .unwrap();
        assert!(read_source(&root, "large").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_matrix_is_read_only_and_never_authorizes_retirement() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let runtime = temporary_root("report");
        let report = inspect_retirement_matrix_v1(&workspace, &runtime).unwrap();
        assert_eq!(report["readOnly"], true);
        assert_eq!(report["authorityGranted"], false);
        assert_eq!(report["nodeRetirement"], false);
        assert!(report["summary"]["entryCount"].as_u64().unwrap() > 0);
        assert_eq!(report["summary"]["implementationVerified"], 0);
        let _ = fs::remove_dir_all(runtime);
    }

    #[test]
    fn target_hash_summary_separates_retirements_without_targets() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let runtime = temporary_root("summary");
        let report = inspect_retirement_matrix_v1(&workspace, &runtime).unwrap();
        assert_eq!(report["summary"]["targetHashNotApplicableEntries"], 209);
        assert_eq!(report["summary"]["targetHashBoundEntries"], 40);
        assert_eq!(report["summary"]["targetHashPendingEntries"], 0);
        let _ = fs::remove_dir_all(runtime);
    }
}
