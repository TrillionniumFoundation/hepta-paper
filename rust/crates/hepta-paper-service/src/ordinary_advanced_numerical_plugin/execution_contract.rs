//! Pure ordinary request/result contracts over the production JSON value domain.
//! Filesystem execution, permissions and settlement belong to the existing owners.
use super::{Json, check, descriptor, field, hash, object, text};
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, production_json_stringify_with_limits_v1,
};
use std::{sync::atomic::AtomicBool, time::Instant};

fn own<'a>(v: &'a Json, key: &str) -> Option<&'a Json> {
    if let Json::Object(fields) = v {
        fields
            .iter()
            .find(|(name, _)| name.iter().copied().eq(key.encode_utf16()))
            .map(|(_, v)| v)
    } else {
        None
    }
}
fn truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => *n != 0.0 && !n.is_nan(),
        Json::String(s) => !s.is_empty(),
        Json::Object(_) | Json::Array(_) => true,
    }
}
// This is the closed JSON-data String conversion used by these two contracts.
// An own JSON toString property is never executable; inherited valueOf returns
// the object. An own valueOf alone does not shadow inherited Object.toString.
// The established encoder reserves the whole input before derived allocation.
pub(super) fn json_string(v: &Json, c: &AtomicBool, d: Instant) -> Result<Vec<u16>, String> {
    let reserved = hepta_legacy_compatibility::production_json_resources_v1(
        v,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 4 * 1024 * 1024,
            maximum_values: 200_000,
            maximum_utf16_units: 4 * 1024 * 1024,
        },
        c,
    );
    check(c, d)?;
    reserved.map_err(|e| e.to_string())?;
    fn append(out: &mut Vec<u16>, units: &[u16], c: &AtomicBool, d: Instant) -> Result<(), String> {
        check(c, d)?;
        if out
            .len()
            .checked_add(units.len())
            .is_none_or(|n| n > 4 * 1024 * 1024)
        {
            return Err("advanced_numerical_plugin_string_budget_refused".into());
        }
        out.extend_from_slice(units);
        Ok(())
    }
    fn walk(v: &Json, out: &mut Vec<u16>, c: &AtomicBool, d: Instant) -> Result<(), String> {
        check(c, d)?;
        match v {
            Json::String(units) => append(out, units, c, d),
            Json::Array(values) => {
                for (i, item) in values.iter().enumerate() {
                    check(c, d)?;
                    if i != 0 {
                        append(out, &[b',' as u16], c, d)?;
                    }
                    if !matches!(item, Json::Null) {
                        walk(item, out, c, d)?;
                    }
                }
                Ok(())
            }
            Json::Object(_) => {
                if own(v, "toString").is_some() {
                    return Err("Cannot convert object to primitive value".into());
                }
                append(
                    out,
                    &"[object Object]".encode_utf16().collect::<Vec<_>>(),
                    c,
                    d,
                )
            }
            Json::Null | Json::Bool(_) | Json::Number(_) => {
                let scalar = match v {
                    Json::Null => "null".to_owned(),
                    Json::Bool(value) => value.to_string(),
                    Json::Number(n) if n.is_nan() => "NaN".into(),
                    Json::Number(n) if *n == f64::INFINITY => "Infinity".into(),
                    Json::Number(n) if *n == f64::NEG_INFINITY => "-Infinity".into(),
                    Json::Number(n) => {
                        let number = serde_json::Number::from_f64(*n)
                            .ok_or("advanced_numerical_plugin_number_invalid")?;
                        crate::release_state::javascript_string(&serde_json::Value::Number(number))
                    }
                    _ => return Err("advanced_numerical_plugin_string_shape_invalid".into()),
                };
                append(out, &scalar.encode_utf16().collect::<Vec<_>>(), c, d)
            }
        }
    }
    let mut out = Vec::new();
    walk(v, &mut out, c, d)?;
    check(c, d)?;
    Ok(out)
}
fn string_or_empty(v: Option<&Json>, c: &AtomicBool, d: Instant) -> Result<Vec<u16>, String> {
    check(c, d)?;
    match v.filter(|v| truthy(v)) {
        Some(v) => json_string(v, c, d),
        None => Ok(Vec::new()),
    }
}
fn safe_id(v: Option<&Json>, c: &AtomicBool, d: Instant) -> Result<bool, String> {
    let raw = string_or_empty(v, c, d)?;
    let Ok(raw) = String::from_utf16(&raw) else {
        return Ok(false);
    };
    let id = crate::automation_runtime_reconciliation::sqlite_number::trim(&raw);
    Ok(!id.is_empty()
        && id.len() <= 192
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b)))
}
fn required_hash(v: Option<&Json>, c: &AtomicBool, d: Instant) -> Result<bool, String> {
    let raw = string_or_empty(v, c, d)?;
    let Ok(raw) = String::from_utf16(&raw) else {
        return Ok(false);
    };
    let lower = raw.to_ascii_lowercase();
    Ok(lower.strip_prefix("sha256:").is_some_and(|body| {
        body.len() == 64
            && body
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }))
}
// Preserve missing versus null, JS number equality and UTF-16 strings. Object
// and array values cannot pass JS strict equality between independent documents.
fn strict_equal(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) | (Some(Json::Null), Some(Json::Null)) => true,
        (Some(Json::Bool(a)), Some(Json::Bool(b))) => a == b,
        (Some(Json::Number(a)), Some(Json::Number(b))) => a == b,
        (Some(Json::String(a)), Some(Json::String(b))) => a == b,
        _ => false,
    }
}
fn nested<'a>(v: &'a Json, keys: &[&str]) -> Option<&'a Json> {
    keys.iter().try_fold(v, |v, key| own(v, key))
}

