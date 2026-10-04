//! One read-only CLI composition for the standalone and unified health routes.
//! Parsing, environment bounds, mode precedence and owner calls are shared.
//! Diagnostics never authorize resident dispatch, recovery or publication.
use super::{
    FullSupervisorHealthOptionsV1, inspect_supervisor_health_current_intake_v1,
    inspect_supervisor_health_fully_autonomous_v1, inspect_supervisor_health_strict_intake_v1,
    inspect_supervisor_health_v1,
};
use crate::{
    machine_intake::MACHINE_INTAKE_ENVIRONMENT_KEYS_V1,
    native_workspace::resolve_native_workspace_root_v1,
};
use serde_json::{Value, json};
use std::path::Path;

/// Selects command grammar and help text, never an authority profile.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SupervisorHealthEntryV1 {
    Standalone,
    Unified,
}

pub struct SupervisorHealthCommandResultV1 {
    pub report: Value,
    pub exit_code: i32,
}

fn parse_options(
    args: &[String],
    entry: SupervisorHealthEntryV1,
) -> Result<std::collections::BTreeMap<&str, &str>, String> {
    let mut options = std::collections::BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected_cli_positional:{token}"))?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        let value = match key {
            "help"
            | "require-startup-reconciliation"
            | "require-machine-intake-reconciliation"
            | "require-current-machine-intake"
            | "require-strict-machine-intake-reconciliation"
            | "require-fully-autonomous" => {
                if inline.is_some() {
                    return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
                }
                ""
            }
            "runtime-root" | "external-qualification-config" | "action"
                if key != "action" || entry == SupervisorHealthEntryV1::Unified =>
            {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        index += 1;
                        args.get(index)
                            .filter(|value| !value.starts_with("--"))
                            .map(String::as_str)
                            .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?
                    }
                };
                if value.is_empty() {
                    return Err(format!("empty_cli_option_value:--{key}"));
                }
                value
            }
            _ if entry == SupervisorHealthEntryV1::Unified => {
                return Err(format!("unsupported_supervisor_mode:{token}"));
            }
            _ => return Err(format!("unknown_cli_option:--{key}")),
        };
        // Node validates a value before checking whether its option was repeated.
        if options.insert(key, value).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        index += 1;
    }
    Ok(options)
}

fn full_environment() -> Result<std::collections::BTreeMap<String, String>, String> {
    // The actual V3 command allowlists choose keys dynamically; a fixed intake
    // list would change command identities. Capture actual UTF-8 inputs without
    // logging values or mutating global environment. Bounds apply only to this
    // new full-mode profile; existing modes retain their existing key selection.
    const MAXIMUM_ENTRIES: usize = 4096;
    const MAXIMUM_BYTES: usize = 1024 * 1024;
    let mut result = std::collections::BTreeMap::new();
    let mut total_bytes = 0usize;
    for (key, value) in std::env::vars_os() {
        let key = key.into_string().map_err(|_| {
            "autonomous_research_supervisor_health_environment_encoding_invalid".to_owned()
        })?;
        let value = value.into_string().map_err(|_| {
            "autonomous_research_supervisor_health_environment_encoding_invalid".to_owned()
        })?;
        total_bytes = total_bytes
            .checked_add(key.len())
            .and_then(|bytes| bytes.checked_add(value.len()))
            .and_then(|bytes| bytes.checked_add(2))
            .ok_or_else(|| {
                "autonomous_research_supervisor_health_environment_bound_exceeded".to_owned()
            })?;
        if total_bytes > MAXIMUM_BYTES || result.len() >= MAXIMUM_ENTRIES {
            return Err(
                "autonomous_research_supervisor_health_environment_bound_exceeded".to_owned(),
            );
        }
        if result.insert(key, value).is_some() {
            return Err(
                "autonomous_research_supervisor_health_environment_duplicate_key".to_owned(),
            );
        }
    }
    Ok(result)
}

/// Observe actual sources through the existing health owner. Help and grammar
/// refusal precede environment/source reads; all modes remain non-mutating.
/// Reuse standalone/unified grammar before choosing a physical workspace.
pub(crate) fn validate_supervisor_health_cli_arguments_v1(
    args: &[String],
    entry: SupervisorHealthEntryV1,
) -> Result<bool, String> {
    Ok(parse_options(args, entry)?.contains_key("help"))
}

pub fn inspect_supervisor_health_command_v1(
    args: &[String],
    entry: SupervisorHealthEntryV1,
) -> Result<SupervisorHealthCommandResultV1, String> {
    inspect_supervisor_health_command_with_directory_v1(args, entry, None)
}

/// Keep the standalone registry worker's physical working directory without
/// changing global process state or granting supervisor execution authority.
pub fn inspect_supervisor_health_command_in_working_directory_v1(
    args: &[String],
    entry: SupervisorHealthEntryV1,
    working_directory: &Path,
) -> Result<SupervisorHealthCommandResultV1, String> {
    inspect_supervisor_health_command_with_directory_v1(args, entry, Some(working_directory))
}

