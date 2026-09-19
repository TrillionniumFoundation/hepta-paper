//! R runtime source archive CAS verification and offline seed acquisition.

use hepta_legacy_compatibility::production_hash_record_v1;
use nix::fcntl::{RenameFlags, renameat2};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::os::fd::AsFd;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

const SNAPSHOT: &str = "https://packagemanager.posit.co/cran/2024-11-01";

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn blocked(blocker: impl Into<String>) -> Value {
    json!({
        "ready": false,
        "status": "r_runtime_source_cas_blocked",
        "manifestHash": null,
        "packageCount": 0,
        "lockfileHash": null,
        "definitionPaths": [],
        "blockers": [blocker.into()],
    })
}

fn valid_package(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    actual == expected
}

fn valid_sha256(value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str) else {
        return false;
    };
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn read_lock(path: &Path) -> Result<(Vec<Value>, String), String> {
    let bytes =
        fs::read(path).map_err(|error| format!("r_runtime_source_cas_unavailable:{error}"))?;
    let lock: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "r_runtime_source_cas_lock_json_invalid".to_owned())?;
    let packages = lock
        .get("Packages")
        .and_then(Value::as_object)
        .ok_or_else(|| "r_runtime_source_cas_lock_closure_invalid".to_owned())?;
    let mut entries = Vec::new();
    for (name, value) in packages {
        let Some(entry) = value.as_object() else {
            return Err("r_runtime_source_cas_lock_entry_invalid".to_owned());
        };
        let package = entry
            .get("Package")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let version = entry
            .get("Version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if package != name
            || entry.get("Source").and_then(Value::as_str) != Some("Repository")
            || entry.get("Repository").and_then(Value::as_str) != Some("CRAN")
            || !valid_package(package)
            || !valid_version(version)
        {
            return Err("r_runtime_source_cas_lock_entry_invalid".to_owned());
        }
        let file = format!("{package}_{version}.tar.gz");
        entries.push(json!({
            "package": package,
            "version": version,
            "file": file,
            "url": format!("{SNAPSHOT}/src/contrib/{file}"),
        }));
    }
    entries.sort_by(|left, right| {
        left["package"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["package"].as_str().unwrap_or_default())
    });
    if entries.is_empty() {
        return Err("r_runtime_source_cas_lock_closure_invalid".to_owned());
    }
    Ok((entries, digest(&bytes)))
}

fn collect_files(root: &Path, relative: &str, output: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if relative.is_empty() && (name == ".git" || name == ".gitattributes") {
            continue;
        }
        let path = entry.path();
        let child = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("symlink".to_owned());
        }
        if metadata.is_dir() {
            collect_files(&path, &child, output)?;
        } else if metadata.is_file() {
            output.push(child);
        } else {
            return Err("type".to_owned());
        }
    }
    Ok(())
}

