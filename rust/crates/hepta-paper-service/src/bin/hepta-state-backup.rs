use hepta_paper_service::{
    sqlite_mutation_coordinator::clock::SystemMutationClockV1,
    state_recoverability::cli::{
        StateBackupCliOutputV1, native_state_backup_cli_context_v1, state_backup_cli_v1,
    },
};
fn run() -> Result<i32, String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let context = native_state_backup_cli_context_v1(
        &args,
        std::env::current_dir().map_err(|e| e.to_string())?,
        std::env::vars()
            .filter(|(name, _)| {
                matches!(
                    name.as_str(),
                    "HEPTA_PAPER_RUNTIME_ROOT" | "HEPTA_PAPER_WORKSPACE_ROOT"
                )
            })
            .collect(),
    )?;
    match state_backup_cli_v1(&args, &context, &mut SystemMutationClockV1)? {
        StateBackupCliOutputV1::Help(usage) => {
            println!("{usage}");
            Ok(0)
        }
        StateBackupCliOutputV1::Report { report, exit_code } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
            );
            Ok(exit_code)
        }
    }
}
fn main() {
    match run() {
        Ok(0) => (),
        Ok(code) => std::process::exit(code),
        Err(cause) => {
            eprintln!("{cause}");
            std::process::exit(1);
        }
    }
}
