//! Read-only legacy archive retirement status inspection.

use crate::workspace_status::{WorkspaceLayoutOptionsV1, resolve_workspace_layout_v1};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};
use thiserror::Error;

const PROTECTED_ROOTS: [&str; 8] = [
    "bin",
    "paperctl_modules",
    "plugins",
    "schema",
    "registry",
    "templates",
    "docs",
    "paper_factory.sqlite",
];
const EXECUTION_BLOCKER: &str =
    "legacy_archive_retirement_execute_disabled_pending_identity_bound_transaction";

#[derive(Debug, Error)]
pub enum RetirementStatusError {
    #[error("retirement status request must be an object")]
    RequestInvalid,
    #[error("retirement status package version is invalid")]
    PackageVersionInvalid,
    #[error("retirement status filesystem operation failed")]
    Io(#[from] std::io::Error),
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn environment_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Match `paper-adapters/runtime/workspace-layout.mjs` defaults used by the
/// incumbent `retire-legacy-archive.mjs` command. Environment overrides are
/// still resolved from the caller's working directory; source defaults are
/// resolved beside the checked-in workspace.
fn default_roots() -> (PathBuf, PathBuf, PathBuf) {
    let workspace = workspace_root();
    let parent = workspace.parent().unwrap_or(&workspace);
    let legacy_parent = parent.file_name().and_then(|name| name.to_str()) == Some("paper_factory");
    let asset = environment_path("HEPTA_PAPER_ASSET_ROOT").unwrap_or_else(|| {
        if legacy_parent {
            parent.to_path_buf()
        } else {
            parent.join("hepta-paper-assets")
        }
    });
    let runtime = environment_path("HEPTA_PAPER_RUNTIME_ROOT")
        .unwrap_or_else(|| parent.join("hepta-paper-runtime/native-runtime"));
    let legacy = environment_path("PAPER_FACTORY_LEGACY_ROOT").unwrap_or_else(|| {
        if legacy_parent {
            parent.to_path_buf()
        } else {
            parent.join("paper_factory")
        }
    });
    (asset, runtime, legacy)
}

fn package_version() -> Result<String, RetirementStatusError> {
    let package = fs::read_to_string(workspace_root().join("package.json"))?;
    let value: Value =
        serde_json::from_str(&package).map_err(|_| RetirementStatusError::PackageVersionInvalid)?;
    value
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| !version.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or(RetirementStatusError::PackageVersionInvalid)
}

fn request_path(
    object: &serde_json::Map<String, Value>,
    name: &str,
    default: PathBuf,
) -> Result<PathBuf, RetirementStatusError> {
    match object.get(name) {
        None => Ok(default),
        Some(Value::String(value)) => Ok(PathBuf::from(value)),
        Some(_) => Err(RetirementStatusError::RequestInvalid),
    }
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    }
}

fn resolved_path(path: &Path) -> PathBuf {
    let absolute = absolute(path);
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            Component::RootDir => resolved.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => resolved.push(name),
        }
    }
    resolved
}

/// Match Node's POSIX `path.join(parent, "hepta-paper-legacy-reference", version)`
/// semantics for the explicit package-version segment.  `PathBuf::join`
/// preserves `.`/`..`, repeated separators, and an absolute child, while the
/// incumbent Node route collapses those lexically and does not let the child
/// reset the already-built parent.  Keep a trailing slash when Node preserves
/// one so the serialized status remains byte-compatible for unusual inputs.
fn node_archive_root(parent: &Path, version: &str) -> PathBuf {
    let mut result = parent.to_path_buf();
    result.push("hepta-paper-legacy-reference");
    let trailing = version.ends_with('/');
    for segment in version.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            result.pop();
        } else {
            result.push(segment);
        }
    }
    if trailing {
        let mut text = result.to_string_lossy().into_owned();
        if !text.ends_with('/') {
            text.push('/');
        }
        PathBuf::from(text)
    } else {
        result
    }
}

fn path_kind(path: &Path) -> &'static str {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => "symlink",
        Ok(metadata) if metadata.is_dir() => "directory",
        Ok(metadata) if metadata.is_file() => "file",
        Ok(_) => "other",
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing",
        Err(_) => "unreadable",
    }
}

