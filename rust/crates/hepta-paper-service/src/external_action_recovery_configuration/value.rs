use super::{INVALID, Result};
use crate::online_runtime_activation::ordered_json::{Json, parse_ordered};
use hepta_legacy_compatibility::{
    ProductionJsonValue, parse_production_json_v1, production_hash_record_v1,
};
use serde_json::Value;

pub(super) const ACTIONS: [&str; 3] = [
    "golden-release-attestor",
    "production-readiness",
    "provider-canary",
];
const JSON_UNSUPPORTED: &str =
    "autonomous_research_supervisor_external_action_recovery_json_profile_unsupported";
pub(super) struct Document {
    pub value: Value,
    ordered: Json,
}
impl Document {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        // The bounded profile requires actual UTF-8 rather than silently mapping
        // arbitrary invalid bytes or unpaired UTF-16 into different hash inputs.
        std::str::from_utf8(bytes).map_err(|_| JSON_UNSUPPORTED.to_owned())?;
        let raw = parse_production_json_v1(bytes).map_err(|_| INVALID.to_owned())?;
        ensure(representable(&raw), JSON_UNSUPPORTED)?;
        let ordered = parse_ordered(bytes).map_err(|_| INVALID.to_owned())?;
        Ok(Self {
            value: ordered.to_value(),
            ordered,
        })
    }
    pub fn action_order_matches(&self) -> Result<bool> {
        let actual = self
            .ordered
            .get("capabilityReceipt")
            .and_then(|receipt| receipt.get("actionConfigurationIdentityHashes"));
        let expected = self.ordered.get("actionConfigurationIdentityHashes");
        match (actual, expected) {
            (Some(actual), Some(expected)) => Ok(actual
                .stringify()
                .map_err(|_| JSON_UNSUPPORTED.to_owned())?
                == expected
                    .stringify()
                    .map_err(|_| JSON_UNSUPPORTED.to_owned())?),
            _ => Ok(false),
        }
    }
}
fn representable(value: &ProductionJsonValue) -> bool {
    match value {
        ProductionJsonValue::Number(value) => value.is_finite(),
        ProductionJsonValue::String(value) => String::from_utf16(value).is_ok(),
        ProductionJsonValue::Array(values) => values.iter().all(representable),
        ProductionJsonValue::Object(values) => values
            .iter()
            .all(|(key, value)| String::from_utf16(key).is_ok() && representable(value)),
        _ => true,
    }
}
pub(super) fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(code.to_owned()) }
}
pub(super) fn hash(domain: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(domain, value)
        .map(|value| value.as_str().to_owned())
        .map_err(|_| JSON_UNSUPPORTED.to_owned())
}
pub(super) fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => match value.as_f64() {
            Some(value) => ryu_js::Buffer::new().format(value).to_owned(),
            None => "NaN".to_owned(),
        },
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}
fn string_or_empty(value: &Value) -> String {
    if truthy(value) {
        string(value)
    } else {
        String::new()
    }
}
pub(super) fn sha(value: &Value) -> bool {
    let text = string_or_empty(value);
    text.len() == 71
        && text.starts_with("sha256:")
        && text.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}
pub(super) fn safe_id(value: &Value) -> bool {
    let text = string_or_empty(value);
    (1..=256).contains(&text.len())
        && text
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:@/-".contains(&byte))
}
pub(super) fn canonical(value: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value.as_str()?)
}
pub(super) fn action_identities(value: &Value) -> bool {
    exact(value, &ACTIONS)
        && value
            .as_object()
            .is_some_and(|object| object.values().all(sha))
}
