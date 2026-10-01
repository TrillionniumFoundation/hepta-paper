//! Existing Node receipt selection over original JSON, without a map-order flag.
use std::fmt;

use hepta_legacy_compatibility::{parse_and_digest_production_v1, parse_and_encode_production_v1};
use rusqlite::types::ValueRef;
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use serde_json::value::RawValue;

use crate::ReadOnlyStoreError;

const MAXIMUM_JSON_BYTES: usize = 16 * 1024 * 1024;

#[cfg(test)]
mod tests;

enum Kind {
    Null,
    Number(f64),
    Boolean(bool),
    String(Option<String>),
    Object,
    Blob(Vec<u8>),
}

pub(crate) struct NodeValue {
    json: String,
    kind: Kind,
}

impl NodeValue {
    pub(crate) fn from_sql(
        value: ValueRef<'_>,
        lossy_text: bool,
    ) -> Result<Self, ReadOnlyStoreError> {
        Ok(match value {
            ValueRef::Null => Self {
                json: "null".into(),
                kind: Kind::Null,
            },
            ValueRef::Integer(n) => {
                if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n) {
                    return Err(ReadOnlyStoreError::NodeIntegerOutOfRange);
                }
                Self::number(n as f64)
            }
            ValueRef::Real(n) => Self::number(n),
            ValueRef::Text(bytes) => {
                if bytes.len() > MAXIMUM_JSON_BYTES {
                    return Err(hepta_legacy_compatibility::CompatibilityError::SizeLimit.into());
                }
                let text = if lossy_text {
                    String::from_utf8_lossy(bytes).into_owned()
                } else {
                    std::str::from_utf8(bytes)
                        .map_err(|_| ReadOnlyStoreError::NonUtf8Text)?
                        .to_owned()
                };
                Self {
                    json: serde_json::to_string(&text)
                        .map_err(|_| ReadOnlyStoreError::Serialization)?,
                    kind: Kind::String(Some(text)),
                }
            }
            ValueRef::Blob(bytes) => {
                if bytes.len() > MAXIMUM_JSON_BYTES {
                    return Err(hepta_legacy_compatibility::CompatibilityError::SizeLimit.into());
                }
                let mut json = String::from("{");
                for (i, byte) in bytes.iter().enumerate() {
                    if i != 0 {
                        json.push(',');
                    }
                    json.push_str(&format!("\"{i}\":{byte}"));
                }
                json.push('}');
                Self {
                    json,
                    kind: Kind::Blob(bytes.to_vec()),
                }
            }
        })
    }

    fn number(n: f64) -> Self {
        Self {
            json: if n.is_finite() {
                ryu_js::Buffer::new().format(n).to_owned()
            } else {
                "null".into()
            },
            kind: Kind::Number(n),
        }
    }

    pub(crate) fn json(&self) -> &str {
        &self.json
    }

    fn from_json(raw: &RawValue) -> Result<Self, ReadOnlyStoreError> {
        let text = raw.get();
        let kind = match text.as_bytes()[0] {
            b'n' => Kind::Null,
            b't' => Kind::Boolean(true),
            b'f' => Kind::Boolean(false),
            b'"' => Kind::String(serde_json::from_str::<String>(text).ok()),
            b'[' | b'{' => Kind::Object,
            _ => Kind::Number(
                text.parse()
                    .map_err(|_| ReadOnlyStoreError::Serialization)?,
            ),
        };
        let encoded = parse_and_encode_production_v1(text.as_bytes())?;
        Ok(Self {
            json: String::from_utf8(encoded).map_err(|_| ReadOnlyStoreError::Serialization)?,
            kind,
        })
    }

    fn strict_equal(&self, other: &Self) -> bool {
        match (&self.kind, &other.kind) {
            (Kind::Null, Kind::Null) => true,
            (Kind::Number(a), Kind::Number(b)) => a == b,
            (Kind::Boolean(a), Kind::Boolean(b)) => a == b,
            (Kind::String(Some(a)), Kind::String(Some(b))) => a == b,
            _ => false, // JSON objects never share the identity of a SQLite BLOB.
        }
    }

    fn string(&self) -> String {
        match &self.kind {
            Kind::Null => "null".into(),
            Kind::Boolean(b) => b.to_string(),
            Kind::Number(n) if n.is_nan() => "NaN".into(),
            Kind::Number(n) if *n == f64::INFINITY => "Infinity".into(),
            Kind::Number(n) if *n == f64::NEG_INFINITY => "-Infinity".into(),
            Kind::Number(n) => ryu_js::Buffer::new().format(*n).to_owned(),
            Kind::String(Some(s)) => s.clone(),
            Kind::Blob(bytes) => bytes
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(","),
            _ => "[object Object]".into(),
        }
    }
}