fn expected_indexes(packages: &[Value]) -> (String, String) {
    let sums = packages
        .iter()
        .map(|entry| {
            format!(
                "{}  src/contrib/{}",
                entry
                    .get("sha256")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim_start_matches("sha256:"),
                entry
                    .get("file")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut rows = vec!["Package\tVersion\tFile\tURL\tSHA256".to_owned()];
    rows.extend(packages.iter().map(|entry| {
        ["package", "version", "file", "url", "sha256"]
            .into_iter()
            .map(|key| entry.get(key).and_then(Value::as_str).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\t")
    }));
    (format!("{sums}\n"), format!("{}\n", rows.join("\n")))
}

fn manifest_hash(manifest: &Value) -> Option<String> {
    let object = manifest.as_object()?;
    let supplied = object.get("rRuntimeSourceCasManifestHash")?.as_str()?;
    let mut payload = object.clone();
    payload.remove("rRuntimeSourceCasManifestHash");
    let hash =
        production_hash_record_v1("RRuntimeSourceCasManifest", &Value::Object(payload)).ok()?;
    (hash.as_str() == supplied).then(|| supplied.to_owned())
}

/// Verify the exact lock closure and content-addressed source archive set.
pub fn inspect_runtime_source_cas_v1(repository_root: &Path) -> Value {
    let context = repository_root.join("runtime-images/r-scientific");
    let lock_path = context.join("renv.lock");
    let cas = context.join("source-cas");
    let (expected, lockfile_hash) = match read_lock(&lock_path) {
        Ok(value) => value,
        Err(error) => return blocked(error),
    };
    let manifest_bytes = match fs::read(cas.join("manifest.json")) {
        Ok(bytes) => bytes,
        Err(error) => return blocked(format!("r_runtime_source_cas_unavailable:{error}")),
    };
    let manifest: Value = match serde_json::from_slice(&manifest_bytes) {
        Ok(value) => value,
        Err(_) => {
            return blocked(
                "r_runtime_source_cas_unavailable:r_runtime_source_cas_manifest_json_invalid",
            );
        }
    };
    let Some(object) = manifest.as_object() else {
        return blocked("r_runtime_source_cas_manifest_drift");
    };
    let Some(packages) = object.get("packages").and_then(Value::as_array) else {
        return blocked("r_runtime_source_cas_manifest_drift");
    };
    let metadata: Vec<Value> = packages
        .iter()
        .map(|entry| {
            json!({
                "package": entry.get("package").and_then(Value::as_str).unwrap_or_default(),
                "version": entry.get("version").and_then(Value::as_str).unwrap_or_default(),
                "file": entry.get("file").and_then(Value::as_str).unwrap_or_default(),
                "url": entry.get("url").and_then(Value::as_str).unwrap_or_default(),
            })
        })
        .collect();
    let entries_valid = packages.iter().all(|entry| {
        exact_keys(
            entry,
            &["bytes", "file", "package", "sha256", "url", "version"],
        ) && entry
            .get("package")
            .and_then(Value::as_str)
            .is_some_and(valid_package)
            && entry
                .get("version")
                .and_then(Value::as_str)
                .is_some_and(valid_version)
            && entry.get("file").and_then(Value::as_str)
                == Some(&format!(
                    "{}_{}.tar.gz",
                    entry
                        .get("package")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    entry
                        .get("version")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ))
            && entry.get("url").and_then(Value::as_str)
                == Some(&format!(
                    "{SNAPSHOT}/src/contrib/{}",
                    entry
                        .get("file")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ))
            && entry
                .get("bytes")
                .and_then(Value::as_u64)
                .is_some_and(|bytes| bytes >= 100)
            && valid_sha256(entry.get("sha256"))
    });
    let packages_sorted = packages.windows(2).all(|pair| {
        pair[0]
            .get("package")
            .and_then(Value::as_str)
            .unwrap_or_default()
            < pair[1]
                .get("package")
                .and_then(Value::as_str)
                .unwrap_or_default()
    });
    if object.get("version") != Some(&json!(1))
        || object.get("kind").and_then(Value::as_str) != Some("RRuntimeSourceCasManifest")
        || object.get("status").and_then(Value::as_str) != Some("r_runtime_source_cas_complete")
        || object.get("snapshot").and_then(Value::as_str) != Some(SNAPSHOT)
        || object.get("exactLockClosure") != Some(&Value::Bool(true))
        || object.get("allSourceArchivesContentHashed") != Some(&Value::Bool(true))
        || object.get("offlineRestoreRequired") != Some(&Value::Bool(true))
        || object.get("lockfileHash").and_then(Value::as_str) != Some(lockfile_hash.as_str())
        || object.get("packageCount").and_then(Value::as_u64) != Some(expected.len() as u64)
        || metadata != expected
        || !entries_valid
        || !packages_sorted
        || manifest_hash(&manifest).is_none()
    {
        return blocked("r_runtime_source_cas_manifest_drift");
    }
    let mut expected_files = vec![
        "PACKAGES.tsv".to_owned(),
        "SHA256SUMS".to_owned(),
        "manifest.json".to_owned(),
    ];
    expected_files.extend(packages.iter().filter_map(|entry| {
        entry
            .get("file")
            .and_then(Value::as_str)
            .map(|file| format!("src/contrib/{file}"))
    }));
    expected_files.sort();
    let mut actual_files = Vec::new();
    if let Err(error) = collect_files(&cas, "", &mut actual_files) {
        return blocked(format!("r_runtime_source_cas_unavailable:{error}"));
    }
    actual_files.sort();
    if actual_files != expected_files {
        return blocked("r_runtime_source_cas_file_closure_mismatch");
    }
    let (sums, package_index) = expected_indexes(packages);
    if fs::read_to_string(cas.join("SHA256SUMS")).ok().as_deref() != Some(sums.as_str())
        || fs::read_to_string(cas.join("PACKAGES.tsv")).ok().as_deref()
            != Some(package_index.as_str())
    {
        return blocked("r_runtime_source_cas_index_content_mismatch");
    }
    for entry in packages {
        let Some(file) = entry.get("file").and_then(Value::as_str) else {
            return blocked("r_runtime_source_cas_manifest_drift");
        };
        let path = cas.join("src/contrib").join(file);
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => return blocked(format!("r_runtime_source_cas_unavailable:{error}")),
        };
        if bytes.len() != entry.get("bytes").and_then(Value::as_u64).unwrap_or(0) as usize
            || digest(&bytes)
                != entry
                    .get("sha256")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
        {
            return blocked(format!(
                "r_runtime_source_cas_archive_hash_mismatch:{}",
                entry
                    .get("package")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ));
        }
    }
    let manifest_hash = manifest
        .get("rRuntimeSourceCasManifestHash")
        .cloned()
        .unwrap_or(Value::Null);
    let mut definition_paths = vec![
        "source-cas/PACKAGES.tsv".to_owned(),
        "source-cas/SHA256SUMS".to_owned(),
        "source-cas/manifest.json".to_owned(),
    ];
    definition_paths.extend(packages.iter().filter_map(|entry| {
        entry
            .get("file")
            .and_then(Value::as_str)
            .map(|file| format!("source-cas/src/contrib/{file}"))
    }));
    json!({
        "ready": true,
        "status": "r_runtime_source_cas_verified",
        "manifestHash": manifest_hash,
        "packageCount": packages.len(),
        "lockfileHash": lockfile_hash,
        "definitionPaths": definition_paths,
        "blockers": [],
    })
}

const MAX_TAR_LISTING_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DESCRIPTION_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

fn archive_tar_output(
    args: &[&str],
    archive: &Path,
    trailing: Option<&str>,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new("tar");
    command.args(args).arg(archive);
    if let Some(trailing) = trailing {
        command.arg(trailing);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "r_runtime_source_cas_archive_invalid".to_owned())?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("r_runtime_source_cas_archive_invalid".to_owned());
        }
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(limit.saturating_add(1)).read_to_end(&mut bytes);
        let _ = sender.send(result.map(|_| bytes));
    });
    let read = receiver.recv_timeout(Duration::from_secs(60));
    let bytes = match read {
        Ok(Ok(bytes)) => bytes,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            // tar's pipe closes on exit; no background archive work survives.
            let _ = reader.join();
            return Err("r_runtime_source_cas_archive_invalid".to_owned());
        }
    };
    let _ = reader.join();
    if bytes.len() as u64 > limit {
        let _ = child.kill();
        let _ = child.wait();
        return Err("r_runtime_source_cas_archive_invalid".to_owned());
    }
    let status = child
        .wait()
        .map_err(|_| "r_runtime_source_cas_archive_invalid".to_owned())?;
    if !status.success() {
        return Err("r_runtime_source_cas_archive_invalid".to_owned());
    }
    Ok(bytes)
}

