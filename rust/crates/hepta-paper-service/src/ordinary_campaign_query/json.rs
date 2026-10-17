//! Incumbent query data uses ECMAScript JSON, including UTF-16 strings and
//! non-finite numbers. The existing production parser/encoder owns that domain.
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json,
    parse_and_hash_production_record_v1, parse_production_json_v1,
    production_json_stringify_with_limits_v1,
};
use std::sync::atomic::AtomicBool;

pub(super) fn string(value: &str) -> Json {
    Json::String(value.encode_utf16().collect())
}
pub(super) fn object<const N: usize>(fields: [(&str, Json); N]) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.encode_utf16().collect(), value))
            .collect(),
    )
}
pub(super) fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
    const NULL: Json = Json::Null;
    match value {
        Json::Object(fields) => fields
            .iter()
            .find(|(name, _)| name.iter().copied().eq(key.encode_utf16()))
            .map_or(&NULL, |(_, value)| value),
        _ => &NULL,
    }
}
pub(super) fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(value) => *value,
        Json::Number(value) => *value != 0.0 && !value.is_nan(),
        Json::String(value) => !value.is_empty(),
        Json::Array(_) | Json::Object(_) => true,
    }
}
pub(super) fn nullable(value: &Json) -> Json {
    if truthy(value) {
        value.clone()
    } else {
        Json::Null
    }
}
pub(super) fn same_scalar(left: &Json, right: &Json) -> bool {
    match (left, right) {
        (Json::Null, Json::Null) => true,
        (Json::Bool(left), Json::Bool(right)) => left == right,
        (Json::Number(left), Json::Number(right)) => left == right,
        (Json::String(left), Json::String(right)) => left == right,
        _ => false,
    }
}
pub(super) fn text(value: &Json) -> Vec<u16> {
    match value {
        Json::Null => "null".encode_utf16().collect(),
        Json::Bool(value) => value.to_string().encode_utf16().collect(),
        Json::Number(value) => {
            let text = if *value == 0.0 {
                "0".to_owned()
            } else if value.is_nan() {
                "NaN".to_owned()
            } else if *value == f64::INFINITY {
                "Infinity".to_owned()
            } else if *value == f64::NEG_INFINITY {
                "-Infinity".to_owned()
            } else {
                ryu_js::Buffer::new().format(*value).to_owned()
            };
            text.encode_utf16().collect()
        }
        Json::String(value) => value.clone(),
        Json::Array(values) => {
            let mut output = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',' as u16);
                }
                if !matches!(value, Json::Null) {
                    output.extend(text(value));
                }
            }
            output
        }
        Json::Object(_) => "[object Object]".encode_utf16().collect(),
    }
}
pub(super) fn number(value: &Json) -> Result<f64, String> {
    match value {
        Json::Null => Ok(0.0),
        Json::Bool(value) => Ok(if *value { 1.0 } else { 0.0 }),
        Json::Number(value) => Ok(*value),
        Json::String(_) | Json::Array(_) => {
            let text = String::from_utf16_lossy(&text(value));
            Ok(
                crate::automation_runtime_reconciliation::sqlite_number::string_number(&text)
                    .unwrap_or(f64::NAN),
            )
        }
        Json::Object(fields) => {
            if fields.iter().any(|(key, _)| {
                key.iter().copied().eq("toString".encode_utf16())
                    || key.iter().copied().eq("valueOf".encode_utf16())
            }) {
                Err("campaign_query_custom_coercion_refused".into())
            } else {
                Ok(f64::NAN)
            }
        }
    }
}
pub(super) fn or_number(value: &Json, fallback: f64) -> Result<Json, String> {
    Ok(Json::Number(if truthy(value) {
        number(value)?
    } else {
        fallback
    }))
}
pub(super) fn nullish_number(value: &Json, fallback: f64) -> Result<Json, String> {
    Ok(Json::Number(if matches!(value, Json::Null) {
        fallback
    } else {
        number(value)?
    }))
}
pub(super) fn column(value: &Json, fallback: Json, reason: &str) -> Result<Json, String> {
    if matches!(value, Json::Null) {
        return Ok(fallback);
    }
    let text = String::from_utf16_lossy(&text(value));
    parse_production_json_v1(text.as_bytes()).map_err(|_| reason.to_owned())
}
pub(super) fn hash(kind: &str, value: &Json, cancelled: &AtomicBool) -> Result<String, String> {
    let bytes = production_json_stringify_with_limits_v1(
        value,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 4 * 1024 * 1024,
            maximum_values: 4 * 1024 * 1024,
            maximum_utf16_units: 4 * 1024 * 1024,
        },
        cancelled,
    )
    .map_err(|error| error.to_string())?;
    parse_and_hash_production_record_v1(kind, &bytes)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|error| error.to_string())
}
pub(super) fn without(value: &Json, removed: &str) -> Json {
    match value {
        Json::Object(fields) => Json::Object(
            fields
                .iter()
                .filter(|(key, _)| !key.iter().copied().eq(removed.encode_utf16()))
                .cloned()
                .collect(),
        ),
        _ => Json::Object(Vec::new()),
    }
}
