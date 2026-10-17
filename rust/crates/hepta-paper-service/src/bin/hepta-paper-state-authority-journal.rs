use hepta_paper_service::{
    local_state_authority::migration::run_authority_journal_cli_v1,
    sqlite_mutation_coordinator::{Result, SqliteMutationCoordinatorError},
};
use serde_json::json;

fn run() -> Result<String> {
    let arguments = std::env::args_os()
        .skip(1)
        .enumerate()
        .map(|(index, value)| {
            value
                .into_string()
                .map_err(|_| SqliteMutationCoordinatorError {
                    code: "local_authority_journal_cli_argument_not_utf8".into(),
                    details: json!({"argumentIndex":index}),
                    state_recoverability_fatal: false,
                    state_recoverability_deferred: false,
                    retryable: false,
                })
        })
        .collect::<Result<Vec<_>>>()?;
    run_authority_journal_cli_v1(&arguments)
}
fn main() {
    match run() {
        Ok(output) => print!("{output}"),
        Err(error) => {
            eprintln!(
                "{}",
                json!({"code":error.code,"details":error.details,"retryable":error.retryable,
                "stateRecoverabilityFatal":error.state_recoverability_fatal,
                "stateRecoverabilityDeferred":error.state_recoverability_deferred})
            );
            std::process::exit(1);
        }
    }
}
