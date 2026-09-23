//! Native, read-only journal connector discovery CLI.
use hepta_paper_service::journal_connector_coverage::journal_connector_coverage_cli_v2;
use std::{collections::BTreeMap, env};

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let environment = env::vars().collect::<BTreeMap<_, _>>();
    match journal_connector_coverage_cli_v2(&args, &environment) {
        Ok(output) => match serde_json::to_string_pretty(&output.value) {
            Ok(json) => {
                println!("{json}");
                std::process::exit(output.exit_code);
            }
            Err(_) => {
                eprintln!("journal_connector_coverage_output_encoding_failed");
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
