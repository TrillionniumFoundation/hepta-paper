use hepta_paper_service::runtime_image_reproducibility::runtime_image_reproducibility_report_v2;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};
// Keep this byte-for-byte aligned with paper-core/bin/runtime-image-
// reproducibility.mjs. The standalone Rust executable is also invoked through
// the package command surface, so help output is part of its wire contract.
const USAGE: &str = "Usage: hepta-paper operator runtime-image-reproducibility -- --action status|request|verify|publish [options]\n\nActions:\n  status   Read and fully revalidate the persisted receipt; never invokes a verifier or writes.\n  request  Emit the current code/release/canonical-context-bound request; never invokes a verifier.\n  verify   Invoke both configured independent external verifiers and validate their Ed25519 attestations.\n  publish  Verify, then atomically publish only a fully valid and currently eligible receipt.\n\nOptions:\n  --config PATH        External verifier process/trust configuration.\n  --receipt PATH       Receipt location (default: isolated runtime root).\n  --runtime-root PATH  Isolated writable runtime root.\n  --root PATH          Repository root containing all canonical Docker contexts.\n\nAll three registered profiles are mandatory. Local Docker output and unsigned record hashes\nare diagnostic only and can never satisfy production readiness.";
fn run() -> Result<i32, String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mut flags = BTreeMap::<String, String>::new();
    let mut help = false;
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let Some(raw) = token.strip_prefix("--") else {
            return Err(format!("unexpected_cli_positional:{token}"));
        };
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(a, b)| (a, Some(b)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        if key == "help" {
            if inline.is_some() {
                return Err("boolean_cli_option_does_not_take_value:--help".into());
            }
            if help {
                return Err("duplicate_cli_option:--help".into());
            }
            help = true;
            i += 1;
            continue;
        }
        if !["action", "config", "receipt", "runtime-root", "root"].contains(&key) {
            return Err(format!("unknown_cli_option:--{key}"));
        }
        let value = if let Some(v) = inline {
            v.to_owned()
        } else {
            i += 1;
            args.get(i)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?
                .clone()
        };
        if value.is_empty() {
            return Err(format!("empty_cli_option_value:--{key}"));
        }
        if flags.insert(key.to_owned(), value).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        i += 1;
    }
    if help {
        println!("{USAGE}");
        return Ok(0);
    }
    let action = flags.get("action").map(String::as_str).unwrap_or("status");
    if !["status", "request", "verify", "publish"].contains(&action) {
        return Err(format!("runtime_reproducibility_action_invalid:{action}"));
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let environment: Value = serde_json::to_value(std::env::vars().collect::<BTreeMap<_, _>>())
        .map_err(|e| e.to_string())?;
    let root = flags
        .get("root")
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.clone());
    let compiled_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let runtime = flags
        .get("runtime-root")
        .map(PathBuf::from)
        .or_else(|| {
            environment["HEPTA_PAPER_RUNTIME_ROOT"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| compiled_root.join("../hepta-paper-runtime/native-runtime"));
    let report=runtime_image_reproducibility_report_v2(&json!({"action":action,"repositoryRoot":root,"runtimeRoot":runtime,"configPath":flags.get("config"),"receiptPath":flags.get("receipt"),"environment":environment})).map_err(|e|e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(if action == "request" || report["ready"] == true {
        0
    } else {
        2
    })
}
fn main() {
    match run() {
        Ok(0) => (),
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1)
        }
    }
}
