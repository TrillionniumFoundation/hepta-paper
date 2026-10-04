//! Pure empirical manuscript declaration shapes, never scientific authority.
use crate::native_business::local_submission_preflight::{
    local_submission_truthy, local_submission_value_budget,
};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

fn control(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("native_empirical_marker_cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("native_empirical_marker_deadline".into());
    }
    Ok(())
}

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

fn text(value: &Value) -> Result<String, String> {
    fn custom(value: &Value) -> bool {
        match value {
            Value::Object(object) => object.contains_key("toString"),
            Value::Array(values) => values.iter().any(custom),
            _ => false,
        }
    }
    if !local_submission_truthy(value) {
        return Ok(String::new());
    }
    if custom(value) {
        return Err("native_empirical_marker_string_coercion_refused".into());
    }
    Ok(crate::release_state::javascript_string(value))
}

fn identifier(value: &Value) -> Result<bool, String> {
    let text = text(value)?;
    let bytes = text.as_bytes();
    Ok(!bytes.is_empty()
        && bytes.len() <= 192
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(byte)))
}

fn hash(value: &Value) -> Result<bool, String> {
    let text = text(value)?;
    let bytes = text.as_bytes();
    Ok(bytes.len() == 71
        && bytes[..7].eq_ignore_ascii_case(b"sha256:")
        && bytes[7..].iter().all(u8::is_ascii_hexdigit))
}

fn version(value: &Value) -> bool {
    value.is_number() && value.as_f64() == Some(1.0)
}

/// Check the original assertion marker shape after borrowed record admission.
/// A true result does not verify a signature, manuscript or authority entry.
pub fn assertion_marker_declaration_valid_v1(
    value: &Value,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<bool, String> {
    control(cancelled, deadline)?;
    local_submission_value_budget(value)?;
    let valid = exact(value, &["version", "assertionId", "authorityEntryHash"])
        && version(&value["version"])
        && identifier(&value["assertionId"])?
        && hash(&value["authorityEntryHash"])?;
    control(cancelled, deadline)?;
    Ok(valid)
}

/// Check the original table/figure marker shape; it grants no artifact authority.
pub fn empirical_presentation_marker_declaration_valid_v1(
    value: &Value,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<bool, String> {
    control(cancelled, deadline)?;
    local_submission_value_budget(value)?;
    let valid = if !exact(
        value,
        &[
            "version",
            "surfaceId",
            "surfaceKind",
            "surfaceAuthorityEntryHash",
            "artifactPath",
            "artifactHash",
        ],
    ) || !version(&value["version"])
        || !identifier(&value["surfaceId"])?
        || !matches!(
            value["surfaceKind"].as_str(),
            Some("confirmatory_result_table" | "confirmatory_result_figure")
        )
        || !hash(&value["surfaceAuthorityEntryHash"])?
    {
        false
    } else if value["surfaceKind"] == "confirmatory_result_table" {
        value["artifactPath"].is_null() && value["artifactHash"].is_null()
    } else {
        let path = text(&value["artifactPath"])?;
        path.strip_prefix("figures/")
            .and_then(|path| path.strip_suffix(".pdf"))
            .is_some_and(|name| {
                !name.is_empty()
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            })
            && hash(&value["artifactHash"])?
    };
    control(cancelled, deadline)?;
    Ok(valid)
}

#[cfg(test)]
mod tests;