fn archive_description_identity(path: &Path) -> Result<(String, String), String> {
    let listing = archive_tar_output(&["-tzf"], path, None, MAX_TAR_LISTING_BYTES)?;
    let listing = String::from_utf8(listing)
        .map_err(|_| "r_runtime_source_cas_archive_invalid".to_owned())?;
    let description = listing
        .lines()
        .map(str::trim_end)
        .find(|entry| {
            entry
                .strip_suffix("/DESCRIPTION")
                .is_some_and(|prefix| !prefix.is_empty() && !prefix.contains('/'))
        })
        .map(str::to_owned)
        .ok_or_else(|| "r_runtime_source_cas_description_missing".to_owned())?;
    let extracted = archive_tar_output(
        &["-xOzf"],
        path,
        Some(description.as_str()),
        MAX_DESCRIPTION_BYTES,
    )
    .map_err(|_| "r_runtime_source_cas_description_invalid".to_owned())?;
    let text = String::from_utf8(extracted)
        .map_err(|_| "r_runtime_source_cas_description_invalid".to_owned())?;
    let field = |name: &str| {
        text.lines().find_map(|line| {
            let value = line.strip_prefix(name)?;
            let mut values = value.split_whitespace();
            let value = values.next()?;
            values.next().is_none().then(|| value.to_owned())
        })
    };
    let package =
        field("Package:").ok_or_else(|| "r_runtime_source_cas_description_invalid".to_owned())?;
    let version =
        field("Version:").ok_or_else(|| "r_runtime_source_cas_description_invalid".to_owned())?;
    Ok((package, version))
}

fn archive_file_name(name: &str) -> bool {
    name.ends_with(".tar.gz") && name.len() > ".tar.gz".len()
}

