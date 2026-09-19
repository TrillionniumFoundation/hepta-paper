//! Explicit native deployment workspace selection. This only resolves a path;
//! each consumer must open and validate its own manifest and retained inputs.
use std::path::{Component, Path, PathBuf};

/// An explicit deployment root takes precedence over a caller-selected legacy
/// default. Relative paths resolve against the real working directory. No
/// environment is read, filesystem entry created, or symbolic link followed.
pub fn resolve_native_workspace_root_v1(
    working_directory: &Path,
    legacy_default: &Path,
    deployment_root: Option<&Path>,
) -> Result<PathBuf, String> {
    if !working_directory.is_absolute() {
        return Err("native_workspace_working_directory_invalid".into());
    }
    let selected = deployment_root.unwrap_or(legacy_default);
    let absolute = if selected.is_absolute() {
        selected.to_owned()
    } else {
        working_directory.join(selected)
    };
    let mut result = PathBuf::from("/");
    for component in absolute.components() {
        match component {
            Component::Normal(name) => result.push(name),
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir | Component::CurDir => (),
            Component::Prefix(_) => return Err("native_workspace_root_invalid".into()),
        }
    }
    if result.to_str().is_none() {
        return Err("native_workspace_root_invalid".into());
    }
    Ok(result)
}
