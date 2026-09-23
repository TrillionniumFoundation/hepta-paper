//! Native, read-only legacy capability owner acceptance projection.
//! Family hashes are rebuilt from the current migration input; signatures alone
//! cannot authorize a different source or business disposition.
pub(crate) mod reader;

use crate::operational_status::authority;
use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{0}")]
pub struct OwnerStatusError(pub String);
type Result<T> = std::result::Result<T, OwnerStatusError>;
fn error(code: &str) -> OwnerStatusError {
    OwnerStatusError(code.into())
}
fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("legacy_owner_acceptance_matrix_invalid"))
}
fn hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|h| h.as_str().into())
        .map_err(|_| error("legacy_owner_acceptance_hash_invalid"))
}
fn capabilities(source: &str) -> Vec<&'static str> {
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
fn safe_id(text: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if separator && !result.is_empty() {
                result.push('-');
            }
            result.push(ch);
            separator = false;
        } else {
            separator = true;
        }
    }
    result
}
/// Rebuild the entire family manifest from current explicit-retirement rows.
pub fn build_owner_acceptance_families_v1(matrix: &Value) -> Result<Value> {
    let rows = matrix["entries"]
        .as_array()
        .ok_or_else(|| error("legacy_owner_acceptance_matrix_invalid"))?;
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut ids = std::collections::BTreeSet::new();
    for row in rows
        .iter()
        .filter(|r| r["verificationClass"] == "explicit_retirement")
    {
        let id = string(row, "id")?;
        if !ids.insert(id) {
            return Err(error("legacy_owner_acceptance_entry_id_invalid"));
        }
        let action = string(row, "migrationAction")?;
        let source = string(&row["source"], "path")?;
        let decision = if [
            "retired_legacy_submission_schema_superseded_by_native_lifecycle",
            "retired_legacy_research_source_mutation_or_patch_queue_control_plane",
        ]
        .contains(&action)
        {
            "superseded_with_coverage"
        } else {
            "permanent_retirement"
        };
        let mut caps = if decision == "permanent_retirement" {
            Vec::new()
        } else {
            capabilities(source)
        };
        caps.sort();
        caps.dedup();
        let key = if caps.is_empty() {
            format!("retirement:{action}")
        } else {
            format!("{decision}:{}", caps.join("+"))
        };
        groups.entry(key).or_default().push(json!({"id":id, "sourceSha256":string(&row["source"], "sha256")?, "migrationAction":action, "businessDecision":decision, "capabilityIds":caps}));
    }
    let collation = ProductionCollationV1::load()
        .map_err(|_| error("legacy_owner_acceptance_collation_invalid"))?;
    let mut groups = groups.into_iter().collect::<Vec<_>>();
    groups.sort_by(|a, b| collation.compare(&a.0, &b.0));
    let mut families = Vec::new();
    for (key, mut entries) in groups {
        entries.sort_by(|a, b| {
            collation.compare(
                a["id"].as_str().unwrap_or_default(),
                b["id"].as_str().unwrap_or_default(),
            )
        });
        let first = &entries[0];
        let mut family = json!({"version":1,"kind":"CapabilityOwnerAcceptanceFamily","familyId":format!("family:{}",safe_id(&key)),"businessDecision":first["businessDecision"],"migrationAction":first["migrationAction"],"capabilityIds":first["capabilityIds"],"legacyEntries":entries.iter().map(|e|json!({"legacyMatrixEntryId":e["id"],"sourceSha256":e["sourceSha256"]})).collect::<Vec<_>>()});
        family["familyHash"] = json!(hash("CapabilityOwnerAcceptanceFamily", &family)?);
        families.push(family);
    }
    let payload = json!({"version":1,"kind":"CapabilityOwnerAcceptanceFamilyManifest","families":families.iter().map(|f|json!({"familyId":f["familyId"],"familyHash":f["familyHash"]})).collect::<Vec<_>>()});
    let mut manifest = payload.clone();
    manifest["familyManifestHash"] =
        json!(hash("CapabilityOwnerAcceptanceFamilyManifest", &payload)?);
    manifest["families"] = json!(families);
    Ok(manifest)
}