fn collect_seed_archives(
    root: &Path,
    output: &mut BTreeMap<String, PathBuf>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(root)
        .map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?;
        if metadata.file_type().is_symlink() {
            return Err("r_runtime_source_cas_seed_symlink_invalid".to_owned());
        }
        if metadata.is_dir() {
            collect_seed_archives(&path, output)?;
        } else if metadata.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if archive_file_name(&name) && output.insert(name.clone(), path).is_some() {
                return Err(format!("r_runtime_source_cas_seed_duplicate:{name}"));
            }
        }
    }
    Ok(())
}

fn seed_archives(root: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    let root =
        fs::canonicalize(root).map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?;
    if !fs::symlink_metadata(&root)
        .map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?
        .is_dir()
    {
        return Err("r_runtime_source_cas_seed_unavailable".to_owned());
    }
    let mut output = BTreeMap::new();
    collect_seed_archives(&root, &mut output)?;
    Ok(output)
}

fn random_nonce() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "r_runtime_source_cas_randomness_unavailable".to_owned())?;
    Ok(hex::encode(bytes))
}

fn begin_staging(context: &Path) -> Result<PathBuf, String> {
    for _ in 0..8 {
        let staging = context.join(format!(
            ".source-cas.staging-{}-{}",
            std::process::id(),
            random_nonce()?
        ));
        match fs::DirBuilder::new().mode(0o700).create(&staging) {
            Ok(()) => {
                if fs::create_dir_all(staging.join("src/contrib")).is_err() {
                    let _ = fs::remove_dir_all(&staging);
                    return Err("r_runtime_source_cas_staging_invalid".to_owned());
                }
                return Ok(staging);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("r_runtime_source_cas_staging_invalid".to_owned()),
        }
    }
    Err("r_runtime_source_cas_staging_collision".to_owned())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o444);
    let mut file = options
        .open(path)
        .map_err(|_| "r_runtime_source_cas_staging_write_failed".to_owned())?;
    file.write_all(bytes)
        .map_err(|_| "r_runtime_source_cas_staging_write_failed".to_owned())?;
    file.sync_all()
        .map_err(|_| "r_runtime_source_cas_staging_write_failed".to_owned())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o444))
        .map_err(|_| "r_runtime_source_cas_staging_write_failed".to_owned())?;
    Ok(())
}

fn copy_seed_archive(source: &Path, destination: &Path) -> Result<(), String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits() | nix::fcntl::OFlag::O_NONBLOCK.bits())
        .open(source)
        .map_err(|_| "r_runtime_source_cas_seed_file_invalid".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "r_runtime_source_cas_seed_file_invalid".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("r_runtime_source_cas_seed_file_invalid".to_owned());
    }
    let mut bytes = Vec::new();
    file.take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "r_runtime_source_cas_seed_file_invalid".to_owned())?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("r_runtime_source_cas_seed_file_invalid".to_owned());
    }
    if bytes.len() < 100 {
        return Err("r_runtime_source_cas_archive_bytes_invalid".to_owned());
    }
    write_new_file(destination, &bytes)
}

fn verify_seed_archive(entry: &Value, destination: &Path) -> Result<Value, String> {
    let bytes =
        fs::read(destination).map_err(|_| "r_runtime_source_cas_archive_invalid".to_owned())?;
    if bytes.len() < 100 {
        return Err("archive_too_small".to_owned());
    }
    let (package, version) = archive_description_identity(destination)?;
    if package != entry["package"] || version != entry["version"] {
        return Err("description_identity_mismatch".to_owned());
    }
    let mut object = entry
        .as_object()
        .cloned()
        .ok_or_else(|| "r_runtime_source_cas_lock_entry_invalid".to_owned())?;
    object.insert("bytes".to_owned(), json!(bytes.len()));
    object.insert("sha256".to_owned(), Value::String(digest(&bytes)));
    Ok(Value::Object(object))
}

fn publish_staging(staging: &Path, context: &Path) -> Result<(), String> {
    let parent =
        File::open(context).map_err(|_| "r_runtime_source_cas_publication_failed".to_owned())?;
    let stage_name = staging
        .file_name()
        .ok_or_else(|| "r_runtime_source_cas_publication_failed".to_owned())?;
    for directory in [
        staging.join("src/contrib"),
        staging.join("src"),
        staging.to_path_buf(),
    ] {
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755))
            .map_err(|_| "r_runtime_source_cas_publication_failed".to_owned())?;
        File::open(&directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "r_runtime_source_cas_publication_failed".to_owned())?;
    }
    renameat2(
        parent.as_fd(),
        stage_name,
        parent.as_fd(),
        Path::new("source-cas"),
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|_| "r_runtime_source_cas_existing_invalid".to_owned())?;
    parent
        .sync_all()
        .map_err(|_| "r_runtime_source_cas_publication_failed".to_owned())
}

