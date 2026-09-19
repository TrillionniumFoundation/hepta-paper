//! Runtime activation input contracts and observed local database evidence.
//!
//! These APIs validate claims and local files, not external qualification. In
//! particular, a valid serialized activation receipt is not an activation
//! capability. No API here upgrades a configured mutation coordinator to ready.
pub mod active_refresh;
pub mod contracts;
pub mod database;
pub mod finalized_inventory;
pub mod inventory;
pub(crate) mod ordered_json;
pub mod startup_inventory;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{code}")]
pub struct RuntimeActivationErrorV1 {
    pub code: String,
}
pub type Result<T> = std::result::Result<T, RuntimeActivationErrorV1>;
fn error(code: impl Into<String>) -> RuntimeActivationErrorV1 {
    RuntimeActivationErrorV1 { code: code.into() }
}
fn hash(kind: &str, value: &Value) -> Result<String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .map(|value| value.as_str().to_owned())
        .map_err(|e| error(e.to_string()))
}
fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 71
            && s.starts_with("sha256:")
            && s.as_bytes()[7..]
                .iter()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    })
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| {
        n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)
    })
}
fn empty(value: &Value) -> bool {
    value.as_array().is_some_and(Vec::is_empty)
}
fn timestamp(value: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value.as_str()?)
}
fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == expected.len() && expected.iter().all(|k| o.contains_key(*k)))
}
fn without(value: &Value, key: &str) -> Result<Value> {
    let mut value = value
        .as_object()
        .cloned()
        .ok_or_else(|| error("autonomous_research_online_runtime_activation_document_invalid"))?;
    value.remove(key);
    Ok(Value::Object(value))
}
