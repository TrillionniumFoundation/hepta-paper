use hepta_paper_service::workspace_status::workspace_status_cli_v1;
use std::collections::BTreeMap;

fn run() -> Result<i32, String> {
    let args = std::env::args_os()
        .skip(1)
        .map(|arg| {
            arg.into_string()
                .map_err(|_| "workspace_status_utf8_argument_required".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut environment = BTreeMap::new();
    for name in [
        "HEPTA_PAPER_WORKSPACE_ROOT",
        "HEPTA_PAPER_ASSET_ROOT",
        "HEPTA_PAPER_RUNTIME_ROOT",
        "PAPER_FACTORY_LEGACY_ROOT",
    ] {
        if let Some(value) = std::env::var_os(name) {
            environment.insert(
                name.to_owned(),
                value
                    .into_string()
                    .map_err(|_| "workspace_status_utf8_environment_required".to_owned())?,
            );
        }
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let (report, code) = workspace_status_cli_v1(&args, &cwd, &environment)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(code)
}
fn main() {
    match run() {
        Ok(0) => (),
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
