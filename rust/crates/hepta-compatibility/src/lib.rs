//! Historical canonical JSON compatibility kernel.
//!
//! V1 intentionally models the frozen Node-era stable JSON contract. It is a
//! read/verification boundary, not a general-purpose serializer for new Rust
//! contracts.

#![forbid(unsafe_code)]

use std::{io::Write, str::FromStr};

use hepta_codex_protocol::Sha256Digest;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_NESTING_DEPTH: usize = 256;
const MAXIMUM_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// Encodes one JSON value using the frozen `LegacyStableJsonV1` ordering rules.
pub fn legacy_stable_json_v1(value: &Value) -> Result<Vec<u8>, CompatibilityError> {
    let mut output = Vec::new();
    encode(value, 0, &mut output)?;
    if output.is_empty() || output.len() > MAXIMUM_OUTPUT_BYTES {
        return Err(CompatibilityError::OutputLimitExceeded);
    }
    Ok(output)
}

/// Parses UTF-8 JSON and returns its exact frozen V1 canonical bytes.
pub fn parse_and_encode_legacy_v1(input: &[u8]) -> Result<Vec<u8>, CompatibilityError> {
    if input.is_empty() || input.len() > MAXIMUM_OUTPUT_BYTES {
        return Err(CompatibilityError::InputLimitExceeded);
    }
    let value: Value = serde_json::from_slice(input)
        .map_err(|error| CompatibilityError::InvalidJson(error.to_string()))?;
    legacy_stable_json_v1(&value)
}

/// Domain-separated hash of canonical V1 bytes.
pub fn legacy_stable_json_hash_v1(value: &Value) -> Result<Sha256Digest, CompatibilityError> {
    let canonical = legacy_stable_json_v1(value)?;
    let mut hasher = Sha256::new();
    update_field(&mut hasher, b"HeptaLegacyStableJsonV1");
    update_field(&mut hasher, &canonical);
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| CompatibilityError::DigestConstruction)
}

fn encode(value: &Value, depth: usize, output: &mut Vec<u8>) -> Result<(), CompatibilityError> {
    if depth > MAXIMUM_NESTING_DEPTH {
        return Err(CompatibilityError::NestingLimitExceeded);
    }
    match value {
        Value::Null => output.write_all(b"null")?,
        Value::Bool(true) => output.write_all(b"true")?,
        Value::Bool(false) => output.write_all(b"false")?,
        Value::Number(number) => output.write_all(number.to_string().as_bytes())?,
        Value::String(text) => {
            let encoded = serde_json::to_vec(text)
                .map_err(|error| CompatibilityError::InvalidJson(error.to_string()))?;
            output.write_all(&encoded)?;
        }
        Value::Array(values) => {
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                encode(item, depth + 1, output)?;
            }
            output.push(b']');
        }
        Value::Object(map) => {
            output.push(b'{');
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                let encoded_key = serde_json::to_vec(key)
                    .map_err(|error| CompatibilityError::InvalidJson(error.to_string()))?;
                output.write_all(&encoded_key)?;
                output.push(b':');
                encode(
                    map.get(key).ok_or(CompatibilityError::ObjectKeyMissing)?,
                    depth + 1,
                    output,
                )?;
            }
            output.push(b'}');
        }
    }
    if output.len() > MAXIMUM_OUTPUT_BYTES {
        return Err(CompatibilityError::OutputLimitExceeded);
    }
    Ok(())
}

fn update_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CompatibilityError {
    #[error("compatibility input is empty or exceeds the hard byte limit")]
    InputLimitExceeded,
    #[error("canonical JSON output exceeds the hard byte limit")]
    OutputLimitExceeded,
    #[error("JSON nesting exceeds the V1 compatibility limit")]
    NestingLimitExceeded,
    #[error("JSON is invalid: {0}")]
    InvalidJson(String),
    #[error("canonical object key disappeared during encoding")]
    ObjectKeyMissing,
    #[error("failed to construct compatibility digest")]
    DigestConstruction,
    #[error("compatibility output failed: {0:?}")]
    Output(std::io::ErrorKind),
}

impl From<std::io::Error> for CompatibilityError {
    fn from(error: std::io::Error) -> Self {
        Self::Output(error.kind())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_object_keys_recursively_without_reordering_arrays() {
        let value: Value = serde_json::from_str(
            r#"{"z":[{"b":2,"a":1},3],"a":"x","nested":{"y":false,"x":null}}"#,
        )
        .expect("fixture JSON");
        let encoded = legacy_stable_json_v1(&value).expect("stable JSON");
        assert_eq!(
            encoded,
            br#"{"a":"x","nested":{"x":null,"y":false},"z":[{"a":1,"b":2},3]}"#,
        );
    }

    #[test]
    fn hash_is_domain_separated_and_deterministic() {
        let left: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).expect("left");
        let right: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).expect("right");
        assert_eq!(
            legacy_stable_json_hash_v1(&left).expect("left hash"),
            legacy_stable_json_hash_v1(&right).expect("right hash"),
        );
    }

    #[test]
    fn rejects_excessive_depth() {
        let mut value = Value::Null;
        for _ in 0..=MAXIMUM_NESTING_DEPTH {
            value = Value::Array(vec![value]);
        }
        assert_eq!(
            legacy_stable_json_v1(&value),
            Err(CompatibilityError::NestingLimitExceeded)
        );
    }
}
