//! Online SQLite reserve/apply/finalize coordination. Authority receipts are
//! authenticated by the pinned verifier before they acquire an opaque type.
pub mod authority;
pub mod clock;
pub mod contracts;
pub mod execution;
pub mod recovery;
pub use execution::{
    RecoverabilityEpochFenceV1, SqliteMutationCoordinatorOptionsV1, SqliteMutationCoordinatorV1,
};
pub mod manifest;
pub mod storage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const ONLINE_MUTATION_PROTOCOL: &str = "external-linearizable-reserve-apply-finalize-v1";
pub const DATABASE_ROLES: &[&str] = &[
    "native-store",
    "submission-handoff",
    "machine-intake",
    "topic-producer",
    "supervisor-state",
    "resident-instance",
    "runtime-reproducibility-refresh",
    "runtime-reproducibility-publication",
    "external-qualification",
    "full-research-qualification-publication",
];
#[derive(Debug, Error)]
#[error("{code}")]
pub struct SqliteMutationCoordinatorError {
    pub code: String,
    pub details: Value,
    pub state_recoverability_fatal: bool,
    pub state_recoverability_deferred: bool,
    pub retryable: bool,
}
pub type Result<T> = std::result::Result<T, SqliteMutationCoordinatorError>;
pub(super) fn error(code: impl Into<String>) -> SqliteMutationCoordinatorError {
    SqliteMutationCoordinatorError {
        code: code.into(),
        details: json!({}),
        state_recoverability_fatal: false,
        state_recoverability_deferred: false,
        retryable: false,
    }
}
pub(super) fn hash(kind: &str, value: &Value) -> Result<String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .map(|v| v.as_str().to_owned())
        .map_err(|e| error(e.to_string()))
}
pub(super) fn hash_bytes(value: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value)))
}
pub(super) fn keys(value: &Value, expected: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == expected.len() && expected.iter().all(|k| o.contains_key(*k)))
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| {
        error(format!(
            "externally_fenced_sqlite_mutation_field_invalid:{key}"
        ))
    })
}
pub(super) fn int(value: &Value, key: &str) -> Result<i64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        .map(|n| n as i64)
        .ok_or_else(|| {
            error(format!(
                "externally_fenced_sqlite_mutation_field_invalid:{key}"
            ))
        })
}
pub(super) fn safe(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        (2..=192).contains(&s.len())
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    })
}
pub(super) fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 71
            && s.starts_with("sha256:")
            && s.as_bytes()[7..]
                .iter()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    })
}
pub(super) fn integer(value: &Value, minimum: i64) -> bool {
    value.as_f64().is_some_and(|n| {
        n.is_finite() && n.fract() == 0.0 && n >= minimum as f64 && n <= 9_007_199_254_740_991.0
    })
}
pub(super) fn sorted(values: &Value, valid: impl Fn(&Value) -> bool) -> bool {
    values
        .as_array()
        .is_some_and(|a| a.iter().all(valid) && a.windows(2).all(|p| p[0].as_str() < p[1].as_str()))
}
pub(super) fn role(value: &Value) -> bool {
    value.as_str().is_some_and(|s| DATABASE_ROLES.contains(&s))
}
pub(super) fn timestamp(value: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value.as_str()?)
}
