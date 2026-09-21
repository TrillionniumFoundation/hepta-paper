use hepta_paper_service::{
    machine_intake::MACHINE_INTAKE_ENVIRONMENT_KEYS_V1,
    native_workspace::resolve_native_workspace_root_v1,
    supervisor_health::{
        inspect_supervisor_health_current_intake_v1, inspect_supervisor_health_v1,
    },
};
use std::path::{Path, PathBuf};
const USAGE: &str = "autonomous-research-supervisor-health --runtime-root PATH [--require-startup-reconciliation|--require-machine-intake-reconciliation|--require-current-machine-intake|--require-fully-autonomous]";
fn parse_options(args: &[String]) -> Result<std::collections::BTreeMap<&str, &str>, String> {
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
            "runtime-root" | "external-qualification-config" => {
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

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse_options(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let root = options.get("runtime-root").map(|value| (*value).to_owned());
    let help = options.contains_key("help");
    let startup = options.contains_key("require-startup-reconciliation");
    let machine = options.contains_key("require-machine-intake-reconciliation");
    let current_intake = options.contains_key("require-current-machine-intake");
    // Remaining chains still require their actual native evidence producers.
    let unsupported_flag = args.iter().find_map(|arg| match arg.as_str() {
        "--require-strict-machine-intake-reconciliation" | "--require-fully-autonomous" => {
            Some(arg.as_str())
        }
        _ => None,
    });
    if help {
        println!(
            "{{
  \"version\": 1,
  \"kind\": \"AutonomousResearchSupervisorHealthUsage\",
  \"usage\": \"{}\",
  \"mutation\": \"none\"
}}",
            USAGE
        );
        return;
    }
    if let Some(flag) = unsupported_flag {
        eprintln!("unsupported_supervisor_health_mode:{flag}");
        std::process::exit(1);
    }
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("health_runtime_root_working_directory_invalid:{error}");
            std::process::exit(1);
        }
    };
    let legacy_default = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../hepta-paper-runtime/native-runtime");
    let requested_root = root.or_else(|| std::env::var("HEPTA_PAPER_RUNTIME_ROOT").ok());
    let root = match resolve_native_workspace_root_v1(
        &cwd,
        &legacy_default,
        requested_root.as_deref().map(Path::new),
    ) {
        Ok(root) => root,
        Err(error) => {
            eprintln!("health_runtime_root_invalid:{error}");
            std::process::exit(1);
        }
    };
    let now = match std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
    {
        Some(now) => now,
        None => {
            eprintln!("health_clock_invalid");
            std::process::exit(1);
        }
    };
    let inspected = if current_intake {
        let mut environment = std::collections::BTreeMap::new();
        for key in MACHINE_INTAKE_ENVIRONMENT_KEYS_V1 {
            match std::env::var(key) {
                Ok(value) => {
                    environment.insert(key.to_owned(), value);
                }
                Err(std::env::VarError::NotPresent) => {}
                Err(std::env::VarError::NotUnicode(_)) => {
                    eprintln!(
                        "autonomous_research_machine_intake_environment_encoding_invalid:{key}"
                    );
                    std::process::exit(1);
                }
            }
        }
        inspect_supervisor_health_current_intake_v1(&root, &environment, &cwd, now)
    } else {
        inspect_supervisor_health_v1(&root, now)
    };
    let report = match inspected {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    };
    let output = match serde_json::to_string(&report) {
        Ok(output) => output,
        Err(error) => {
            eprintln!("health_report_serialization_failed:{error}");
            std::process::exit(1);
        }
    };
    println!("{output}");
    let passing = if current_intake {
        report["currentMachineIntakeReady"] == true
    } else if machine {
        report["ready"] == true
    } else if startup {
        report["startupReady"] == true
    } else {
        report["healthy"] == true
    };
    if !passing {
        std::process::exit(2)
    };
}
