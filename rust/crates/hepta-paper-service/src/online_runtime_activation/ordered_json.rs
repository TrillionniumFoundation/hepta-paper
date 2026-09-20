//! Retains parsed object order because the legacy structural contract compares
//! JSON.stringify(builder(input)) to JSON.stringify(input), not sorted JSON.
use hepta_legacy_compatibility::ProductionJsonValue;
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;
use std::fmt;

fn node_number(value: Value) -> Json {
    let normalized = hepta_legacy_compatibility::production_stable_json_v1(&value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(value);
    Json::Scalar(normalized)
}

#[derive(Clone, Debug)]
pub(crate) enum Json {
    Scalar(Value),
    /// JavaScript strings are UTF-16 sequences and may contain an unpaired
    /// surrogate. Keep those units for JSON.stringify-compatible output;
    /// `to_value` projects them to replacement characters only at the
    /// business-value boundary where Rust strings cannot represent them.
    Utf16String(Vec<u16>),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}
impl Json {
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(values) => values.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }
    pub fn stringify(&self) -> super::Result<String> {
        match self {
            Self::Scalar(v) => String::from_utf8(
                hepta_legacy_compatibility::production_stable_json_v1(v)
                    .map_err(|e| super::error(e.to_string()))?,
            )
            .map_err(|e| super::error(e.to_string())),
            Self::Utf16String(units) => {
                let mut output = Vec::new();
                encode_utf16_string(units, &mut output);
                String::from_utf8(output).map_err(|e| super::error(e.to_string()))
            }
            Self::Array(a) => Ok(format!(
                "[{}]",
                a.iter()
                    .map(Self::stringify)
                    .collect::<super::Result<Vec<_>>>()?
                    .join(",")
            )),
            Self::Object(entries) => {
                let index = |s: &str| {
                    s.parse::<u32>()
                        .ok()
                        .filter(|n| *n != u32::MAX && n.to_string() == s)
                };
                let mut ordered = entries.iter().collect::<Vec<_>>();
                ordered.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                });
                let mut members = Vec::new();
                for (key, value) in ordered {
                    members.push(format!(
                        "{}:{}",
                        Self::Scalar(Value::String(key.clone())).stringify()?,
                        value.stringify()?
                    ));
                }
                Ok(format!("{{{}}}", members.join(",")))
            }
        }
    }
    pub fn string(&self) -> Option<&str> {
        match self {
            Self::Scalar(v) => v.as_str(),
            _ => None,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Scalar(value) => value.clone(),
            Self::Utf16String(units) => {
                let mut text = String::new();
                for decoded in char::decode_utf16(units.iter().copied()) {
                    text.push(decoded.unwrap_or(char::REPLACEMENT_CHARACTER));
                }
                Value::String(text)
            }
            Self::Array(values) => Value::Array(values.iter().map(Self::to_value).collect()),
            Self::Object(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_value()))
                    .collect(),
            ),
        }
    }
}

fn encode_utf16_string(units: &[u16], output: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    output.push(b'"');
    for decoded in char::decode_utf16(units.iter().copied()) {
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
            Ok(character) => {
                output.extend_from_slice(br"\u");
                let unit = character as u16;
                for shift in [12, 8, 4, 0] {
                    output.push(HEX[usize::from((unit >> shift) & 15)]);
                }
            }
            Err(error) => {
                output.extend_from_slice(br"\u");
                let unit = error.unpaired_surrogate();
                for shift in [12, 8, 4, 0] {
                    output.push(HEX[usize::from((unit >> shift) & 15)]);
                }
            }
        }
    }
    output.push(b'"');
}

fn from_production(value: ProductionJsonValue) -> Json {
    match value {
        ProductionJsonValue::Null => Json::Scalar(Value::Null),
        ProductionJsonValue::Bool(value) => Json::Scalar(Value::Bool(value)),
        ProductionJsonValue::Number(value) => {
            if value.is_finite() {
                let number = serde_json::Number::from_f64(value)
                    .unwrap_or_else(|| serde_json::Number::from(0));
                node_number(Value::Number(number))
            } else {
                // JSON.stringify serializes Infinity and NaN as null.
                Json::Scalar(Value::Null)
            }
        }
        ProductionJsonValue::String(value) => Json::Utf16String(value),
        ProductionJsonValue::Array(values) => {
            Json::Array(values.into_iter().map(from_production).collect())
        }
        ProductionJsonValue::Object(entries) => Json::Object(
            entries
                .into_iter()
                .map(|(key, value)| {
                    let key = String::from_utf16_lossy(&key);
                    (key, from_production(value))
                })
                .collect(),
        ),
    }
}

pub(crate) fn parse_ordered(input: &[u8]) -> Result<Json, String> {
    hepta_legacy_compatibility::parse_production_json_v1(input)
        .map(from_production)
        .map_err(|error| error.to_string())
}

// Retain the serde adapter used by the other ordered-JSON consumers. The GPU
// receipt wire path calls `parse_ordered` above so it can retain V8's UTF-16
// and number edge cases; these callers operate on already-qualified JSON and
// continue to receive the historical serde behavior.
impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor;
        impl<'de> Visitor<'de> for OrderedVisitor {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Scalar(Value::Bool(value)))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(node_number(value.into()))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(node_number(value.into()))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Json, E> {
                Ok(node_number(serde_json::json!(value)))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::Scalar(Value::String(value.to_owned())))
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::Scalar(Value::String(value)))
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Scalar(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element()? {
                    values.push(value);
                }
                Ok(Json::Array(values))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut values: Vec<(String, Json)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    if let Some((_, prior)) = values.iter_mut().find(|(k, _)| *k == key) {
                        *prior = value;
                    } else {
                        values.push((key, value));
                    }
                }
                Ok(Json::Object(values))
            }
        }
        deserializer.deserialize_any(OrderedVisitor)
    }
}
