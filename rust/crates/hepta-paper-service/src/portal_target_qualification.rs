//! Native local portal-qualification operator. Every qualification remains
//! distinct from human single-use live-commit authorization. No network or
//! credential code is involved in any of the four operations.
mod cli;
mod files;
mod preflight;
pub use cli::{PortalTargetQualificationCliOutputV1, portal_target_qualification_cli_at_v1};

use crate::journal_connector_coverage::qualification::{
    PortalTargetQualificationOptionsV1, canonical_instant_millis,
    inspect_portal_target_qualification_registry_v1,
    operator_support::{Document, EVIDENCE_TYPES},
};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{0}")]
pub struct PortalTargetQualificationError(pub String);
type Result<T> = std::result::Result<T, PortalTargetQualificationError>;
fn error(value: impl Into<String>) -> PortalTargetQualificationError {
    PortalTargetQualificationError(value.into())
}
impl From<crate::journal_connector_coverage::JournalConnectorCoverageError>
    for PortalTargetQualificationError
{
    fn from(value: crate::journal_connector_coverage::JournalConnectorCoverageError) -> Self {
        error(value.to_string())
    }
}
/// Paths and cryptographic pins, with an explicit clock for reproducible evaluation.
#[derive(Clone, Debug, Default)]
pub struct PortalTargetQualificationOperatorOptionsV1 {
    pub registry_path: Option<PathBuf>,
    pub candidate_path: Option<PathBuf>,
    pub trust_store_path: Option<PathBuf>,
    pub expected_registry_hash: Option<String>,
    pub expected_candidate_file_hash: Option<String>,
    pub expected_trust_store_hash: Option<String>,
    pub expected_plan_hash: Option<String>,
    pub now_unix_ms: i64,
    pub target_venue_ids: Vec<String>,
    pub requested_qualification_level: Option<String>,
    pub expected_target_bindings: BTreeMap<String, Value>,
}
fn hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|v| v.as_str().to_owned())
        .map_err(|_| error("portal_target_qualification_hash_failed"))
}
fn sha(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn pin(value: Option<&str>, code: &str, required: bool) -> Result<Option<String>> {
    match value.filter(|v| !v.is_empty()) {
        Some(v) => {
            let lower = v.to_lowercase();
            if !sha(&lower) {
                return Err(error(code));
            }
            Ok(Some(lower))
        }
        None if required => Err(error(code)),
        None => Ok(None),
    }
}
fn array(value: &Value) -> Result<&[Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| error("portal_target_qualification_registry_structure_invalid"))
}
fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .ok_or_else(|| error("portal_target_qualification_registry_structure_invalid"))
}
fn instant(value: &Value) -> Option<i64> {
    value.as_str().and_then(canonical_instant_millis)
}
fn referenced_external(value: &Value) -> bool {
    value["entries"].as_array().is_some_and(|entries| {
        !entries.is_empty()
            && entries.iter().all(|e| {
                EVIDENCE_TYPES
                    .iter()
                    .any(|t| e["evidence"][*t]["externalActionPerformed"] == true)
            })
    })
}
/// Read-only, exact semantic pin plus byte-pinned trust and real signature checks.
pub fn inspect_portal_target_qualification_v1(
    options: &PortalTargetQualificationOperatorOptionsV1,
) -> Result<Value> {
    let empty = PathBuf::new();
    Ok(
        inspect_portal_target_qualification_registry_v1(PortalTargetQualificationOptionsV1 {
            registry_path: options.registry_path.as_ref().unwrap_or(&empty),
            trust_store_path: options.trust_store_path.as_deref(),
            expected_registry_hash: options.expected_registry_hash.as_deref(),
            expected_trust_store_hash: options.expected_trust_store_hash.as_deref(),
            now_unix_ms: options.now_unix_ms,
        })?
        .report()
        .clone(),
    )
}
/// Read-only redacted lint; it does not import, produce evidence, or sign anything.
pub fn preflight_portal_target_qualification_v1(
    options: &PortalTargetQualificationOperatorOptionsV1,
) -> Result<Value> {
    preflight::run(options)
}

