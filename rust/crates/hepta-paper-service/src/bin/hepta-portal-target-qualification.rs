use hepta_paper_service::portal_target_qualification::portal_target_qualification_cli_at_v1;
use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};
fn main() {
    let result = (|| -> Result<_, String> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?;
        let now = i64::try_from(elapsed.as_millis())
            .map_err(|_| "portal_target_qualification_clock_invalid".to_owned())?;
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        let environment = std::env::vars().collect::<BTreeMap<_, _>>();
        portal_target_qualification_cli_at_v1(&args, &environment, now)
            .map_err(|error| error.to_string())
    })();
    match result {
        Ok(output) => match serde_json::to_string_pretty(&output.report) {
            Ok(text) => {
                println!("{text}");
                std::process::exit(output.exit_code);
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
