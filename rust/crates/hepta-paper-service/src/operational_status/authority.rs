use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

// Authority signatures use ECMAScript's UTF-16 key ordering, distinct from the
// locale collation used by record hashes. Restrict only unsupported encodings;
// never treat an unparsed or unverified key as trusted.
fn canonical(value: &Value, output: &mut String) -> Option<()> {
    match value {
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by_key(|key| key.encode_utf16().collect::<Vec<_>>());
            // JSON.stringify enumerates array-index object keys before all other keys.
            keys.sort_by_key(|key| {
                key.parse::<u32>()
                    .ok()
                    .filter(|v| *v != u32::MAX && v.to_string() == **key)
                    .map_or((1, 0), |v| (0, v))
            });
            output.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).ok()?);
                output.push(':');
                canonical(&values[*key], output)?;
            }
            output.push('}');
        }
        // Numeric encoding is checked against the production encoder (scalar
        // values have no collation difference).
        _ => output.push_str(
            std::str::from_utf8(
                &hepta_legacy_compatibility::production_stable_json_v1(value).ok()?,
            )
            .ok()?,
        ),
    }
    Some(())
}
fn public_key(pem: &str) -> Option<VerifyingKey> {
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")?
        .strip_suffix("-----END PUBLIC KEY-----")?;
    let bytes = Base64::decode_vec(
        &body
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect::<String>(),
    )
    .ok()?;
    // RFC 8410 SubjectPublicKeyInfo, id-Ed25519, absent parameters.
    const PREFIX: &[u8] = &[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if bytes.len() != 44 || !bytes.starts_with(PREFIX) {
        return None;
    }
    VerifyingKey::from_bytes(bytes[12..].try_into().ok()?).ok()
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn js_string(value: &Value) -> Option<String> {
    match value {
        Value::String(v) => Some(v.clone()),
        Value::Array(values) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    Some(String::new())
                } else {
                    js_string(v)
                }
            })
            .collect::<Option<Vec<_>>>()
            .map(|v| v.join(",")),
        Value::Object(values) => {
            if values.contains_key("toString") {
                None
            } else {
                Some("[object Object]".into())
            }
        }
        value => {
            String::from_utf8(hepta_legacy_compatibility::production_stable_json_v1(value).ok()?)
                .ok()
        }
    }
}
fn js_or_empty(value: &Value) -> Option<String> {
    if truthy(value) {
        js_string(value)
    } else {
        Some(String::new())
    }
}
// Buffer.from(value, 'base64') is deliberately lenient for signature values:
// whitespace, URL-safe alphabet and omitted padding still describe the same
// 64 signed bytes. This decoder is NEVER used for public-key PEM material.
fn signature_bytes(encoded: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut pending = 0u16;
    let mut bits = 0u8;
    for byte in encoded.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        pending = (pending << 6) | u16::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((pending >> bits) as u8);
            pending &= (1 << bits) - 1;
            if bytes.len() > 64 {
                return None;
            }
        }
    }
    (bytes.len() == 64).then_some(bytes)
}
pub(crate) fn verify<'a>(
    document: &Value,
    trust: &'a Value,
    roles: &[&str],
    minimum: usize,
) -> Option<Vec<&'a Value>> {
    if trust["version"] != 1 || trust["kind"] != "AuthorityTrustStore" {
        return None;
    }
    let mut keys = BTreeMap::new();
    for key in trust["keys"].as_array()? {
        let id = js_or_empty(&key["keyId"])?;
        if id.is_empty() {
            continue;
        }
        if keys.insert(id, key).is_some() {
            return None;
        }
    }
    let mut payload = String::new();
    canonical(
        &super::stripped(document, &["signature", "signatures"]),
        &mut payload,
    )?;
    let signatures = document["signatures"].as_array()?;
    if signatures.len() < minimum {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut subjects = BTreeSet::new();
    let mut found_roles = BTreeSet::new();
    let mut verified = Vec::new();
    for signature in signatures {
        let id = js_or_empty(&signature["keyId"])?;
        let role = js_or_empty(&signature["role"])?;
        if id.is_empty()
            || role.is_empty()
            || !seen.insert(id.clone())
            || signature["algorithm"] != "ed25519"
        {
            return None;
        }
        let key = *keys.get(&id)?;
        if key["status"] != "active"
            || key["algorithm"] != "ed25519"
            || key.get("privateKeyPem").is_some_and(truthy)
            || !key["roles"]
                .as_array()?
                .iter()
                .any(|value| value == role.as_str())
        {
            return None;
        }
        let pem = key["publicKeyPem"].as_str()?;
        if pem.contains("PRIVATE KEY") {
            return None;
        }
        let public = public_key(pem)?;
        let encoded = js_or_empty(&signature["value"])?;
        let bytes = signature_bytes(&encoded)?;
        let signature = Signature::from_slice(&bytes).ok()?;
        public.verify_strict(payload.as_bytes(), &signature).ok()?;
        let subject = if truthy(&key["subjectId"]) {
            js_string(&key["subjectId"])?
        } else {
            id.clone()
        };
        if !subjects.insert(subject) {
            return None;
        }
        found_roles.insert(role);
        verified.push(key);
    }
    if verified.len() < minimum || roles.iter().any(|role| !found_roles.contains(*role)) {
        return None;
    }
    Some(verified)
}
