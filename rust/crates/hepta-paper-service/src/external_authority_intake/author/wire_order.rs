//! Insertion-order half of the incumbent configuration's JSON.stringify check.
//!
//! serde_json::Value deliberately remains unordered in this workspace. The
//! production JSON parser retains UTF-16 property names, first insertion
//! position, and the last value for duplicate names, matching JSON.parse.
//! Comparing parsed property names avoids rejecting harmless whitespace,
//! escapes, duplicate spellings, or equivalent number encodings in the file.
//! Semantic values, hashes, key sorting, and signatures belong to author.rs.

use hepta_legacy_compatibility::{
    ProductionJsonValue, parse_production_json_v1, production_stable_json_v1,
};
use serde_json::{Map, Value};
use std::cmp::Ordering;

const CONFIGURATION_V1_ORDER: &[&str] = &[
    "version",
    "kind",
    "status",
    "trustStoreHash",
    "signerKeyIds",
    "signerRole",
    "maximumLifetimeMs",
    "subject",
    "authorityEnvelope",
    "trustStore",
    "configurationHash",
];
const CONFIGURATION_V2_ORDER: &[&str] = &[
    "version",
    "kind",
    "status",
    "trustStoreHash",
    "signerKeyIds",
    "signerRole",
    "maximumLifetimeMs",
    "identityPolicy",
    "subject",
    "authorityEnvelope",
    "trustStore",
    "configurationHash",
];
const SUBJECT_ORDER: &[&str] = &[
    "version",
    "kind",
    "serviceId",
    "principalId",
    "provider",
    "providerAccountIdentityHash",
    "credentialRootIdentityHash",
    "hostIdentityHash",
    "processIdentityHash",
    "trustDomainIdentityHash",
    "signerPublicKeySpkiHash",
    "challengeHash",
    "assuranceProfile",
    "attestedAt",
    "expiresAt",
    "externalPrincipalIdentityAttestationSubjectHash",
];
const POLICY_ORDER: &[&str] = &[
    "version",
    "kind",
    "serviceId",
    "principalId",
    "provider",
    "providerAccountIdentityHash",
    "credentialRootIdentityHash",
    "trustDomainIdentityHash",
    "signerPublicKeySpkiHash",
    "assuranceProfile",
    "platformAttestationRequired",
];
const ENVELOPE_ORDER: &[&str] = &[
    "version",
    "kind",
    "subjectKind",
    "subjectHash",
    "signedAt",
    "expiresAt",
    "signatures",
];
const TRUST_STORE_ORDER: &[&str] = &["version", "kind", "keys"];
const TRUST_KEY_ORDER: &[&str] = &[
    "keyId",
    "subjectId",
    "organization",
    "algorithm",
    "publicKeyPem",
    "roles",
    "status",
    "effectiveFrom",
    "expiresAt",
    "revokedAt",
];
const SIGNATURE_KEYS: &[&str] = &["algorithm", "keyId", "role", "value"];

fn key_matches(key: &[u16], expected: &str) -> bool {
    key.iter().copied().eq(expected.encode_utf16())
}

fn property<'a>(value: &'a ProductionJsonValue, name: &str) -> Option<&'a ProductionJsonValue> {
    let ProductionJsonValue::Object(entries) = value else {
        return None;
    };
    entries
        .iter()
        .find(|(key, _)| key_matches(key, name))
        .map(|(_, value)| value)
}

fn ordered_object(value: &ProductionJsonValue, expected: &[&str]) -> bool {
    let ProductionJsonValue::Object(entries) = value else {
        return false;
    };
    // Every accepted property name is nonnumeric ASCII. ECMAScript's integer
    // index enumeration rule therefore cannot change this insertion order;
    // any unexpected index/name fails the exact shape check here.
    entries.len() == expected.len()
        && entries
            .iter()
            .zip(expected)
            .all(|((key, _), expected)| key_matches(key, expected))
}

fn signature_object(value: &ProductionJsonValue) -> bool {
    let ProductionJsonValue::Object(entries) = value else {
        return false;
    };
    // Node spreads each signature object instead of rebuilding its fields.
    // The exact field set is required, but its insertion order is retained.
    entries.len() == SIGNATURE_KEYS.len()
        && SIGNATURE_KEYS
            .iter()
            .all(|name| entries.iter().any(|(key, _)| key_matches(key, name)))
}

fn array_items_match(
    value: Option<&ProductionJsonValue>,
    predicate: impl Fn(&ProductionJsonValue) -> bool,
) -> bool {
    match value {
        Some(ProductionJsonValue::Array(items)) => items.iter().all(predicate),
        _ => false,
    }
}

