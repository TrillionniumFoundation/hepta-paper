//! Ordered ECMAScript JSON values for the incumbent dataset contracts. Object
//! insertion order is observable in mount bindings and must survive validation.
use hepta_legacy_compatibility::{ProductionJsonValue as Json, production_json_stringify_v1};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

pub(super) fn text(value: &str) -> Json {
    Json::String(value.encode_utf16().collect())
}
pub(super) fn object<const N: usize>(fields: [(&str, Json); N]) -> Json {
    fields_object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value)),
    )
}
pub(super) fn fields_object(fields: impl IntoIterator<Item = (String, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.encode_utf16().collect(), value))
            .collect(),
    )
}
pub(super) fn get<'a>(value: &'a Json, key: &str) -> &'a Json {
    let units = key.encode_utf16().collect::<Vec<_>>();
    match value {
        Json::Object(fields) => fields
            .iter()
            .find(|(name, _)| *name == units)
            .map_or(&Json::Null, |(_, value)| value),
        _ => &Json::Null,
    }
}
pub(super) fn has(value: &Json, key: &str) -> bool {
    let units = key.encode_utf16().collect::<Vec<_>>();
    matches!(value, Json::Object(fields) if fields.iter().any(|(name, _)| *name == units))
}
pub(super) fn exact(value: &Json, keys: &[&str]) -> bool {
    matches!(value, Json::Object(fields) if fields.len() == keys.len() && keys.iter().all(|key| has(value, key)))
}
pub(super) fn array(value: &Json) -> &[Json] {
    match value {
        Json::Array(values) => values,
        _ => &[],
    }
}
pub(super) fn is_array(value: &Json) -> bool {
    matches!(value, Json::Array(_))
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
pub(super) fn units(value: &Json) -> Result<Vec<u16>, String> {
    Ok(match value {
        Json::Null => "null".encode_utf16().collect(),
        Json::Bool(value) => if *value { "true" } else { "false" }
            .encode_utf16()
            .collect(),
        Json::Number(value) => if value.is_nan() {
            "NaN".into()
        } else if *value == f64::INFINITY {
            "Infinity".into()
        } else if *value == f64::NEG_INFINITY {
            "-Infinity".into()
        } else {
            ryu_js::Buffer::new().format(*value).to_owned()
        }
        .encode_utf16()
        .collect(),
        Json::String(value) => value.clone(),
        Json::Object(_) => {
            if has(value, "toString") || has(value, "valueOf") {
                return Err("operator_dataset_ecmascript_custom_coercion_refused".into());
            }
            "[object Object]".encode_utf16().collect()
        }
        Json::Array(values) => {
            let mut output = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(u16::from(b','));
                }
                if !matches!(value, Json::Null) {
                    output.extend(units(value)?);
                }
            }
            output
        }
    })
}
pub(super) fn string(value: &Json) -> Result<String, String> {
    String::from_utf16(&units(value)?)
        .map_err(|_| "operator_dataset_scalar_string_domain_refused".into())
}
pub(super) fn or_string(value: &Json) -> Result<String, String> {
    if truthy(value) {
        string(value)
    } else {
        Ok(String::new())
    }
}
pub(super) fn eq(value: &Json, expected: &str) -> bool {
    matches!(value, Json::String(units) if units.iter().copied().eq(expected.encode_utf16()))
}
pub(super) fn literal_number(value: &Json, expected: f64) -> bool {
    matches!(value, Json::Number(number) if *number == expected)
}
pub(super) fn boolean(value: &Json, expected: bool) -> bool {
    matches!(value, Json::Bool(boolean) if *boolean == expected)
}
pub(super) fn number(value: &Json) -> Result<f64, String> {
    Ok(match value {
        Json::Null => 0.0,
        Json::Bool(value) => f64::from(u8::from(*value)),
        Json::Number(value) => *value,
        Json::Object(_) => {
            if has(value, "valueOf") || has(value, "toString") {
                return Err("operator_dataset_ecmascript_custom_coercion_refused".into());
            }
            f64::NAN
        }
        Json::String(_) | Json::Array(_) => String::from_utf16(&units(value)?)
            .ok()
            .and_then(|text| {
                crate::automation_runtime_reconciliation::sqlite_number::string_number(&text)
            })
            .unwrap_or(f64::NAN),
    })
}
pub(super) fn safe(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}
pub(super) fn bounded(value: &Json, min: f64, max: f64) -> Result<bool, String> {
    let n = number(value)?;
    Ok(n.is_finite() && n >= min && n <= max)
}
pub(super) fn hash(kind: &str, value: &Json) -> Result<String, String> {
    let bytes = wire(value)?;
    hepta_legacy_compatibility::parse_and_hash_production_record_v1(kind, &bytes)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|error| error.to_string())
}
pub(super) fn wire(value: &Json) -> Result<Vec<u8>, String> {
    production_json_stringify_v1(value).map_err(|error| error.to_string())
}
pub(super) fn same(left: &Json, right: &Json) -> Result<bool, String> {
    Ok(wire(left)? == wire(right)?)
}
pub(super) fn sha(value: &Json) -> Result<bool, String> {
    let text = or_string(value)?;
    Ok(text.len() == 71
        && text
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("sha256:"))
        && text.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit))
}
pub(super) fn identifier(value: &str, maximum: usize, punctuation: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || punctuation.contains(&byte))
}
pub(super) fn semantic_text(value: &Json) -> Result<Option<Json>, String> {
    let source = if truthy(value) {
        units(value)?
    } else {
        Vec::new()
    };
    let mut normalized = Vec::new();
    let mut segment = String::new();
    for unit in char::decode_utf16(source) {
        match unit {
            Ok(ch) => segment.push(ch),
            Err(error) => {
                normalized.extend(segment.nfkc().flat_map(|ch| {
                    let mut out = [0u16; 2];
                    ch.encode_utf16(&mut out).to_vec()
                }));
                segment.clear();
                normalized.push(error.unpaired_surrogate());
            }
        }
    }
    normalized.extend(segment.nfkc().flat_map(|ch| {
        let mut out = [0u16; 2];
        ch.encode_utf16(&mut out).to_vec()
    }));
    let mut output = Vec::new();
    let mut pending_space = false;
    for unit in normalized {
        let whitespace = char::from_u32(u32::from(unit)).is_some_and(|ch| {
            let mut bytes = [0u8; 4];
            crate::automation_runtime_reconciliation::sqlite_number::trim(
                ch.encode_utf8(&mut bytes),
            )
            .is_empty()
        });
        if whitespace {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(u16::from(b' '));
            }
            output.push(unit);
            pending_space = false;
        }
    }
    Ok((!output.is_empty() && output.len() <= 2000).then_some(Json::String(output)))
}
pub(super) fn semantic_list(value: &Json, maximum: usize) -> Result<Option<Json>, String> {
    if !is_array(value) || array(value).is_empty() || array(value).len() > maximum {
        return Ok(None);
    }
    let mut values = Vec::new();
    let mut seen = BTreeSet::new();
    for value in array(value) {
        let Some(value) = semantic_text(value)? else {
            return Ok(None);
        };
        if !seen.insert(wire(&value)?) {
            return Ok(None);
        }
        values.push(value);
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|error| error.to_string())?;
    // ICU receives UTF-16, but the current public comparison API receives UTF-8.
    // Refuse an unpaired-surrogate list rather than silently substitute U+FFFD.
    let mut pairs = values
        .into_iter()
        .map(|value| Ok((string(&value)?, value)))
        .collect::<Result<Vec<_>, String>>()?;
    pairs.sort_by(|left, right| collator.compare(&left.0, &right.0));
    Ok(Some(Json::Array(
        pairs.into_iter().map(|(_, value)| value).collect(),
    )))
}
pub(super) fn ensure(condition: bool, code: &str) -> Result<(), String> {
    if condition { Ok(()) } else { Err(code.into()) }
}