fn archive_status(path: &Path) -> Result<Value, RetirementStatusError> {
    let kind = path_kind(path);
    if kind == "missing" {
        return Ok(json!({
            "path": path,
            "present": false,
            "safeRegularFile": false,
            "sha256": null,
            "bytes": 0,
            "mode": null,
            "identity": null,
            "blocker": null,
        }));
    }
    if kind != "file" {
        return Ok(json!({
            "path": path,
            "present": true,
            "safeRegularFile": false,
            "sha256": null,
            "bytes": 0,
            "mode": null,
            "identity": null,
            "blocker": format!("legacy_archive_retirement_archive_{kind}"),
        }));
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("/"));
    let parent_is_safe = fs::symlink_metadata(parent)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
        && fs::canonicalize(parent)
            .map(|canonical| canonical == absolute(parent))
            .unwrap_or(false);
    if !parent_is_safe {
        return Ok(json!({
            "path": path,
            "present": true,
            "safeRegularFile": false,
            "sha256": null,
            "bytes": 0,
            "mode": null,
            "identity": null,
            "blocker": "legacy_archive_retirement_archive_parent_unsafe",
        }));
    }

    let result = (|| -> Result<Value, String> {
        let file = File::open(path).map_err(|error| error.to_string())?;
        let before = file.metadata().map_err(|error| error.to_string())?;
        let selected = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !before.is_file()
            || before.nlink() != 1
            || !selected.is_file()
            || selected.file_type().is_symlink()
            || before.dev() != selected.dev()
            || before.ino() != selected.ino()
        {
            return Err("legacy_archive_retirement_archive_unsafe".to_owned());
        }
        let mut reader = file;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 1024 * 1024];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            bytes += count as u64;
        }
        if bytes != before.size() {
            return Err("legacy_archive_retirement_archive_changed_during_read".to_owned());
        }
        let after = reader.metadata().map_err(|error| error.to_string())?;
        let final_path = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if after.dev() != before.dev()
            || after.ino() != before.ino()
            || after.size() != before.size()
            || after.mtime() != before.mtime()
            || after.ctime() != before.ctime()
            || !final_path.is_file()
            || final_path.file_type().is_symlink()
            || final_path.dev() != before.dev()
            || final_path.ino() != before.ino()
        {
            return Err("legacy_archive_retirement_archive_changed_during_read".to_owned());
        }
        Ok(json!({
            "path": path,
            "present": true,
            "safeRegularFile": true,
            "sha256": format!("sha256:{:x}", hash.finalize()),
            "bytes": before.size(),
            "mode": before.mode() & 0o7777,
            "identity": {"dev": before.dev().to_string(), "ino": before.ino().to_string()},
            "blocker": null,
        }))
    })();
    Ok(match result {
        Ok(value) => value,
        Err(blocker) => json!({
            "path": path,
            "present": true,
            "safeRegularFile": false,
            "sha256": null,
            "bytes": 0,
            "mode": null,
            "identity": null,
            "blocker": blocker,
        }),
    })
}

fn push_unique(blockers: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !blockers.iter().any(|existing| existing == &value) {
        blockers.push(value);
    }
}

/// Inspect the destructive legacy archive retirement boundary without mutating anything.
pub fn inspect_retirement_status_v1(input: &Value) -> Result<Value, RetirementStatusError> {
    let object = input
        .as_object()
        .ok_or(RetirementStatusError::RequestInvalid)?;
    let version = match object.get("version") {
        None => package_version()?,
        Some(Value::String(value)) => value.to_owned(),
        Some(_) => return Err(RetirementStatusError::RequestInvalid),
    };
    let (default_asset_root, default_runtime_root, default_legacy_root) = default_roots();
    let legacy_root = resolved_path(&request_path(object, "legacyRoot", default_legacy_root)?);
    let runtime_root = resolved_path(&request_path(object, "runtimeRoot", default_runtime_root)?);
    let asset_root = resolved_path(&request_path(object, "assetRoot", default_asset_root)?);
    let working_directory = std::env::current_dir()?;
    let layout = resolve_workspace_layout_v1(
        &workspace_root(),
        &working_directory,
        &BTreeMap::new(),
        &WorkspaceLayoutOptionsV1 {
            legacy_root: legacy_root.to_str(),
            runtime_root: runtime_root.to_str(),
            asset_root: asset_root.to_str(),
        },
    )
    .map_err(|_| RetirementStatusError::RequestInvalid)?;
    let layout = serde_json::to_value(layout).map_err(|_| RetirementStatusError::RequestInvalid)?;
    let physically_decoupled = layout["physicallyDecoupled"] == true;
    let mut blockers = vec![EXECUTION_BLOCKER.to_owned()];
    if !physically_decoupled {
        let detail = layout["decouplingBlockers"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        push_unique(
            &mut blockers,
            format!("workspace_layout_not_physically_decoupled:{detail}"),
        );
    }
    let legacy_kind = path_kind(&legacy_root);
    if legacy_kind != "directory" && legacy_kind != "missing" {
        push_unique(
            &mut blockers,
            format!("legacy_archive_retirement_legacy_root_{legacy_kind}"),
        );
    }
    let protected = PROTECTED_ROOTS.iter().map(|relative| {
        json!({
            "relative": relative,
            "kind": if legacy_kind == "directory" { path_kind(&legacy_root.join(relative)) } else { "missing" },
        })
    }).collect::<Vec<_>>();
    let archive_root = node_archive_root(
        legacy_root.parent().unwrap_or_else(|| Path::new("/")),
        &version,
    );
    let archive =
        archive_status(&archive_root.join("paper-factory-control-plane-reference.tar.gz"))?;
    if let Some(blocker) = archive.get("blocker").and_then(Value::as_str) {
        push_unique(&mut blockers, blocker);
    }
    Ok(json!({
        "version": 2,
        "kind": "LegacyArchiveRetirementStatus",
        "status": "legacy_archive_retirement_read_only",
        "packageVersion": version,
        "executeSupported": false,
        "externalActionPerformed": false,
        "destructiveRemovalPerformed": false,
        "layoutPhysicallyDecoupled": physically_decoupled,
        "legacyRoot": legacy_root,
        "legacyRootKind": legacy_kind,
        "runtimeRoot": runtime_root,
        "assetRoot": asset_root,
        "protectedRoots": protected,
        "archiveRoot": archive_root,
        "archive": archive,
        "blockers": blockers,
    }))
}
