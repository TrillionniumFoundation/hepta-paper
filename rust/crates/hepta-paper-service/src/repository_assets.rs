//! Rust implementation of the repository asset identity/externalization check.
//!
//! This is a read-only verifier. It never publishes an external reference,
//! deletes tracked bytes, or grants release authority.

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use thiserror::Error;

const SHA256_HEX: usize = 64;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum RepositoryAssetError {
    #[error("repository asset request is invalid")]
    InvalidRequest,
    #[error("repository asset file operation failed")]
    Io,
    #[error("repository asset externalization handoff blocked:{0}")]
    HandoffBlocked(String),
    #[error("repository asset compatibility hash failed")]
    Compatibility,
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn is_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX + 7
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Array(_)) => String::from(""),
        Some(Value::Object(_)) => String::from("[object Object]"),
    }
}

fn field<'a>(asset: &'a Value, name: &str) -> Option<&'a Value> {
    asset.as_object().and_then(|object| object.get(name))
}

fn field_string(asset: &Value, name: &str) -> String {
    js_string(field(asset, name))
}

fn optional_string(value: String) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value)
    }
}

fn path_value(value: &str) -> Result<String, &'static str> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.split('/').any(|part| part == "..")
    {
        return Err("repository_asset_path_invalid");
    }
    Ok(normalized)
}

fn safe_join(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn read_file_bounded(path: &Path) -> Result<Vec<u8>, RepositoryAssetError> {
    let file = File::open(path).map_err(|_| RepositoryAssetError::Io)?;
    let metadata = file.metadata().map_err(|_| RepositoryAssetError::Io)?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err(RepositoryAssetError::Io);
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| RepositoryAssetError::Io)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(RepositoryAssetError::Io);
    }
    Ok(bytes)
}

fn valid_date_string(value: &str) -> bool {
    // The manifest uses ISO-8601 UTC timestamps. Keep this parser bounded and
    // reject malformed values without treating a receipt as external authority.
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[17..19].iter().all(u8::is_ascii_digit)
        && (bytes[19] == b'Z' || bytes[19] == b'+' || bytes[19] == b'-' || bytes[19] == b'.')
}

fn valid_restore_receipt(
    asset: &Value,
    receipt: Option<&Value>,
) -> Result<bool, RepositoryAssetError> {
    let Some(receipt) = receipt.and_then(Value::as_object) else {
        return Ok(false);
    };
    let claimed = receipt
        .get("repositoryAssetExternalRestoreDrillReceiptHash")
        .map(|value| js_string(Some(value)))
        .unwrap_or_default();
    let payload: Map<String, Value> = receipt
        .iter()
        .filter(|(key, _)| key.as_str() != "repositoryAssetExternalRestoreDrillReceiptHash")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let ok = receipt.get("version").and_then(Value::as_u64) == Some(1)
        && receipt.get("kind").and_then(Value::as_str)
            == Some("RepositoryAssetExternalRestoreDrillReceipt")
        && receipt.get("status").and_then(Value::as_str)
            == Some("repository_asset_external_restore_verified")
        && receipt.get("assetId").and_then(Value::as_str)
            == Some(field_string(asset, "assetId").as_str())
        && receipt
            .get("externalReferenceDigest")
            .and_then(Value::as_str)
            == field(asset, "externalReference")
                .and_then(|reference| reference.get("digest"))
                .and_then(Value::as_str)
        && receipt
            .get("restoredIdentitySha256")
            .and_then(Value::as_str)
            == field(asset, "expectedIdentitySha256").and_then(Value::as_str)
        && receipt
            .get("verifiedAt")
            .and_then(Value::as_str)
            .is_some_and(valid_date_string)
        && is_sha256(&claimed)
        && production_hash_record_v1(
            "RepositoryAssetExternalRestoreDrillReceipt",
            &Value::Object(payload),
        )
        .map_err(|_| RepositoryAssetError::Compatibility)?
        .as_str()
            == claimed;
    Ok(ok)
}