fn inspect_supervisor_health_command_with_directory_v1(
    args: &[String],
    entry: SupervisorHealthEntryV1,
    working_directory: Option<&Path>,
) -> Result<SupervisorHealthCommandResultV1, String> {
    let options = parse_options(args, entry)?;
    if options.contains_key("help") {
        let (kind, command) = match entry {
            SupervisorHealthEntryV1::Standalone => (
                "AutonomousResearchSupervisorHealthUsage",
                "autonomous-research-supervisor-health",
            ),
            SupervisorHealthEntryV1::Unified => (
                "AutonomousSupervisorHealthUsage",
                "hepta-paper-rust autonomous-supervisor --action health",
            ),
        };
        // Retain the incumbent standalone help bytes, including its narrower
        // historical option summary. Both entries still use the same parser.
        let usage = match entry {
            SupervisorHealthEntryV1::Standalone => format!(
                "{command} --runtime-root PATH [--require-startup-reconciliation|--require-machine-intake-reconciliation|--require-current-machine-intake|--require-fully-autonomous]"
            ),
            SupervisorHealthEntryV1::Unified => format!(
                "{command} --runtime-root PATH [--require-startup-reconciliation|--require-machine-intake-reconciliation|--require-current-machine-intake|--require-strict-machine-intake-reconciliation|--require-fully-autonomous] [--external-qualification-config PATH]"
            ),
        };
        return Ok(SupervisorHealthCommandResultV1 {
            report: json!({"version": 1, "kind": kind, "mutation": "none",
                "usage": usage}),
            exit_code: 0,
        });
    }
    if options
        .get("action")
        .is_some_and(|action| *action != "health")
    {
        return Err("rust_autonomous_supervisor_execution_not_ported".into());
    }
    let startup = options.contains_key("require-startup-reconciliation");
    let machine = options.contains_key("require-machine-intake-reconciliation");
    let current_intake = options.contains_key("require-current-machine-intake");
    let strict_intake = options.contains_key("require-strict-machine-intake-reconciliation");
    let fully_autonomous = options.contains_key("require-fully-autonomous");
    let cwd = match working_directory {
        Some(directory) => directory.to_owned(),
        None => std::env::current_dir()
            .map_err(|error| format!("health_runtime_root_working_directory_invalid:{error}"))?,
    };
    let requested_root = options
        .get("runtime-root")
        .map(|value| (*value).to_owned())
        .or_else(|| {
            std::env::var("HEPTA_PAPER_RUNTIME_ROOT")
                .ok()
                .filter(|value| !value.is_empty())
        });
    let root = match requested_root {
        Some(selected) => {
            resolve_native_workspace_root_v1(&cwd, Path::new(&selected), Some(Path::new(&selected)))
        }
        None => match working_directory {
            Some(workspace) => Ok(workspace
                .parent()
                .unwrap_or(workspace)
                .join("hepta-paper-runtime/native-runtime")),
            None => crate::native_workspace::current_native_command_runtime_root_v1(),
        },
    }
    .map_err(|error| format!("health_runtime_root_invalid:{error}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| "health_clock_invalid".to_owned())?;
    let report = if fully_autonomous {
        let environment = full_environment()?;
        let repository = crate::native_workspace::resolve_native_command_workspace_root_v1(
            &cwd,
            &environment,
            None,
        )
        .map_err(|error| format!("health_repository_root_invalid:{error}"))?;
        inspect_supervisor_health_fully_autonomous_v1(&FullSupervisorHealthOptionsV1 {
            runtime_root: &root,
            repository_root: &repository,
            working_directory: &cwd,
            environment: &environment,
            external_qualification_config: options
                .get("external-qualification-config")
                .map(|value| Path::new(*value)),
            now_millis: now,
            strict_mode: strict_intake,
        })?
    } else if current_intake || strict_intake {
        let mut environment = std::collections::BTreeMap::new();
        for key in MACHINE_INTAKE_ENVIRONMENT_KEYS_V1.into_iter().chain(
            [
                "HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH",
                "HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY",
            ]
            .into_iter()
            .filter(|_| strict_intake),
        ) {
            match std::env::var(key) {
                Ok(value) => {
                    environment.insert(key.to_owned(), value);
                }
                Err(std::env::VarError::NotPresent) => {}
                Err(std::env::VarError::NotUnicode(_)) => {
                    return Err(format!(
                        "autonomous_research_machine_intake_environment_encoding_invalid:{key}"
                    ));
                }
            }
        }
        if strict_intake {
            inspect_supervisor_health_strict_intake_v1(&root, &environment, &cwd, now)?
        } else {
            inspect_supervisor_health_current_intake_v1(&root, &environment, &cwd, now)?
        }
    } else {
        inspect_supervisor_health_v1(&root, now)?
    };
    let passing = if fully_autonomous {
        report["fullyAutonomousReady"] == true
    } else if strict_intake {
        report["strictMachineIntakeReconciliationReady"] == true
    } else if current_intake {
        report["currentMachineIntakeReady"] == true
    } else if machine {
        report["ready"] == true
    } else if startup {
        report["startupReady"] == true
    } else {
        report["healthy"] == true
    };
    Ok(SupervisorHealthCommandResultV1 {
        report,
        exit_code: if passing { 0 } else { 2 },
    })
}
