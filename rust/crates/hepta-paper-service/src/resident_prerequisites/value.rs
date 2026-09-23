use super::{Error, Result};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub(super) fn hash(domain: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(domain, value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| Error::new("autonomous_research_resident_json_profile_unsupported"))
}
pub(super) fn own_hash(domain: &str, value: &Value, field: &str) -> Result<bool> {
    let Some(object) = value.as_object() else {
        return Ok(false);
    };
    let mut payload = object.clone();
    payload.remove(field);
    Ok(value[field].as_str() == Some(hash(domain, &Value::Object(payload))?.as_str()))
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
        Value::Array(_) | Value::Object(_) => true,
    }
}
pub(super) fn or_null(value: &Value) -> Value {
    if truthy(value) {
        value.clone()
    } else {
        Value::Null
    }
}
pub(super) fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value
            .as_f64()
            .map(|value| ryu_js::Buffer::new().format(value).to_owned())
            .unwrap_or_else(|| "NaN".to_owned()),
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
pub(super) fn or_empty(value: &Value) -> String {
    if truthy(value) {
        string(value)
    } else {
        String::new()
    }
}
pub(super) fn sha(value: &Value) -> bool {
    let text = or_empty(value);
    text.len() == 71
        && text
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("sha256:"))
        && text.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit)
}
pub(super) fn strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Object(_), Value::Object(_)) | (Value::Array(_), Value::Array(_)) => {
            std::ptr::eq(left, right)
        }
        _ => left == right,
    }
}
pub(super) fn canonical(value: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value.as_str()?)
}
pub(super) fn whitespace(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub(super) fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::Object(_) => None,
        Value::String(_) | Value::Array(_) => {
            let text = string(value);
            let text = text.trim_matches(whitespace);
            if text.is_empty() {
                return Some(0.0);
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
                    return digits.chars().try_fold(0.0, |value, digit| {
                        Some(value * f64::from(radix) + f64::from(digit.to_digit(radix)?))
                    });
                }
            }
            if !text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || b"+-.eE".contains(&byte))
            {
                return None;
            }
            text.parse::<f64>().ok()
        }
    }
}
pub(super) fn safe_integer(value: &Value, minimum: f64) -> bool {
    value.as_f64().is_some_and(|value| {
        value.is_finite()
            && value.fract() == 0.0
            && (minimum..=9_007_199_254_740_991.0).contains(&value)
    })
}
pub(super) fn safe_id(value: &Value, minimum: usize) -> bool {
    let text = or_empty(value);
    (minimum..=160).contains(&text.len())
        && text
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:@/-".contains(&byte))
}
pub(super) fn organization_valid(value: &Value) -> bool {
    let text = or_empty(value);
    (1..=160).contains(&text.len())
        && text
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ._():-".contains(&byte))
}
pub(super) fn absolute(path: &Path, cwd: &Path) -> Result<PathBuf> {
    if !cwd.is_absolute() {
        return Err(Error::new(
            "autonomous_research_resident_path_profile_unsupported",
        ));
    }
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    let Some(text) = joined.to_str() else {
        return Err(Error::new(
            "autonomous_research_resident_path_profile_unsupported",
        ));
    };
    if text.contains('\0') || text.len() > 4096 || joined.components().count() > 128 {
        return Err(Error::new(
            "autonomous_research_resident_path_profile_unsupported",
        ));
    }
    let mut output = PathBuf::from("/");
    for part in joined.components() {
        match part {
            Component::RootDir | Component::CurDir => (),
            Component::ParentDir => {
                output.pop();
            }
            Component::Normal(part) => output.push(part),
            _ => {
                return Err(Error::new(
                    "autonomous_research_resident_path_profile_unsupported",
                ));
            }
        }
    }
    Ok(output)
}
