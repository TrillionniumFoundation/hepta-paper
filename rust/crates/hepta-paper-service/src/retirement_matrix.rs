//! Read-only retirement capability matrix inspection.
//!
//! This is the native, bounded source inspection for the incumbent
//! `migration:capability-matrix-v3` route.  It deliberately stops before
//! executing capability conformance/operational receipts or granting owner or
//! retirement authority.  The resulting report is therefore a useful local
//! migration inventory, never a retirement decision.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use thiserror::Error;

const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;

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

fn read_json(path: &Path, code: &str) -> Result<Value> {
    let metadata = fs::symlink_metadata(path).map_err(|_| error(code))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_INPUT_BYTES
    {
        return Err(error(code));
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| error(code))?).map_err(|_| error(code))
}

fn sha256(path: &Path) -> Result<String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| error("retirement_matrix_source_read_failed"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_INPUT_BYTES
    {
        return Err(error("retirement_matrix_source_unsafe"));
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(fs::read(path).map_err(|_| error("retirement_matrix_source_read_failed"))?)
    ))
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

fn target_record(workspace_root: &Path, id: &str) -> Value {
    let Some((_, bounded_context, relative)) = CAPABILITY_TARGETS
        .iter()
        .find(|(candidate, _, _)| *candidate == id)
    else {
        return json!({"id": id, "target": null, "exists": false, "sha256": null});
    };
    let path = workspace_root.join(relative);
    let digest = sha256(&path).ok();
    json!({"id": id, "boundedContext": bounded_context, "target": relative, "exists": digest.is_some(), "sha256": digest})
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
    let matrix = read_json(
        &workspace_root.join("migration/legacy-semantic-migration-matrix.json"),
        "retirement_matrix_source_invalid",
    )?;
    if matrix["version"] != 2 || matrix["kind"] != "LegacySemanticMigrationMatrix" {
        return Err(error("retirement_matrix_source_version_invalid"));
    }
    let rows = matrix["entries"]
        .as_array()
        .ok_or_else(|| error("retirement_matrix_entries_invalid"))?;
    let mut entries = Vec::new();
    let mut source_hash_verified = 0usize;
    let mut source_hash_pending = 0usize;
    let mut target_hash_bound = 0usize;
    let mut target_hash_pending = 0usize;
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
        let source_path = source["path"]
            .as_str()
            .ok_or_else(|| error("retirement_matrix_source_path_invalid"))?;
        let declared_source_hash = source["sha256"]
            .as_str()
            .ok_or_else(|| error("retirement_matrix_source_hash_invalid"))?;
        let current_source_hash = sha256(&workspace_root.join(source_path)).ok();
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
            .map(|id| target_record(workspace_root, id))
            .collect();
        if targets.iter().all(|target| target["exists"] == true) {
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
    use super::inspect_retirement_matrix_v1;
    use std::{fs, path::PathBuf};

    #[test]
    fn current_matrix_is_read_only_and_never_authorizes_retirement() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let runtime =
            std::env::temp_dir().join(format!("hepta-retirement-matrix-{}", std::process::id()));
        fs::create_dir_all(&runtime).unwrap();
        let report = inspect_retirement_matrix_v1(&workspace, &runtime).unwrap();
        assert_eq!(report["readOnly"], true);
        assert_eq!(report["authorityGranted"], false);
        assert_eq!(report["nodeRetirement"], false);
        assert!(report["summary"]["entryCount"].as_u64().unwrap() > 0);
        assert_eq!(report["summary"]["implementationVerified"], 0);
        let _ = fs::remove_dir_all(runtime);
    }
}
