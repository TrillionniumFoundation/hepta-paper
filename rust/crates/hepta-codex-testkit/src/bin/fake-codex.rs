use std::{env, io::{self, Write}, process::ExitCode, str::FromStr};

use hepta_codex_testkit::Scenario;

fn main() -> ExitCode {
    let mut arguments = env::args().skip(1);
    let Some(raw_scenario) = arguments.next() else {
        eprintln!("usage: fake-codex <scenario>");
        return ExitCode::from(64);
    };
    if arguments.next().is_some() {
        eprintln!("fake-codex accepts exactly one scenario");
        return ExitCode::from(64);
    }
    let scenario = match Scenario::from_str(&raw_scenario) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}: {raw_scenario}");
            return ExitCode::from(64);
        }
    };
    let mut stdout = io::stdout().lock();
    if let Err(error) = stdout
        .write_all(&scenario.stdout())
        .and_then(|()| stdout.flush())
    {
        eprintln!("failed to write scenario: {error}");
        return ExitCode::from(74);
    }
    ExitCode::from(u8::try_from(scenario.exit_code()).unwrap_or(70))
}