fn git_env() -> Vec<(String, String)> {
    let mut envs: BTreeMap<String, String> = env::vars().collect();
    envs.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
    envs.insert("LC_ALL".into(), "C".into());
    for key in [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_WORK_TREE",
    ] {
        envs.remove(key);
    }
    envs.into_iter().collect()
}

fn parent_gitlink(root: &Path, source: &str) -> Result<String, &'static str> {
    let output = Command::new("git")
        .args(["-c", "core.quotepath=false", "-C"])
        .arg(root)
        .args(["ls-tree", "-z", "HEAD", "--"])
        .arg(source)
        .envs(git_env())
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "repository_asset_parent_gitlink_unreadable")?;
    if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT {
        return Err("repository_asset_parent_gitlink_unreadable");
    }
    let records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    if records.len() != 1 {
        return Err("repository_asset_parent_gitlink_invalid");
    }
    let text = String::from_utf8(records[0].to_vec())
        .map_err(|_| "repository_asset_parent_gitlink_invalid")?;
    let Some((header, path)) = text.split_once('\t') else {
        return Err("repository_asset_parent_gitlink_invalid");
    };
    let mut parts = header.split(' ');
    if parts.next() != Some("160000") || parts.next() != Some("commit") || path != source {
        return Err("repository_asset_parent_gitlink_invalid");
    }
    let commit = parts.next().unwrap_or_default();
    if !(commit.len() >= 40
        && commit.len() <= 64
        && commit
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    {
        return Err("repository_asset_parent_gitlink_invalid");
    }
    Ok(commit.to_owned())
}

fn submodule_binding(root: &Path, source: &str, asset: &Value) -> Vec<String> {
    let Some(reference) = field(asset, "externalReference").and_then(Value::as_object) else {
        return vec![];
    };
    let transport = reference
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if transport != "git-submodule" && transport != "git-lfs-submodule" {
        return vec!["repository_asset_external_transport_invalid".into()];
    }
    let pinned = reference
        .get("pinnedCommit")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let repository_url = reference
        .get("repositoryUrl")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let location = reference
        .get("location")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected = field_string(asset, "expectedIdentitySha256");
    if !(pinned.len() >= 40
        && pinned.len() <= 64
        && pinned
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        || repository_url.is_empty()
        || location != format!("{repository_url}#{pinned}")
        || reference.get("digest").and_then(Value::as_str) != Some(expected.as_str())
    {
        return vec!["repository_asset_submodule_reference_invalid".into()];
    }
    let gitmodules = fs::read_to_string(root.join(".gitmodules"));
    let binding = gitmodules.ok().map(|contents| {
        let mut path_value = None;
        let mut url_value = None;
        let mut bindings = Vec::new();
        for line in contents.lines() {
            if line.trim_start().starts_with("[submodule ")
                && let (Some(path_value), Some(url_value)) = (path_value.take(), url_value.take())
            {
                bindings.push((path_value, url_value));
            }
            if let Some(value) = line.trim().strip_prefix("path = ") {
                path_value = Some(value.to_owned());
            }
            if let Some(value) = line.trim().strip_prefix("url = ") {
                url_value = Some(value.to_owned());
            }
        }
        if let (Some(path_value), Some(url_value)) = (path_value, url_value) {
            bindings.push((path_value, url_value));
        }
        bindings
            .into_iter()
            .any(|(path_value, url_value)| path_value == source && url_value == repository_url)
    });
    let parent = match parent_gitlink(root, source) {
        Ok(parent) => parent,
        Err(error) => return vec![error.into()],
    };
    let materialized = match materialized_submodule_head(&safe_join(root, source)) {
        Ok(head) => head,
        Err(error) => return vec![error.into()],
    };
    if binding != Some(true)
        || parent != pinned
        || materialized.as_ref().is_some_and(|head| head != pinned)
    {
        return vec!["repository_asset_submodule_binding_mismatch".into()];
    }
    vec![]
}

fn materialized_submodule_head(source: &Path) -> Result<Option<String>, &'static str> {
    let marker = source.join(".git");
    let Ok(stat) = fs::symlink_metadata(&marker) else {
        return Ok(None);
    };
    if !stat.is_file() {
        return Err("repository_asset_submodule_git_marker_invalid");
    }
    let content =
        fs::read_to_string(&marker).map_err(|_| "repository_asset_submodule_git_marker_invalid")?;
    let Some(gitdir) = content.trim().strip_prefix("gitdir:").map(str::trim) else {
        return Err("repository_asset_submodule_git_marker_invalid");
    };
    let gitdir = source.join(gitdir);
    let head = fs::read_to_string(gitdir.join("HEAD"))
        .map_err(|_| "repository_asset_submodule_head_invalid")?
        .trim()
        .to_owned();
    if head.len() >= 40
        && head
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Ok(Some(head));
    }
    let Some(reference) = head.strip_prefix("ref:").map(str::trim) else {
        return Err("repository_asset_submodule_head_invalid");
    };
    if let Ok(value) = fs::read_to_string(gitdir.join(reference)) {
        let value = value.trim().to_owned();
        if value.len() >= 40
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Ok(Some(value));
        }
        return Err("repository_asset_submodule_head_invalid");
    }
    let packed = fs::read_to_string(gitdir.join("packed-refs"))
        .map_err(|_| "repository_asset_submodule_head_unresolved")?;
    for line in packed.lines() {
        if line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(commit) = parts.next() else {
            continue;
        };
        if parts.next() == Some(reference) {
            if commit.len() >= 40
                && commit
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Ok(Some(commit.to_owned()));
            }
            return Err("repository_asset_submodule_head_invalid");
        }
    }
    Err("repository_asset_submodule_head_unresolved")
}