fn ascii_string(value: &ProductionJsonValue) -> Option<String> {
    let ProductionJsonValue::String(units) = value else {
        return None;
    };
    String::from_utf16(units).ok()
}

fn production_key_order(left: &str, right: &str) -> Option<Ordering> {
    let mut object = Map::new();
    object.insert(left.to_owned(), Value::Null);
    object.insert(right.to_owned(), Value::Null);
    let bytes = production_stable_json_v1(&Value::Object(object)).ok()?;
    let left_marker = format!("\"{left}\":");
    let right_marker = format!("\"{right}\":");
    let left_position = bytes
        .windows(left_marker.len())
        .position(|window| window == left_marker.as_bytes())?;
    let right_position = bytes
        .windows(right_marker.len())
        .position(|window| window == right_marker.as_bytes())?;
    Some(left_position.cmp(&right_position))
}

fn trust_keys_are_sorted(value: Option<&ProductionJsonValue>) -> bool {
    let Some(ProductionJsonValue::Array(keys)) = value else {
        return false;
    };
    let mut previous: Option<String> = None;
    for key in keys {
        if !ordered_object(key, TRUST_KEY_ORDER) {
            return false;
        }
        let Some(current) = property(key, "keyId").and_then(ascii_string) else {
            return false;
        };
        if let Some(previous) = previous
            && production_key_order(&previous, &current) == Some(Ordering::Greater)
        {
            return false;
        }
        previous = Some(current);
    }
    true
}

