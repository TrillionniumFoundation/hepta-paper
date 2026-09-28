use hepta_paper_service::supervisor_health::cli::{
    SupervisorHealthEntryV1, inspect_supervisor_health_command_v1,
};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = inspect_supervisor_health_command_v1(&args, SupervisorHealthEntryV1::Standalone)
        .and_then(|result| {
            let output = serde_json::to_string(&result.report)
                .map_err(|error| format!("health_report_serialization_failed:{error}"))?;
            println!("{output}");
            Ok(result.exit_code)
        });
    match result {
        Ok(0) => {}
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
