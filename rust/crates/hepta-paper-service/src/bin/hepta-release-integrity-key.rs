//! Create-once local integrity keys. No key material is emitted on stdout/stderr.
use hepta_paper_service::release_integrity_key::release_integrity_key_cli_v1;
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let environment = std::env::vars().collect();
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