/// Acquire the R source CAS exclusively from a caller-selected read-only seed.
///
/// This is deliberately offline: it performs no network transport and never
/// treats caller-supplied hashes or manifests as authority. Every archive is
/// copied to private staging, checked for its tar DESCRIPTION identity and
/// content hash, then published with Linux `RENAME_NOREPLACE`.
pub fn acquire_runtime_source_cas_from_seed_v1(
    repository_root: &Path,
    seed_source_directory: &Path,
) -> Result<Value, String> {
    let context = fs::canonicalize(repository_root.join("runtime-images/r-scientific"))
        .map_err(|_| "r_runtime_source_cas_unavailable".to_owned())?;
    let current = inspect_runtime_source_cas_v1(repository_root);
    if current["ready"] == Value::Bool(true) {
        let mut report = current;
        report["acquired"] = Value::Bool(false);
        return Ok(report);
    }
    let destination = context.join("source-cas");
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("r_runtime_source_cas_existing_invalid".to_owned());
    }
    let (expected, lockfile_hash) = read_lock(&context.join("renv.lock"))?;
    let seeds = seed_archives(seed_source_directory)?;
    let staging = begin_staging(&context)?;
    let staging_identity = fs::symlink_metadata(&staging)
        .map_err(|_| "r_runtime_source_cas_staging_invalid".to_owned())?;
    let result = (|| {
        let mut packages = Vec::with_capacity(expected.len());
        for entry in &expected {
            let file = entry["file"]
                .as_str()
                .ok_or_else(|| "r_runtime_source_cas_lock_entry_invalid".to_owned())?;
            let source = seeds
                .get(file)
                .ok_or_else(|| format!("r_runtime_source_cas_seed_missing:{file}"))?;
            let target = staging.join("src/contrib").join(file);
            copy_seed_archive(source, &target)?;
            packages.push(verify_seed_archive(entry, &target)?);
        }
        let (sums, package_index) = expected_indexes(&packages);
        write_new_file(&staging.join("SHA256SUMS"), sums.as_bytes())?;
        write_new_file(&staging.join("PACKAGES.tsv"), package_index.as_bytes())?;
        let payload = json!({
            "version": 1,
            "kind": "RRuntimeSourceCasManifest",
            "status": "r_runtime_source_cas_complete",
            "snapshot": SNAPSHOT,
            "lockfileHash": lockfile_hash,
            "packageCount": packages.len(),
            "packages": packages,
            "exactLockClosure": true,
            "allSourceArchivesContentHashed": true,
            "offlineRestoreRequired": true,
        });
        let manifest_hash = production_hash_record_v1("RRuntimeSourceCasManifest", &payload)
            .map_err(|_| "r_runtime_source_cas_manifest_hash_failed".to_owned())?;
        let mut manifest = payload
            .as_object()
            .cloned()
            .ok_or_else(|| "r_runtime_source_cas_manifest_hash_failed".to_owned())?;
        manifest.insert(
            "rRuntimeSourceCasManifestHash".to_owned(),
            Value::String(manifest_hash.as_str().to_owned()),
        );
        let mut manifest_bytes = serde_json::to_vec_pretty(&Value::Object(manifest))
            .map_err(|_| "r_runtime_source_cas_manifest_write_failed".to_owned())?;
        manifest_bytes.push(b'\n');
        write_new_file(&staging.join("manifest.json"), &manifest_bytes)?;
        publish_staging(&staging, &context)?;
        let verified = inspect_runtime_source_cas_v1(repository_root);
        if verified["ready"] != Value::Bool(true) {
            if fs::symlink_metadata(&destination).is_ok_and(|current| {
                current.is_dir()
                    && current.dev() == staging_identity.dev()
                    && current.ino() == staging_identity.ino()
            }) {
                let _ = fs::remove_dir_all(&destination);
            }
            return Err(format!(
                "r_runtime_source_cas_post_publish_invalid:{}",
                verified["blockers"]
                    .as_array()
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default()
            ));
        }
        let mut report = verified;
        report["acquired"] = Value::Bool(true);
        Ok(report)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}
