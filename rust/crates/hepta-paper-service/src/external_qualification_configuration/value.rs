use super::{Error, Result};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub(super) fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(Error::new(code)) }
}

pub(super) fn hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| Error::new("external_qualification_json_profile_unsupported"))
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
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

// JSON-data String conversion only; no caller object coercion or executable JS.
pub(super) fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => match value.as_f64() {
            Some(number) => ryu_js::Buffer::new().format(number).to_owned(),
            None => "NaN".to_owned(),
        },
        Value::String(value) => value.clone(),
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
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

pub(super) fn or_empty(value: &Value) -> String {
    if truthy(value) {
        string(value)
    } else {
        String::new()
    }
}

pub(super) fn stat_number(value: u64) -> String {
    // Node's non-bigint stat projection uses binary64 even though our retained
    // descriptor identities deliberately compare the full kernel integers.
    ryu_js::Buffer::new().format(value as f64).to_owned()
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
            // Rust accepts `inf`; JavaScript's Number does not. Only decimal
            // notation can contribute a valid finite timeout in this reader.
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

pub(super) fn path_text(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| Error::new("external_qualification_path_encoding_unsupported"))
}

pub(super) fn resolve(base: &Path, path: &Path) -> Result<PathBuf> {
    ensure(
        base.is_absolute(),
        "external_qualification_working_directory_invalid",
    )?;
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        base.join(path)
    };
    ensure(
        !path_text(&joined)?.contains('\0'),
        "external_qualification_path_invalid",
    )?;
    let mut result = PathBuf::from("/");
    for part in joined.components() {
        match part {
            Component::Normal(name) => result.push(name),
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir | Component::CurDir => (),
            _ => return Err(Error::new("external_qualification_path_invalid")),
        }
    }
    Ok(result)
}

pub(super) fn relative(value: &Value, configuration: &Path) -> Result<PathBuf> {
    let parent = configuration
        .parent()
        .ok_or_else(|| Error::new("external_qualification_path_invalid"))?;
    resolve(parent, Path::new(&or_empty(value)))
}
