//! Exact production JSON/hash adapter for the qualified Node 22 / en-US profile.
//!
//! This is JSON-data compatibility, not JavaScript object execution: accessors,
//! `undefined`, functions, symbols and user-defined `toJSON` are not JSON input.
//! Raw parsing preserves duplicate-key position, collation ties and UTF-16 string
//! values. Unpaired surrogates in *keys* fail closed because ICU4X and ICU4C have
//! different ill-formed UTF-16 collation semantics.

use std::{cmp::Ordering, collections::BTreeMap, sync::OnceLock};

use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale::locale;
use icu_provider_blob::BlobDataProvider;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{CompatibilityError, LegacyRecordHash};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_DEPTH: usize = 256;

/// SHA-256 of the complete qualified ICU78.2/CLDR48 Unihan + NFD data blob.
pub const PRODUCTION_COLLATION_DATA_SHA256: &str =
    "sha256:a20c77e130c05fe3265ffe9ef3ab3ed5aa859fe3b328beee0d0d7d2fe324851e";
const PRODUCTION_COLLATION_DATA: &[u8] = include_bytes!("../data/node22-en-us-unihan.postcard");
static PRODUCTION_COLLATOR: OnceLock<Result<Collator, CompatibilityError>> = OnceLock::new();

fn production_collator() -> Result<CollatorBorrowed<'static>, CompatibilityError> {
    PRODUCTION_COLLATOR
        .get_or_init(|| {
            if raw_digest(PRODUCTION_COLLATION_DATA).as_str() != PRODUCTION_COLLATION_DATA_SHA256 {
                return Err(CompatibilityError::CollationData);
            }
            let provider = BlobDataProvider::try_new_from_static_blob(PRODUCTION_COLLATION_DATA)
                .map_err(|_| CompatibilityError::CollationData)?;
            Collator::try_new_with_buffer_provider(
                &provider,
                locale!("en-US").into(),
                CollatorOptions::default(),
            )
            .map_err(|_| CompatibilityError::Collator)
        })
        .as_ref()
        .map(Collator::as_borrowed)
        .map_err(Clone::clone)
}

/// Qualified historical production runtime. Other runtimes require fresh qualification.
pub const PRODUCTION_NODE_PROFILE_V1: &str = "node22.23.1-icu78.2-cldr48-en-US-v1";
/// Frozen identity of the actual Node source; changing it requires requalification.
pub const PRODUCTION_RECORD_HASH_SOURCE_SHA256: &str =
    "sha256:5c885e62f225e3dd4c7d53cff16686188b9d7ec0ba75e5a41cf7078a1d1ef639";
/// Frozen production source used by the executable oracle, never a copied serializer.
pub const PRODUCTION_RECORD_HASH_SOURCE: &[u8] =
    include_bytes!("../../../../workflow-kernel/record-hash.mjs");

/// Confirms oracle provenance before treating a differential run as qualified.
///
/// Merely obtaining matching hashes from another Node version is not a passing
/// qualification. The test runner must invoke this check on oracle metadata.
pub fn qualify_production_node_profile_v1(profile: &Value) -> Result<(), CompatibilityError> {
    for (key, expected) in [
        ("profile", PRODUCTION_NODE_PROFILE_V1),
        ("node", "v22.23.1"),
        ("icu", "78.2"),
        ("cldr", "48.0"),
        ("unicode", "17.0"),
    ] {
        if profile[key].as_str() != Some(expected) {
            return Err(CompatibilityError::RuntimeProfile(key.to_owned()));
        }
    }
    let expected_collator = serde_json::json!({
        "locale": "en-US", "usage": "sort", "sensitivity": "variant",
        "ignorePunctuation": false, "collation": "default", "numeric": false,
        "caseFirst": "false"
    });
    if profile["collator"] != expected_collator {
        return Err(CompatibilityError::RuntimeProfile("collator".to_owned()));
    }
    if raw_digest(PRODUCTION_RECORD_HASH_SOURCE).as_str() != PRODUCTION_RECORD_HASH_SOURCE_SHA256 {
        return Err(CompatibilityError::RuntimeProfile(
            "compiled_source_sha256".to_owned(),
        ));
    }
    if profile["source_sha256"].as_str() != Some(PRODUCTION_RECORD_HASH_SOURCE_SHA256) {
        return Err(CompatibilityError::RuntimeProfile(
            "source_sha256".to_owned(),
        ));
    }
    Ok(())
}