/// Check the object orders that the Node builders compare with JSON.stringify.
///
/// Call this against the original bytes after normal JSON parsing succeeds.
/// A false result is a configuration-verification failure, not a file-read
/// error. A true result checks only canonical shape/order and must never be
/// used as authority: the parent's semantic and cryptographic checks remain
/// required. The production parser enforces its normal size/depth limits.
pub(super) fn canonical_configuration_key_order(bytes: &[u8]) -> bool {
    let Ok(configuration) = parse_production_json_v1(bytes) else {
        return false;
    };
    let order = match property(&configuration, "version") {
        Some(ProductionJsonValue::Number(version)) if *version == 1.0 => CONFIGURATION_V1_ORDER,
        Some(ProductionJsonValue::Number(version)) if *version == 2.0 => CONFIGURATION_V2_ORDER,
        _ => return false,
    };
    if !ordered_object(&configuration, order) {
        return false;
    }
    if let Some(policy) = property(&configuration, "identityPolicy")
        && !ordered_object(policy, POLICY_ORDER)
    {
        return false;
    }
    let Some(subject) = property(&configuration, "subject") else {
        return false;
    };
    let Some(envelope) = property(&configuration, "authorityEnvelope") else {
        return false;
    };
    let Some(trust_store) = property(&configuration, "trustStore") else {
        return false;
    };
    ordered_object(subject, SUBJECT_ORDER)
        && ordered_object(envelope, ENVELOPE_ORDER)
        && array_items_match(property(envelope, "signatures"), signature_object)
        && ordered_object(trust_store, TRUST_STORE_ORDER)
        && trust_keys_are_sorted(property(trust_store, "keys"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // These fixtures deliberately contain only structural values. This helper
    // verifies wire order, while parent differential tests verify authority.
    fn object(order: &[&str], values: &[(&str, &str)]) -> String {
        let fields = order
            .iter()
            .map(|name| {
                let value = values
                    .iter()
                    .find(|(candidate, _)| candidate == name)
                    .map_or("null", |(_, value)| *value);
                format!("\"{name}\":{value}")
            })
            .collect::<Vec<_>>();
        format!("{{{}}}", fields.join(","))
    }

    fn fixture(version: &str) -> String {
        let subject = object(SUBJECT_ORDER, &[]);
        let policy = object(POLICY_ORDER, &[]);
        let signature = object(SIGNATURE_KEYS, &[]);
        let envelope = object(ENVELOPE_ORDER, &[("signatures", &format!("[{signature}]"))]);
        let trust_key = object(TRUST_KEY_ORDER, &[("keyId", "\"a\"")]);
        let trust_store = object(TRUST_STORE_ORDER, &[("keys", &format!("[{trust_key}]"))]);
        let order = if version == "1" {
            CONFIGURATION_V1_ORDER
        } else {
            CONFIGURATION_V2_ORDER
        };
        object(
            order,
            &[
                ("version", version),
                ("identityPolicy", &policy),
                ("subject", &subject),
                ("authorityEnvelope", &envelope),
                ("trustStore", &trust_store),
            ],
        )
    }

    #[test]
    fn accepts_both_configuration_versions_and_equivalent_json_encodings() {
        assert!(canonical_configuration_key_order(fixture("1").as_bytes()));
        let canonical = fixture("2e0");
        assert!(canonical_configuration_key_order(canonical.as_bytes()));
        let escaped = canonical.replace("\"version\"", "\"\\u0076ersion\"");
        assert!(canonical_configuration_key_order(
            format!("\n {escaped} \t").as_bytes()
        ));
    }

    #[test]
    fn rejects_reordered_configuration_and_each_rebuilt_nested_object() {
        let canonical = fixture("2");
        let reordered_root = canonical.replacen(
            "\"version\":2,\"kind\":null",
            "\"kind\":null,\"version\":2",
            1,
        );
        assert!(!canonical_configuration_key_order(
            reordered_root.as_bytes()
        ));
        for (field, order) in [
            ("subject", SUBJECT_ORDER),
            ("identityPolicy", POLICY_ORDER),
            ("authorityEnvelope", ENVELOPE_ORDER),
            ("trustStore", TRUST_STORE_ORDER),
        ] {
            let source = format!("\"{field}\":{{\"{}\":null,\"{}\":null", order[0], order[1]);
            let replacement = format!("\"{field}\":{{\"{}\":null,\"{}\":null", order[1], order[0]);
            let reordered = canonical.replacen(&source, &replacement, 1);
            assert_ne!(reordered, canonical, "fixture must reorder {field}");
            assert!(
                !canonical_configuration_key_order(reordered.as_bytes()),
                "{field}"
            );
        }
        let reordered_key = canonical.replacen(
            "\"keyId\":\"a\",\"subjectId\":null",
            "\"subjectId\":null,\"keyId\":\"a\"",
            1,
        );
        assert!(!canonical_configuration_key_order(reordered_key.as_bytes()));
    }

    #[test]
    fn signature_field_order_is_preserved_and_not_rebuilt() {
        let canonical = fixture("2");
        let reordered = canonical.replace(
            &object(SIGNATURE_KEYS, &[]),
            &object(&["value", "role", "keyId", "algorithm"], &[]),
        );
        assert_ne!(reordered, canonical);
        assert!(canonical_configuration_key_order(reordered.as_bytes()));
        let extra_field = reordered.replace(
            "\"value\":null,\"role\":null",
            "\"value\":null,\"extra\":null,\"role\":null",
        );
        assert!(!canonical_configuration_key_order(extra_field.as_bytes()));
    }

    #[test]
    fn duplicate_keys_keep_first_position_and_last_value() {
        let canonical = fixture("2");
        let initial_wrong_value = canonical.replacen("\"version\":2", "\"version\":0", 1);
        let corrected = format!(
            "{},\"version\":2}}",
            &initial_wrong_value[..initial_wrong_value.len() - 1]
        );
        assert!(canonical_configuration_key_order(corrected.as_bytes()));
        let now_invalid = format!("{},\"version\":3}}", &canonical[..canonical.len() - 1]);
        assert!(!canonical_configuration_key_order(now_invalid.as_bytes()));
        let first_position_wrong = canonical.replacen(
            "{\"version\":2,\"kind\":null",
            "{\"kind\":false,\"version\":2,\"kind\":null",
            1,
        );
        assert!(!canonical_configuration_key_order(
            first_position_wrong.as_bytes()
        ));
    }

    #[test]
    fn duplicate_parent_value_replaces_obsolete_subtree_without_reordering() {
        let canonical = fixture("2");
        let subject = object(SUBJECT_ORDER, &[]);
        let obsolete = canonical.replacen(&format!("\"subject\":{subject}"), "\"subject\":{}", 1);
        let replaced = format!(
            "{},\"subject\":{subject}}}",
            &obsolete[..obsolete.len() - 1]
        );
        assert!(canonical_configuration_key_order(replaced.as_bytes()));
    }

    #[test]
    fn malformed_json_and_noncanonical_shapes_fail_closed() {
        for malformed in ["", "{", "{}", "[]", "null", "1", "{\"version\":2}"] {
            assert!(!canonical_configuration_key_order(malformed.as_bytes()));
        }
        let with_index = fixture("2").replacen('{', "{\"0\":null,", 1);
        assert!(!canonical_configuration_key_order(with_index.as_bytes()));
        let null_keys = fixture("2").replace("\"keys\":[{", "\"keys\":null,");
        assert!(!canonical_configuration_key_order(null_keys.as_bytes()));
    }
}
