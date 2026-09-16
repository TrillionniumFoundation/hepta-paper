//! Ed25519 authority verification with the legacy per-signature blocker report.
use super::{js_string, truthy};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct VerifiedSignature {
    pub value: Value,
    pub spki: String,
    role: String,
    subject: String,
}
pub(super) struct AuthorityVerification {
    pub report: Value,
    pub signatures: Vec<VerifiedSignature>,
    pub blockers: Vec<String>,
}
fn string_or_empty(value: &Value) -> String {
    if truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
}
fn canonical(value: &Value, output: &mut String) -> Option<()> {
    match value {
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                canonical(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by_key(|key| key.encode_utf16().collect::<Vec<_>>());
            keys.sort_by_key(|key| {
                key.parse::<u32>()
                    .ok()
                    .filter(|v| *v != u32::MAX && v.to_string() == **key)
                    .map_or((1, 0), |v| (0, v))
            });
            output.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).ok()?);
                output.push(':');
                canonical(&values[*key], output)?;
            }
            output.push('}');
        }
        _ => output.push_str(
            std::str::from_utf8(
                &hepta_legacy_compatibility::production_stable_json_v1(value).ok()?,
            )
            .ok()?,
        ),
    }
    Some(())
}
// Buffer.from(text,'base64') accepts URL-safe digits, omitted padding and ignored
// whitespace/non-alphabet characters. Reproduce decoding; verification still
// requires the resulting Ed25519 signature to contain exactly 64 bytes.
fn node_base64(input: &str) -> Vec<u8> {
    let mut result = Vec::new();
    let mut bits: u32 = 0;
    let mut count = 0;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = ((bits << 6) | u32::from(value)) & 0x00ff_ffff;
        count += 6;
        if count >= 8 {
            count -= 8;
            result.push((bits >> count) as u8);
        }
    }
    result
}
fn public_key(value: &Value) -> std::result::Result<(VerifyingKey, String), &'static str> {
    let pem = value.as_str().ok_or("trusted_public_key_invalid")?.trim();
    let body = pem
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|v| v.strip_suffix("-----END PUBLIC KEY-----"))
        .ok_or("trusted_public_key_invalid")?;
    let compact = body
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect::<String>();
    let bytes = Base64::decode_vec(&compact).map_err(|_| "trusted_public_key_invalid")?;
    const PREFIX: &[u8] = &[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if bytes.len() == 44 && bytes.starts_with(PREFIX) {
        let key = VerifyingKey::from_bytes(
            bytes[12..]
                .try_into()
                .map_err(|_| "trusted_public_key_invalid")?,
        )
        .map_err(|_| "trusted_public_key_invalid")?;
        return Ok((
            key,
            format!("sha256:{}", hex::encode(Sha256::digest(&bytes))),
        ));
    }
    // Common valid SPKI algorithms need the distinct legacy wrong-key-type error.
    if bytes.first() == Some(&0x30)
        && [
            &[
                0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
            ][..], // RSA
            &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01][..], // EC
            &[0x06, 0x03, 0x2b, 0x65, 0x71][..],                         // Ed448
        ]
        .iter()
        .any(|oid| bytes.windows(oid.len()).any(|window| window == *oid))
    {
        return Err("trusted_key_type_not_ed25519");
    }
    Err("trusted_public_key_invalid")
}
fn unique(values: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    values.retain(|value| seen.insert(value.clone()));
}

