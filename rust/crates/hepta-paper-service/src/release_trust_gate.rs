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

fn js_integer(value: Option<&Value>, label: &'static str) -> Result<u64, ReleaseTrustGateError> {
    let value = value.ok_or(ReleaseTrustGateError::CountInvalid(label))?;
    let number = match value {
        Value::Null => 0.0,
        Value::Bool(value) => u8::from(*value) as f64,
        Value::Number(value) => value
            .as_f64()
            .ok_or(ReleaseTrustGateError::CountInvalid(label))?,
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty() {
                0.0
            } else if let Some(hex) = value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
            {
                u64::from_str_radix(hex, 16)
                    .map_err(|_| ReleaseTrustGateError::CountInvalid(label))? as f64
            } else {
                value
                    .parse::<f64>()
                    .map_err(|_| ReleaseTrustGateError::CountInvalid(label))?
            }
        }
        // JavaScript converts [] to 0 and [x] through String(x). Other objects
        // become NaN; keep the same fail-closed result for those cases.
        Value::Array(values) if values.is_empty() => 0.0,
        Value::Array(values) if values.len() == 1 => js_integer(values.first(), label)? as f64,
        Value::Array(_) | Value::Object(_) => {
            return Err(ReleaseTrustGateError::CountInvalid(label));
        }
    };
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 || number > u64::MAX as f64 {
        return Err(ReleaseTrustGateError::CountInvalid(label));
    }
    Ok(number as u64)
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

/// JSON-facing variant preserving the Node `Number(...)` coercion boundary.
pub fn build_release_trust_layer_gate_from_values_v1(
    input: &Value,
) -> Result<Value, ReleaseTrustGateError> {
    let release_commit = input
        .get("releaseCommit")
        .and_then(Value::as_str)
        .unwrap_or_default();
    build_release_trust_layer_gate_v1(
        release_commit,
        js_integer(input.get("capabilityCount"), "capability")?,
        js_integer(input.get("implementationVerified"), "implementation")?,
        js_integer(input.get("releaseBoundConformanceVerified"), "conformance")?,
        js_integer(
            input.get("independentProductionOperationalVerified"),
            "operational",
        )?,
    )
}
