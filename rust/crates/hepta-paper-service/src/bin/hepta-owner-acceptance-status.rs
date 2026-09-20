use hepta_paper_service::owner_status::inspect_owner_acceptance_status_v1;
use std::{
    env,
    path::{Component, Path, PathBuf},
};

fn lexical_absolute_path(path: PathBuf) -> PathBuf {
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(component) => normalized.push(component),
        }
    }
    normalized
}

fn environment_path(name: &str) -> Option<PathBuf> {
    let value = env::var_os(name)?;
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    Some(lexical_absolute_path(path))
}

fn compiled_workspace_root() -> PathBuf {
    lexical_absolute_path(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn run() -> Result<(), String> {
    let mut workspace_root = None;
    let mut runtime_root = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        let target = match arg.as_str() {
            "--workspace-root" => &mut workspace_root,
            "--runtime-root" => &mut runtime_root,
            _ => return Err("unknown or duplicate argument".into()),
        };
        if target.is_some() {
            return Err("unknown or duplicate argument".into());
        }
        let path = PathBuf::from(args.next().ok_or("argument value required")?);
        if !path.is_absolute() {
            return Err("absolute root paths required".into());
        }
        *target = Some(path);
    }
    let workspace_root = workspace_root
        .or_else(|| environment_path("HEPTA_WORKSPACE_ROOT"))
        .unwrap_or_else(compiled_workspace_root);
    let runtime_root = runtime_root.unwrap_or_else(|| {
        environment_path("HEPTA_PAPER_RUNTIME_ROOT").unwrap_or_else(|| {
            workspace_root
                .parent()
                .unwrap_or(&workspace_root)
                .join("hepta-paper-runtime/native-runtime")
        })
    });
    let report = inspect_owner_acceptance_status_v1(&workspace_root, &runtime_root)
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
