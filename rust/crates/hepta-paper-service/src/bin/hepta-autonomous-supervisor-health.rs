use hepta_paper_service::{
    native_workspace::resolve_native_workspace_root_v1,
    supervisor_health::inspect_supervisor_health_v1,
};
use std::path::{Path, PathBuf};
const USAGE: &str = "autonomous-research-supervisor-health --runtime-root PATH [--require-startup-reconciliation|--require-machine-intake-reconciliation|--require-current-machine-intake|--require-fully-autonomous]";
fn main() {
    let mut root: Option<String> = None;
    let mut help = false;
    let mut unsupported = false;
    let mut unsupported_flag: Option<&str> = None;
    let mut startup = false;
    let mut machine = false;
    // Node accepts this value option for the fully-autonomous prerequisite
    // inspection.  The native observer still fails closed for that mode, but
    // must preserve the incumbent parser contract before reaching it.
    let mut _external_qualification_config: Option<String> = None;
    let mut i = 0;
    let args: Vec<String> = std::env::args().skip(1).collect();
    while i < args.len() {
        let t = &args[i];
        let Some(raw) = t.strip_prefix("--") else {
            eprintln!("unexpected_cli_positional:{t}");
            std::process::exit(1);
        };
        let (k, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(a, b)| (a, Some(b)));
        match k {
            "help" => {
                if inline.is_some() || help {
                    eprintln!(
                        "{}",
                        if inline.is_some() {
                            "boolean_cli_option_does_not_take_value:--help"
                        } else {
                            "duplicate_cli_option:--help"
                        }
                    );
                    std::process::exit(1)
                };
                help = true;
            }
            "require-startup-reconciliation" => {
                if inline.is_some() || startup {
                    eprintln!("duplicate_cli_option:--require-startup-reconciliation");
                    std::process::exit(1)
                };
                startup = true;
            }
            "require-machine-intake-reconciliation" => {
                if inline.is_some() || machine {
                    eprintln!("duplicate_cli_option:--require-machine-intake-reconciliation");
                    std::process::exit(1)
                };
                machine = true;
            }
            "require-current-machine-intake"
            | "require-strict-machine-intake-reconciliation"
            | "require-fully-autonomous" => {
                if inline.is_some() {
                    eprintln!("boolean_cli_option_does_not_take_value:--{k}");
                    std::process::exit(1);
                }
                if unsupported_flag == Some(k) {
                    eprintln!("duplicate_cli_option:--{k}");
                    std::process::exit(1);
                }
                unsupported = true;
                unsupported_flag.get_or_insert(k);
            }
            "runtime-root" => {
                if root.is_some() {
                    eprintln!("duplicate_cli_option:--runtime-root");
                    std::process::exit(1)
                };
                let v = inline.map(str::to_owned).or_else(|| {
                    i += 1;
                    args.get(i).cloned()
                });
                match v.filter(|v| !v.is_empty() && !v.starts_with("--")) {
                    Some(v) => root = Some(v),
                    None => {
                        eprintln!("missing_cli_option_value:--runtime-root");
                        std::process::exit(1)
                    }
                }
            }
            "external-qualification-config" => {
                if _external_qualification_config.is_some() {
                    eprintln!("duplicate_cli_option:--external-qualification-config");
                    std::process::exit(1)
                }
                let v = inline.map(str::to_owned).or_else(|| {
                    i += 1;
                    args.get(i).cloned()
                });
                match v.filter(|v| !v.is_empty() && !v.starts_with("--")) {
                    Some(v) => _external_qualification_config = Some(v),
                    None => {
                        eprintln!("missing_cli_option_value:--external-qualification-config");
                        std::process::exit(1)
                    }
                }
            }
            _ => {
                eprintln!("unknown_cli_option:--{k}");
                std::process::exit(1)
            }
        }
        i += 1;
    }
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
    if unsupported {
        let Some(flag) = unsupported_flag else {
            eprintln!("unsupported_supervisor_health_mode");
            std::process::exit(1);
        };
        eprintln!("unsupported_supervisor_health_mode:--{flag}");
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
    let report = match inspect_supervisor_health_v1(&root, now) {
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
    let passing = if machine {
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