struct OrderedObject(Vec<(String, Box<RawValue>)>);
impl<'de> Deserialize<'de> for OrderedObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = OrderedObject;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("original JSON object properties")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut fields: Vec<(String, Box<RawValue>)> = Vec::new();
                let mut positions = std::collections::BTreeMap::<String, usize>::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if let Some(index) = positions.get(&key) {
                        fields[*index].1 = value; // JSON.parse updates the value, retaining first insertion.
                    } else {
                        positions.insert(key.clone(), fields.len());
                        fields.push((key, value));
                    }
                }
                Ok(OrderedObject(fields))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

fn truthy(raw: &RawValue) -> bool {
    match raw.get() {
        "null" | "false" | "\"\"" => false,
        text if matches!(text.as_bytes()[0], b'{' | b'[' | b'"' | b't') => true,
        text => text.parse::<f64>().is_ok_and(|n| n != 0.0),
    }
}

fn expected(raw: &RawValue) -> Result<NodeValue, ReadOnlyStoreError> {
    let object = if raw.get().starts_with('{') {
        Some(
            serde_json::from_str::<OrderedObject>(raw.get()).map_err(|_| {
                hepta_legacy_compatibility::CompatibilityError::UnpairedSurrogateKey
            })?,
        )
    } else {
        None
    };
    if let Some(OrderedObject(fields)) = &object {
        for key in ["receiptHash", "writeReceiptHash", "jobReceiptHash"] {
            if let Some((_, candidate)) = fields.iter().find(|(name, _)| name == key)
                && truthy(candidate)
            {
                return NodeValue::from_json(candidate);
            }
        }
        // Node chooses the last matching property first; a falsy last value
        // triggers fallback, rather than selecting an earlier truthy value.
        if let Some((_, candidate)) = fields
            .iter()
            .rev()
            .find(|(key, _)| key.ends_with("ReceiptHash"))
            && truthy(candidate)
        {
            return NodeValue::from_json(candidate);
        }
    }
    let kind = object
        .as_ref()
        .and_then(|OrderedObject(fields)| {
            fields
                .iter()
                .find(|(key, value)| key == "kind" && truthy(value))
                .map(|(_, value)| value.get())
        })
        .unwrap_or("\"Receipt\"");
    let wrapper = format!("{{\"kind\":{kind},\"value\":{}}}", raw.get());
    let hash = parse_and_digest_production_v1(wrapper.as_bytes())?;
    Ok(NodeValue {
        json: serde_json::to_string(hash.as_str())
            .map_err(|_| ReadOnlyStoreError::Serialization)?,
        kind: Kind::String(Some(hash.as_str().to_owned())),
    })
}

pub(crate) fn inspect_row(
    id: &NodeValue,
    receipt: &NodeValue,
    actual: &NodeValue,
) -> Result<Option<Box<RawValue>>, ReadOnlyStoreError> {
    let input = receipt.string();
    if input.len() > MAXIMUM_JSON_BYTES {
        return Err(hepta_legacy_compatibility::CompatibilityError::SizeLimit.into());
    }
    let raw = serde_json::from_str::<Box<RawValue>>(&input);
    let invalid = match raw {
        Err(_) => Some(format!(
            "{{\"receiptId\":{},\"error\":\"SyntaxError\"}}",
            id.json()
        )),
        Ok(raw) if raw.get() == "null" => Some(format!(
            "{{\"receiptId\":{},\"error\":\"TypeError\"}}",
            id.json()
        )),
        Ok(raw) => {
            let expected = expected(&raw)?;
            if !expected.strict_equal(actual)
                || !id.string().ends_with(&format!(":{}", expected.string()))
            {
                Some(format!(
                    "{{\"receiptId\":{},\"expected\":{},\"actual\":{}}}",
                    id.json(),
                    expected.json(),
                    actual.json()
                ))
            } else {
                None
            }
        }
    };
    invalid
        .map(|value| RawValue::from_string(value).map_err(|_| ReadOnlyStoreError::Serialization))
        .transpose()
}