/// Production `stableStringify` bytes for the pinned en-US profile.
///
/// Map insertion order is meaningful when distinct Unicode keys compare equal.
/// The Value API rejects collation-equivalent distinct keys because the default
/// serde_json map has already lost their original insertion order. The
/// `float_roundtrip` feature preserves binary64 parsing precision.
/// Prefer `parse_and_encode_production_v1` when migrating original JSON bytes:
/// it additionally retains unpaired surrogate string values and overflowing numbers.
pub fn production_stable_json_v1(value: &Value) -> Result<Vec<u8>, CompatibilityError> {
    encode_node(&NodeJson::from_value(value, 0)?)
}

/// Parses historical JSON with JavaScript Number and object-property semantics.
pub fn parse_and_encode_production_v1(input: &[u8]) -> Result<Vec<u8>, CompatibilityError> {
    encode_node(&Parser::parse(input)?)
}

/// Production `digest(value)`: SHA-256 of production stable JSON, without a prefix frame.
pub fn production_digest_v1(value: &Value) -> Result<LegacyRecordHash, CompatibilityError> {
    Ok(raw_digest(&production_stable_json_v1(value)?))
}

/// Production `hashRecord(kind, value)`: `digest({kind, value})` exactly.
pub fn production_hash_record_v1(
    kind: &str,
    value: &Value,
) -> Result<LegacyRecordHash, CompatibilityError> {
    hash_node_record(kind, NodeJson::from_value(value, 1)?)
}

/// Production `hashRecord` over original JSON text, including JavaScript numeric coercion.
pub fn parse_and_hash_production_record_v1(
    kind: &str,
    input: &[u8],
) -> Result<LegacyRecordHash, CompatibilityError> {
    hash_node_record(kind, Parser::parse(input)?)
}

/// Production `digest` over original JSON text.
pub fn parse_and_digest_production_v1(
    input: &[u8],
) -> Result<LegacyRecordHash, CompatibilityError> {
    Ok(raw_digest(&parse_and_encode_production_v1(input)?))
}

fn hash_node_record(kind: &str, value: NodeJson) -> Result<LegacyRecordHash, CompatibilityError> {
    let wrapper = NodeJson::Object(vec![
        (
            "kind".encode_utf16().collect(),
            NodeJson::String(kind.encode_utf16().collect()),
        ),
        ("value".encode_utf16().collect(), value),
    ]);
    Ok(raw_digest(&encode_node(&wrapper)?))
}

