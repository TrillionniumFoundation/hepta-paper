use hepta_legacy_compatibility::ProductionJsonValue as V;

use super::NativeBusinessError;

pub(super) fn object<const N: usize>(fields: [(&str, V); N]) -> V {
    V::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.encode_utf16().collect(), value))
            .collect(),
    )
}
pub(super) fn text(value: &str) -> V {
    V::String(value.encode_utf16().collect())
}
pub(super) fn number(value: f64) -> V {
    V::Number(value)
}
pub(super) fn field<'a>(value: &'a V, key: &str) -> Option<&'a V> {
    let key = key.encode_utf16().collect::<Vec<_>>();
    match value {
        V::Object(fields) => fields
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value),
        _ => None,
    }
}
pub(super) fn truthy(value: Option<&V>) -> bool {
    match value {
        None | Some(V::Null) => false,
        Some(V::Bool(value)) => *value,
        Some(V::Number(value)) => *value != 0.0 && !value.is_nan(),
        Some(V::String(value)) => !value.is_empty(),
        Some(V::Array(_) | V::Object(_)) => true,
    }
}
pub(super) fn string(value: Option<&V>) -> Result<Vec<u16>, NativeBusinessError> {
    Ok(match value {
        None => "undefined".encode_utf16().collect(),
        Some(V::Null) => "null".encode_utf16().collect(),
        Some(V::Bool(value)) => if *value { "true" } else { "false" }
            .encode_utf16()
            .collect(),
        Some(V::Number(value)) => {
            if value.is_nan() {
                "NaN".encode_utf16().collect()
            } else if *value == f64::INFINITY {
                "Infinity".encode_utf16().collect()
            } else if *value == f64::NEG_INFINITY {
                "-Infinity".encode_utf16().collect()
            } else {
                ryu_js::Buffer::new()
                    .format(*value)
                    .encode_utf16()
                    .collect()
            }
        }
        Some(V::String(value)) => value.clone(),
        Some(V::Object(_)) => {
            let object = value.ok_or(NativeBusinessError::Contract)?;
            if field(object, "toString").is_some() || field(object, "valueOf").is_some() {
                return Err(NativeBusinessError::Contract);
            }
            "[object Object]".encode_utf16().collect()
        }
        Some(V::Array(values)) => {
            let mut output = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(u16::from(b','));
                }
                if !matches!(value, V::Null) {
                    output.extend(string(Some(value))?);
                }
            }
            output
        }
    })
}
pub(super) fn number_coercion(value: Option<&V>) -> Result<f64, NativeBusinessError> {
    Ok(match value {
        None => f64::NAN,
        Some(V::Null) => 0.0,
        Some(V::Bool(value)) => f64::from(u8::from(*value)),
        Some(V::Number(value)) => *value,
        Some(V::Object(_)) => {
            if field(value.ok_or(NativeBusinessError::Contract)?, "valueOf").is_some()
                || field(value.ok_or(NativeBusinessError::Contract)?, "toString").is_some()
            {
                return Err(NativeBusinessError::Contract);
            }
            f64::NAN
        }
        Some(V::String(_) | V::Array(_)) => {
            let units = string(value)?;
            String::from_utf16(&units)
                .ok()
                .and_then(|text| {
                    crate::automation_runtime_reconciliation::sqlite_number::string_number(&text)
                })
                .unwrap_or(f64::NAN)
        }
    })
}
pub(super) fn blocked(blocker: &str) -> V {
    object([
        ("status", text("native_research_worker_blocked")),
        ("blockers", V::Array(vec![text(blocker)])),
    ])
}