pub(super) fn request_v1(
    descriptor_document: &Json,
    request_document: &Json,
    c: &AtomicBool,
    d: Instant,
) -> Result<Json, String> {
    check(c, d)?;
    if descriptor::inspect(descriptor_document, c, d).is_err() {
        check(c, d)?;
        return Err("advanced_numerical_plugin_request_invalid".into());
    }
    let run_id = own(request_document, "runId");
    let seed = own(request_document, "seed");
    if !safe_id(run_id, c, d)?
        || !matches!(seed, Some(Json::Number(n)) if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
    {
        return Err("advanced_numerical_plugin_request_invalid".into());
    }
    // Missing input is outside the JSON value domain; never replace it with null.
    let input =
        own(request_document, "input").ok_or("advanced_numerical_plugin_request_input_invalid")?;
    let encoded_input = production_json_stringify_with_limits_v1(
        input,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 32 * 1024,
            maximum_values: 200_000,
            maximum_utf16_units: 4 * 1024 * 1024,
        },
        c,
    );
    check(c, d)?;
    encoded_input.map_err(|_| "advanced_numerical_plugin_request_input_too_large")?;
    let mut request = object([
        ("version", Json::Number(1.0)),
        ("kind", text("AdvancedNumericalPluginRequest")),
        ("runId", field(request_document, "runId").clone()),
        ("pluginId", field(descriptor_document, "pluginId").clone()),
        (
            "pluginDescriptorHash",
            field(descriptor_document, "advancedNumericalPluginDescriptorHash").clone(),
        ),
        (
            "analysisFamily",
            field(descriptor_document, "analysisFamily").clone(),
        ),
        ("seed", field(request_document, "seed").clone()),
        ("input", input.clone()),
        (
            "assuranceContracts",
            field(descriptor_document, "assuranceContracts").clone(),
        ),
    ]);
    let digest = hash("AdvancedNumericalPluginRequest", &request, c);
    check(c, d)?;
    let digest = digest?;
    let Json::Object(fields) = &mut request else {
        return Err("advanced_numerical_plugin_request_invalid".into());
    };
    fields.push((
        "advancedNumericalPluginRequestHash"
            .encode_utf16()
            .collect(),
        text(&digest),
    ));
    check(c, d)?;
    Ok(request)
}

pub(super) fn result_valid_v1(
    result: &Json,
    descriptor_document: &Json,
    request: &Json,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    check(c, d)?;
    if !strict_equal(own(result, "version"), Some(&Json::Number(1.0)))
        || !strict_equal(
            own(result, "kind"),
            Some(&text("AdvancedNumericalPluginResult")),
        )
        || !strict_equal(
            own(result, "status"),
            Some(&text("advanced_numerical_computation_completed")),
        )
        || !strict_equal(
            own(result, "pluginId"),
            own(descriptor_document, "pluginId"),
        )
        || !strict_equal(
            own(result, "analysisFamily"),
            own(descriptor_document, "analysisFamily"),
        )
        || !strict_equal(
            own(result, "requestHash"),
            own(request, "advancedNumericalPluginRequestHash"),
        )
    {
        return Ok(false);
    }
    for (name, contract) in [
        ("oracleContractHash", "oracle"),
        ("replayContractHash", "replay"),
        ("uncertaintyContractHash", "uncertainty"),
    ] {
        if !strict_equal(
            own(result, name),
            nested(
                descriptor_document,
                &["assuranceContracts", contract, "contractHash"],
            ),
        ) {
            return Ok(false);
        }
    }
    for name in [
        "estimateArtifactHash",
        "oracleReceiptHash",
        "replayReceiptHash",
        "uncertaintyArtifactHash",
        "uncertaintyReceiptHash",
        "advancedNumericalPluginResultHash",
    ] {
        if !required_hash(own(result, name), c, d)? {
            return Ok(false);
        }
    }
    let Json::Object(fields) = result else {
        return Ok(false);
    };
    let payload = Json::Object(
        fields
            .iter()
            .filter(|(name, _)| {
                !name
                    .iter()
                    .copied()
                    .eq("advancedNumericalPluginResultHash".encode_utf16())
            })
            .cloned()
            .collect(),
    );
    let digest = hash("AdvancedNumericalPluginResult", &payload, c);
    check(c, d)?;
    let digest = digest?;
    Ok(strict_equal(
        own(result, "advancedNumericalPluginResultHash"),
        Some(&text(&digest)),
    ))
}

#[cfg(test)]
mod tests;
