//! Bounded JSON-domain JavaScript coercion for the passive asset inspector.
//! Values returned in reports retain their original type. This owner grants no
//! external-reference, release or mutation authority.
use super::RepositoryAssetError as Error;
use hepta_legacy_compatibility::{ProductionJsonValue, production_json_stringify_v1};
use serde_json::Value;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_VALUES: usize = MAX_BYTES;
const MAX_DEPTH: usize = 256;

pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Number(value)) => value.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Some(Value::Bool(true) | Value::Array(_) | Value::Object(_)) => true,
    }
}
pub(super) fn raw_or_null(value: Option<&Value>) -> Result<Value, Error> {
    clone_raw(value.filter(|v| truthy(Some(v))))
}
pub(super) fn clone_raw(value: Option<&Value>) -> Result<Value, Error> {
    clone_value(value.unwrap_or(&Value::Null), 0, &mut 0, &mut 0)
}
fn clone_value(
    value: &Value,
    depth: usize,
    visited: &mut usize,
    bytes: &mut usize,
) -> Result<Value, Error> {
    if depth > MAX_DEPTH || *visited >= MAX_VALUES {
        return Err(Error::Coercion("repository_asset_coercion_limit"));
    }
    *visited += 1;
    let mut charge = |n: usize| {
        if n > MAX_BYTES.saturating_sub(*bytes) {
            return Err(Error::Coercion("repository_asset_coercion_limit"));
        }
        *bytes += n;
        Ok(())
    };
    match value {
        Value::Null | Value::Bool(_) => {
            charge(5)?;
            Ok(value.clone())
        }
        Value::String(v) => {
            charge(v.len())?;
            Ok(Value::String(v.clone()))
        }
        Value::Number(v) => {
            let raw = production_json_stringify_v1(&ProductionJsonValue::Number(
                v.as_f64().ok_or(Error::Compatibility)?,
            ))
            .map_err(|_| Error::Compatibility)?;
            charge(raw.len())?;
            serde_json::from_slice(&raw).map_err(|_| Error::Compatibility)
        }
        Value::Array(values) => {
            charge(values.len())?;
            values
                .iter()
                .map(|v| clone_value(v, depth + 1, visited, bytes))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        Value::Object(values) => {
            charge(values.len())?;
            let mut result = serde_json::Map::new();
            for (key, value) in values {
                if key.len() > MAX_BYTES.saturating_sub(*bytes) {
                    return Err(Error::Coercion("repository_asset_coercion_limit"));
                }
                *bytes += key.len();
                let value = clone_value(value, depth + 1, visited, bytes)?;
                result.insert(key.clone(), value);
            }
            Ok(Value::Object(result))
        }
    }
}
pub(super) fn primitive_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(left)), Some(Value::Bool(right))) => left == right,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left
            .as_f64()
            .zip(right.as_f64())
            .is_some_and(|(a, b)| a == b),
        (Some(Value::String(left)), Some(Value::String(right))) => left == right,
        // Separate JSON object/array members do not have JavaScript identity,
        // even when their serialized bytes happen to match.
        _ => false,
    }
}
#[derive(Eq, PartialEq, Ord, PartialOrd)]
pub(super) enum PrimitiveIdentity {
    Null,
    Bool(bool),
    Number(u64),
    String(String),
}
pub(super) fn primitive_identity(value: &Value) -> Option<PrimitiveIdentity> {
    match value {
        Value::Null => Some(PrimitiveIdentity::Null),
        Value::Bool(v) => Some(PrimitiveIdentity::Bool(*v)),
        Value::String(v) => Some(PrimitiveIdentity::String(v.clone())),
        Value::Number(v) => v
            .as_f64()
            .map(|v| PrimitiveIdentity::Number(if v == 0.0 { 0 } else { v.to_bits() })),
        Value::Array(_) | Value::Object(_) => None,
    }
}
pub(super) fn trim(value: &str) -> &str {
    crate::automation_runtime_reconciliation::sqlite_number::trim(value)
}
pub(super) fn has_whitespace(value: &str) -> bool {
    value.chars().any(|c| {
        let mut bytes = [0; 4];
        trim(c.encode_utf8(&mut bytes)).is_empty()
    })
}
pub(super) fn string_or_empty(value: Option<&Value>) -> Result<String, Error> {
    if !truthy(value) {
        return Ok(String::new());
    }
    string(value)
}
pub(super) fn string(value: Option<&Value>) -> Result<String, Error> {
    let mut output = String::new();
    append(value, false, 0, &mut 0, &mut output)?;
    Ok(output)
}
fn push(output: &mut String, value: &str) -> Result<(), Error> {
    if value.len() > MAX_BYTES.saturating_sub(output.len()) {
        return Err(Error::Coercion("repository_asset_coercion_limit"));
    }
    output.push_str(value);
    Ok(())
}
fn append(
    value: Option<&Value>,
    array_member: bool,
    depth: usize,
    visited: &mut usize,
    output: &mut String,
) -> Result<(), Error> {
    if depth > MAX_DEPTH || *visited >= MAX_VALUES {
        return Err(Error::Coercion("repository_asset_coercion_limit"));
    }
    *visited += 1;
    match value {
        None => {
            if !array_member {
                push(output, "undefined")?;
            }
        }
        Some(Value::Null) => {
            if !array_member {
                push(output, "null")?;
            }
        }
        Some(Value::Bool(value)) => push(output, if *value { "true" } else { "false" })?,
        Some(Value::String(value)) => push(output, value)?,
        Some(Value::Number(value)) => {
            let number = value.as_f64().ok_or(Error::Compatibility)?;
            // Use the existing exact Number/stringify encoder rather than a
            // second decimal/rounding formatter. JSON numbers here are finite.
            let raw = production_json_stringify_v1(&ProductionJsonValue::Number(number))
                .map_err(|_| Error::Compatibility)?;
            let text = std::str::from_utf8(&raw).map_err(|_| Error::Compatibility)?;
            push(output, text)?;
        }
        Some(Value::Array(values)) => {
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    push(output, ",")?;
                }
                append(Some(value), true, depth + 1, visited, output)?;
            }
        }
        Some(Value::Object(value)) => {
            // JSON cannot provide callable methods. An own toString shadows
            // Object.prototype.toString; valueOf can only return the object.
            if value.contains_key("toString") {
                return Err(Error::Coercion("Cannot convert object to primitive value"));
            }
            push(output, "[object Object]")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
