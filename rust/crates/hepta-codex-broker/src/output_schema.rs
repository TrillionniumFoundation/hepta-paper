//! Deliberately bounded JSON Schema subset. Unsupported assertions fail preflight.
//! No remote references, regular expressions, implicit coercion, or ignored assertions.
use serde_json::Value;

const MAXIMUM_SCHEMA_DEPTH: usize = 32;
const MAXIMUM_SCHEMA_NODES: usize = 16_384;

pub(crate) fn validate_schema(schema: &Value) -> Result<(), String> {
    let mut remaining = MAXIMUM_SCHEMA_NODES;
    inspect(schema, 0, &mut remaining)
}

fn inspect(schema: &Value, depth: usize, remaining: &mut usize) -> Result<(), String> {
    if depth > MAXIMUM_SCHEMA_DEPTH || *remaining == 0 {
        return Err("schema_complexity_limit".into());
    }
    *remaining -= 1;
    if schema.is_boolean() {
        return Ok(());
    }
    let object = schema.as_object().ok_or("schema_not_object")?;
    for (key, value) in object {
        match key.as_str() {
            "$schema" => {
                if !matches!(
                    value.as_str(),
                    Some(
                        "https://json-schema.org/draft/2020-12/schema"
                            | "http://json-schema.org/draft-07/schema#"
                    )
                ) {
                    return Err("unsupported_schema_dialect".into());
                }
            }
            "title" | "description" | "$comment" => {
                if !value.is_string() {
                    return Err("invalid_schema_annotation".into());
                }
            }
            "type" => {
                let types = match value {
                    Value::String(_) => vec![value],
                    Value::Array(types) if !types.is_empty() => types.iter().collect(),
                    _ => return Err("invalid_schema_type".into()),
                };
                if types.iter().any(|v| {
                    !matches!(
                        v.as_str(),
                        Some(
                            "null"
                                | "boolean"
                                | "object"
                                | "array"
                                | "number"
                                | "integer"
                                | "string"
                        )
                    )
                }) {
                    return Err("invalid_schema_type".into());
                }
            }
            "properties" => {
                for child in value
                    .as_object()
                    .ok_or("invalid_schema_properties")?
                    .values()
                {
                    inspect(child, depth + 1, remaining)?;
                }
            }
            "required" => {
                let items = value.as_array().ok_or("invalid_schema_required")?;
                if items.iter().any(|item| !item.is_string()) {
                    return Err("invalid_schema_required".into());
                }
                let names = items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default())
                    .collect::<std::collections::BTreeSet<_>>();
                if names.len() != items.len() {
                    return Err("duplicate_schema_required".into());
                }
            }
            "additionalProperties" | "items" => inspect(value, depth + 1, remaining)?,
            "anyOf" | "oneOf" | "allOf" => {
                let items = value.as_array().ok_or("invalid_schema_combination")?;
                if items.is_empty() {
                    return Err("empty_schema_combination".into());
                }
                for child in items {
                    inspect(child, depth + 1, remaining)?;
                }
            }
            "enum" => {
                if value.as_array().is_none_or(Vec::is_empty) {
                    return Err("invalid_schema_enum".into());
                }
            }
            "const" => {}
            "minLength" | "maxLength" | "minItems" | "maxItems" | "minProperties"
            | "maxProperties" => {
                if value.as_u64().is_none() {
                    return Err("invalid_schema_bound".into());
                }
            }
            "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" => {
                if !value.is_number() {
                    return Err("invalid_schema_bound".into());
                }
            }
            "uniqueItems" => {
                if !value.is_boolean() {
                    return Err("invalid_schema_unique_items".into());
                }
            }
            _ => return Err(format!("unsupported_schema_keyword:{key}")),
        }
    }
    Ok(())
}

pub(crate) fn validate_output(schema: &Value, output: &Value) -> Result<(), String> {
    validate_schema(schema)?;
    let mut budget = 1_000_000usize;
    if matches_schema(schema, output, 0, &mut budget)? {
        Ok(())
    } else {
        Err("output_schema_mismatch".into())
    }
}

