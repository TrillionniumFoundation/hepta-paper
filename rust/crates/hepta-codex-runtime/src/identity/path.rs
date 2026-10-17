use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs, io,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};

use super::types::RuntimeIdentityError;

pub(super) fn resolve_executable(
    executable: &OsStr,
    source_environment: &BTreeMap<String, String>,
) -> Result<PathBuf, RuntimeIdentityError> {
    if executable.is_empty() {
        return Err(RuntimeIdentityError::ExecutableRequired);
    }
    if executable.as_bytes().contains(&b'/') {
        return lexical_absolute(Path::new(executable));
    }
    let path = source_environment
        .get("PATH")
        .ok_or(RuntimeIdentityError::PathEnvironmentRequired)?;
    for directory in std::env::split_paths(OsStr::new(path)) {
        let candidate = directory.join(executable);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => return lexical_absolute(&candidate),
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(RuntimeIdentityError::Filesystem(
                    "executable_resolution",
                    error.kind(),
                ));
            }
        }
    }
    Err(RuntimeIdentityError::ExecutableUnavailable)
}

pub(super) fn canonical_requested_path(requested: &Path) -> Result<PathBuf, RuntimeIdentityError> {
    let normalized = lexical_absolute(requested)?;
    let canonical = fs::canonicalize(&normalized)
        .map_err(|error| RuntimeIdentityError::Filesystem("canonical_path", error.kind()))?;
    if canonical != normalized {
        return Err(RuntimeIdentityError::NonCanonicalOrSymlinkPath);
    }
    Ok(canonical)
}

pub(super) fn lexical_absolute(path: &Path) -> Result<PathBuf, RuntimeIdentityError> {
    let source = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| RuntimeIdentityError::Filesystem("current_directory", error.kind()))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in source.components() {
        match component {
            Component::RootDir => normalized.push(Path::new("/")),
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(RuntimeIdentityError::InvalidPath);
                }
            }
            Component::Prefix(_) => return Err(RuntimeIdentityError::InvalidPath),
        }
    }
    if !normalized.is_absolute() {
        return Err(RuntimeIdentityError::InvalidPath);
    }
    Ok(normalized)
}

pub(super) fn validate_safe_relative_path(relative: &str) -> Result<(), RuntimeIdentityError> {
    if relative.is_empty() || relative.len() > 512 || relative.contains('\0') {
        return Err(RuntimeIdentityError::InvalidCredentialPath(
            relative.to_owned(),
        ));
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err(RuntimeIdentityError::InvalidCredentialPath(
            relative.to_owned(),
        ));
    }
    Ok(())
}
