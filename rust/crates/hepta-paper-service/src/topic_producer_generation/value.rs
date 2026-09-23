use super::{Result, invalid};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::Value;
pub(super) fn hash(domain: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(domain, value)
        .map(|v| v.as_str().to_owned())
        .map_err(|_| invalid("autonomous_research_topic_producer_json_profile_unsupported"))
}
pub(super) fn own_hash(value: &Value, domain: &str, field: &str) -> Result<bool> {
    let Some(mut payload) = value.as_object().cloned() else {
        return Ok(false);
    };
    payload.remove(field);
    Ok(value[field].as_str() == Some(hash(domain, &Value::Object(payload))?.as_str()))
}
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub(super) fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(v) => v.to_string(),
        Value::String(v) => v.clone(),
        Value::Number(v) => v
            .as_f64()
            .map(|v| ryu_js::Buffer::new().format(v).to_owned())
            .unwrap_or_else(|| "NaN".to_owned()),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    string(v)
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
pub(super) fn sha(value: &Value) -> bool {
    let s = or_empty(value);
    s.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(super) fn strict_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => {
            std::ptr::eq(a, b)
        }
        _ => a == b,
    }
}
pub(super) fn time(value: &Value) -> Result<i64> {
    crate::machine_intake::contract::canonical_instant(value)
        .ok_or_else(|| invalid("autonomous_research_topic_producer_date_parse_profile_unsupported"))
}
pub(super) fn iso(millis: i64) -> Result<String> {
    if millis.abs() > 8_640_000_000_000_000 {
        return Err(invalid(
            "autonomous_research_topic_producer_date_parse_profile_unsupported",
        ));
    }
    let days = millis.div_euclid(86_400_000);
    let within = millis.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + i64::from(month <= 2);
    let year = if (0..10000).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Ok(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        within / 3_600_000,
        (within / 60_000) % 60,
        (within / 1000) % 60,
        within % 1000
    ))
}

/// Bound recursive coercion/hashing before work. Plain JSON objects with an own
/// noncallable toString can make original coercion throw engine TypeErrors;
/// retain an explicit native transport refusal instead of inventing its value.
pub(super) fn ensure_supported(value: &Value) -> Result<()> {
    fn visit(value: &Value, depth: usize, nodes: &mut usize, bytes: &mut usize) -> bool {
        *nodes += 1;
        if depth > 64 || *nodes > 100_000 {
            return false;
        }
        *bytes = bytes.saturating_add(match value {
            Value::String(v) => v.len(),
            Value::Number(_) => 32,
            _ => 8,
        });
        if *bytes > 2 * 1024 * 1024 {
            return false;
        }
        match value {
            Value::Array(values) => values.iter().all(|v| visit(v, depth + 1, nodes, bytes)),
            Value::Object(values) => {
                !values.contains_key("toString")
                    && values.iter().all(|(key, v)| {
                        *bytes = bytes.saturating_add(key.len());
                        *bytes <= 2 * 1024 * 1024 && visit(v, depth + 1, nodes, bytes)
                    })
            }
            _ => true,
        }
    }
    if visit(value, 0, &mut 0, &mut 0) {
        Ok(())
    } else {
        Err(invalid(
            "autonomous_research_topic_producer_json_profile_unsupported",
        ))
    }
}

// Match the incumbent JSON boundary after hashing: ECMAScript emits 1e0/1.0 as
// 1 and negative zero as 0. Do not retain serde Float variants in diagnostics.
pub(super) fn project(value: Value) -> Result<Value> {
    let bytes = hepta_legacy_compatibility::production_stable_json_v1(&value)
        .map_err(|_| invalid("autonomous_research_topic_producer_json_profile_unsupported"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| invalid("autonomous_research_topic_producer_json_profile_unsupported"))
}