/// Only inspect signed values. This routine never generates acceptance.
pub fn owner_acceptance_status_from_values_v1(
    matrix: &Value,
    manifest: &Value,
    document: &Value,
    trust: &Value,
) -> Result<Value> {
    let generated = build_owner_acceptance_families_v1(matrix)?;
    if generated != *manifest {
        return Err(error("legacy_owner_acceptance_active_manifest_drift"));
    }
    let families = generated["families"]
        .as_array()
        .ok_or_else(|| error("legacy_owner_acceptance_family_manifest_invalid"))?;
    let count = families
        .iter()
        .map(|f| f["legacyEntries"].as_array().map_or(0, Vec::len))
        .sum::<usize>();
    let mut accepted = BTreeMap::new();
    let mut assurance = "unspecified";
    if document["kind"] == "CapabilityOwnerAcceptance"
        && (document["version"] == 1 || document["version"] == 2)
        // Node's loader rejects the entire signed document when a null array
        // entry throws during family/entry indexing; never retain a prefix.
        && document[if document["version"] == 2 { "acceptedFamilies" } else { "acceptedEntries" }]
            .as_array().is_none_or(|entries| entries.iter().all(|entry| !entry.is_null()))
        && let Some(keys) = authority::verify(document, trust, &["capability_owner"], 1)
    {
        assurance = keys
            .first()
            .and_then(|k| k["assurance"].as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or("unspecified");
        if document["version"] == 2
            && document["familyManifestHash"] == generated["familyManifestHash"]
        {
            let mut by_family = BTreeMap::new();
            for entry in document["acceptedFamilies"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(id) = entry["familyId"].as_str() {
                    by_family.insert(id, entry);
                }
            }
            for family in families {
                if let Some(entry) = family["familyId"].as_str().and_then(|id| by_family.get(id))
                    && entry["familyHash"] == family["familyHash"]
                    && entry["businessDecision"] == family["businessDecision"]
                {
                    for legacy in family["legacyEntries"].as_array().into_iter().flatten() {
                        accepted.insert(
                            legacy["legacyMatrixEntryId"].as_str().unwrap_or_default(),
                            (
                                family["businessDecision"].clone(),
                                legacy["sourceSha256"].clone(),
                            ),
                        );
                    }
                }
            }
        } else if document["version"] == 1 {
            for entry in document["acceptedEntries"].as_array().into_iter().flatten() {
                if let Some(id) = entry["legacyMatrixEntryId"].as_str() {
                    accepted.insert(
                        id,
                        (
                            entry["businessDecision"].clone(),
                            entry["sourceSha256"].clone(),
                        ),
                    );
                }
            }
        }
    }
    let mut accepted_count = 0;
    for family in families {
        for entry in family["legacyEntries"].as_array().into_iter().flatten() {
            if let Some((decision, source)) = entry["legacyMatrixEntryId"]
                .as_str()
                .and_then(|id| accepted.get(id))
                && *decision == family["businessDecision"]
                && *source == entry["sourceSha256"]
            {
                accepted_count += 1;
            }
        }
    }
    let external = if assurance == "external_independent" {
        accepted_count
    } else {
        0
    };
    let local = if assurance == "local_admin_delegated" {
        accepted_count
    } else {
        0
    };
    Ok(
        json!({"version":1,"kind":"CapabilityOwnerAcceptanceStatus","status":if external == count {"external_independent_owner_acceptance_complete"}else if local == count {"local_admin_delegated_owner_acceptance_complete"}else{"owner_acceptance_pending"},"familyCount":families.len(),"entryCount":count,"ownerAccepted":accepted_count,"externallyOwnerAccepted":external,"localAdminOwnerAccepted":local,"ownerAcceptancePending":count-accepted_count,"assurance":if external==count{"external_independent"}else if local==count{"local_admin_delegated"}else{"mixed_or_pending"},"independentExternalAcceptanceComplete":external==count,"externalSignatureRequiredForIndependentAssurance":true,"automaticAcceptanceForbidden":true}),
    )
}

/// Inspect current matrix/manifest input and imported public trust/acceptance.
pub fn inspect_owner_acceptance_status_v1(
    workspace_root: &Path,
    runtime_root: &Path,
) -> Result<Value> {
    // Source files may belong to a group-writable development checkout. Public
    // trust and acceptance intake must not be writable by group or others.
    let matrix = reader::read(
        &workspace_root.join("migration/legacy-semantic-migration-matrix.json"),
        false,
    )?;
    let manifest = reader::read(
        &workspace_root
            .join("paper-domain/governance/legacy-owner-acceptance-family-manifest.v1.json"),
        false,
    )?;
    let document = reader::read(
        &runtime_root.join("owner-acceptance/CAPABILITY_OWNER_ACCEPTANCE.json"),
        true,
    )
    .ok();
    let trust = reader::read(
        &runtime_root.join("owner-acceptance/OWNER_TRUST_STORE.json"),
        true,
    )
    .ok();
    let result = owner_acceptance_status_from_values_v1(
        &matrix.document,
        &manifest.document,
        document
            .as_ref()
            .map_or(&Value::Null, |value| &value.document),
        trust.as_ref().map_or(&Value::Null, |value| &value.document),
    )?;
    matrix.assert_current()?;
    manifest.assert_current()?;
    if document
        .as_ref()
        .is_some_and(|value| value.assert_current().is_err())
        || trust
            .as_ref()
            .is_some_and(|value| value.assert_current().is_err())
    {
        return owner_acceptance_status_from_values_v1(
            &matrix.document,
            &manifest.document,
            &Value::Null,
            &Value::Null,
        );
    }
    Ok(result)
}
