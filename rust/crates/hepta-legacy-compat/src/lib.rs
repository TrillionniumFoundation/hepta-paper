//! Immutable byte-level compatibility for the historical stable JSON contract.

use std::{cmp::Ordering, str::FromStr};

use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Canonical lower-case SHA-256 digest for legacy records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyDigestV1(String);

impl LegacyDigestV1 {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for LegacyDigestV1 {
    type Err = LegacyCompatError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some(hex_value) = value.strip_prefix("sha256:") else {
            return Err(LegacyCompatError::InvalidDigest);
        };
        if hex_value.len() != 64
            || !hex_value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(LegacyCompatError::InvalidDigest);
        }
        Ok(Self(value.to_owned()))
    }
}

/// Exact immutable encoder used only for historical V1 verification.
pub fn encode_legacy_stable_json_v1(value: &Value) -> Result<Vec<u8>, LegacyCompatError> {
    let mut output = Vec::new();
    encode_value(value, &mut output)?;
    Ok(output)
}

/// Domain-separated digest of the exact V1 bytes.
pub fn hash_legacy_stable_json_v1(value: &Value) -> Result<LegacyDigestV1, LegacyCompatError> {
    let encoded = encode_legacy_stable_json_v1(value)?;
    let domain = b"HeptaLegacyStableJsonV1";
    let mut hasher = Sha256::new();
    hasher.update(
        u64::try_from(domain.len())
            .map_err(|_| LegacyCompatError::NumericOverflow)?
            .to_be_bytes(),
    );
    hasher.update(domain);
    hasher.update(
        u64::try_from(encoded.len())
            .map_err(|_| LegacyCompatError::NumericOverflow)?
            .to_be_bytes(),
    );
    hasher.update(encoded);
    LegacyDigestV1::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn encode_value(value: &Value, output: &mut Vec<u8>) -> Result<(), LegacyCompatError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(true) => output.extend_from_slice(b"true"),
        Value::Bool(false) => output.extend_from_slice(b"false"),
        Value::Number(number) => output.extend_from_slice(number.to_string().as_bytes()),
        Value::String(text) => output.extend_from_slice(
            serde_json::to_string(text)
                .map_err(|_| LegacyCompatError::Encode)?
                .as_bytes(),
        ),
        Value::Array(values) => {
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                encode_value(item, output)?;
            }
            output.push(b']');
        }
        Value::Object(object) => {
            output.push(b'{');
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| compare_utf8(left, right));
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|_| LegacyCompatError::Encode)?
                        .as_bytes(),
                );
                output.push(b':');
                encode_value(item, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn compare_utf8(left: &str, right: &str) -> Ordering {
    left.as_bytes().cmp(right.as_bytes())
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LegacyCompatError {
    #[error("legacy stable JSON encoding failed")]
    Encode,
    #[error("legacy digest is invalid")]
    InvalidDigest,
    #[error("legacy numeric conversion overflowed")]
    NumericOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_bytes_are_order_independent_and_whitespace_free() {
        let left: Value = serde_json::from_str(r#"{"z":1,"a":[true,null,"x"]}"#).expect("json");
        let right: Value = serde_json::from_str(r#"{ "a" : [ true, null, "x" ], "z": 1 }"#)
            .expect("json");
        let expected = br#"{"a":[true,null,"x"],"z":1}"#;
        assert_eq!(encode_legacy_stable_json_v1(&left).expect("encode"), expected);
        assert_eq!(
            encode_legacy_stable_json_v1(&left).expect("left"),
            encode_legacy_stable_json_v1(&right).expect("right")
        );
        assert_eq!(
            hash_legacy_stable_json_v1(&left).expect("left hash"),
            hash_legacy_stable_json_v1(&right).expect("right hash")
        );
    }

    #[test]
    fn utf8_key_sorting_and_string_escaping_are_stable() {
        let value: Value = serde_json::from_str(r#"{"é":"\n","z":"\\","aa":"\""}"#)
            .expect("json");
        assert_eq!(
            String::from_utf8(encode_legacy_stable_json_v1(&value).expect("encode"))
                .expect("utf8"),
            r#"{"aa":"\"","z":"\\","é":"\n"}"#
        );
    }
}
