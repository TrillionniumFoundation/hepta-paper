//! Pure release trust-layer gate. It evaluates supplied counts only; it never
//! mints external signatures or claims production activation.

use hepta_legacy_compatibility::production_hash_record_v1;
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

fn javascript_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        // Arrays and objects are truthy in JavaScript, including empty ones.
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn javascript_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                _ => javascript_string(value),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn javascript_string_or_empty(value: Option<&Value>) -> String {
    value
        .filter(|value| javascript_truthy(value))
        .map(javascript_string)
        .unwrap_or_default()
}

/// `Number(string)` trims ECMAScript WhiteSpace and LineTerminator code points.
/// This is not the Unicode White_Space set used by Rust's `str::trim`: JavaScript
/// includes BOM (U+FEFF) and excludes Next Line (U+0085).
fn javascript_trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

fn javascript_number_string(
    value: &str,
    label: &'static str,
) -> Result<f64, ReleaseTrustGateError> {
    let value = javascript_trim(value);
    if value.is_empty() {
        return Ok(0.0);
    }
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16)
            .map(|number| number as f64)
            .map_err(|_| ReleaseTrustGateError::CountInvalid(label));
    }
    if let Some(binary) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        return u64::from_str_radix(binary, 2)
            .map(|number| number as f64)
            .map_err(|_| ReleaseTrustGateError::CountInvalid(label));
    }
    if let Some(octal) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        return u64::from_str_radix(octal, 8)
            .map(|number| number as f64)
            .map_err(|_| ReleaseTrustGateError::CountInvalid(label));
    }
    value
        .parse::<f64>()
        .map_err(|_| ReleaseTrustGateError::CountInvalid(label))
}

/// JSON.parse in the incumbent produces IEEE-754 numbers before the gate's
/// record hash is computed.  serde_json can retain a lexical `1.0` float, so
/// normalize integral finite values to the same JSON integer representation;
/// this also makes `-0` serialize as the JavaScript `0`.
fn normalize_javascript_json(value: &Value) -> Value {
    match value {
        Value::Number(number) => {
            let Some(float) = number.as_f64() else {
                return value.clone();
            };
            if !float.is_finite() || float.fract() != 0.0 {
                return value.clone();
            }
            if (0.0..18_446_744_073_709_551_616.0).contains(&float) {
                return Value::Number(serde_json::Number::from(float as u64));
            }
            if (-9_223_372_036_854_775_808.0..0.0).contains(&float) {
                return Value::Number(serde_json::Number::from(float as i64));
            }
            value.clone()
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(normalize_javascript_json).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), normalize_javascript_json(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn js_integer(value: Option<&Value>, label: &'static str) -> Result<u64, ReleaseTrustGateError> {
    let value = value.ok_or(ReleaseTrustGateError::CountInvalid(label))?;
    let number = match value {
        Value::Null => 0.0,
        Value::Bool(value) => u8::from(*value) as f64,
        Value::Number(value) => value
            .as_f64()
            .ok_or(ReleaseTrustGateError::CountInvalid(label))?,
        // `Number(value)` first applies ToPrimitive. For JSON arrays that is
        // Array#toString (null elements become empty fields); recursively
        // converting a singleton boolean would incorrectly turn [true] into
        // 1 instead of the JavaScript NaN from Number("true").
        Value::String(value) => javascript_number_string(value, label)?,
        Value::Array(_) | Value::Object(_) => {
            javascript_number_string(&javascript_string(value), label)?
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
    build_release_trust_layer_gate_value_v1(
        Value::String(release_commit.to_owned()),
        capability_count,
        implementation_verified,
        release_bound_conformance_verified,
        independent_production_operational_verified,
    )
}

fn build_release_trust_layer_gate_value_v1(
    release_commit_value: Value,
    capability_count: u64,
    implementation_verified: u64,
    release_bound_conformance_verified: u64,
    independent_production_operational_verified: u64,
) -> Result<Value, ReleaseTrustGateError> {
    let release_commit_value = normalize_javascript_json(&release_commit_value);
    let release_commit = javascript_string_or_empty(Some(&release_commit_value));
    if javascript_trim(&release_commit).is_empty() {
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
        "releaseCommit": release_commit_value,
        "capabilityCount": capability_count,
        "implementation": { "verified": implementation, "required": capability_count, "releaseBlocking": true },
        "releaseBoundConformance": { "verified": conformance, "required": capability_count, "releaseBlocking": true, "productionEligible": false },
        "independentProductionOperational": { "verified": operational, "required": capability_count, "releaseBlocking": false, "externalIndependentRequired": true },
        "conformanceCannotQualifyAsOperationalProof": true,
        "operationalProofCannotSubstituteForReleaseBoundConformance": true,
    });
    let hash = production_hash_record_v1("ReleaseTrustLayerGate", &payload)
        .map_err(|_| ReleaseTrustGateError::Encoding)?;
    let mut result = payload;
    result
        .as_object_mut()
        .ok_or(ReleaseTrustGateError::Encoding)?
        .insert(
            "releaseTrustLayerGateHash".to_owned(),
            Value::String(hash.as_str().to_owned()),
        );
    Ok(result)
}

/// JSON-facing variant preserving the Node `Number(...)` coercion boundary.
pub fn build_release_trust_layer_gate_from_values_v1(
    input: &Value,
) -> Result<Value, ReleaseTrustGateError> {
    let release_commit =
        normalize_javascript_json(&input.get("releaseCommit").cloned().unwrap_or(Value::Null));
    // `Number(capabilityCount)` cannot throw for JSON values, so the Node
    // gate checks the release-commit requirement before exposing any count
    // validation error. Keep that precedence at the JSON adapter boundary.
    let release_commit_text = javascript_string_or_empty(Some(&release_commit));
    if javascript_trim(&release_commit_text).is_empty() {
        return Err(ReleaseTrustGateError::ReleaseCommitRequired);
    }
    // Keep coercion errors in the same observable order as the incumbent
    // JavaScript call: capability, implementation, conformance, then
    // operational.  Function-argument evaluation order is not a Rust API
    // contract, so materialize each value before constructing the gate.
    let capability_count = js_integer(input.get("capabilityCount"), "capability")?;
    if capability_count == 0 {
        return Err(ReleaseTrustGateError::CapabilityCountInvalid);
    }
    let implementation_verified =
        js_integer(input.get("implementationVerified"), "implementation")?;
    let implementation_verified =
        bounded_count(implementation_verified, capability_count, "implementation")?;
    let release_bound_conformance_verified =
        js_integer(input.get("releaseBoundConformanceVerified"), "conformance")?;
    let release_bound_conformance_verified = bounded_count(
        release_bound_conformance_verified,
        capability_count,
        "conformance",
    )?;
    let independent_production_operational_verified = js_integer(
        input.get("independentProductionOperationalVerified"),
        "operational",
    )?;
    let independent_production_operational_verified = bounded_count(
        independent_production_operational_verified,
        capability_count,
        "operational",
    )?;
    build_release_trust_layer_gate_value_v1(
        release_commit,
        capability_count,
        implementation_verified,
        release_bound_conformance_verified,
        independent_production_operational_verified,
    )
}
