use hepta_paper_service::automation_runtime_reconciliation::{
    LocalOfflineReconciliationRequestV1,
    execute_local_offline_automation_runtime_reconciliation_v1,
    inspect_automation_runtime_reconciliation_v1, inspect_legacy_terminal_active_residue_v1,
};
use std::{env, fs::OpenOptions, io::Read, os::unix::fs::OpenOptionsExt, path::Path};

fn usage() {
    println!(
        "{{\"version\":1,\"kind\":\"AutomationRuntimeReconciliationUsage\",\"usage\":\"hepta-automation-reconcile --database ABSOLUTE_SQLITE --at ISO_TIME [--campaign-id ID] [--no-progress-seconds N] [--legacy-terminal-active-residue]\",\"localExecuteUsage\":\"hepta-automation-reconcile --execute-local REQUEST_JSON\",\"readOnly\":true,\"externalActionPerformed\":false,\"localMutationSupported\":true,\"productionMutationSupported\":false}}"
    );
}

fn main() {
    let mut database = None;
    let mut now = None;
    let mut campaign_id = None;
    let mut no_progress_seconds = 1800.0_f64;
    let mut legacy_terminal_active_residue = false;
    let args: Vec<String> = env::args().skip(1).collect();
    // The incumbent scans every argument before opening the store. Preserve
    // that precedence even for help or otherwise invalid native arguments.
    if args
        .iter()
        .filter(|arg| arg.as_str() == "--campaign-id" || arg.starts_with("--campaign-id="))
        .count()
        > 1
    {
        eprintln!("automation_runtime_reconciliation_campaign_id_duplicate");
        std::process::exit(1);
    }
    if args.iter().any(|arg| arg == "--help") {
        usage();
        return;
    }
    let mut index = 0;
    let result: Result<(), String> = (|| {
        if args.first().is_some_and(|arg| arg == "--execute-local") {
            if args.len() != 2 {
                return Err("--execute-local requires exactly one request file".into());
            }
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
                .open(&args[1])
                .map_err(|_| "local request file unavailable")?;
            if !file
                .metadata()
                .map_err(|_| "local request file unavailable")?
                .is_file()
            {
                return Err("local request must be a regular file".into());
            }
            let mut bytes = Vec::new();
            file.take(1_048_577)
                .read_to_end(&mut bytes)
                .map_err(|_| "local request unreadable")?;
            if bytes.len() > 1_048_576 {
                return Err("local request too large".into());
            }
            let request: LocalOfflineReconciliationRequestV1 =
                serde_json::from_slice(&bytes).map_err(|_| "local request invalid")?;
            let report = execute_local_offline_automation_runtime_reconciliation_v1(&request)
                .map_err(|error| error.to_string())?;
            println!(
                "{}",
                serde_json::to_string(&report).map_err(|_| "json encode")?
            );
            return Ok(());
        }
        while index < args.len() {
            if args[index] == "--legacy-terminal-active-residue" {
                legacy_terminal_active_residue = true;
                index += 1;
                continue;
            }
            let (key, value) = args[index]
                .split_once('=')
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .unwrap_or_else(|| {
                    let key = args[index].clone();
                    let value = args.get(index + 1).cloned().unwrap_or_default();
                    index += 1;
                    (key, value)
                });
            match key.as_str() {
                "--database" => database = Some(value),
                "--at" => now = Some(value),
                "--campaign-id" => campaign_id = Some(value),
                "--no-progress-seconds" => {
                    no_progress_seconds = value.parse().map_err(|_| "invalid seconds")?
                }
                _ => return Err("unsupported argument".into()),
            }
            index += 1;
        }
        let database = database.ok_or("--database is required")?;
        let now = now.ok_or("--at is required")?;
        let report = if legacy_terminal_active_residue {
            inspect_legacy_terminal_active_residue_v1(
                Path::new(&database),
                &now,
                campaign_id
                    .as_deref()
                    .ok_or("--campaign-id is required for legacy maintenance")?,
            )
        } else {
            inspect_automation_runtime_reconciliation_v1(
                Path::new(&database),
                &now,
                no_progress_seconds,
                campaign_id.as_deref(),
            )
        }
        .map_err(|error| error.to_string())?;
        println!(
            "{}",
            serde_json::to_string(&report).map_err(|_| "json encode")?
        );
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("automation reconciliation rejected: {error}");
        std::process::exit(2);
    }
}
