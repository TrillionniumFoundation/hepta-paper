use super::{Error, Result};
use crate::online_runtime_activation::ordered_json::{Json, parse_ordered};
use hepta_legacy_compatibility::{ProductionJsonValue, parse_production_json_v1};
use serde_json::Value;

pub(super) const MAXIMUM_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAXIMUM_NODES: usize = 100_000;
const MAXIMUM_DEPTH: usize = 64;

// Bound traversal before recursive coercion, cloning, hashing, or JSON parsing.
// This is a finite JSON transport profile, not a limit from the original module.
pub(super) fn supported(value: &Value) -> bool {
    fn visit(value: &Value, depth: usize, nodes: &mut usize, bytes: &mut usize) -> bool {
        *nodes += 1;
        if depth > MAXIMUM_DEPTH || *nodes > MAXIMUM_NODES {
            return false;
        }
        *bytes = bytes.saturating_add(match value {
            Value::String(text) => text.len(),
            Value::Number(_) => 32,
            _ => 8,
        });
        if *bytes > MAXIMUM_JSON_BYTES {
            return false;
        }
        match value {
            Value::Array(values) => values
                .iter()
                .all(|value| visit(value, depth + 1, nodes, bytes)),
            Value::Object(values) => {
                !values.contains_key("toString")
                    && values.iter().all(|(key, value)| {
                        *bytes = bytes.saturating_add(key.len());
                        *bytes <= MAXIMUM_JSON_BYTES && visit(value, depth + 1, nodes, bytes)
                    })
            }
            _ => true,
        }
    }
    visit(value, 0, &mut 0, &mut 0)
}

pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub(super) fn string(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("null".to_owned()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => value
            .as_f64()
            .map(|value| ryu_js::Buffer::new().format(value).to_owned()),
        Value::String(value) => Some(value.clone()),
        // JSON cannot carry callable methods. An own noncallable toString
        // shadows Object.prototype.toString, so String(object) throws.
        Value::Object(value) if value.contains_key("toString") => None,
        Value::Object(_) => Some("[object Object]".to_owned()),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    Some(String::new())
                } else {
                    string(value)
                }
            })
            .collect::<Option<Vec<_>>>()
            .map(|values| values.join(",")),
    }
}

pub(super) fn or_empty(value: &Value) -> Option<String> {
    if truthy(value) {
        string(value)
    } else {
        Some(String::new())
    }
}

pub(super) fn sha(value: &Value) -> bool {
    or_empty(value).is_some_and(|text| {
        text.len() == 71
            && text.starts_with("sha256:")
            && text.as_bytes()[7..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    })
}

pub(super) fn safe_code(value: &Value) -> bool {
    or_empty(value).is_some_and(|text| {
        (1..=160).contains(&text.len())
            && text.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && text.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.:-".contains(&byte)
            })
    })
}

pub(super) fn reservation_id(value: &Value) -> bool {
    or_empty(value).is_some_and(|text| {
        (1..=96).contains(&text.len())
            && text
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
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

pub(super) fn optional_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => strict_equal(left, right),
        (None, None) => true, // both are JavaScript undefined
        _ => false,
    }
}

fn whitespace(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

// None represents NaN. The caller projects nonfinite Number results as JSON
// null, exactly as the original JSON boundary, rather than treating them as 0.
pub(super) fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::Object(_) => None,
        value @ (Value::String(_) | Value::Array(_)) => {
            let text = string(value)?;
            let text = text.trim_matches(whitespace);
            if text.is_empty() {
                return Some(0.0);
            }
            if matches!(text, "Infinity" | "+Infinity") {
                return Some(f64::INFINITY);
            }
            if text == "-Infinity" {
                return Some(f64::NEG_INFINITY);
            }
            for (prefix, radix) in [
                ("0x", 16),
                ("0X", 16),
                ("0o", 8),
                ("0O", 8),
                ("0b", 2),
                ("0B", 2),
            ] {
                if let Some(digits) = text.strip_prefix(prefix) {
                    if digits.is_empty() {
                        return None;
                    }
                    return digits.chars().try_fold(0.0, |number, digit| {
                        Some(number * f64::from(radix) + f64::from(digit.to_digit(radix)?))
                    });
                }
            }
            if !text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || b"+-.eE".contains(&byte))
            {
                return None;
            }
            text.parse().ok()
        }
    }
}

pub(super) fn number_value(value: Option<&Value>) -> Value {
    number(value)
        .and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}

pub(super) struct Document {
    pub value: Value,
    ordered: Json,
}
impl Document {
    pub fn parse(value: Option<&Value>) -> Result<Self> {
        let text = value.and_then(string).ok_or_else(Error::invalid)?;
        if text.len() > MAXIMUM_JSON_BYTES {
            return Err(Error::unsupported());
        }
        let original = parse_production_json_v1(text.as_bytes()).map_err(|_| Error::invalid())?;
        if !representable(&original, 0, &mut 0) {
            return Err(Error::unsupported());
        }
        let ordered = parse_ordered(text.as_bytes()).map_err(|_| Error::invalid())?;
        let value = ordered.to_value();
        if !supported(&value) {
            return Err(Error::unsupported());
        }
        Ok(Self { value, ordered })
    }

    pub fn actions_prefix_matches(&self, inspection: &Self) -> bool {
        let (Some(journal), Some(inspection)) = (
            self.ordered.get("actions").and_then(Json::array),
            inspection.ordered.get("actions").and_then(Json::array),
        ) else {
            return false;
        };
        journal.iter().enumerate().all(|(index, action)| {
            inspection.get(index).is_some_and(|other| {
                matches!((action.stringify(), other.stringify()), (Ok(left), Ok(right)) if left == right)
            })
        })
    }
}

fn representable(value: &ProductionJsonValue, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if depth > MAXIMUM_DEPTH || *nodes > MAXIMUM_NODES {
        return false;
    }
    match value {
        ProductionJsonValue::Number(value) => value.is_finite(),
        ProductionJsonValue::String(value) => String::from_utf16(value).is_ok(),
        ProductionJsonValue::Array(values) => values
            .iter()
            .all(|value| representable(value, depth + 1, nodes)),
        ProductionJsonValue::Object(values) => values.iter().all(|(key, value)| {
            String::from_utf16(key).is_ok() && representable(value, depth + 1, nodes)
        }),
        _ => true,
    }
}
