//! Read-only capability operational/conformance proof inspection.
//!
//! The implementation verifies imported receipts against independently stored
//! public keys and current source bytes. It never creates proof or authority.
//! Node is used only by the differential test oracle.

pub(crate) mod authority;
mod bounded;
mod conformance;
mod files;
mod ordered;
mod owner;
pub(crate) mod production;
mod provenance;
mod sealed;

pub(crate) use ordered::Ordered;
pub(crate) use provenance::{ProvenanceObservationV1, current_bounded_code_provenance_v1};

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path, sync::atomic::AtomicBool};
use thiserror::Error;

pub use owner::inspect_ordinary_owner_acceptance_status_with_cancellation_v1;
pub use provenance::{
    current_operational_code_provenance_v1,
    current_operational_code_provenance_with_cancellation_v1,
};
pub use sealed::inspect_operational_sealed_submodules_v1;

/// The capability catalog used by the existing `verify/operational` command.
pub const OPERATIONAL_CAPABILITIES_V1: &[(&str, &str)] = &[
    (
        "research.claim-registry",
        "paper-domain/research/claim-registry.mjs",
    ),
    (
        "research.gap-planner",
        "paper-domain/research/gap-planner.mjs",
    ),
    (
        "research.evidence-ingestor",
        "paper-domain/research/evidence-ingestor.mjs",
    ),
    (
        "research.evidence-quality-gate",
        "paper-domain/research/evidence-quality-gate.mjs",
    ),
    (
        "research.experiment-registry",
        "paper-domain/research/experiment-registry.mjs",
    ),
    (
        "research.formal-verifier",
        "paper-ports/formal-verifier-port.mjs",
    ),
    (
        "research.gpu-pde-solver",
        "paper-composition/automation/pde-poisson-2d-gpu-composition.mjs",
    ),
    (
        "research.gpu-deep-learning-training",
        "paper-composition/automation/deep-learning-gpu-training-composition.mjs",
    ),
    (
        "research.change-proposal",
        "paper-domain/research/change-proposal.mjs",
    ),
    (
        "runtime.sandboxed-worker-runner",
        "paper-ports/worker-runner-port.mjs",
    ),
    (
        "runtime.artifact-repository",
        "paper-ports/artifact-repository-port.mjs",
    ),
    (
        "runtime.job-receipt-store",
        "paper-ports/job-receipt-store-port.mjs",
    ),
    (
        "submission.executor-port",
        "paper-ports/submission-executor-port.mjs",
    ),
    (
        "submission.delivery-runtime",
        "paper-domain/submission/delivery-runtime.mjs",
    ),
    (
        "submission.release-lock",
        "paper-domain/submission/release-lock.mjs",
    ),
    (
        "repair.safe-apply",
        "paper-adapters/referee-revise/repair-executor.mjs",
    ),
];

#[derive(Debug, Error)]
#[error("{0}")]
pub struct OperationalStatusError(pub String);

