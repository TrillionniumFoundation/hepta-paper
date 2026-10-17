//! Owner-private deployment environment overlay. No shell expansion, process
//! execution, configuration activation or provider credential loading occurs.
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
mod file;
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DeploymentEnvironmentError(String);
type Result<T> = std::result::Result<T, DeploymentEnvironmentError>;
fn error(code: impl Into<String>) -> DeploymentEnvironmentError {
    DeploymentEnvironmentError(code.into())
}
fn space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn trim(s: &str) -> &str {
    s.trim_matches(space)
}
fn decode(source: &str, line: usize) -> Result<String> {
    let value = trim(source);
    if value.is_empty() {
        return Ok(String::new());
    }
    let quote = value
        .chars()
        .next()
        .ok_or_else(|| error("deployment_environment_value_invalid"))?;
    if quote == '\'' || quote == '"' {
        if value.len() < 2 || !value.ends_with(quote) {
            return Err(error(format!(
                "deployment_environment_value_quote_invalid:{line}"
            )));
        }
        let inner = &value[1..value.len() - 1];
        if quote == '\'' && inner.contains('\'') {
            return Err(error(format!(
                "deployment_environment_single_quote_invalid:{line}"
            )));
        }
        if quote == '\'' {
            return Ok(inner.into());
        }
        let mut result = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' && chars.peek().is_some_and(|v| *v == '"' || *v == '\\') {
                if let Some(escaped) = chars.next() {
                    result.push(escaped);
                }
            } else {
                result.push(c);
            }
        }
        return Ok(result);
    }
    if value.chars().any(space) || value.contains('#') {
        return Err(error(format!(
            "deployment_environment_unquoted_value_invalid:{line}"
        )));
    }
    Ok(value.into())
}
/// Parse the closed assignment grammar. Nothing is expanded or executed.
pub fn parse_deployment_environment_file_v1(content: &str) -> Result<BTreeMap<String, String>> {
    let allowed: Vec<String> =
        serde_json::from_str(include_str!("deployment_environment/allowed-keys.v1.json"))
            .map_err(|_| error("deployment_environment_allowlist_invalid"))?;
    let mut values = BTreeMap::new();
    for (index, raw) in content.split('\n').enumerate() {
        let line = trim(raw);
        let line_number = index + 1;
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(separator) = line.find('=').filter(|p| *p >= 1) else {
            return Err(error(format!(
                "deployment_environment_assignment_invalid:{line_number}"
            )));
        };
        let key = trim(&line[..separator]);
        let valid = key
            .as_bytes()
            .first()
            .is_some_and(|c| c.is_ascii_uppercase() || *c == b'_')
            && key
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            && allowed.iter().any(|v| v == key);
        if !valid {
            return Err(error(format!(
                "deployment_environment_key_not_allowlisted:{line_number}:{key}"
            )));
        }
        if values.contains_key(key) {
            return Err(error(format!(
                "deployment_environment_key_duplicate:{line_number}:{key}"
            )));
        }
        values.insert(key.to_owned(), decode(&line[separator + 1..], line_number)?);
    }
    Ok(values)
}
pub struct DeploymentEnvironmentV1 {
    pub environment: Value,
    pub inspection: Value,
}
/// Overlay explicit allowlisted assignments onto an owned environment map.
/// Reports contain names and hashes only. Caller-provided ambient values are
/// preserved; the output map must not be logged as a credential-safe report.
pub fn load_readiness_deployment_environment_v1(
    base: &Value,
    path: Option<&Path>,
) -> Result<DeploymentEnvironmentV1> {
    let mut environment = base
        .as_object()
        .cloned()
        .ok_or_else(|| error("deployment_environment_base_object_required"))?;
    let mut payload = json!({"version":1,"kind":"AutomationReadinessDeploymentEnvironmentInspection","status":"automation_readiness_ambient_environment_observed","source":"ambient-process-environment","filePath":null,"fileHash":null,"loadedKeys":[],"credentialMaterialLoaded":false});
    if let Some(path) = path.filter(|p| !p.as_os_str().is_empty()) {
        let snapshot = file::PrivateEnvironmentFile::read(path)?;
        let content = std::str::from_utf8(&snapshot.bytes)
            .map_err(|_| error("deployment_environment_file_utf8_invalid"))?;
        let values = parse_deployment_environment_file_v1(content)?;
        let keys: Vec<_> = values.keys().cloned().collect();
        for (key, value) in values {
            environment.insert(key, Value::String(value));
        }
        payload["status"] = json!("automation_readiness_deployment_environment_loaded");
        payload["source"] = json!("explicit-owner-private-environment-file");
        payload["filePath"] = json!(snapshot.path);
        payload["fileHash"] = json!(format!(
            "sha256:{}",
            hex::encode(Sha256::digest(&snapshot.bytes))
        ));
        payload["loadedKeys"] = json!(keys);
        snapshot.assert_current()?;
    }
    payload["automationReadinessDeploymentEnvironmentInspectionHash"] = json!(
        production_hash_record_v1(
            "AutomationReadinessDeploymentEnvironmentInspection",
            &payload
        )
        .map_err(|_| error("deployment_environment_inspection_hash_failed"))?
        .as_str()
    );
    Ok(DeploymentEnvironmentV1 {
        environment: Value::Object(environment),
        inspection: payload,
    })
}
