//! Thin accessors over the existing production JSON owner; no parser/serializer.
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json, parse_and_encode_production_v1,
    parse_and_hash_production_record_v1, parse_production_json_v1,
    production_json_stringify_with_limits_v1,
};
use std::sync::atomic::AtomicBool;
pub(super) fn string(text: &str) -> Json {
    Json::String(text.encode_utf16().collect())
}
pub(super) fn object<const N: usize>(entries: [(&str, Json); N]) -> Json {
    Json::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.encode_utf16().collect(), value))
            .collect(),
    )
}
pub(super) fn field<'a>(json: &'a Json, key: &str) -> &'a Json {
    const NULL: Json = Json::Null;
    match json {
        Json::Object(fields) => fields
            .iter()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
            .map_or(&NULL, |(_, v)| v),
        _ => &NULL,
    }
}
pub(super) fn text(json: &Json) -> Option<String> {
    match json {
        Json::String(value) => String::from_utf16(value).ok(),
        _ => None,
    }
}
pub(super) fn is_text(json: &Json, expected: &str) -> bool {
    matches!(json,Json::String(value) if value.iter().copied().eq(expected.encode_utf16()))
}
pub(super) fn number(json: &Json, expected: f64) -> bool {
    matches!(json,Json::Number(value) if *value==expected)
}
pub(super) fn boolean(json: &Json, expected: bool) -> bool {
    matches!(json,Json::Bool(value) if *value==expected)
}
pub(super) fn scalar_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Null, Json::Null) => true,
        (Json::Number(a), Json::Number(b)) => a == b,
        (Json::Bool(a), Json::Bool(b)) => a == b,
        (Json::String(a), Json::String(b)) => a == b,
        _ => false,
    }
}
pub(super) fn exact(json: &Json, keys: &[&str]) -> bool {
    matches!(json,Json::Object(fields) if fields.len()==keys.len() && fields.iter().all(|(k,_)|keys.iter().any(|key|k.iter().copied().eq(key.encode_utf16()))))
}
pub(super) fn exact_data(json: &Json, keys: &serde_json::Value) -> bool {
    let Some(keys) = keys.as_array() else {
        return false;
    };
    matches!(json,Json::Object(fields) if fields.len()==keys.len() && fields.iter().all(|(k,_)|keys.iter().any(|key| key.as_str().is_some_and(|key|k.iter().copied().eq(key.encode_utf16())))))
}
pub(super) fn canonical_shape(value: &Json, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    match value {
        Json::Number(n) => {
            n.is_finite() && (n.fract() != 0.0 || n.abs() <= 9_007_199_254_740_991.0)
        }
        Json::Array(values) => values.iter().all(|v| canonical_shape(v, depth + 1)),
        Json::Object(values) => values
            .iter()
            .all(|(k, v)| !k.is_empty() && k.len() <= 256 && canonical_shape(v, depth + 1)),
        _ => true,
    }
}
pub(super) fn canonical_bytes(
    value: &Json,
    limit: usize,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if !canonical_shape(value, 0) {
        return Err("one_shot_status_canonical_json_invalid".into());
    }
    let raw = production_json_stringify_with_limits_v1(
        value,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: limit,
            maximum_values: limit,
            maximum_utf16_units: limit,
        },
        cancelled,
    )
    .map_err(|e| e.to_string())?;
    let result = parse_and_encode_production_v1(&raw).map_err(|e| e.to_string())?;
    if result.len() > limit {
        return Err("one_shot_status_canonical_json_limit".into());
    }
    Ok(result)
}
pub(super) fn row(raw: &str, code: &str, cancelled: &AtomicBool) -> Result<Json, String> {
    let value = parse_production_json_v1(raw.as_bytes()).map_err(|_| code.to_owned())?;
    if canonical_bytes(&value, 1024 * 1024, cancelled).map_err(|_| code.to_owned())?
        != raw.as_bytes()
    {
        return Err(code.into());
    }
    Ok(value)
}
pub(super) fn hash(kind: &str, value: &Json, cancelled: &AtomicBool) -> Result<String, String> {
    let bytes = canonical_bytes(value, 1024 * 1024, cancelled)?;
    parse_and_hash_production_record_v1(kind, &bytes)
        .map(|v| v.as_str().to_owned())
        .map_err(|e| e.to_string())
}
pub(super) fn without(value: &Json, name: &str) -> Result<Json, String> {
    match value {
        Json::Object(fields) => Ok(Json::Object(
            fields
                .iter()
                .filter(|(key, _)| !key.iter().copied().eq(name.encode_utf16()))
                .cloned()
                .collect(),
        )),
        _ => Err("one_shot_status_object_required".into()),
    }
}
pub(super) fn same_json(a: &Json, b: &Json, cancelled: &AtomicBool) -> bool {
    canonical_bytes(a, 1024 * 1024, cancelled)
        .ok()
        .zip(canonical_bytes(b, 1024 * 1024, cancelled).ok())
        .is_some_and(|(a, b)| a == b)
}
pub(super) fn instant(value: &Json) -> Option<i64> {
    text(value).and_then(|value| {
        crate::journal_connector_coverage::qualification::canonical_instant_millis(&value)
    })
}
pub(super) fn sha(value: &Json) -> bool {
    // The incumbent regex uses String(value || ''). A singleton array has
    // the same string projection; cross-record equality still compares the
    // actual values separately and never coerces an authenticated hash claim.
    match value {
        Json::Array(values) if values.len() == 1 => sha(&values[0]),
        _ => text(value).is_some_and(|s| {
            s.len() == 71
                && s.starts_with("sha256:")
                && s[7..]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        }),
    }
}
pub(super) fn safe_id(value: &Json) -> bool {
    text(value).is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.:@/-".contains(&c))
    })
}
