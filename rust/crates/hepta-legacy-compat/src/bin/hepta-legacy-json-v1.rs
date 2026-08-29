use std::{io::{self, Read}, process::ExitCode};

use hepta_legacy_compat::{encode_legacy_stable_json_v1, hash_legacy_stable_json_v1};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("legacy compatibility verification failed: {message}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<(), String> {
    let mut input = Vec::new();
    io::stdin()
        .take(8 * 1024 * 1024)
        .read_to_end(&mut input)
        .map_err(|error| error.to_string())?;
    if input.is_empty() || input.len() >= 8 * 1024 * 1024 {
        return Err("input is empty or exceeds the hard byte limit".to_owned());
    }
    let value = serde_json::from_slice(&input).map_err(|error| error.to_string())?;
    let encoded = encode_legacy_stable_json_v1(&value).map_err(|error| error.to_string())?;
    let digest = hash_legacy_stable_json_v1(&value).map_err(|error| error.to_string())?;
    println!("{}", String::from_utf8(encoded).map_err(|error| error.to_string())?);
    println!("{}", digest.as_str());
    Ok(())
}