fn raw_digest(bytes: &[u8]) -> LegacyRecordHash {
    LegacyRecordHash(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

#[derive(Debug)]
enum NodeJson {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<Self>),
    Object(Vec<(Vec<u16>, Self)>),
}

impl NodeJson {
    fn from_value(value: &Value, depth: usize) -> Result<Self, CompatibilityError> {
        check_depth(depth)?;
        Ok(match value {
            Value::Null => Self::Null,
            Value::Bool(value) => Self::Bool(*value),
            Value::Number(value) => Self::Number(
                value
                    .to_string()
                    .parse::<f64>()
                    .map_err(|_| CompatibilityError::Encoding)?,
            ),
            Value::String(value) => Self::String(value.encode_utf16().collect()),
            Value::Array(values) => Self::Array(
                values
                    .iter()
                    .map(|value| Self::from_value(value, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            Value::Object(values) => {
                let collator = production_collator()?;
                let mut keys = values
                    .keys()
                    .filter(|key| array_index(&key.encode_utf16().collect::<Vec<_>>()).is_none())
                    .collect::<Vec<_>>();
                keys.sort_by(|left, right| collator.compare(left, right));
                if keys
                    .windows(2)
                    .any(|pair| collator.compare(pair[0], pair[1]) == Ordering::Equal)
                {
                    return Err(CompatibilityError::AmbiguousObjectKeyOrder);
                }
                Self::Object(
                    values
                        .iter()
                        .map(|(key, value)| {
                            Ok((
                                key.encode_utf16().collect(),
                                Self::from_value(value, depth + 1)?,
                            ))
                        })
                        .collect::<Result<_, CompatibilityError>>()?,
                )
            }
        })
    }
}

fn check_depth(depth: usize) -> Result<(), CompatibilityError> {
    if depth > MAX_DEPTH {
        Err(CompatibilityError::NestingLimit)
    } else {
        Ok(())
    }
}

fn encode_node(value: &NodeJson) -> Result<Vec<u8>, CompatibilityError> {
    let collator = production_collator()?;
    let mut output = Vec::new();
    encode(value, &collator, 0, &mut output)?;
    Ok(output)
}

fn encode(
    value: &NodeJson,
    collator: &CollatorBorrowed<'_>,
    depth: usize,
    output: &mut Vec<u8>,
) -> Result<(), CompatibilityError> {
    check_depth(depth)?;
    match value {
        NodeJson::Null => output.extend_from_slice(b"null"),
        NodeJson::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        NodeJson::Number(value) => {
            if !value.is_finite() {
                output.extend_from_slice(b"null");
            } else {
                output.extend_from_slice(ryu_js::Buffer::new().format(*value).as_bytes());
            }
        }
        NodeJson::String(value) => encode_string(value, output),
        NodeJson::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                encode(value, collator, depth + 1, output)?;
            }
            output.push(b']');
        }
        NodeJson::Object(values) => {
            // Node sorts Object.entries with stable localeCompare, then builds
            // Object.fromEntries. JSON.stringify enumerates integer-index keys
            // first in numeric order, regardless of that insertion order.
            let mut entries: Vec<_> = values.iter().collect();
            if entries
                .iter()
                .any(|(key, _)| char::decode_utf16(key.iter().copied()).any(|ch| ch.is_err()))
            {
                return Err(CompatibilityError::UnpairedSurrogateKey);
            }
            entries.sort_by(|(left, _), (right, _)| {
                match (array_index(left), array_index(right)) {
                    (Some(left), Some(right)) => left.cmp(&right),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => collator.compare_utf16(left, right),
                }
            });
            output.push(b'{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                encode_string(key, output);
                output.push(b':');
                encode(value, collator, depth + 1, output)?;
            }
            output.push(b'}');
        }
    }
    if output.len() > MAX_BYTES {
        return Err(CompatibilityError::SizeLimit);
    }
    Ok(())
}

fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value = 0_u32;
    for unit in key {
        if !(u16::from(b'0')..=u16::from(b'9')).contains(unit) {
            return None;
        }
        value = value
            .checked_mul(10)?
            .checked_add(u32::from(*unit - u16::from(b'0')))?;
    }
    (value != u32::MAX).then_some(value)
}

fn encode_string(value: &[u16], output: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    output.push(b'"');
    for decoded in char::decode_utf16(value.iter().copied()) {
        match decoded {
            Ok('"') => output.extend_from_slice(br#"\""#),
            Ok('\\') => output.extend_from_slice(br"\\"),
            Ok('\u{0008}') => output.extend_from_slice(br"\b"),
            Ok('\u{000c}') => output.extend_from_slice(br"\f"),
            Ok('\n') => output.extend_from_slice(br"\n"),
            Ok('\r') => output.extend_from_slice(br"\r"),
            Ok('\t') => output.extend_from_slice(br"\t"),
            Ok(character) if character >= ' ' => {
                let mut bytes = [0_u8; 4];
                output.extend_from_slice(character.encode_utf8(&mut bytes).as_bytes());
            }
            other => {
                let unit = match other {
                    Ok(character) => character as u16,
                    Err(error) => error.unpaired_surrogate(),
                };
                output.extend_from_slice(br"\u");
                for shift in [12, 8, 4, 0] {
                    output.push(HEX[usize::from((unit >> shift) & 15)]);
                }
            }
        }
    }
    output.push(b'"');
}

struct Parser<'a> {
    input: &'a str,
    position: usize,
}

impl<'a> Parser<'a> {
    fn parse(input: &'a [u8]) -> Result<NodeJson, CompatibilityError> {
        if input.is_empty() || input.len() > MAX_BYTES {
            return Err(CompatibilityError::SizeLimit);
        }
        let input = std::str::from_utf8(input).map_err(|_| CompatibilityError::InvalidUtf8)?;
        let mut parser = Self { input, position: 0 };
        let value = parser.value(0)?;
        parser.whitespace();
        if parser.position != parser.input.len() {
            return Err(parser.error());
        }
        Ok(value)
    }

    fn error(&self) -> CompatibilityError {
        CompatibilityError::InvalidJson(self.position)
    }
    fn peek(&self) -> Option<u8> {
        self.input.as_bytes().get(self.position).copied()
    }
    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }
    fn consume(&mut self, byte: u8) -> Result<(), CompatibilityError> {
        if self.peek() != Some(byte) {
            return Err(self.error());
        }
        self.position += 1;
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<NodeJson, CompatibilityError> {
        check_depth(depth)?;
        self.whitespace();
        match self.peek() {
            Some(b'n') => self.literal("null", NodeJson::Null),
            Some(b't') => self.literal("true", NodeJson::Bool(true)),
            Some(b'f') => self.literal("false", NodeJson::Bool(false)),
            Some(b'"') => Ok(NodeJson::String(self.string()?)),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.error()),
        }
    }

    fn literal(&mut self, text: &str, value: NodeJson) -> Result<NodeJson, CompatibilityError> {
        if !self.input[self.position..].starts_with(text) {
            return Err(self.error());
        }
        self.position += text.len();
        Ok(value)
    }

    fn array(&mut self, depth: usize) -> Result<NodeJson, CompatibilityError> {
        self.consume(b'[')?;
        self.whitespace();
        let mut values = Vec::new();
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(NodeJson::Array(values));
        }
        loop {
            values.push(self.value(depth + 1)?);
            self.whitespace();
            if self.peek() == Some(b']') {
                self.position += 1;
                break;
            }
            self.consume(b',')?;
        }
        Ok(NodeJson::Array(values))
    }

    fn object(&mut self, depth: usize) -> Result<NodeJson, CompatibilityError> {
        self.consume(b'{')?;
        self.whitespace();
        let mut entries = Vec::<(Vec<u16>, NodeJson)>::new();
        let mut positions = BTreeMap::<Vec<u16>, usize>::new();
        if self.peek() == Some(b'}') {
            self.position += 1;
            return Ok(NodeJson::Object(entries));
        }
        loop {
            self.whitespace();
            let key = self.string()?;
            self.whitespace();
            self.consume(b':')?;
            let value = self.value(depth + 1)?;
            if let Some(index) = positions.get(&key).copied() {
                entries[index].1 = value;
            } else {
                positions.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
            self.whitespace();
            if self.peek() == Some(b'}') {
                self.position += 1;
                break;
            }
            self.consume(b',')?;
        }
        Ok(NodeJson::Object(entries))
    }

    fn number(&mut self) -> Result<NodeJson, CompatibilityError> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.error()),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            let before = self.position;
            self.digits();
            if before == self.position {
                return Err(self.error());
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            let before = self.position;
            self.digits();
            if before == self.position {
                return Err(self.error());
            }
        }
        let number = self.input[start..self.position]
            .parse::<f64>()
            .map_err(|_| self.error())?;
        Ok(NodeJson::Number(number))
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.position += 1;
        }
    }

    fn string(&mut self) -> Result<Vec<u16>, CompatibilityError> {
        self.consume(b'"')?;
        let mut units = Vec::new();
        loop {
            let next = self.peek().ok_or_else(|| self.error())?;
            match next {
                b'"' => {
                    self.position += 1;
                    return Ok(units);
                }
                b'\\' => {
                    self.position += 1;
                    let escaped = self.peek().ok_or_else(|| self.error())?;
                    self.position += 1;
                    units.push(match escaped {
                        b'"' | b'\\' | b'/' => u16::from(escaped),
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let mut unit = 0;
                            for _ in 0..4 {
                                let digit = self
                                    .peek()
                                    .and_then(|byte| char::from(byte).to_digit(16))
                                    .ok_or_else(|| self.error())?;
                                unit = unit * 16 + digit as u16;
                                self.position += 1;
                            }
                            unit
                        }
                        _ => return Err(self.error()),
                    });
                }
                0..=31 => return Err(self.error()),
                _ => {
                    let character = self.input[self.position..]
                        .chars()
                        .next()
                        .ok_or_else(|| self.error())?;
                    self.position += character.len_utf8();
                    let mut encoded = [0_u16; 2];
                    units.extend_from_slice(character.encode_utf16(&mut encoded));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_index_keys_follow_javascript_enumeration() {
        assert_eq!(
            parse_and_encode_production_v1(
                br#"{"10":3,"2":4,"01":5,"4294967295":6,"4294967294":7}"#
            )
            .unwrap(),
            br#"{"2":4,"10":3,"4294967294":7,"01":5,"4294967295":6}"#
        );
    }

    #[test]
    fn javascript_number_thresholds_and_overflow_are_preserved() {
        assert_eq!(
            parse_and_encode_production_v1(
                b"[-0,1.0,1e-6,1e-7,1e20,1e21,9007199254740993,1e400,-1e400]"
            )
            .unwrap(),
            b"[0,1,0.000001,1e-7,100000000000000000000,1e+21,9007199254740992,null,null]"
        );
    }

    #[test]
    fn surrogate_values_roundtrip_but_malformed_keys_fail_closed() {
        assert_eq!(
            parse_and_encode_production_v1(br#"["\ud800","\udc00","\ud83d\ude00"]"#).unwrap(),
            "[\"\\ud800\",\"\\udc00\",\"😀\"]".as_bytes()
        );
        assert_eq!(
            parse_and_encode_production_v1(br#"{"\ud800":1}"#),
            Err(CompatibilityError::UnpairedSurrogateKey)
        );
    }

    #[test]
    fn normalization_equivalent_keys_preserve_original_position_and_duplicate_semantics() {
        let input = "{\"é\":1,\"é\":2,\"é\":3}";
        assert_eq!(
            parse_and_encode_production_v1(input.as_bytes()).unwrap(),
            "{\"é\":3,\"é\":2}".as_bytes()
        );
        let value: Value = serde_json::from_str(input).unwrap();
        assert_eq!(
            production_stable_json_v1(&value),
            Err(CompatibilityError::AmbiguousObjectKeyOrder)
        );
    }

    #[test]
    fn rejects_bad_grammar_and_bounded_depth_without_accepting_a_prefix() {
        for input in [
            "01",
            "1.",
            "1e",
            "1e+",
            "+1",
            "NaN",
            "true false",
            "[1,]",
            "{\"a\":1,}",
            "\"\\x20\"",
            "\"\n\"",
        ] {
            assert!(
                parse_and_encode_production_v1(input.as_bytes()).is_err(),
                "accepted {input}"
            );
        }
        let nested = format!(
            "{}null{}",
            "[".repeat(MAX_DEPTH + 1),
            "]".repeat(MAX_DEPTH + 1)
        );
        assert_eq!(
            parse_and_encode_production_v1(nested.as_bytes()),
            Err(CompatibilityError::NestingLimit)
        );
    }

    #[test]
    fn production_hash_has_the_real_kind_value_envelope() {
        let value = serde_json::json!({"10":3,"2":4});
        assert_eq!(
            production_hash_record_v1("Record", &value).unwrap(),
            raw_digest(br#"{"kind":"Record","value":{"2":4,"10":3}}"#)
        );
        assert_ne!(
            production_digest_v1(&value).unwrap(),
            crate::hash_rust_draft_record_v1(&value).unwrap()
        );
    }
}
