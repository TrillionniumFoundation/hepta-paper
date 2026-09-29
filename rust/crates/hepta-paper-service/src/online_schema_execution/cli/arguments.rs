//! Strict grammar for the explicitly pinned, read-only native planning profile.
use std::{collections::BTreeMap, path::PathBuf};
pub(super) struct Arguments {
    pub help: bool,
    pub runtime: PathBuf,
    pub process: PathBuf,
    pub process_hash: String,
    pub requested_lease_ms: i64,
    pub execution_window_ms: i64,
    pub expected_pristine: Option<String>,
}
fn invalid(name: &str) -> String {
    format!("autonomous_research_online_schema_transition_{name}")
}
fn hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn positive(
    values: &BTreeMap<String, String>,
    key: &str,
    fallback: i64,
    minimum: i64,
) -> Result<i64, String> {
    let Some(value) = values.get(key) else {
        return Ok(fallback);
    };
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid(&format!("{}_invalid", key.replace('-', "_"))));
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|v| *v >= minimum && *v <= 900000)
        .ok_or_else(|| invalid(&format!("{}_invalid", key.replace('-', "_"))))
}
pub(super) fn parse(args: &[String]) -> Result<Arguments, String> {
    let mut values = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected_cli_positional:{token}"))?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        let value = match key {
            "help" | "execute" => {
                if inline.is_some() {
                    return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
                }
                String::new()
            }
            "action"
            | "runtime-root"
            | "authority-process-config"
            | "authority-process-config-sha256"
            | "requested-lease-ms"
            | "required-execution-window-ms"
            | "commit-safety-margin-ms"
            | "transition-id"
            | "expected-pre-rebind-pristine-runtime-state-hash" => {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        index += 1;
                        args.get(index)
                            .filter(|v| !v.starts_with("--"))
                            .map(String::as_str)
                            .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?
                    }
                };
                if value.is_empty() {
                    return Err(format!("empty_cli_option_value:--{key}"));
                }
                value.to_owned()
            }
            _ => return Err(format!("unknown_cli_option:--{key}")),
        };
        if values.insert(key.to_owned(), value).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        index += 1;
    }
    let help = values.contains_key("help");
    let defaults = Arguments {
        help,
        runtime: PathBuf::new(),
        process: PathBuf::new(),
        process_hash: String::new(),
        requested_lease_ms: 120000,
        execution_window_ms: 30000,
        expected_pristine: None,
    };
    if help {
        return Ok(defaults);
    }
    let action = values.get("action").map(String::as_str).unwrap_or("plan");
    if !matches!(action, "plan" | "execute") {
        return Err(invalid(&format!("action_invalid:{action}")));
    }
    if action == "execute" {
        if !values.contains_key("execute") {
            return Err(invalid("execute_confirmation_required"));
        }
        if !values.get("transition-id").is_some_and(|v| hash(v)) {
            return Err(invalid("transition_id_required"));
        }
        // This entry cannot enter the live executor, even with apparent pins or
        // confirmation flags. Installed recovery/activation is a separate owner.
        return Err(invalid("native_execute_requires_installed_owner"));
    }
    if values.contains_key("execute") {
        return Err(invalid("execute_action_required"));
    }
    if values.contains_key("transition-id") || values.contains_key("commit-safety-margin-ms") {
        return Err(invalid("execute_option_forbidden_in_plan"));
    }
    let runtime = values
        .get("runtime-root")
        .ok_or_else(|| invalid("runtime_root_required"))?;
    let process = values
        .get("authority-process-config")
        .ok_or_else(|| invalid("authority_process_config_required"))?;
    let process_hash = values
        .get("authority-process-config-sha256")
        .filter(|v| hash(v))
        .ok_or_else(|| invalid("authority_process_config_pin_required"))?;
    let requested = positive(&values, "requested-lease-ms", 120000, 1000)?;
    let window = positive(&values, "required-execution-window-ms", 30000, 1000)?;
    if window > requested {
        return Err(invalid("execution_window_invalid"));
    }
    if window <= 1000 {
        return Err(invalid("safety_margin_invalid"));
    }
    let expected = values
        .get("expected-pre-rebind-pristine-runtime-state-hash")
        .cloned();
    if expected.as_ref().is_some_and(|v| !hash(v)) {
        return Err(invalid("expected_pre_rebind_state_hash_invalid"));
    }
    Ok(Arguments {
        help: false,
        runtime: runtime.into(),
        process: process.into(),
        process_hash: process_hash.clone(),
        requested_lease_ms: requested,
        execution_window_ms: window,
        expected_pristine: expected,
    })
}
