//! Create-once local integrity keys. No key material is emitted on stdout/stderr.
use hepta_paper_service::release_integrity_key::release_integrity_key_cli_v1;
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut environment = std::collections::BTreeMap::new();
    for key in [
        "HEPTA_PAPER_WORKSPACE_ROOT",
        "HEPTA_PAPER_RUNTIME_ROOT",
        "HEPTA_PAPER_ASSET_ROOT",
        "PAPER_FACTORY_LEGACY_ROOT",
        "HEPTA_PAPER_RUNTIME_ISOLATED",
    ] {
        match std::env::var(key) {
            Ok(value) => {
                environment.insert(key.to_owned(), value);
            }
            Err(std::env::VarError::NotPresent) => (),
            Err(std::env::VarError::NotUnicode(_)) => {
                eprintln!("release_integrity_key_environment_encoding_invalid:{key}");
                std::process::exit(1);
            }
        }
    }
    match release_integrity_key_cli_v1(&args, &environment) {
        Ok(output) => {
            if let Some(text) = output.text {
                println!("{text}");
            } else {
                match serde_json::to_string_pretty(&output.value) {
                    Ok(value) => println!("{value}"),
                    Err(_) => {
                        eprintln!("release_integrity_key_report_encoding_failed");
                        std::process::exit(1);
                    }
                }
            }
            std::process::exit(output.exit_code);
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
