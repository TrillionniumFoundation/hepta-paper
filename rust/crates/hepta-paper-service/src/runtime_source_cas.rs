//! Read-only verification of the R runtime source archive CAS.

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

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
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
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
