//! Private original capability checks; no trust is created from receipt fields.
use super::{Result, value::*};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Value, json};

const CAPABILITY_KEYS: &[&str] = &[
    "actionConfigurationIdentityHashes",
    "actionKinds",
    "authoritativeSignedLookupSupported",
    "autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash",
    "definitiveNotFoundSupported",
    "expiresAt",
    "idempotentResumeSupported",
    "issuedAt",
    "kind",
    "processIdentityHash",
    "recoveryProcessConfigurationIdentityHash",
    "recoveryTrustIdentityHash",
    "signature",
    "signer",
    "stableKeyContractId",
    "status",
    "version",
];
const SIGNER_KEYS: &[&str] = &[
    "algorithm",
    "keyId",
    "keyVersion",
    "organization",
    "role",
    "subjectId",
];
const TRUST_KEYS: &[&str] = &[
    "algorithm",
    "keyId",
    "keyVersion",
    "organization",
    "role",
    "subjectId",
    "effectiveFrom",
    "expiresAt",
    "revokedAt",
];

pub(super) fn verify(
    receipt: &Value,
    trusted: &Value,
    original_public_key_pem: Option<&str>,
    process_identity: &Value,
    configuration_identity: &Value,
    trust_identity: &Value,
    now_millis: i64,
) -> Result<bool> {
    if !exact(receipt, CAPABILITY_KEYS)
        || receipt["version"].as_f64() != Some(1.0)
        || receipt["kind"] != "AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt"
        || receipt["status"] != "autonomous_research_supervisor_external_action_recovery_qualified"
        || receipt["actionKinds"] != json!(ACTIONS)
        || receipt["authoritativeSignedLookupSupported"] != true
        || receipt["definitiveNotFoundSupported"] != true
        || receipt["idempotentResumeSupported"] != true
        || receipt["stableKeyContractId"]
            != "autonomous-research-supervisor-external-action-stable-key-v1"
        || !sha(&receipt["processIdentityHash"])
        || &receipt["processIdentityHash"] != process_identity
        || !sha(&receipt["recoveryProcessConfigurationIdentityHash"])
        || &receipt["recoveryProcessConfigurationIdentityHash"] != configuration_identity
        || !sha(&receipt["recoveryTrustIdentityHash"])
        || &receipt["recoveryTrustIdentityHash"] != trust_identity
        || !action_identities(&receipt["actionConfigurationIdentityHashes"])
    {
        return Ok(false);
    }
    let (Some(issued), Some(expires)) = (
        canonical(&receipt["issuedAt"]),
        canonical(&receipt["expiresAt"]),
    ) else {
        return Ok(false);
    };
    if expires <= issued {
        return Ok(false);
    }
    // This is reached at the same stage as original now.toISOString(). It does
    // not make invalid clocks override an earlier structural false predicate.
    let now = crate::sqlite_mutation_coordinator::clock::iso(now_millis)
        .map_err(|_| "Invalid time value".to_owned())?;
    if canonical(&Value::String(now)).is_none()
        || now_millis < issued
        || now_millis >= expires
        || !trusted_matches(&receipt["signer"], trusted, issued)
    {
        return Ok(false);
    }
    // The actual V3 adapter supplies a KeyObject, not a string PEM. Its caller
    // therefore passes None here without silently converting the representation.
    // This private verifier still implements the original hash/signature stage
    // for its stated typed input; no public caller can inject replacement trust.
    let Some(pem) = original_public_key_pem else {
        return Ok(false);
    };
    let Some(key) = public_key(pem) else {
        return Ok(false);
    };
    let Some(object) = receipt.as_object() else {
        return Ok(false);
    };
    let mut payload = object.clone();
    payload.remove("signature");
    payload.remove("autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash");
    let payload_hash = hash(
        "AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptPayload",
        &Value::Object(payload.clone()),
    )?;
    payload.insert("signature".into(), receipt["signature"].clone());
    let receipt_hash = hash(
        "AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt",
        &Value::Object(payload),
    )?;
    if receipt["autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash"].as_str()
        != Some(&receipt_hash)
        || !sha(&Value::String(payload_hash.clone()))
    {
        return Ok(false);
    }
    let Some(signature) = receipt["signature"]
        .as_str()
        .filter(|signature| !signature.is_empty())
    else {
        return Ok(false);
    };
    let Some(bytes) = node_signature(signature) else {
        return Ok(false);
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return Ok(false);
    };
    Ok(key
        .verify_strict(payload_hash.as_bytes(), &signature)
        .is_ok())
}

fn signer_valid(value: &Value) -> bool {
    exact(value, SIGNER_KEYS)
        && value["algorithm"] == "Ed25519"
        && value["role"] == "autonomous-research-external-action-recovery-authority"
        && safe_id(&value["keyId"])
        && safe_id(&value["subjectId"])
        && value["keyVersion"].as_f64().is_some_and(|version| {
            version.is_finite()
                && version.fract() == 0.0
                && (1.0..=9_007_199_254_740_991.0).contains(&version)
        })
        && (value["organization"].is_null() || safe_id(&value["organization"]))
}
fn trusted_matches(signer: &Value, trusted: &Value, observed_at: i64) -> bool {
    if !signer_valid(signer) || !exact(trusted, TRUST_KEYS) {
        return false;
    }
    let projection = Value::Object(
        SIGNER_KEYS
            .iter()
            .map(|key| ((*key).to_owned(), trusted[*key].clone()))
            .collect(),
    );
    if !signer_valid(&projection)
        || !SIGNER_KEYS
            .iter()
            .all(|key| strict_equal(&signer[*key], &trusted[*key]))
        || !trusted["revokedAt"].is_null()
    {
        return false;
    }
    matches!((canonical(&trusted["effectiveFrom"]), canonical(&trusted["expiresAt"])),
        (Some(start), Some(end)) if observed_at >= start && observed_at < end)
}
fn strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Object(_), Value::Object(_)) | (Value::Array(_), Value::Array(_)) => {
            std::ptr::eq(left, right)
        }
        _ => left == right,
    }
}
fn public_key(pem: &str) -> Option<VerifyingKey> {
    if pem.is_empty() || pem.contains("PRIVATE KEY") {
        return None;
    }
    let pem = pem.trim();
    let body = pem
        .strip_prefix("-----BEGIN PUBLIC KEY-----")?
        .strip_suffix("-----END PUBLIC KEY-----")?;
    let der = Base64::decode_vec(&body.split_ascii_whitespace().collect::<String>()).ok()?;
    const PREFIX: &[u8] = &[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != 44 || !der.starts_with(PREFIX) {
        return None;
    }
    VerifyingKey::from_bytes(der[12..].try_into().ok()?).ok()
}
fn node_signature(input: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(64);
    let mut bits = 0u32;
    let mut count = 0;
    // Node Buffer base64 decodes the low byte of each ECMAScript UTF-16
    // code unit, including non-ASCII ignored bytes and padding aliases.
    for byte in input.encode_utf16().map(|unit| unit as u8) {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = ((bits << 6) | u32::from(digit)) & 0x00ff_ffff;
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
            if output.len() > 64 {
                return None;
            }
        }
    }
    if output.len() == 64 {
        Some(output)
    } else {
        None
    }
}