fn inspect_asset(root: &Path, asset: &Value) -> Result<Value, RepositoryAssetError> {
    let mut blockers = Vec::new();
    let source = path_value(&field_string(asset, "sourcePath")).ok();
    let identity = path_value(&field_string(asset, "identityFile")).ok();
    if source.is_none() || identity.is_none() {
        blockers.push("repository_asset_path_invalid".into());
    }
    let asset_id = field_string(asset, "assetId");
    if asset_id.trim().is_empty() {
        blockers.push("repository_asset_id_required".into());
    }
    let expected = field_string(asset, "expectedIdentitySha256");
    if !is_sha256(&expected) {
        blockers.push("repository_asset_identity_hash_invalid".into());
    }
    if field_string(asset, "currentStorage").trim().is_empty()
        || field_string(asset, "targetStorage").trim().is_empty()
        || field_string(asset, "requiredExternalReferenceKind")
            .trim()
            .is_empty()
        || field_string(asset, "retentionPolicy").trim().is_empty()
    {
        blockers.push("repository_asset_storage_policy_incomplete".into());
    }
    let migration = field_string(asset, "migrationStatus");
    let migration_blocker = match migration.as_str() {
        "externalized" => None,
        "pending-external-registry-reference" => Some("external_registry_reference_required"),
        "pending-read-only-reference-release" => Some("read_only_reference_release_required"),
        _ => {
            blockers.push("repository_asset_migration_status_invalid".into());
            None
        }
    };
    let mut observed = None;
    if let (Some(source), Some(identity)) = (&source, &identity) {
        let source_root = safe_join(root, source);
        let identity_path = safe_join(root, identity);
        if !identity_path.starts_with(&source_root) {
            blockers.push("repository_asset_identity_outside_source".into());
        } else if migration == "externalized" {
            let restored = field(asset, "externalReference")
                .and_then(|r| r.get("restoreDrillReceipt"))
                .and_then(|r| r.get("restoredIdentitySha256"));
            observed = restored
                .and_then(Value::as_str)
                .filter(|value| is_sha256(value))
                .map(ToOwned::to_owned);
            if observed.as_deref() != Some(expected.as_str()) {
                blockers.push("repository_asset_identity_hash_mismatch".into());
            }
            if let Ok(stat) = fs::symlink_metadata(&source_root)
                && (stat.file_type().is_symlink() || !stat.is_dir())
            {
                blockers.push("repository_asset_source_not_regular_directory".into());
            }
            if let Ok(stat) = fs::symlink_metadata(&identity_path) {
                if stat.file_type().is_symlink() || !stat.is_file() {
                    blockers.push("repository_asset_identity_not_regular_file".into());
                } else if let Ok(bytes) = read_file_bounded(&identity_path) {
                    if sha256(&bytes) != expected {
                        blockers.push("repository_asset_identity_hash_mismatch".into());
                    }
                } else {
                    blockers.push("repository_asset_identity_unreadable".into());
                }
            }
        } else {
            match fs::symlink_metadata(&source_root) {
                Ok(stat) if !stat.file_type().is_symlink() && stat.is_dir() => {}
                _ => blockers.push("repository_asset_source_not_regular_directory".into()),
            }
            match fs::symlink_metadata(&identity_path) {
                Ok(stat) if !stat.file_type().is_symlink() && stat.is_file() => {
                    match read_file_bounded(&identity_path) {
                        Ok(bytes) => {
                            observed = Some(sha256(&bytes));
                            if observed.as_deref() != Some(expected.as_str()) {
                                blockers.push("repository_asset_identity_hash_mismatch".into());
                            }
                        }
                        Err(_) => blockers.push("repository_asset_identity_unreadable".into()),
                    }
                }
                _ => blockers.push("repository_asset_identity_not_regular_file".into()),
            }
        }
    }
    if migration == "externalized" {
        let reference = field(asset, "externalReference").and_then(Value::as_object);
        let valid_reference = reference.is_some_and(|reference| {
            reference.get("kind").and_then(Value::as_str)
                == Some(field_string(asset, "requiredExternalReferenceKind").as_str())
                && reference
                    .get("location")
                    .and_then(Value::as_str)
                    .is_some_and(|value| {
                        !value.trim().is_empty()
                            && value.len() <= 2048
                            && !value.chars().any(char::is_whitespace)
                    })
                && reference
                    .get("digest")
                    .and_then(Value::as_str)
                    .is_some_and(is_sha256)
                && valid_restore_receipt(asset, reference.get("restoreDrillReceipt"))
                    .unwrap_or(false)
        });
        if !valid_reference {
            blockers.push("repository_asset_external_reference_incomplete".into());
        }
        if let Some(ref source) = source {
            blockers.extend(submodule_binding(root, source, asset));
        }
    }
    let integrity_ready = blockers.is_empty();
    Ok(json!({
        "assetId": optional_string(asset_id),
        "sourcePath": source,
        "identityFile": identity,
        "expectedIdentitySha256": optional_string(expected),
        "observedIdentitySha256": observed,
        "currentStorage": optional_string(field_string(asset, "currentStorage")),
        "targetStorage": optional_string(field_string(asset, "targetStorage")),
        "migrationStatus": optional_string(field_string(asset, "migrationStatus")),
        "integrityReady": integrity_ready,
        "externalized": migration == "externalized" && integrity_ready,
        "blockers": blockers,
        "externalizationBlockers": migration_blocker.into_iter().collect::<Vec<_>>(),
    }))
}

