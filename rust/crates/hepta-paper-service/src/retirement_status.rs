//! Read-only legacy archive retirement status inspection.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
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
    #[error("retirement status request is missing version")]
    VersionMissing,
    #[error("retirement status filesystem operation failed")]
    Io(#[from] std::io::Error),
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
    let path = absolute(path);
    if let Ok(value) = fs::canonicalize(&path) {
        return value;
    }
    let mut missing = Vec::new();
    let mut cursor = path.as_path();
    while !cursor.exists() {
        if let Some(name) = cursor.file_name() {
            missing.push(name.to_owned());
        }
        let Some(parent) = cursor.parent() else { break };
        cursor = parent;
    }
    let mut resolved = fs::canonicalize(cursor).unwrap_or_else(|_| cursor.to_path_buf());
    for name in missing.iter().rev() {
        resolved.push(name);
    }
    resolved
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

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

/// Inspect the destructive legacy archive retirement boundary without mutating anything.
pub fn inspect_retirement_status_v1(input: &Value) -> Result<Value, RetirementStatusError> {
    let object = input
        .as_object()
        .ok_or(RetirementStatusError::RequestInvalid)?;
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(RetirementStatusError::VersionMissing)?;
    let legacy_root = resolved_path(Path::new(
        object
            .get("legacyRoot")
            .and_then(Value::as_str)
            .unwrap_or("paper_factory"),
    ));
    let runtime_root = resolved_path(Path::new(
        object
            .get("runtimeRoot")
            .and_then(Value::as_str)
            .unwrap_or("hepta-paper-runtime/native-runtime"),
    ));
    let asset_root = resolved_path(Path::new(
        object
            .get("assetRoot")
            .and_then(Value::as_str)
            .unwrap_or("hepta-paper-assets"),
    ));
    let roots = [&legacy_root, &runtime_root, &asset_root];
    let physically_decoupled = roots.iter().enumerate().all(|(index, left)| {
        roots[index + 1..]
            .iter()
            .all(|right| !paths_overlap(left, right))
    });
    let mut blockers = vec![EXECUTION_BLOCKER.to_owned()];
    if !physically_decoupled {
        push_unique(&mut blockers, "workspace_layout_not_physically_decoupled");
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
    let archive_root = legacy_root
        .parent()
        .unwrap_or_else(|| Path::new("/"))
        .join("hepta-paper-legacy-reference")
        .join(version);
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
