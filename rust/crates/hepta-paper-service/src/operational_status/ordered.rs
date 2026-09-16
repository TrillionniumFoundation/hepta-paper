//! JSON object insertion order for the legacy sealed-closure byte contract.
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Number, Value};
use std::fmt;
#[derive(Clone)]
pub(super) enum Ordered {
    Scalar(Value),
    Array(Vec<Ordered>),
    Object(Vec<(String, Ordered)>),
}
impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Parse;
        impl<'de> Visitor<'de> for Parse {
            type Value = Ordered;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Bool(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Number(Number::from(v))))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Number(Number::from(v))))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Ordered, E> {
                Ok(Ordered::Scalar(
                    Number::from_f64(v).map_or(Value::Null, Value::Number),
                ))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::String(v.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::String(v)))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Ordered, A::Error> {
                let mut v = Vec::new();
                while let Some(item) = a.next_element()? {
                    v.push(item);
                }
                Ok(Ordered::Array(v))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Ordered, A::Error> {
                let mut values: Vec<(String, Ordered)> = Vec::new();
                while let Some((key, value)) = a.next_entry::<String, Ordered>()? {
                    if let Some((_, old)) = values.iter_mut().find(|(k, _)| k == &key) {
                        *old = value;
                    } else {
                        values.push((key, value));
                    }
                }
                Ok(Ordered::Object(values))
            }
        }
        d.deserialize_any(Parse)
    }
}
impl Ordered {
    pub fn value(&self) -> Value {
        match self {
            Self::Scalar(v) => v.clone(),
            Self::Array(v) => Value::Array(v.iter().map(Self::value).collect()),
            Self::Object(v) => {
                Value::Object(v.iter().map(|(k, v)| (k.clone(), v.value())).collect())
            }
        }
    }
    pub fn get(&self, key: &str) -> Option<&Ordered> {
        match self {
            Self::Object(v) => v.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn without(&self, key: &str) -> Self {
        match self {
            Self::Object(v) => Self::Object(v.iter().filter(|(k, _)| k != key).cloned().collect()),
            _ => self.clone(),
        }
    }
    pub fn encode(&self, pretty: bool) -> super::Result<String> {
        let mut output = String::new();
        self.write(pretty, 0, &mut output)?;
        Ok(output)
    }
    fn write(&self, pretty: bool, level: usize, output: &mut String) -> super::Result<()> {
        let indent = |output: &mut String, depth: usize| {
            if pretty {
                output.push('\n');
                output.push_str(&"  ".repeat(depth));
            }
        };
        match self {
            Self::Scalar(value) => output.push_str(
                std::str::from_utf8(
                    &hepta_legacy_compatibility::production_stable_json_v1(value)
                        .map_err(|_| super::error("code_provenance_sealed_closure_json_invalid"))?,
                )
                .map_err(|_| super::error("code_provenance_sealed_closure_json_invalid"))?,
            ),
            Self::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    indent(output, level + 1);
                    value.write(pretty, level + 1, output)?;
                }
                if !values.is_empty() {
                    indent(output, level);
                }
                output.push(']');
            }
            Self::Object(values) => {
                let mut entries = values.iter().collect::<Vec<_>>();
                entries.sort_by_key(|(key, _)| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|v| *v != u32::MAX && v.to_string() == *key)
                        .map_or((1, 0), |v| (0, v))
                });
                output.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    indent(output, level + 1);
                    output.push_str(&serde_json::to_string(key).map_err(|_| {
                        super::error("code_provenance_sealed_closure_json_invalid")
                    })?);
                    output.push(':');
                    if pretty {
                        output.push(' ');
                    }
                    value.write(pretty, level + 1, output)?;
                }
                if !entries.is_empty() {
                    indent(output, level);
                }
                output.push('}');
            }
        }
        Ok(())
    }
}
