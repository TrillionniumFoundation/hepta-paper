//! Read-only imported operational and conformance proof inspector.
use hepta_paper_service::operational_status::capability_operational_proof_status_v1;
use std::{
    env,
    path::{Path, PathBuf},
};

fn environment_path(name: &str) -> Option<PathBuf> {
    let value = env::var_os(name)?;
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    Some(if path.is_absolute() {
        path
    } else {
        env::current_dir().ok()?.join(path)
    })
}

fn compiled_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn default_asset_root(workspace_root: &Path) -> PathBuf {
    if let Some(path) = environment_path("HEPTA_PAPER_ASSET_ROOT") {
        return path;
    }
    let parent = workspace_root.parent().unwrap_or(workspace_root);
    if parent
        .file_name()
        .is_some_and(|name| name == "paper_factory")
    {
        parent.to_path_buf()
    } else {
        parent.join("hepta-paper-assets")
    }
}

fn default_runtime_root(workspace_root: &Path) -> PathBuf {
    environment_path("HEPTA_PAPER_RUNTIME_ROOT").unwrap_or_else(|| {
        workspace_root
            .parent()
            .unwrap_or(workspace_root)
            .join("hepta-paper-runtime/native-runtime")
    })
}

fn run() -> Result<(), String> {
    let mut workspace_root = None;
    let mut runtime_root = None;
    let mut asset_root = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        let target = match arg.as_str() {
            "--workspace-root" => &mut workspace_root,
            "--runtime-root" => &mut runtime_root,
            "--asset-root" => &mut asset_root,
            _ => return Err("unknown or duplicate argument".into()),
        };
        if target.is_some() {
            return Err("unknown or duplicate argument".into());
        }
        let value = args.next().ok_or("argument value required")?;
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err("absolute root paths required".into());
        }
        *target = Some(path);
    }
    let workspace_root = workspace_root
        .or_else(|| environment_path("HEPTA_WORKSPACE_ROOT"))
        .unwrap_or_else(compiled_workspace_root);
    let runtime_root = runtime_root.unwrap_or_else(|| default_runtime_root(&workspace_root));
    let asset_root = asset_root.unwrap_or_else(|| default_asset_root(&workspace_root));
    let report =
        capability_operational_proof_status_v1(&workspace_root, &runtime_root, &asset_root)
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
