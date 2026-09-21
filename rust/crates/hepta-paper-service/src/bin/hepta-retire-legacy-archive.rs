//! Native read-only retirement CLI; destructive execution remains fail-closed.
use hepta_paper_service::retirement_status::inspect_retirement_status_v1;
use serde_json::{Value, json};

const USAGE: &str = "Usage:\n  node paper-core/bin/retire-legacy-archive.mjs\n  node paper-core/bin/retire-legacy-archive.mjs status\n  node paper-core/bin/retire-legacy-archive.mjs --execute\n\nThe default and status modes are read-only.\nDestructive execution is fail-closed until identity-bound publication and rollback are implemented.";

fn error(status: &str, message: &str) {
    eprintln!(
        "{}",
        json!({
            "version": 1,
            "kind": "LegacyArchiveRetirementCliError",
            "status": status,
            "error": message,
            "externalActionPerformed": false,
        })
    );
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let execute = match args.as_slice() {
        [] => false,
        [arg] if arg == "status" => false,
        [arg] if arg == "--help" || arg == "-h" => {
            println!("{USAGE}");
            return;
        }
        [arg] if arg == "--execute" => true,
        _ => {
            error(
                "legacy_archive_retirement_arguments_invalid",
                &format!(
                    "legacy_archive_retirement_unknown_arguments:{}",
                    args.join(" ")
                ),
            );
            std::process::exit(2);
        }
    };
    let mut report = match inspect_retirement_status_v1(&json!({})) {
        Ok(report) => report,
        Err(cause) => {
            error(
                "legacy_archive_retirement_status_failed",
                &cause.to_string(),
            );
            std::process::exit(1);
        }
    };
    report["executeRequested"] = Value::Bool(execute);
    if execute {
        report["status"] = json!("legacy_archive_retirement_execute_blocked");
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("JSON report")
    );
    if execute {
        std::process::exit(1);
    }
}
