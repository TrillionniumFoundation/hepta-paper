//! Retains parsed object order because the legacy structural contract compares
//! JSON.stringify(builder(input)) to JSON.stringify(input), not sorted JSON.
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
}
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
                    // JSON.parse retains the first property position and the last value.
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