fn matches_schema(
    schema: &Value,
    value: &Value,
    depth: usize,
    budget: &mut usize,
) -> Result<bool, String> {
    if depth > 64 || *budget == 0 {
        return Err("output_validation_complexity_limit".into());
    }
    *budget -= 1;
    if let Some(allowed) = schema.as_bool() {
        return Ok(allowed);
    }
    let object = schema.as_object().ok_or("schema_not_object")?;
    if let Some(types) = object.get("type") {
        let matches_type = |kind: &Value| match kind.as_str() {
            Some("null") => value.is_null(),
            Some("boolean") => value.is_boolean(),
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("number") => value.is_number(),
            Some("integer") => {
                value.as_i64().is_some()
                    || value.as_u64().is_some()
                    || value.as_f64().is_some_and(|v| v.fract() == 0.0)
            }
            Some("string") => value.is_string(),
            _ => false,
        };
        if !match types {
            Value::Array(types) => types.iter().any(matches_type),
            _ => matches_type(types),
        } {
            return Ok(false);
        }
    }
    if object
        .get("const")
        .is_some_and(|expected| expected != value)
    {
        return Ok(false);
    }
    if object.get("enum").is_some_and(|choices| {
        !choices
            .as_array()
            .is_some_and(|choices| choices.contains(value))
    }) {
        return Ok(false);
    }
    for keyword in ["allOf", "anyOf", "oneOf"] {
        if let Some(children) = object.get(keyword).and_then(Value::as_array) {
            let mut count = 0;
            for child in children {
                if matches_schema(child, value, depth + 1, budget)? {
                    count += 1;
                }
            }
            if (keyword == "allOf" && count != children.len())
                || (keyword == "anyOf" && count == 0)
                || (keyword == "oneOf" && count != 1)
            {
                return Ok(false);
            }
        }
    }
    if let Some(value) = value.as_object() {
        if !length_bounds(object, value.len(), "minProperties", "maxProperties") {
            return Ok(false);
        }
        if object
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(|names| {
                names
                    .iter()
                    .any(|name| !value.contains_key(name.as_str().unwrap_or_default()))
            })
        {
            return Ok(false);
        }
        let properties = object.get("properties").and_then(Value::as_object);
        for (key, item) in value {
            if let Some(child) = properties
                .and_then(|properties| properties.get(key))
                .or_else(|| object.get("additionalProperties"))
                && !matches_schema(child, item, depth + 1, budget)?
            {
                return Ok(false);
            }
        }
    }
    if let Some(items) = value.as_array() {
        if !length_bounds(object, items.len(), "minItems", "maxItems") {
            return Ok(false);
        }
        if let Some(child) = object.get("items") {
            for item in items {
                if !matches_schema(child, item, depth + 1, budget)? {
                    return Ok(false);
                }
            }
        }
        if object.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
            for (index, item) in items.iter().enumerate() {
                if *budget < index {
                    return Err("output_validation_complexity_limit".into());
                }
                *budget -= index;
                if items[..index].contains(item) {
                    return Ok(false);
                }
            }
        }
    }
    if let Some(text) = value.as_str()
        && !length_bounds(object, text.chars().count(), "minLength", "maxLength")
    {
        return Ok(false);
    }
    if value.is_number() {
        for keyword in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] {
            if let Some(bound) = object.get(keyword) {
                let ordering = compare_numbers(value, bound)?;
                let passes = match keyword {
                    "minimum" => !ordering.is_lt(),
                    "maximum" => !ordering.is_gt(),
                    "exclusiveMinimum" => ordering.is_gt(),
                    _ => ordering.is_lt(),
                };
                if !passes {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

fn compare_numbers(left: &Value, right: &Value) -> Result<std::cmp::Ordering, String> {
    let integer = |value: &Value| {
        value
            .as_i64()
            .map(i128::from)
            .or_else(|| value.as_u64().map(i128::from))
    };
    if let (Some(left), Some(right)) = (integer(left), integer(right)) {
        return Ok(left.cmp(&right));
    }
    let left = left.as_f64().ok_or("invalid_numeric_assertion")?;
    let right = right.as_f64().ok_or("invalid_numeric_assertion")?;
    // Mixed large integer/fraction comparisons require decimal arithmetic absent from this subset.
    if left.abs() > 9_007_199_254_740_992.0 || right.abs() > 9_007_199_254_740_992.0 {
        return Err("unsupported_numeric_precision".into());
    }
    left.partial_cmp(&right)
        .ok_or_else(|| "invalid_numeric_assertion".into())
}

fn length_bounds(
    object: &serde_json::Map<String, Value>,
    length: usize,
    min: &str,
    max: &str,
) -> bool {
    object
        .get(min)
        .and_then(Value::as_u64)
        .is_none_or(|bound| length as u64 >= bound)
        && object
            .get(max)
            .and_then(Value::as_u64)
            .is_none_or(|bound| length as u64 <= bound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn validates_actual_values_and_rejects_unsupported_assertions() {
        let schema = json!({"type":"object", "required":["answer"], "additionalProperties":false, "properties":{"answer":{"type":"string","minLength":1},"score":{"type":"integer","minimum":0,"maximum":10}}});
        assert!(validate_output(&schema, &json!({"answer":"yes","score":10})).is_ok());
        for invalid in [
            json!({}),
            json!({"answer":""}),
            json!({"answer":"yes","score":11}),
            json!({"answer":"yes","extra":0}),
        ] {
            assert!(validate_output(&schema, &invalid).is_err());
        }
        assert!(validate_schema(&json!({"type":"string","pattern":"^x$"})).is_err());
        assert!(validate_schema(&json!({"$ref":"https://example.invalid/schema"})).is_err());
        assert!(
            validate_output(
                &json!({"type":"integer","maximum":9_007_199_254_740_992u64}),
                &json!(9_007_199_254_740_993u64)
            )
            .is_err()
        );
    }
}
