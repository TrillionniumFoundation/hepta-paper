//! Explicit native deployment workspace selection. This only resolves a path;
//! each consumer must open and validate its own manifest and retained inputs.
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

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

/// Ordinary frontend location, independent of the caller's working directory.
/// Explicit configuration selects a path, never deployment authority. A source
/// default is available only inside this build's exact Cargo profile directory.
/// Copied frontends use the recognized physical ROOT/bin layout and its own
/// regular package marker; consumers still validate their actual manifests.
pub fn resolve_native_command_workspace_root_v1(
    working_directory: &Path,
    environment: &BTreeMap<String, String>,
    explicit_root: Option<&Path>,
) -> Result<PathBuf, String> {
    resolve_native_command_workspace_root_with_context_v1(
        working_directory,
        environment,
        explicit_root,
        false,
    )
}
fn resolve_native_command_workspace_root_with_context_v1(
    working_directory: &Path,
    environment: &BTreeMap<String, String>,
    explicit_root: Option<&Path>,
    command_surface: bool,
) -> Result<PathBuf, String> {
    if let Some(selected) = explicit_root.or_else(|| {
        environment
            .get("HEPTA_PAPER_WORKSPACE_ROOT")
            .filter(|value| !value.is_empty())
            .map(Path::new)
    }) {
        return resolve_native_workspace_root_v1(working_directory, selected, Some(selected));
    }
    let executable =
        std::env::current_exe().map_err(|_| "native_workspace_executable_unavailable")?;
    let parent = executable
        .parent()
        .ok_or("native_workspace_root_required")?;
    let physical_parent = fs::canonicalize(parent).map_err(|_| "native_workspace_root_required")?;
    let profile = Path::new(env!("HEPTA_NATIVE_BUILD_PROFILE_ROOT_V1"));
    if physical_parent == profile || physical_parent == profile.join("deps") {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        return resolve_native_workspace_root_v1(working_directory, &source, None);
    }
    if physical_parent
        .file_name()
        .is_some_and(|name| name == "bin")
        && executable.file_name().is_some_and(|name| {
            [
                "hepta-paper-rust",
                "hepta-release-integrity-key",
                "hepta-workspace-status",
                "hepta-runtime-image-reproducibility",
                "hepta-state-backup",
                "hepta-automation-reconcile",
                "hepta-operational-proof-status",
                "hepta-owner-acceptance-status",
            ]
            .iter()
            .any(|expected| name == *expected)
        })
    {
        let root = physical_parent
            .parent()
            .ok_or("native_workspace_root_required")?;
        if deployment_marker(root, command_surface)? {
            return resolve_native_workspace_root_v1(working_directory, root, None);
        }
    }
    Err("native_workspace_root_required".into())
}

/// Process frontend convenience for owners whose contract obtains its own
/// working directory and environment. The same selector owns every default.
pub fn current_native_command_workspace_root_v1(
    explicit_root: Option<&Path>,
) -> Result<PathBuf, String> {
    current_native_command_workspace_root_with_context_v1(explicit_root, false)
}
/// Ordinary package synchronization can grow its own metadata through Node
/// string/array coercion. Only this closed context uses the package owner's
/// fixed input/output budget and UTF-16-compatible marker projection.
pub fn current_native_command_surface_workspace_root_v1() -> Result<PathBuf, String> {
    current_native_command_workspace_root_with_context_v1(None, true)
}
fn current_native_command_workspace_root_with_context_v1(
    explicit_root: Option<&Path>,
    command_surface: bool,
) -> Result<PathBuf, String> {
    let cwd =
        std::env::current_dir().map_err(|_| "native_workspace_working_directory_unavailable")?;
    if explicit_root.is_some() {
        return resolve_native_command_workspace_root_with_context_v1(
            &cwd,
            &BTreeMap::new(),
            explicit_root,
            command_surface,
        );
    }
    let environment = match std::env::var("HEPTA_PAPER_WORKSPACE_ROOT") {
        Ok(value) => BTreeMap::from([("HEPTA_PAPER_WORKSPACE_ROOT".to_owned(), value)]),
        Err(std::env::VarError::NotPresent) => BTreeMap::new(),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err("native_workspace_root_invalid".into());
        }
    };
    resolve_native_command_workspace_root_with_context_v1(
        &cwd,
        &environment,
        explicit_root,
        command_surface,
    )
}

