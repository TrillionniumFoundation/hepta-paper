use hepta_paper_service::owner_status::inspect_owner_acceptance_status_v1;
use std::{collections::BTreeMap, path::PathBuf};

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut paths = BTreeMap::new();
    while let Some(arg) = args.next() {
        if !["--workspace-root", "--runtime-root"].contains(&arg.as_str())
            || paths.contains_key(&arg)
        {
            return Err("unknown or duplicate argument".into());
        }
        let path = PathBuf::from(args.next().ok_or("argument value required")?);
        if !path.is_absolute() {
            return Err("absolute root paths required".into());
        }
        paths.insert(arg, path);
    }
    if paths.len() != 2 {
        return Err("usage: hepta-owner-acceptance-status --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH".into());
    }
    let report =
        inspect_owner_acceptance_status_v1(&paths["--workspace-root"], &paths["--runtime-root"])
            .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
