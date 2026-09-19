//! Read-only local preparation for the legacy `release-evidence --execute`
//! route.
//!
//! The Node route also replays the differential suites, captures independently
//! trusted release provenance, signs an evidence bundle and publishes it.  The
//! native route composes only the locally reproducible release-state, trust
//! gate, schema-25 freeze and archive checks.  It never signs, publishes,
//! deletes, or authorizes a release.

use crate::{
    LegacyDeletionDrillAttestationRequestV1, inspect_legacy_deletion_drill_attest_v1,
    release_state::inspect_release_state_v1,
    release_trust_gate::build_release_trust_layer_gate_from_values_v1,
};
use hepta_control_plane::canonical_hash_v1;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

const REQUEST_VERSION: u16 = 1;
const REQUEST_KIND: &str = "ReleaseAttestationRequest";
const REPORT_KIND: &str = "ReleaseAttestationInspection";

/// Input for the locally reproducible part of release attestation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationRequestV1 {
    pub version: u16,
    pub kind: String,
    pub drill: LegacyDeletionDrillAttestationRequestV1,
    pub release_state: Value,
    pub release_trust_gate: Value,
}

#[derive(Debug, Error)]
pub enum ReleaseAttestError {
    #[error("release attestation request is invalid")]
    RequestInvalid,
    #[error("release attestation release-state request is invalid: {0}")]
    ReleaseState(#[from] crate::release_state::ReleaseStateError),
    #[error("release attestation trust-gate request is invalid: {0}")]
    TrustGate(#[from] crate::release_trust_gate::ReleaseTrustGateError),
    #[error("release attestation drill inspection failed: {0}")]
    Drill(#[from] crate::LegacyDeletionDrillAttestError),
    #[error("release attestation report hash failed")]
    Hash,
}

fn external_blockers() -> Vec<&'static str> {
    vec![
        "release_attestation_node_differential_replay_external",
        "release_attestation_policy_replay_external",
        "release_attestation_release_provenance_external",
        "release_attestation_signing_authority_external",
        "release_attestation_runtime_publication_external",
        "release_attestation_owner_acceptance_external",
        "release_attestation_physical_deletion_external",
    ]
}

/// Inspect release attestation without crossing any release authority.
pub fn inspect_release_attestation_v1(
    request: ReleaseAttestationRequestV1,
) -> Result<Value, ReleaseAttestError> {
    if request.version != REQUEST_VERSION
        || request.kind != REQUEST_KIND
        || request.release_state.is_null()
        || request.release_trust_gate.is_null()
        || request.drill.release_commit != request.drill.commit
        || request.release_trust_gate["releaseCommit"]
            .as_str()
            .is_none_or(|value| value != request.drill.release_commit)
    {
        return Err(ReleaseAttestError::RequestInvalid);
    }
    let release_state = inspect_release_state_v1(&request.release_state)?;
    let trust_gate = build_release_trust_layer_gate_from_values_v1(&request.release_trust_gate)?;
    let drill = inspect_legacy_deletion_drill_attest_v1(request.drill)?;
    let mut blockers = external_blockers()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if release_state["ok"] != true {
        blockers.push("release_attestation_release_state_blocked".to_owned());
    }
    if trust_gate["status"] != "code_release_trust_layers_ready" {
        blockers.push("release_attestation_trust_layers_blocked".to_owned());
    }
    blockers.extend(
        drill
            .blockers
            .iter()
            .map(|value| format!("release_attestation_drill:{value}")),
    );
    blockers.sort();
    blockers.dedup();
    let payload = json!({
        "version": REQUEST_VERSION,
        "kind": REPORT_KIND,
        "status": "release_attestation_blocked",
        "releaseState": release_state,
        "releaseTrustGate": trust_gate,
        "drill": drill,
        "blockers": blockers,
        "technicalLocalChecksReady": false,
        "releaseEvidenceReady": false,
        "signingKeyRead": false,
        "runtimeEvidenceWritten": false,
        "physicalDeletionAllowed": false,
        "nodeRetirement": false,
        "externalActionPerformed": false,
    });
    let report_hash = canonical_hash_v1(&json!({
        "kind": REPORT_KIND,
        "value": payload.clone(),
    }))
    .map_err(|_| ReleaseAttestError::Hash)?;
    let mut report = payload;
    report["reportHash"] = json!(report_hash.to_string());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_rejects_mismatched_release_subject_before_filesystem_access() {
        let request = ReleaseAttestationRequestV1 {
            version: REQUEST_VERSION,
            kind: REQUEST_KIND.to_owned(),
            drill: LegacyDeletionDrillAttestationRequestV1 {
                version: 1,
                kind: "LegacyDeletionDrillAttestationRequest".to_owned(),
                legacy_database_path: "/tmp/legacy.sqlite".to_owned(),
                archive_path: "/tmp/archive.tar".to_owned(),
                repository: "TrillionniumFoundation/hepta-paper".to_owned(),
                commit: "a".repeat(40),
                tree: "b".repeat(40),
                release_commit: "c".repeat(40),
                release_state_snapshot_hash: format!("sha256:{}", "d".repeat(64)),
            },
            release_state: json!({}),
            release_trust_gate: json!({}),
        };
        assert!(matches!(
            inspect_release_attestation_v1(request),
            Err(ReleaseAttestError::RequestInvalid)
        ));
    }
}