type Result<T> = std::result::Result<T, OperationalStatusError>;
fn error(code: &str) -> OperationalStatusError {
    OperationalStatusError(code.to_owned())
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
fn record_hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|value| value.as_str().to_owned())
        .map_err(|_| error("capability_proof_record_encoding_invalid"))
}
fn sha(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|value| value.strip_prefix("sha256:"))
        .is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn object_id(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        (40..=64).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|value| {
        value.len() == keys.len() && keys.iter().all(|key| value.contains_key(*key))
    })
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|value| !value.is_empty())
}
fn stripped(value: &Value, keys: &[&str]) -> Value {
    let mut result = value.clone();
    if let Some(result) = result.as_object_mut() {
        for key in keys {
            result.remove(*key);
        }
    }
    result
}
fn common_receipt(document: &Value, capability: &str, targets: &Value, commit: &str) -> bool {
    document["capabilityId"] == capability
        && (nonempty(&document["productionSubject"]["paperId"])
            || nonempty(&document["productionSubject"]["subjectId"]))
        && document["inputHashes"]
            .as_array()
            .is_some_and(|v| !v.is_empty() && v.iter().all(sha))
        && ["executionReceiptHash", "resultHash", "replayReceiptHash"]
            .iter()
            .all(|key| sha(&document[*key]))
        && document["replayMatched"] == true
        && !commit.is_empty()
        && document["releaseCommit"] == commit
        && document["targetHashes"] == *targets
}
fn targets_match_json(snapshot: &files::Snapshot, targets: &Value) -> bool {
    snapshot
        .ordered
        .get("targetHashes")
        .and_then(|value| value.encode(false).ok())
        == serde_json::to_string(targets).ok()
}
fn operational_receipt(
    document: &Value,
    trust: &Value,
    capability: &str,
    targets: &Value,
    commit: &str,
) -> bool {
    document["kind"] == "CapabilityOperationalReceipt"
        && document["version"] == 2
        && document["status"] == "production_runtime_observation_verified"
        && document["executionClass"] == "production_runtime_observation"
        && document["evidenceEnvironment"] == "production"
        && document["evidenceClass"] == "operational"
        && document["productionEligible"] == true
        && common_receipt(document, capability, targets, commit)
        && authority::verify(
            document,
            trust,
            &["capability_owner", "operational_observer"],
            2,
        )
        .is_some_and(|keys| {
            keys.len() >= 2
                && keys
                    .iter()
                    .all(|key| key["assurance"] == "external_independent")
                // Keep the composition-level contract explicit even though
                // authority::verify currently enforces this invariant too.
                && distinct_verified_subjects(&keys)
        })
}

fn distinct_verified_subjects(keys: &[&Value]) -> bool {
    keys.iter()
        .map(|key| {
            key["subjectId"]
                .as_str()
                .unwrap_or_else(|| key["keyId"].as_str().unwrap_or(""))
        })
        .collect::<BTreeSet<_>>()
        .len()
        >= 2
}