/// An explicit runtime path has no dependency on an unrelated workspace. Only
/// the actual missing default is derived beside the recognized frontend.
pub fn current_native_command_runtime_root_v1() -> Result<PathBuf, String> {
    let cwd =
        std::env::current_dir().map_err(|_| "native_workspace_working_directory_unavailable")?;
    if let Some(selected) =
        std::env::var_os("HEPTA_PAPER_RUNTIME_ROOT").filter(|value| !value.is_empty())
    {
        let selected = PathBuf::from(selected);
        return resolve_native_workspace_root_v1(&cwd, &selected, Some(&selected));
    }
    let root = current_native_command_workspace_root_v1(None)?;
    Ok(root
        .parent()
        .unwrap_or(&root)
        .join("hepta-paper-runtime/native-runtime"))
}

fn deployment_marker(root: &Path, command_surface: bool) -> Result<bool, String> {
    for relative in ["paper-core", "paper-core/bin", "paper-core/config"] {
        let Ok(metadata) = fs::symlink_metadata(root.join(relative)) else {
            return Ok(false);
        };
        if !metadata.is_dir() || metadata.is_symlink() {
            return Ok(false);
        }
    }
    if command_surface {
        let bytes = match read_native_workspace_package_bytes_with_limit_v1(
            root,
            crate::command_surface::COMMAND_SURFACE_PACKAGE_MAX_BYTES_V1,
        ) {
            Ok(bytes) => bytes,
            Err(cause) if cause == "native_workspace_marker_changed" => return Err(cause),
            Err(_) => return Ok(false),
        };
        use hepta_legacy_compatibility::ProductionJsonValue as Node;
        let Ok(Node::Object(entries)) =
            hepta_legacy_compatibility::parse_production_json_v1(&bytes)
        else {
            return Ok(false);
        };
        let expected_name: Vec<u16> = "name".encode_utf16().collect();
        let expected_value: Vec<u16> = "hepta-paper-workspace".encode_utf16().collect();
        return Ok(entries
            .into_iter()
            .find(|(key, _)| *key == expected_name)
            .is_some_and(
                |(_, value)| matches!(value, Node::String(value) if value == expected_value),
            ));
    }
    match read_native_workspace_package_v1(root) {
        Ok(value) => {
            Ok(value.get("name").and_then(serde_json::Value::as_str)
                == Some("hepta-paper-workspace"))
        }
        Err(cause) if cause == "native_workspace_marker_changed" => Err(cause),
        Err(_) => Ok(false),
    }
}

/// One bounded, no-follow package reader for path discovery and consumers of
/// package metadata. This checks a cooperative before/after observation; the
/// returned JSON never authenticates deployment or publication authority.
pub fn read_native_workspace_package_v1(root: &Path) -> Result<serde_json::Value, String> {
    let bytes = read_native_workspace_package_bytes_with_limit_v1(root, 64 * 1024)?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| "native_workspace_marker_invalid".into())
}
pub(crate) fn read_native_workspace_package_bytes_with_limit_v1(
    root: &Path,
    maximum_bytes: u64,
) -> Result<Vec<u8>, String> {
    if maximum_bytes == 0
        || maximum_bytes > crate::command_surface::COMMAND_SURFACE_PACKAGE_MAX_BYTES_V1
    {
        return Err("native_workspace_marker_invalid".into());
    }
    let marker = root.join("package.json");
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(&marker)
        .map_err(|_| "native_workspace_marker_unreadable")?;
    let before = file
        .metadata()
        .map_err(|_| "native_workspace_marker_unreadable")?;
    if !before.is_file() || before.nlink() != 1 || before.len() == 0 || before.len() > maximum_bytes
    {
        return Err("native_workspace_marker_invalid".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "native_workspace_marker_unreadable")?;
    let after = file
        .metadata()
        .map_err(|_| "native_workspace_marker_unreadable")?;
    let named = fs::symlink_metadata(&marker).map_err(|_| "native_workspace_marker_changed")?;
    let identity = |value: &fs::Metadata| {
        (
            value.dev(),
            value.ino(),
            value.uid(),
            value.gid(),
            value.mode(),
            value.nlink(),
            value.len(),
            value.mtime(),
            value.mtime_nsec(),
            value.ctime(),
            value.ctime_nsec(),
        )
    };
    if bytes.len() as u64 != before.len()
        || identity(&before) != identity(&after)
        || identity(&before) != identity(&named)
    {
        return Err("native_workspace_marker_changed".into());
    }
    Ok(bytes)
}
