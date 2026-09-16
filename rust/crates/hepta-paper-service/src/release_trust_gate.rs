//! Pure release trust-layer gate. It evaluates supplied counts only; it never
//! mints external signatures or claims production activation.

use hepta_control_plane::canonical_hash_v1;
use serde_json::{Value, json};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReleaseTrustGateError {
    #[error("release_trust_gate_release_commit_required")]
    ReleaseCommitRequired,
    #[error("release_trust_gate_capability_count_invalid")]
    CapabilityCountInvalid,
    #[error("release_trust_gate_{0}_count_invalid")]
    CountInvalid(&'static str),
    #[error("release_trust_gate_encoding_failed")]
    Encoding,
}

fn bounded_count(
    value: u64,
    required: u64,
    label: &'static str,
) -> Result<u64, ReleaseTrustGateError> {
    if value > required {
        return Err(ReleaseTrustGateError::CountInvalid(label));
    }
    Ok(value)
}

/// Build the same gate payload and content hash as the Node implementation.
pub fn build_release_trust_layer_gate_v1(
    release_commit: &str,
    capability_count: u64,
    implementation_verified: u64,
    release_bound_conformance_verified: u64,
    independent_production_operational_verified: u64,
) -> Result<Value, ReleaseTrustGateError> {
    if release_commit.trim().is_empty() {
        return Err(ReleaseTrustGateError::ReleaseCommitRequired);
    }
    if capability_count == 0 {
        return Err(ReleaseTrustGateError::CapabilityCountInvalid);
    }
    let implementation =
        bounded_count(implementation_verified, capability_count, "implementation")?;
    let conformance = bounded_count(
        release_bound_conformance_verified,
        capability_count,
        "conformance",
    )?;
    let operational = bounded_count(
        independent_production_operational_verified,
        capability_count,
        "operational",
    )?;
    let payload = json!({
        "version": 1,
        "kind": "ReleaseTrustLayerGate",
        "status": if implementation == capability_count && conformance == capability_count { "code_release_trust_layers_ready" } else { "code_release_trust_layers_blocked" },
        "releaseCommit": release_commit,
        "capabilityCount": capability_count,
        "implementation": { "verified": implementation, "required": capability_count, "releaseBlocking": true },
        "releaseBoundConformance": { "verified": conformance, "required": capability_count, "releaseBlocking": true, "productionEligible": false },
        "independentProductionOperational": { "verified": operational, "required": capability_count, "releaseBlocking": false, "externalIndependentRequired": true },
        "conformanceCannotQualifyAsOperationalProof": true,
        "operationalProofCannotSubstituteForReleaseBoundConformance": true,
    });
    let hash =
        canonical_hash_v1(&json!({"kind": "ReleaseTrustLayerGate", "value": payload.clone()}))
            .map_err(|_| ReleaseTrustGateError::Encoding)?;
    let mut result = payload;
    result
        .as_object_mut()
        .ok_or(ReleaseTrustGateError::Encoding)?
        .insert(
            "releaseTrustLayerGateHash".to_owned(),
            Value::String(hash.to_string()),
        );
    Ok(result)
}