struct Plan {
    report: Value,
    candidate: files::Snapshot,
    trust: files::Snapshot,
    current: Option<files::Snapshot>,
}
fn verified(
    document: &Document,
    trust: &Document,
    now: i64,
    require_current: bool,
) -> Result<Vec<String>> {
    if !document.structure_valid()? {
        return Ok(vec![
            "portal_target_qualification_registry_structure_invalid".into(),
        ]);
    }
    let mut blockers = document.authority_blockers(trust);
    if blockers.is_empty() && require_current {
        blockers.extend(document.freshness(now));
    }
    let mut seen = std::collections::BTreeSet::new();
    blockers.retain(|v| seen.insert(v.clone()));
    Ok(blockers)
}
fn monotonic(current: Option<&Value>, candidate: &Value) -> Result<()> {
    let Some(current) = current else {
        if candidate["generation"] != 1
            || !candidate["predecessorRegistryHash"].is_null()
            || !array(&candidate["revokedQualificationHashes"])?.is_empty()
        {
            return Err(error(
                "portal_target_qualification_initial_generation_invalid",
            ));
        }
        return Ok(());
    };
    if candidate["generation"].as_u64()
        != current["generation"]
            .as_u64()
            .and_then(|v| v.checked_add(1))
        || candidate["predecessorRegistryHash"] != current["portalTargetQualificationRegistryHash"]
        || instant(&candidate["issuedAt"]) <= instant(&current["issuedAt"])
    {
        return Err(error(
            "portal_target_qualification_generation_not_monotonic",
        ));
    }
    let previous = array(&current["entries"])?;
    let entries = array(&candidate["entries"])?;
    let revoked = array(&candidate["revokedQualificationHashes"])?;
    if revoked.iter().any(|h| {
        !previous
            .iter()
            .any(|e| e["portalTargetQualificationHash"] == *h)
    }) {
        return Err(error("portal_target_qualification_revocation_not_current"));
    }
    for prior in previous {
        let next = entries
            .iter()
            .find(|entry| entry["venueId"] == prior["venueId"]);
        let changed = next.is_none_or(|next| {
            next["portalTargetQualificationHash"] != prior["portalTargetQualificationHash"]
        });
        if changed != revoked.contains(&prior["portalTargetQualificationHash"]) {
            return Err(error(format!(
                "portal_target_qualification_revocation_required:{}",
                text(&prior["venueId"])?
            )));
        }
    }
    if entries
        .iter()
        .any(|e| revoked.contains(&e["portalTargetQualificationHash"]))
    {
        return Err(error("portal_target_qualification_revoked_entry_reused"));
    }
    Ok(())
}
fn plan(options: &PortalTargetQualificationOperatorOptionsV1) -> Result<Plan> {
    let candidate_pin = pin(
        options.expected_candidate_file_hash.as_deref(),
        "portal_target_qualification_candidate_pin_required",
        true,
    )?;
    let trust_pin = pin(
        options.expected_trust_store_hash.as_deref(),
        "portal_target_qualification_trust_store_pin_required",
        true,
    )?;
    let trust = files::read(
        options.trust_store_path.as_deref(),
        trust_pin.as_deref(),
        "portal_target_qualification_trust_store_invalid",
    )?;
    let candidate = files::read(
        options.candidate_path.as_deref(),
        candidate_pin.as_deref(),
        "portal_target_qualification_candidate_invalid",
    )?;
    let blockers = verified(
        &candidate.document,
        &trust.document,
        options.now_unix_ms,
        true,
    )?;
    if !blockers.is_empty() {
        return Err(error(format!(
            "portal_target_qualification_candidate_blocked:{}",
            blockers.join(",")
        )));
    }
    let registry_path = files::normalize(options.registry_path.as_deref())?;
    let current = files::read_optional(
        &registry_path,
        "portal_target_qualification_registry_file_invalid",
    )?;
    if let Some(current) = &current {
        let blockers = verified(
            &current.document,
            &trust.document,
            options.now_unix_ms,
            false,
        )?;
        if !blockers.is_empty() {
            return Err(error(format!(
                "portal_target_qualification_current_registry_blocked:{}",
                blockers.join(",")
            )));
        }
    }
    let value = &candidate.document.value;
    monotonic(current.as_ref().map(|s| &s.document.value), value)?;
    let mut report = json!({
        "version":1,"kind":"PortalTargetQualificationRegistryImportPlan","status":"portal_target_qualification_registry_import_planned",
        "registryPath":registry_path,"currentRegistryHash":current.as_ref().map(|r| &r.document.value["portalTargetQualificationRegistryHash"]),
        "candidatePath":candidate.path,"candidateFileHash":candidate.file_hash,"candidateRegistryHash":value["portalTargetQualificationRegistryHash"],
        "candidateGeneration":value["generation"],"trustStorePath":trust.path,"trustStoreFileHash":trust.file_hash,
        "targetVenueIds":array(&value["entries"])?.iter().map(|e| e["venueId"].clone()).collect::<Vec<_>>(),
        "liveCommitAuthorizationIncluded":false,"humanSingleUseAuthorizationRequired":true,
    });
    report["planHash"] = json!(hash(
        "PortalTargetQualificationRegistryImportPlan",
        &report
    )?);
    report["candidate"] = value.clone();
    report["safety"] = json!({"mutationPerformed":false,"externalActionPerformed":false,"referencedEvidenceExternalActionPerformed":referenced_external(value),"liveCommitPermitProduced":false,"liveCommitPermitConsumed":false});
    trust.assert_current()?;
    candidate.assert_current()?;
    if let Some(current) = &current {
        current.assert_current()?;
    }
    Ok(Plan {
        report,
        candidate,
        trust,
        current,
    })
}
/// Verify signatures, byte pins and successor/revocation continuity without mutation.
pub fn plan_portal_target_qualification_import_v1(
    options: &PortalTargetQualificationOperatorOptionsV1,
) -> Result<Value> {
    Ok(plan(options)?.report)
}
/// Execute exactly one local atomic publication after rechecking the bound plan
/// under an exclusive lock. All input and output file handles are locally scoped.
pub fn execute_portal_target_qualification_import_v1(
    options: &PortalTargetQualificationOperatorOptionsV1,
) -> Result<Value> {
    let expected = pin(
        options.expected_plan_hash.as_deref(),
        "portal_target_qualification_plan_hash_required",
        true,
    )?
    .ok_or_else(|| error("portal_target_qualification_plan_hash_required"))?;
    let initial = plan(options)?;
    if initial.report["planHash"] != expected {
        return Err(error("portal_target_qualification_plan_hash_mismatch"));
    }
    let registry_path = PathBuf::from(text(&initial.report["registryPath"])?);
    let lock = files::RegistryLock::acquire(&registry_path, &expected)?;
    let before = plan(options)?;
    if before.report["planHash"] != expected {
        return Err(error("portal_target_qualification_plan_stale"));
    }
    before.trust.assert_current()?;
    before.candidate.assert_current()?;
    if let Some(current) = &before.current {
        current.assert_current()?;
    }
    let publication = lock.publish(
        &before.candidate.document.publication_bytes()?,
        before.current.as_ref(),
    )?;
    let mut inspect_options = options.clone();
    inspect_options.registry_path = Some(registry_path.clone());
    inspect_options.expected_registry_hash = before.report["candidateRegistryHash"]
        .as_str()
        .map(str::to_owned);
    let inspection = inspect_portal_target_qualification_v1(&inspect_options).and_then(|report| {
        before.trust.assert_current()?;
        lock.assert_current()?;
        if report["ready"] != true {
            return Err(error(
                array(&report["blockers"])?
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
            ));
        }
        Ok(report)
    });
    let inspection = match inspection {
        Ok(inspection) => {
            publication.commit()?;
            inspection
        }
        Err(failed) => {
            publication
                .rollback()
                .map_err(|_| error("portal_target_qualification_post_import_rollback_failed"))?;
            return Err(error(format!(
                "portal_target_qualification_post_import_verification_failed:{failed}"
            )));
        }
    };
    Ok(
        json!({"version":1,"kind":"PortalTargetQualificationRegistryImportReceipt","status":"portal_target_qualification_registry_imported","planHash":expected,"registryPath":registry_path,"registryHash":inspection["registryHash"],"generation":inspection["generation"],"targetVenueIds":before.report["targetVenueIds"],"inspection":inspection,"externalActionPerformed":false,"liveCommitPermitProduced":false,"liveCommitPermitConsumed":false,"humanSingleUseAuthorizationRequired":true}),
    )
}
