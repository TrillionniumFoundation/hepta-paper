//! Strict grammar for separate read-only planning and pinned installed execution.
use std::{collections::BTreeMap, path::PathBuf};
pub(in crate::online_schema_execution) struct Arguments {
    pub help: bool,
    pub action: String,
    pub runtime: PathBuf,
    pub process: PathBuf,
    pub process_hash: String,
    pub requested_lease_ms: i64,
    pub execution_window_ms: i64,
    pub expected_pristine: Option<String>,
    pub expected_previous_final: Option<String>,
    pub historical_source_process: Option<PathBuf>,
    pub historical_source_process_hash: Option<String>,
    pub installed_profile: Option<PathBuf>,
    pub installed_profile_hash: Option<String>,
    pub expected_transition_id: Option<String>,
    pub expected_plan_hash: Option<String>,
    pub planned_at: Option<String>,
    pub commit_safety_margin_ms: i64,
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
            | "historical-source-authority-process-config"
            | "historical-source-authority-process-config-sha256"
            | "requested-lease-ms"
            | "required-execution-window-ms"
            | "commit-safety-margin-ms"
            | "transition-id"
            | "expected-plan-hash"
            | "planned-at"
            | "installed-maintenance-profile"
            | "installed-maintenance-profile-sha256"
            | "expected-pre-rebind-pristine-runtime-state-hash"
            | "expected-previous-final-receipt-sha256" => {
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
        action: "plan".into(),
        runtime: PathBuf::new(),
        process: PathBuf::new(),
        process_hash: String::new(),
        requested_lease_ms: 120000,
        execution_window_ms: 30000,
        expected_pristine: None,
        expected_previous_final: None,
        historical_source_process: None,
        historical_source_process_hash: None,
        installed_profile: None,
        installed_profile_hash: None,
        expected_transition_id: None,
        expected_plan_hash: None,
        planned_at: None,
        commit_safety_margin_ms: 1000,
    };
    if help {
        return Ok(defaults);
    }
    let action = values.get("action").map(String::as_str).unwrap_or("plan");
    if !matches!(
        action,
        "plan"
            | "inspect-pristine"
            | "inspect-installed-profile"
            | "execute"
            | "recover"
            | "rollback"
    ) {
        return Err(invalid(&format!("action_invalid:{action}")));
    }
    let mutating = matches!(action, "execute" | "recover" | "rollback");
    if mutating {
        if !values.contains_key("execute") {
            return Err(invalid("execute_confirmation_required"));
        }
        if !values.get("transition-id").is_some_and(|v| hash(v)) {
            return Err(invalid("transition_id_required"));
        }
        if !values.get("expected-plan-hash").is_some_and(|v| hash(v)) {
            return Err(invalid("execution_plan_pin_required"));
        }
        if !values.get("planned-at").is_some_and(|v| {
            crate::sqlite_mutation_coordinator::timestamp(&serde_json::Value::from(v.clone()))
                .is_some()
        }) {
            return Err(invalid("execution_planned_at_required"));
        }
    } else if values.contains_key("execute") {
        return Err(invalid("execute_action_required"));
    }
    if !mutating
        && [
            "transition-id",
            "commit-safety-margin-ms",
            "expected-plan-hash",
            "planned-at",
        ]
        .iter()
        .any(|key| values.contains_key(*key))
    {
        return Err(invalid("execute_option_forbidden_in_plan"));
    }
    if action == "inspect-pristine"
        && values.contains_key("expected-pre-rebind-pristine-runtime-state-hash")
    {
        return Err(invalid("expected_pre_rebind_state_forbidden_in_inspection"));
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
    let expected_previous_final = values
        .get("expected-previous-final-receipt-sha256")
        .cloned();
    if expected_previous_final.as_ref().is_some_and(|v| !hash(v)) {
        return Err(invalid("expected_previous_final_receipt_hash_invalid"));
    }
    let historical_source_process = values
        .get("historical-source-authority-process-config")
        .map(PathBuf::from);
    let historical_source_process_hash = values
        .get("historical-source-authority-process-config-sha256")
        .cloned();
    if historical_source_process.is_some() != historical_source_process_hash.is_some()
        || historical_source_process_hash
            .as_ref()
            .is_some_and(|value| !hash(value))
    {
        return Err(invalid("historical_source_authority_process_pin_required"));
    }
    let installed_profile = values
        .get("installed-maintenance-profile")
        .map(PathBuf::from);
    let installed_profile_hash = values.get("installed-maintenance-profile-sha256").cloned();
    if installed_profile.is_some() != installed_profile_hash.is_some()
        || installed_profile_hash.as_ref().is_some_and(|v| !hash(v))
        || ((mutating || action == "inspect-installed-profile") && installed_profile.is_none())
    {
        return Err(invalid("installed_maintenance_profile_pin_required"));
    }
    if !mutating && action != "inspect-installed-profile" && installed_profile.is_some() {
        return Err(invalid("installed_profile_option_forbidden_in_plan"));
    }
    let margin = positive(&values, "commit-safety-margin-ms", 1000, 1)?;
    if margin >= window {
        return Err(invalid("commit_safety_margin_invalid"));
    }
    Ok(Arguments {
        help: false,
        action: action.into(),
        runtime: runtime.into(),
        process: process.into(),
        process_hash: process_hash.clone(),
        requested_lease_ms: requested,
        execution_window_ms: window,
        expected_pristine: expected,
        expected_previous_final,
        historical_source_process,
        historical_source_process_hash,
        installed_profile,
        installed_profile_hash,
        expected_transition_id: values.get("transition-id").cloned(),
        expected_plan_hash: values.get("expected-plan-hash").cloned(),
        planned_at: values.get("planned-at").cloned(),
        commit_safety_margin_ms: margin,
    })
}
