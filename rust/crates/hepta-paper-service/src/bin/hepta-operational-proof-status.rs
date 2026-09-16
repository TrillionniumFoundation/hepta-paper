//! Read-only imported operational and conformance proof inspector.
use hepta_paper_service::operational_status::capability_operational_proof_status_v1;
use std::{collections::BTreeMap, path::PathBuf};

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut paths = BTreeMap::new();
    while let Some(arg) = args.next() {
        if !["--workspace-root", "--runtime-root", "--asset-root"].contains(&arg.as_str())
            || paths.contains_key(&arg)
        {
            return Err("unknown or duplicate argument".into());
        }
        let value = args.next().ok_or("argument value required")?;
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err("absolute root paths required".into());
        }
        paths.insert(arg, path);
    }
    if paths.len() != 3 {
        return Err("usage: hepta-operational-proof-status --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH --asset-root ABSOLUTE_PATH".into());
    }
    let report = capability_operational_proof_status_v1(
        &paths["--workspace-root"],
        &paths["--runtime-root"],
        &paths["--asset-root"],
    )
    .map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