/// Inspect the same catalog and runtime receipt layout as Node's status command.
/// The asset root is the current production manuscript root, not receipt input.
/// A pending proof is an ordinary status, while a failed source snapshot is an error.
pub fn capability_operational_proof_status_v1(
    workspace_root: &Path,
    runtime_root: &Path,
    asset_root: &Path,
) -> Result<Value> {
    capability_operational_proof_status_with_cancellation_v1(
        workspace_root,
        runtime_root,
        asset_root,
        &AtomicBool::new(false),
    )
}
fn read_imported_with_observation(
    root: &Path,
    path: &Path,
    observation: &mut bounded::Observation<'_>,
) -> Result<Option<files::Snapshot>> {
    match files::read_with_observation(root, path, observation) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(failure) if failure.0.starts_with("code_provenance_") => Err(failure),
        Err(_) => Ok(None),
    }
}
/// Inspect imported proofs using the existing validation algorithms. Ordinary
/// source observations and receipt directory enumeration have finite budgets.
pub fn capability_operational_proof_status_with_cancellation_v1(
    workspace_root: &Path,
    runtime_root: &Path,
    asset_root: &Path,
    cancelled: &AtomicBool,
) -> Result<Value> {
    let mut observation = bounded::Observation::new(cancelled)?;
    let provenance =
        provenance::current_operational_with_observation(workspace_root, &mut observation)?;
    let commit = provenance["commit"]
        .as_str()
        .ok_or_else(|| error("code_provenance_commit_required"))?;
    let mut catalog = OPERATIONAL_CAPABILITIES_V1.to_vec();
    catalog.sort_by_key(|(id, _)| *id);
    let targets = catalog
        .iter()
        .map(|(id, target)| {
            let path = workspace_root.join(target);
            let digest = if path.exists() {
                Some(hash(
                    &observation.read_file(&path, bounded::MAX_FILE_BYTES)?,
                ))
            } else {
                None
            };
            Ok((id.to_string(), json!([{"path": target, "sha256": digest}])))
        })
        .collect::<Result<std::collections::BTreeMap<_, _>>>()?;
    let mut operational = std::collections::BTreeMap::new();
    if let Some(trust) = read_imported_with_observation(
        runtime_root,
        &runtime_root.join("owner-acceptance/OWNER_TRUST_STORE.json"),
        &mut observation,
    )? {
        let mut accepted = Vec::new();
        let mut enumerated = 0usize;
        for (capability, _) in &catalog {
            observation.checkpoint()?;
            let directory = runtime_root
                .join("operational-proof/capabilities")
                .join(capability);
            let mut paths = Vec::new();
            if let Ok(entries) = fs::read_dir(&directory) {
                for entry in entries {
                    observation.checkpoint()?;
                    enumerated = enumerated
                        .checked_add(1)
                        .filter(|count| *count <= 4096)
                        .ok_or_else(|| error("capability_proof_directory_entry_budget_exceeded"))?;
                    if let Ok(entry) = entry {
                        let path = entry.path();
                        if path
                            .file_name()
                            .is_some_and(|name| name.to_string_lossy().ends_with(".json"))
                        {
                            paths.push(path);
                        }
                    }
                }
            }
            paths.sort();
            let mut receipts = BTreeSet::new();
            for path in paths {
                observation.checkpoint()?;
                if let Some(receipt) =
                    read_imported_with_observation(runtime_root, &path, &mut observation)?
                    && targets_match_json(&receipt, &targets[*capability])
                    && operational_receipt(
                        &receipt.document,
                        &trust.document,
                        capability,
                        &targets[*capability],
                        commit,
                    )
                    && let Ok(digest) =
                        record_hash("CapabilityOperationalReceipt", &receipt.document)
                {
                    receipts.insert(digest);
                    accepted.push(receipt);
                }
            }
            if !receipts.is_empty() {
                operational.insert(*capability, receipts);
            }
        }
        if trust.assert_current().is_err()
            || accepted
                .iter()
                .any(|receipt| receipt.assert_current().is_err())
        {
            operational.clear();
        }
    }
    observation.checkpoint()?;
    let conformance = match conformance::load(
        runtime_root,
        asset_root,
        &provenance,
        &catalog,
        &targets,
        &mut observation,
    ) {
        Ok(value) => value,
        Err(failure) if failure.0.starts_with("code_provenance_") => return Err(failure),
        Err(_) => std::collections::BTreeMap::new(),
    };
    observation.checkpoint()?;
    let capabilities: Vec<_> = catalog.iter().map(|(id, _)| json!({
        "capabilityId": id,
        "operationallyProven": operational.contains_key(id),
        "operationalReceiptHashes": operational.get(id).cloned().unwrap_or_default(),
        "conformanceVerified": conformance.contains_key(*id),
        "conformanceReceiptHashes": conformance.get(*id).map(|proof| vec![proof.0.clone()]).unwrap_or_default(),
        "conformanceIssuerAssurances": conformance.get(*id).map(|proof| vec![proof.1.clone()]).unwrap_or_default(),
    })).collect();
    Ok(json!({
        "version": 1, "kind": "CapabilityOperationalProofStatus",
        "status": if operational.len() == catalog.len() { "all_capabilities_operationally_proven" } else { "capability_operational_proof_pending" },
        "releaseCommit": commit, "capabilityCount": catalog.len(),
        "operationallyProven": operational.len(), "operationallyPending": catalog.len() - operational.len(),
        "conformanceVerified": conformance.len(), "conformancePending": catalog.len() - conformance.len(),
        "conformanceCannotQualifyAsOperationalProof": true, "externalOwnerSignatureRequired": true,
        "capabilities": capabilities,
    }))
}

#[cfg(test)]
mod subject_tests {
    use super::*;

    #[test]
    fn duplicate_subject_ids_are_rejected() {
        let first = json!({"keyId":"key-a","subjectId":"same"});
        let second = json!({"keyId":"key-b","subjectId":"same"});
        assert!(!distinct_verified_subjects(&[&first, &second]));
    }

    #[test]
    fn missing_subject_ids_fall_back_to_distinct_key_ids() {
        let first = json!({"keyId":"key-a"});
        let second = json!({"keyId":"key-b"});
        assert!(distinct_verified_subjects(&[&first, &second]));
    }
}