pub fn inspect_repository_asset_externalization_v1(
    root: &Path,
    manifest: &Value,
) -> Result<Value, RepositoryAssetError> {
    let mut manifest_blockers = Vec::new();
    let assets = manifest.get("assets").and_then(Value::as_array);
    if manifest.get("version").and_then(Value::as_u64) != Some(1)
        || manifest.get("kind").and_then(Value::as_str)
            != Some("RepositoryAssetExternalizationManifest")
        || assets.is_none_or(|assets| assets.is_empty())
    {
        manifest_blockers.push("repository_asset_externalization_manifest_invalid");
    }
    let mut inspected = Vec::new();
    for asset in assets.into_iter().flatten() {
        inspected.push(inspect_asset(root, asset)?);
    }
    let mut ids = std::collections::BTreeSet::new();
    if inspected.iter().any(|asset| {
        !ids.insert(
            asset
                .get("assetId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        )
    }) {
        manifest_blockers.push("repository_asset_id_duplicate");
    }
    let integrity: Vec<String> = manifest_blockers
        .iter()
        .map(|value| (*value).to_owned())
        .chain(inspected.iter().flat_map(|asset| {
            asset["blockers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str())
                .map(|blocker| {
                    format!(
                        "{}:{blocker}",
                        asset["assetId"].as_str().unwrap_or("unknown")
                    )
                })
        }))
        .collect();
    let external: Vec<String> = inspected
        .iter()
        .flat_map(|asset| {
            asset["externalizationBlockers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str())
                .map(|blocker| {
                    format!(
                        "{}:{blocker}",
                        asset["assetId"].as_str().unwrap_or("unknown")
                    )
                })
        })
        .collect();
    Ok(json!({
        "version": 1,
        "kind": "RepositoryAssetExternalizationInspection",
        "status": if !integrity.is_empty() { "repository_asset_boundary_blocked" } else if !external.is_empty() { "repository_asset_boundary_ready_externalization_pending" } else { "repository_assets_externalized" },
        "repositoryBoundaryReady": integrity.is_empty(),
        "fullyExternalized": integrity.is_empty() && external.is_empty(),
        "assets": inspected,
        "integrityBlockers": integrity,
        "externalizationBlockers": external,
    }))
}

pub fn build_repository_asset_externalization_handoff_v1(
    root: &Path,
    manifest: &Value,
) -> Result<Value, RepositoryAssetError> {
    let inspection = inspect_repository_asset_externalization_v1(root, manifest)?;
    if !inspection["repositoryBoundaryReady"]
        .as_bool()
        .unwrap_or(false)
    {
        let blockers = inspection["integrityBlockers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(",");
        return Err(RepositoryAssetError::HandoffBlocked(blockers));
    }
    let assets = manifest
        .get("assets")
        .and_then(Value::as_array)
        .ok_or(RepositoryAssetError::InvalidRequest)?;
    let handoff_assets = assets.iter().map(|asset| {
        let asset_id = field_string(asset, "assetId");
        let expected = field_string(asset, "expectedIdentitySha256");
        json!({
            "assetId": asset_id,
            "sourcePath": field_string(asset, "sourcePath"),
            "identityFile": field_string(asset, "identityFile"),
            "expectedIdentitySha256": expected,
            "targetStorage": field_string(asset, "targetStorage"),
            "requiredExternalReferenceKind": field_string(asset, "requiredExternalReferenceKind"),
            "retentionPolicy": field_string(asset, "retentionPolicy"),
            "externalizationSequence": ["publish-immutable-reference", "verify-reference-digest", "restore-into-fresh-trusted-root", "verify-restored-identity", "issue-content-bound-restore-drill-receipt", "update-manifest-to-externalized", "switch-production-readers", "delete-tracked-payload-in-dedicated-migration"],
            "requiredExternalReference": { "kind": field_string(asset, "requiredExternalReferenceKind"), "location": null, "digest": null, "restoreDrillReceipt": { "version": 1, "kind": "RepositoryAssetExternalRestoreDrillReceipt", "status": "repository_asset_external_restore_verified", "assetId": asset_id, "externalReferenceDigest": null, "restoredIdentitySha256": expected, "verifiedAt": null, "repositoryAssetExternalRestoreDrillReceiptHash": null } },
        })
    }).collect::<Vec<_>>();
    Ok(json!({
        "version": 1,
        "kind": "RepositoryAssetExternalizationHandoff",
        "status": if inspection["fullyExternalized"].as_bool().unwrap_or(false) { "repository_assets_already_externalized" } else { "repository_asset_externalization_authority_required" },
        "assets": handoff_assets,
        "currentInspection": inspection,
    }))
}
