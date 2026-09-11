use std::{
    io::{self, Read, Write},
    process::ExitCode,
};

use hepta_control_plane::{
    MAXIMUM_QUALIFICATION_REQUEST_BYTES_V1, PerformanceQualificationRequestV1,
    qualify_performance_v1,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(()) => ExitCode::from(2),
    }
}

fn run() -> Result<(), ()> {
    let mut input = Vec::new();
    io::stdin()
        .take(MAXIMUM_QUALIFICATION_REQUEST_BYTES_V1 + 1)
        .read_to_end(&mut input)
        .map_err(|_| ())?;
    if input.is_empty() || input.len() as u64 > MAXIMUM_QUALIFICATION_REQUEST_BYTES_V1 {
        eprintln!("performance_qualification_input_invalid");
        return Err(());
    }
    let request: PerformanceQualificationRequestV1 =
        serde_json::from_slice(&input).map_err(|_| {
            eprintln!("performance_qualification_request_invalid");
        })?;
    let receipt = qualify_performance_v1(&request).map_err(|_| {
        eprintln!("performance_qualification_failed");
    })?;
    let encoded = serde_json::to_vec(&receipt).map_err(|_| {
        eprintln!("performance_qualification_encoding_failed");
    })?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&encoded).map_err(|_| ())?;
    stdout.write_all(b"\n").map_err(|_| ())?;
    stdout.flush().map_err(|_| ())?;
    Ok(())
}