pub(super) fn verify_authority(
    document: &Value,
    trust: &Value,
    roles: &[&str],
) -> AuthorityVerification {
    let mut blockers = Vec::new();
    if trust["version"] != 1 || trust["kind"] != "AuthorityTrustStore" {
        blockers.push("authority_trust_store_missing_or_invalid".into());
    }
    let empty = Vec::new();
    let signatures = document["signatures"].as_array().unwrap_or(&empty);
    let required_count = roles.len().max(1);
    if signatures.len() < required_count {
        blockers.push("authority_signatures_missing".into());
    }
    let mut keys = BTreeMap::new();
    let mut duplicates = BTreeSet::new();
    for key in trust["keys"].as_array().unwrap_or(&empty) {
        let id = string_or_empty(&key["keyId"]);
        if id.is_empty() {
            continue;
        }
        if keys.contains_key(&id) || duplicates.contains(&id) {
            keys.remove(&id);
            duplicates.insert(id);
        } else {
            keys.insert(id, key);
        }
    }
    for key in duplicates {
        blockers.push(format!("{key}:duplicate_trust_key_id"));
    }
    let mut payload = document.clone();
    if let Some(object) = payload.as_object_mut() {
        object.remove("signature");
        object.remove("signatures");
    }
    let mut bytes = String::new();
    let encoding_valid = canonical(&payload, &mut bytes).is_some();
    let mut seen = BTreeSet::new();
    let mut verified = Vec::new();
    for signature in signatures {
        let id = string_or_empty(&signature["keyId"]);
        let role = string_or_empty(&signature["role"]);
        let mut failed: Vec<&str> = Vec::new();
        if id.is_empty() {
            failed.push("signature_key_id_missing");
        }
        if role.is_empty() {
            failed.push("signature_role_missing");
        }
        if signature["algorithm"] != "ed25519" {
            failed.push("signature_algorithm_not_ed25519");
        }
        if !seen.insert(id.clone()) {
            failed.push("duplicate_signature_key_id");
        }
        let key = keys.get(&id).copied();
        if key.is_none() {
            failed.push("signature_key_not_trusted");
        }
        let value = key.unwrap_or(&Value::Null);
        if value["status"] != "active" {
            failed.push("signature_key_not_active");
        }
        if value["algorithm"] != "ed25519" {
            failed.push("trusted_key_algorithm_not_ed25519");
        }
        if truthy(&value["privateKeyPem"])
            || string_or_empty(&value["publicKeyPem"]).contains("PRIVATE KEY")
        {
            failed.push("private_key_material_forbidden_in_trust_store");
        }
        if !value["roles"]
            .as_array()
            .is_some_and(|roles| roles.iter().any(|candidate| candidate == &role))
        {
            failed.push("signature_role_not_authorized_for_key");
        }
        let public = key.and_then(|key| match public_key(&key["publicKeyPem"]) {
            Ok(value) => Some(value),
            Err(code) => {
                failed.push(code);
                None
            }
        });
        if failed.is_empty() {
            let signature_bytes = node_base64(&string_or_empty(&signature["value"]));
            let valid = encoding_valid
                && public.as_ref().is_some_and(|(key, _)| {
                    Signature::from_slice(&signature_bytes).is_ok_and(|signature| {
                        key.verify_strict(bytes.as_bytes(), &signature).is_ok()
                    })
                });
            if !valid {
                failed.push("authority_signature_invalid");
            }
        }
        blockers.extend(
            failed.iter().map(|failure| {
                format!("{}:{failure}", if id.is_empty() { "unknown" } else { &id })
            }),
        );
        if failed.is_empty() {
            let Some((_, spki)) = public else {
                blockers.push(format!("{id}:trusted_public_key_invalid"));
                continue;
            };
            let subject = if truthy(&value["subjectId"]) {
                js_string(&value["subjectId"])
            } else {
                id.clone()
            };
            verified.push(VerifiedSignature { value: json!({"keyId": id, "role": role, "subjectId": subject, "organization": if truthy(&value["organization"]) { value["organization"].clone() } else { Value::Null }, "cryptographicallyVerified": true}), spki, role, subject });
        }
    }
    let found_roles = verified
        .iter()
        .map(|v| v.role.as_str())
        .collect::<BTreeSet<_>>();
    let subjects = verified
        .iter()
        .map(|v| v.subject.as_str())
        .collect::<BTreeSet<_>>();
    for role in roles {
        if !found_roles.contains(role) {
            blockers.push(format!("required_authority_role_missing:{role}"));
        }
    }
    if verified.len() < required_count {
        blockers.push("verified_authority_signature_count_insufficient".into());
    }
    if verified.len() > 1 && subjects.len() != verified.len() {
        blockers.push("authority_signers_must_be_distinct_subjects".into());
    }
    unique(&mut blockers);
    let report = json!({ "status": if blockers.is_empty() { "authority_signatures_verified" } else { "authority_signatures_blocked" }, "cryptographicSignaturesVerified": blockers.is_empty(), "requiredRoles": roles, "requiredSignatureCount": required_count, "verifiedSignatures": verified.iter().map(|v| &v.value).collect::<Vec<_>>(), "verifiedRoles": found_roles, "verifiedSubjectIds": subjects, "blockers": blockers });
    AuthorityVerification {
        report,
        signatures: verified,
        blockers,
    }
}
