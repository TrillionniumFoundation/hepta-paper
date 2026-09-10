//! Production Node record compatibility and the separately retained Rust draft format.
//!
//! Use `production_*_v1` for existing Node records. The older
//! `encode_legacy_stable_json_v1` and `hash_legacy_record_v1` names describe a Rust
//! migration draft, not the historical Node wire format, and remain available
//! only so already-created draft receipts do not silently change identity.

mod module_adapter;
mod node_adapter;
mod production;

pub use module_adapter::*;
pub use node_adapter::*;
pub use production::*;

use std::{collections::BTreeMap, str::FromStr};

use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// SHA-256 of a canonical compatibility record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyRecordHash(String);

impl LegacyRecordHash {
    /// Returns the canonical `sha256:<lowercase-hex>` representation.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for LegacyRecordHash {
    type Err = CompatibilityError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some(hex_value) = value.strip_prefix("sha256:") else {
            return Err(CompatibilityError::InvalidDigest);
        };
        if hex_value.len() != 64
            || !hex_value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(CompatibilityError::InvalidDigest);
        }
        Ok(Self(value.to_owned()))
    }
}

/// Encodes the Rust migration draft; **not** production Node `stableStringify`.
pub fn encode_legacy_stable_json_v1(value: &Value) -> Result<Vec<u8>, CompatibilityError> {
    let mut output = Vec::new();
    encode_value(value, &mut output)?;
    Ok(output)
}

/// Hashes the Rust migration draft with domain separation; **not** Node `hashRecord`.
pub fn hash_legacy_record_v1(value: &Value) -> Result<LegacyRecordHash, CompatibilityError> {
    let encoded = encode_legacy_stable_json_v1(value)?;
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, b"HeptaLegacyStableJsonV1");
    update_length_prefixed(&mut hasher, &encoded);
    LegacyRecordHash::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
}

/// Explicit name for the retained pre-production Rust draft encoding.
pub use encode_legacy_stable_json_v1 as encode_rust_draft_stable_json_v1;
/// Explicit name for the retained pre-production Rust draft digest.
pub use hash_legacy_record_v1 as hash_rust_draft_record_v1;

fn encode_value(value: &Value, output: &mut Vec<u8>) -> Result<(), CompatibilityError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(true) => output.extend_from_slice(b"true"),
        Value::Bool(false) => output.extend_from_slice(b"false"),
        Value::String(text) => output.extend_from_slice(
            serde_json::to_string(text)
                .map_err(|_| CompatibilityError::Encoding)?
                .as_bytes(),
        ),
        Value::Number(number) => output.extend_from_slice(normalize_number(number).as_bytes()),
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
        Value::Object(values) => {
            output.push(b'{');
            let ordered = values.iter().collect::<BTreeMap<_, _>>();
            for (index, (key, item)) in ordered.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|_| CompatibilityError::Encoding)?
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

fn normalize_number(number: &serde_json::Number) -> String {
    let raw = number.to_string();
    if matches!(raw.as_str(), "-0" | "-0.0" | "0.0") {
        return "0".to_owned();
    }
    if let Some(integer) = raw.strip_suffix(".0") {
        return integer.to_owned();
    }
    raw.replace('E', "e")
}

fn update_length_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

/// Compatibility encoding or digest failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CompatibilityError {
    /// Raw input or encoded output exceeds the resource bound.
    #[error("production JSON exceeds the 16 MiB size limit")]
    SizeLimit,
    /// Nesting exceeds the bounded compatibility parser's contract.
    #[error("production JSON exceeds the 256-level nesting limit")]
    NestingLimit,
    /// A raw input does not match the JSON grammar.
    #[error("invalid production JSON at byte {0}")]
    InvalidJson(usize),
    /// The supplied JSON is not encoded as valid UTF-8.
    #[error("production JSON input must be UTF-8")]
    InvalidUtf8,
    /// A serde Value has lost the original insertion order of equivalent keys.
    #[error("collation-equivalent object keys require original JSON bytes, not serde_json::Value")]
    AmbiguousObjectKeyOrder,
    /// ICU4X does not preserve ICU4C ordering of unpaired surrogate keys.
    #[error("unpaired UTF-16 surrogate in an object key is not qualified for native collation")]
    UnpairedSurrogateKey,
    /// The frozen collation data did not match its digest or could not be decoded.
    #[error("production collation data integrity or decoding failed")]
    CollationData,
    /// The frozen ICU collator could not be initialized.
    #[error("production en-US collator initialization failed")]
    Collator,
    /// Metadata does not identify the qualified production Node environment.
    #[error("production Node runtime/source profile mismatch: {0}")]
    RuntimeProfile(String),
    /// JSON encoding failed.
    #[error("legacy JSON encoding failed")]
    Encoding,
    /// A record digest was noncanonical.
    #[error("legacy record digest is invalid")]
    InvalidDigest,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_are_sorted_and_integral_float_is_normalized() {
        let value: Value =
            serde_json::from_str(r#"{"z":1.0,"a":[true,null,"x"]}"#).expect("fixture JSON");
        assert_eq!(
            encode_legacy_stable_json_v1(&value).expect("canonical encoding"),
            br#"{"a":[true,null,"x"],"z":1}"#,
        );
    }

    #[test]
    fn digest_is_lowercase_and_domain_separated() {
        let value: Value = serde_json::from_str(r#"{"a":1}"#).expect("fixture JSON");
        let digest = hash_legacy_record_v1(&value).expect("record digest");
        assert!(digest.as_str().starts_with("sha256:"));
        assert_eq!(digest.as_str().len(), 71);
    }
}
