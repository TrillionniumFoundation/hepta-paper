//! Rust implementation of the repository asset identity/externalization check.
//!
//! This is a read-only verifier. It never publishes an external reference,
//! deletes tracked bytes, or grants release authority.

mod coercion;

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
    #[error("repository_asset_externalization_handoff_blocked:{0}")]
    HandoffBlocked(String),
    #[error("repository asset compatibility hash failed")]
    Compatibility,
    #[error("{0}")]
    Coercion(&'static str),
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

fn field<'a>(asset: &'a Value, name: &str) -> Option<&'a Value> {
    asset.as_object().and_then(|object| object.get(name))
}
fn field_string(asset: &Value, name: &str) -> Result<String, RepositoryAssetError> {
    coercion::string_or_empty(field(asset, name))
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

fn valid_restore_receipt(
    asset: &Value,
    receipt: Option<&Value>,
) -> Result<bool, RepositoryAssetError> {
    let Some(receipt) = receipt.and_then(Value::as_object) else {
        return Ok(false);
    };
    let reference = field(asset, "externalReference").and_then(Value::as_object);
    if !receipt
        .get("version")
        .and_then(Value::as_f64)
        .is_some_and(|v| v == 1.0)
        || receipt.get("kind").and_then(Value::as_str)
            != Some("RepositoryAssetExternalRestoreDrillReceipt")
        || receipt.get("status").and_then(Value::as_str)
            != Some("repository_asset_external_restore_verified")
        || !coercion::primitive_equal(receipt.get("assetId"), field(asset, "assetId"))
        || !coercion::primitive_equal(
            receipt.get("externalReferenceDigest"),
            reference.and_then(|v| v.get("digest")),
        )
        || !coercion::primitive_equal(
            receipt.get("restoredIdentitySha256"),
            field(asset, "expectedIdentitySha256"),
        )
        || !crate::store_status::passive_node_date_parse_finite_v1(&coercion::string_or_empty(
            receipt.get("verifiedAt"),
        )?)
    {
        return Ok(false);
    }
    let claimed = receipt.get("repositoryAssetExternalRestoreDrillReceiptHash");
    if !is_sha256(&coercion::string_or_empty(claimed)?) {
        return Ok(false);
    }
    let payload: Map<String, Value> = receipt
        .iter()
        .filter(|(key, _)| key.as_str() != "repositoryAssetExternalRestoreDrillReceiptHash")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let actual = production_hash_record_v1(
        "RepositoryAssetExternalRestoreDrillReceipt",
        &Value::Object(payload),
    )
    .map_err(|_| RepositoryAssetError::Compatibility)?;
    Ok(claimed.and_then(Value::as_str) == Some(actual.as_str()))
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

fn submodule_binding(
    root: &Path,
    source: &str,
    asset: &Value,
) -> Result<Vec<String>, RepositoryAssetError> {
    let Some(reference) = field(asset, "externalReference").and_then(Value::as_object) else {
        return Ok(vec![]);
    };
    let transport = reference.get("transport");
    if !coercion::truthy(transport) {
        return Ok(vec![]);
    }
    if !matches!(
        transport.and_then(Value::as_str),
        Some("git-submodule" | "git-lfs-submodule")
    ) {
        return Ok(vec!["repository_asset_external_transport_invalid".into()]);
    }
    let pinned = coercion::string_or_empty(reference.get("pinnedCommit"))?;
    let repository_url = reference.get("repositoryUrl").and_then(Value::as_str);
    let location = reference.get("location").and_then(Value::as_str);
    if !(pinned.len() >= 40
        && pinned.len() <= 64
        && pinned
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        || repository_url.is_none_or(|v| coercion::trim(v).is_empty())
        || location != repository_url.map(|v| format!("{v}#{pinned}")).as_deref()
        || !coercion::primitive_equal(
            reference.get("digest"),
            field(asset, "expectedIdentitySha256"),
        )
    {
        return Ok(vec!["repository_asset_submodule_reference_invalid".into()]);
    }
    let repository_url = repository_url.unwrap_or_default();
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
        Err(error) => return Ok(vec![error.into()]),
    };
    let materialized = match materialized_submodule_head(&safe_join(root, source)) {
        Ok(head) => head,
        Err(error) => return Ok(vec![error.into()]),
    };
    if binding != Some(true)
        || reference.get("pinnedCommit").and_then(Value::as_str) != Some(parent.as_str())
        || materialized.as_ref().is_some_and(|head| {
            reference.get("pinnedCommit").and_then(Value::as_str) != Some(head.as_str())
        })
    {
        return Ok(vec!["repository_asset_submodule_binding_mismatch".into()]);
    }
    Ok(vec![])
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

struct MigrationBlocker {
    json: Value,
    message: String,
}
fn migration_blocker(
    value: Option<&Value>,
) -> Result<Option<MigrationBlocker>, RepositoryAssetError> {
    let key = coercion::string(value)?;
    let message = match key.as_str() {
        "pending-external-registry-reference" => "external_registry_reference_required".to_owned(),
        "pending-read-only-reference-release" => "read_only_reference_release_required".to_owned(),
        "__proto__" => "[object Object]".to_owned(),
        "constructor" => "function Object() { [native code] }".to_owned(),
        "__defineGetter__"
        | "__defineSetter__"
        | "hasOwnProperty"
        | "__lookupGetter__"
        | "__lookupSetter__"
        | "isPrototypeOf"
        | "propertyIsEnumerable"
        | "toString"
        | "valueOf"
        | "toLocaleString" => format!("function {key}() {{ [native code] }}"),
        _ => return Ok(None),
    };
    let json = if key.starts_with("pending-") {
        Value::String(message.clone())
    } else if key == "__proto__" {
        json!({})
    } else {
        Value::Null
    };
    Ok(Some(MigrationBlocker { json, message }))
}

fn inspect_asset(root: &Path, asset: &Value) -> Result<Value, RepositoryAssetError> {
    let mut blockers: Vec<String> = Vec::new();
    let mut source = None;
    let mut identity = None;
    // One incumbent try block: the second path is evaluated only after the
    // first succeeds, and an invalid second path retains the first result.
    let paths = (|| {
        source = Some(
            path_value(&field_string(asset, "sourcePath")?)
                .map_err(RepositoryAssetError::Coercion)?,
        );
        identity = Some(
            path_value(&field_string(asset, "identityFile")?)
                .map_err(RepositoryAssetError::Coercion)?,
        );
        Ok::<(), RepositoryAssetError>(())
    })();
    if let Err(error) = paths {
        blockers.push(error.to_string());
    }
    if coercion::trim(&field_string(asset, "assetId")?).is_empty() {
        blockers.push("repository_asset_id_required".into());
    }
    if !is_sha256(&field_string(asset, "expectedIdentitySha256")?) {
        blockers.push("repository_asset_identity_hash_invalid".into());
    }
    if coercion::trim(&field_string(asset, "currentStorage")?).is_empty()
        || coercion::trim(&field_string(asset, "targetStorage")?).is_empty()
        || coercion::trim(&field_string(asset, "requiredExternalReferenceKind")?).is_empty()
        || coercion::trim(&field_string(asset, "retentionPolicy")?).is_empty()
    {
        blockers.push("repository_asset_storage_policy_incomplete".into());
    }
    let migration = field(asset, "migrationStatus");
    let externalized = migration.and_then(Value::as_str) == Some("externalized");
    let migration_blocker = migration_blocker(migration)?;
    if migration_blocker.is_none() && !externalized {
        blockers.push("repository_asset_migration_status_invalid".into());
    }
    let mut observed = Value::Null;
    let expected = field(asset, "expectedIdentitySha256");
    if let (Some(source), Some(identity)) = (&source, &identity) {
        let source_root = safe_join(root, source);
        let identity_path = safe_join(root, identity);
        if !identity_path.starts_with(&source_root) {
            blockers.push("repository_asset_identity_outside_source".into());
        } else if externalized {
            let restored = field(asset, "externalReference")
                .and_then(|v| v.get("restoreDrillReceipt"))
                .and_then(|v| v.get("restoredIdentitySha256"));
            if is_sha256(&coercion::string_or_empty(restored)?) {
                observed = coercion::clone_raw(restored)?;
            }
            if !coercion::primitive_equal(Some(&observed), expected) {
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
                    let actual = Value::String(sha256(&bytes));
                    if !coercion::primitive_equal(Some(&actual), expected) {
                        blockers.push("repository_asset_identity_hash_mismatch".into());
                    }
                } else {
                    blockers.push("repository_asset_identity_unreadable".into());
                }
            }
        } else {
            // Source and identity metadata are obtained before either type
            // check, matching the incumbent's single try/catch ordering.
            match fs::symlink_metadata(&source_root)
                .and_then(|a| fs::symlink_metadata(&identity_path).map(|b| (a, b)))
            {
                Ok((source_stat, identity_stat)) => {
                    if source_stat.file_type().is_symlink() || !source_stat.is_dir() {
                        blockers.push("repository_asset_source_not_regular_directory".into());
                    }
                    if identity_stat.file_type().is_symlink() || !identity_stat.is_file() {
                        blockers.push("repository_asset_identity_not_regular_file".into());
                    } else {
                        match read_file_bounded(&identity_path) {
                            Ok(bytes) => {
                                observed = Value::String(sha256(&bytes));
                                if !coercion::primitive_equal(Some(&observed), expected) {
                                    blockers.push("repository_asset_identity_hash_mismatch".into());
                                }
                            }
                            Err(_) => blockers.push("repository_asset_identity_unreadable".into()),
                        }
                    }
                }
                Err(_) => blockers.push("repository_asset_identity_unreadable".into()),
            }
        }
    }
    if externalized {
        let reference = field(asset, "externalReference");
        let location = reference
            .and_then(|v| v.get("location"))
            .and_then(Value::as_str);
        let valid_reference = coercion::primitive_equal(
            reference.and_then(|v| v.get("kind")),
            field(asset, "requiredExternalReferenceKind"),
        ) && location.is_some_and(|v| {
            !coercion::trim(v).is_empty()
                && v.encode_utf16().count() <= 2048
                && !coercion::has_whitespace(v)
        }) && is_sha256(&coercion::string_or_empty(
            reference.and_then(|v| v.get("digest")),
        )?) && valid_restore_receipt(
            asset,
            reference.and_then(|v| v.get("restoreDrillReceipt")),
        )?;
        if !valid_reference {
            blockers.push("repository_asset_external_reference_incomplete".into());
        }
        if let Some(source) = &source {
            blockers.extend(submodule_binding(root, source, asset)?);
        }
    }
    let integrity_ready = blockers.is_empty();
    Ok(json!({
        "assetId": coercion::raw_or_null(field(asset, "assetId"))?,
        "sourcePath": source, "identityFile": identity,
        "expectedIdentitySha256": coercion::raw_or_null(expected)?,
        "observedIdentitySha256": observed,
        "currentStorage": coercion::raw_or_null(field(asset, "currentStorage"))?,
        "targetStorage": coercion::raw_or_null(field(asset, "targetStorage"))?,
        "migrationStatus": coercion::raw_or_null(migration)?,
        "integrityReady": integrity_ready, "externalized": externalized && integrity_ready,
        "blockers": blockers,
        "externalizationBlockers": migration_blocker.into_iter().map(|v| v.json).collect::<Vec<_>>(),
    }))
}

pub fn inspect_repository_asset_externalization_v1(
    root: &Path,
    manifest: &Value,
) -> Result<Value, RepositoryAssetError> {
    let mut manifest_blockers = Vec::new();
    let assets = manifest.get("assets").and_then(Value::as_array);
    if manifest.get("version").and_then(Value::as_f64) != Some(1.0)
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
    // Set uses primitive SameValueZero and object identity. Each independently
    // parsed JSON member has its own identity, even with equal object bytes.
    let mut ids = std::collections::BTreeSet::new();
    for asset in &inspected {
        if let Some(id) = coercion::primitive_identity(&asset["assetId"])
            && !ids.insert(id)
        {
            manifest_blockers.push("repository_asset_id_duplicate");
            break;
        }
    }
    let mut integrity: Vec<String> = manifest_blockers.iter().map(|v| (*v).to_owned()).collect();
    let mut external = Vec::new();
    for (index, asset) in inspected.iter().enumerate() {
        let id = asset.get("assetId");
        let prefix = if coercion::truthy(id) {
            coercion::string(id)?
        } else {
            "unknown".to_owned()
        };
        for blocker in asset["blockers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            integrity.push(format!("{prefix}:{blocker}"));
        }
        if let Some(blocker) = migration_blocker(
            assets
                .and_then(|v| v.get(index))
                .and_then(|v| field(v, "migrationStatus")),
        )? {
            external.push(format!("{}:{}", coercion::string(id)?, blocker.message));
        }
    }
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
        let asset_id = coercion::clone_raw(field(asset, "assetId"))?;
        let expected = coercion::clone_raw(field(asset, "expectedIdentitySha256"))?;
        Ok::<Value, RepositoryAssetError>(json!({
            "assetId": asset_id,
            "sourcePath": coercion::clone_raw(field(asset, "sourcePath"))?,
            "identityFile": coercion::clone_raw(field(asset, "identityFile"))?,
            "expectedIdentitySha256": expected,
            "targetStorage": coercion::clone_raw(field(asset, "targetStorage"))?,
            "requiredExternalReferenceKind": coercion::clone_raw(field(asset, "requiredExternalReferenceKind"))?,
            "retentionPolicy": coercion::clone_raw(field(asset, "retentionPolicy"))?,
            "externalizationSequence": ["publish-immutable-reference", "verify-reference-digest", "restore-into-fresh-trusted-root", "verify-restored-identity", "issue-content-bound-restore-drill-receipt", "update-manifest-to-externalized", "switch-production-readers", "delete-tracked-payload-in-dedicated-migration"],
            "requiredExternalReference": { "kind": coercion::clone_raw(field(asset, "requiredExternalReferenceKind"))?, "location": null, "digest": null, "restoreDrillReceipt": { "version": 1, "kind": "RepositoryAssetExternalRestoreDrillReceipt", "status": "repository_asset_external_restore_verified", "assetId": asset_id, "externalReferenceDigest": null, "restoredIdentitySha256": expected, "verifiedAt": null, "repositoryAssetExternalRestoreDrillReceiptHash": null } },
        }))
    }).collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "version": 1,
        "kind": "RepositoryAssetExternalizationHandoff",
        "status": if inspection["fullyExternalized"].as_bool().unwrap_or(false) { "repository_assets_already_externalized" } else { "repository_asset_externalization_authority_required" },
        "assets": handoff_assets,
        "currentInspection": inspection,
    }))
}
