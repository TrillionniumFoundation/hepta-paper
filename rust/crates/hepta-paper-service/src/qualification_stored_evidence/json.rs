use super::{Error, Result, ensure};
use crate::online_runtime_activation::ordered_json::{Json, parse_ordered};
use hepta_legacy_compatibility::{
    ProductionJsonValue, parse_and_hash_production_record_v1, parse_production_json_v1,
};
use serde_json::Value;

pub(super) struct Document {
    pub ordered: Json,
    pub value: Value,
    pub stringify: String,
}

impl Document {
    pub fn parse(bytes: &[u8], invalid: &str) -> Result<Self> {
        let text = String::from_utf8_lossy(bytes);
        let raw = parse_production_json_v1(text.as_bytes()).map_err(|_| Error::new(invalid))?;
        ensure(
            valid_keys(&raw),
            "qualification_stored_evidence_json_key_profile_unsupported",
        )?;
        // The public projection is serde Value: refuse inputs that would lose
        // JavaScript scalar identity before semantic validation (notably an
        // overflowing number becoming null in an unverified state's receipt).
        ensure(
            valid_values(&raw),
            "qualification_stored_evidence_json_value_profile_unsupported",
        )?;
        let ordered = parse_ordered(text.as_bytes()).map_err(|_| Error::new(invalid))?;
        let value = ordered.to_value();
        let stringify = ordered.stringify().map_err(|_| Error::new(invalid))?;
        Ok(Self {
            ordered,
            value,
            stringify,
        })
    }

    pub fn own_hash(&self, domain: &str, field: &str) -> Result<bool> {
        let Json::Object(entries) = &self.ordered else {
            return Ok(false);
        };
        let payload = Json::Object(
            entries
                .iter()
                .filter(|(key, _)| key != field)
                .cloned()
                .collect(),
        );
        let raw = payload
            .stringify()
            .map_err(|_| Error::new("qualification_stored_evidence_json_profile_unsupported"))?;
        let expected = parse_and_hash_production_record_v1(domain, raw.as_bytes())
            .map_err(|_| Error::new("qualification_stored_evidence_json_profile_unsupported"))?;
        Ok(self.value[field].as_str() == Some(expected.as_str()))
    }
}

fn valid_keys(value: &ProductionJsonValue) -> bool {
    match value {
        ProductionJsonValue::Object(entries) => entries
            .iter()
            .all(|(key, value)| String::from_utf16(key).is_ok() && valid_keys(value)),
        ProductionJsonValue::Array(values) => values.iter().all(valid_keys),
        _ => true,
    }
}

fn valid_values(value: &ProductionJsonValue) -> bool {
    match value {
        ProductionJsonValue::Number(value) => value.is_finite(),
        ProductionJsonValue::String(value) => String::from_utf16(value).is_ok(),
        ProductionJsonValue::Object(entries) => {
            entries.iter().all(|(_, value)| valid_values(value))
        }
        ProductionJsonValue::Array(values) => values.iter().all(valid_values),
        _ => true,
    }
}

pub(super) fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Object(_) | Value::Array(_) => true,
    }
}

pub(super) fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => match value.as_f64() {
            Some(value) => ryu_js::Buffer::new().format(value).to_owned(),
            None => "NaN".to_owned(),
        },
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

pub(super) fn hash_like(value: &Value) -> bool {
    let text = if truthy(value) {
        string(value)
    } else {
        String::new()
    };
    text.len() == 71
        && text
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("sha256:"))
        && text.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit)
}

pub(super) fn id(value: &Value, maximum: usize, extended: bool) -> bool {
    let text = if truthy(value) {
        string(value)
    } else {
        String::new()
    };
    (1..=maximum).contains(&text.len())
        && text
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && text.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || b"_.:-".contains(&byte)
                || (extended && b"@/".contains(&byte))
        })
}

pub(super) fn strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => {
            std::ptr::eq(left, right)
        }
        _ => left == right,
    }
}

pub(super) fn counter(value: &Value, minimum: f64, maximum: f64) -> bool {
    value.as_f64().is_some_and(|number| {
        number.is_finite() && number.fract() == 0.0 && (minimum..=maximum).contains(&number)
    })
}

pub(super) fn canonical_time(value: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value.as_str()?)
}
