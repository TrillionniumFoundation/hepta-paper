//! R runtime source archive CAS verification and offline seed acquisition.
//!
//! The existing publisher uses one nonblocking parent-directory lock. A new
//! acquisition checks the original stage and lockfile before no-replace rename.
//! Rename is a one-way publication boundary: errors never remove published
//! archives. A valid retry verifies that exact set and synchronizes directories
//! without reading seeds, invoking tar, overwriting files or minting authority.
//! Unpublished crash residue is retained; another invocation may rebuild a new
//! private stage but never adopts or removes that orphan. This is a cooperative
//! local filesystem contract, not installed qualification or hostile-UID isolation.
//! Tar listing and DESCRIPTION use the existing bounded process-group owner,
//! not a second supervisor. Full stdout capture retains the existing 16 MiB /
//! 4 MiB caps independently of bounded log tails. Children receive only fixed
//! PATH/LC_ALL; stdin is closed, stderr is capped at 64 KiB and the 60-second
//! deadline remains active after stdout EOF. Archive member names follow `--`,
//! never becoming options. Both listing and extraction preserve cancellation,
//! timeout and unknown-cleanup diagnostics. CLI cancellation is checked before
//! work, throughout a bounded seed walk, between archives and at publication
//! boundaries. Seed discovery allows at most 16,384 aggregate directory entries
//! and 64 nested directory levels before staging; larger seeds are explicit
//! native profile refusals, not universal Node compatibility claims. Failed group/pipe
//! cleanup retains the original unpublished stage rather than deleting live
//! inputs. This is not kernel-I/O preemption or containment of escaped sessions.
//! Explicit --snapshot acquisition adds sequential HTTPS GETs for missing CAS
//! roots through this SAME archive/process/publication owner. --seed remains
//! strictly offline; there is no partial-seed network fallback. Snapshot URLs
//! are derived solely from validated lock entries at the fixed original origin.
//! Redirects, non-2xx responses and mismatched effective URLs fail closed. The
//! curl process gets no inherited proxy, credentials, CA override or curlrc;
//! system TLS verification is not disabled. Downloads have a 120-second bound
//! and a 63 MiB archive ceiling within the unchanged process capture limit.
//! Successful replay does not resolve curl/tar or perform another GET. Neither
//! transport nor an offline seed verifies publisher provenance or grants runtime,
//! release or submission authority. Tool/CA identity qualification, concurrent
//! downloads, mixed seed/network acquisition and orphan disposal remain open. The command's actual recovery and Node
//! comparisons are in `tests/runtime_r_source_cas_seed.rs`; syscall/crash owners
//! are the private unit tests, not an alternative execution implementation.
//!
//! Status, initial lock reads and acquisition replay use one descriptor-pinned,
//! nonblocking observer. Documents are limited to 16 MiB, an archive to 256 MiB,
//! and each complete observation/publication to 1 GiB including lock and indexes.
//! Archive hashes stream through a 64 KiB buffer. FIFO/special files, child links,
//! hardlinked files, oversized/sparse inputs and namespace/content drift refuse
//! readiness without changing the source. Only the explicitly selected root may
//! resolve an alias; all child components use retained directory descriptors.
//! Metadata/namespace/cancellation are checked after hashes and before readiness.
//! Staged archives remain pinned across tar and across later package checks;
//! all generated indexes and the complete staged namespace are rechecked before
//! the existing publisher's no-replace rename. A post-rename failure still keeps
//! published bytes. These observations are not filesystem snapshots, hostile
//! same-UID exclusion, kernel-I/O preemption or publisher/installation authority.

use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use nix::fcntl::{Flock, FlockArg, OFlag, RenameFlags, renameat2};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::os::fd::AsFd;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

mod archive_process;
mod mixed_acquisition;
pub(crate) mod observation;
pub(crate) mod ordinary_status;
use archive_process::{ArchiveExecution, require_active};
use observation::{MAX_DOCUMENT_BYTES, ObservationBudget, SourceObservation};

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

fn parse_lock(bytes: &[u8]) -> Result<(Vec<Value>, String), String> {
    let lock: Value = serde_json::from_slice(bytes)
        .map_err(|_| "r_runtime_source_cas_lock_json_invalid".to_owned())?;
    let packages = lock
        .get("Packages")
        .and_then(Value::as_object)
        .ok_or_else(|| "r_runtime_source_cas_lock_closure_invalid".to_owned())?;
    if packages.len() > MAX_SEED_ENTRIES - 5 {
        return Err("r_runtime_source_cas_observation_limit_exceeded".to_owned());
    }
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
    let collator = ProductionCollationV1::load()
        .map_err(|_| "r_runtime_source_cas_collation_unavailable".to_owned())?;
    entries.sort_by(|left, right| {
        collator.compare(
            left["package"].as_str().unwrap_or_default(),
            right["package"].as_str().unwrap_or_default(),
        )
    });
    if entries.is_empty() {
        return Err("r_runtime_source_cas_lock_closure_invalid".to_owned());
    }
    Ok((entries, digest(bytes)))
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

fn expected_cas_files(packages: &[Value]) -> Vec<String> {
    let mut files = vec![
        "PACKAGES.tsv".to_owned(),
        "SHA256SUMS".to_owned(),
        "manifest.json".to_owned(),
    ];
    files.extend(packages.iter().filter_map(|entry| {
        entry
            .get("file")
            .and_then(Value::as_str)
            .map(|file| format!("src/contrib/{file}"))
    }));
    files.sort();
    files
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
    inspect_runtime_source_cas_with_cancellation_v1(repository_root, &AtomicBool::new(false))
}

/// The same read-only status owner is used by the ordinary CLI and acquisition
/// replay. Cancellation, input bounds and source drift cannot become readiness.
pub fn inspect_runtime_source_cas_with_cancellation_v1(
    repository_root: &Path,
    cancelled: &AtomicBool,
) -> Value {
    inspect_with_checkpoint(repository_root, cancelled, &mut || {})
}

fn inspect_with_checkpoint(
    repository_root: &Path,
    cancelled: &AtomicBool,
    checkpoint: &mut impl FnMut(),
) -> Value {
    inspect_with_optional_deadline(repository_root, cancelled, None, checkpoint)
}

pub(crate) fn inspect_runtime_source_cas_with_deadline_v1(
    repository_root: &Path,
    cancelled: &AtomicBool,
    deadline: std::time::Instant,
) -> Value {
    inspect_with_optional_deadline(repository_root, cancelled, Some(deadline), &mut || {})
}

fn inspect_with_optional_deadline(
    repository_root: &Path,
    cancelled: &AtomicBool,
    deadline: Option<std::time::Instant>,
    checkpoint: &mut impl FnMut(),
) -> Value {
    let result = (|| -> Result<Value, String> {
        let context = repository_root.join("runtime-images/r-scientific");
        let mut observed = match deadline {
            Some(deadline) => SourceObservation::new_with_deadline(&context, cancelled, deadline)?,
            None => SourceObservation::new(&context, cancelled)?,
        };
        inspect_observed_status_v1(&mut observed, checkpoint, false)
    })();
    result.unwrap_or_else(blocked)
}

// Both original standalone status and the ordinary retained adapter execute
// this one validator. The ordinary branch only preserves original diagnostics;
// it never relaxes the descriptor, archive, namespace or input budgets.
fn inspect_observed_status_v1(
    observed: &mut SourceObservation<'_>,
    checkpoint: &mut impl FnMut(),
    ordinary: bool,
) -> Result<Value, String> {
    let lock = if ordinary {
        observed.status_document_v1(Path::new("renv.lock"))?
    } else {
        observed.document(Path::new("renv.lock"))?
    };
    let (expected, lockfile_hash) = parse_lock(&lock).map_err(|error| {
        if ordinary
            && matches!(
                error.as_str(),
                "r_runtime_source_cas_lock_json_invalid"
                    | "r_runtime_source_cas_lock_entry_invalid"
                    | "r_runtime_source_cas_lock_closure_invalid"
            )
        {
            format!("r_runtime_source_cas_unavailable:{error}")
        } else {
            error
        }
    })?;
    let manifest_bytes = if ordinary {
        observed.status_document_v1(Path::new("source-cas/manifest.json"))?
    } else {
        observed.document(Path::new("source-cas/manifest.json"))?
    };
    let manifest: Value = match serde_json::from_slice(&manifest_bytes) {
        Ok(value) => value,
        Err(_) => {
            return Ok(blocked(
                "r_runtime_source_cas_unavailable:r_runtime_source_cas_manifest_json_invalid",
            ));
        }
    };
    let Some(object) = manifest.as_object() else {
        return Ok(blocked("r_runtime_source_cas_manifest_drift"));
    };
    let Some(packages) = object.get("packages").and_then(Value::as_array) else {
        return Ok(blocked("r_runtime_source_cas_manifest_drift"));
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
    let collator = ProductionCollationV1::load()
        .map_err(|_| "r_runtime_source_cas_collation_unavailable".to_owned())?;
    let packages_sorted = packages.windows(2).all(|pair| {
        collator.compare(
            pair[0]
                .get("package")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            pair[1]
                .get("package")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) == std::cmp::Ordering::Less
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
        return Ok(blocked("r_runtime_source_cas_manifest_drift"));
    }
    let expected_files = expected_cas_files(packages);
    let mut actual_files = observed.files(Path::new("source-cas"))?;
    actual_files.sort();
    if actual_files != expected_files {
        return Ok(blocked("r_runtime_source_cas_file_closure_mismatch"));
    }
    let (sums, package_index) = expected_indexes(packages);
    let mut read_index = |relative: &Path| {
        if ordinary {
            observed.status_document_v1(relative)
        } else {
            observed.document(relative)
        }
    };
    if read_index(Path::new("source-cas/SHA256SUMS"))? != sums.as_bytes()
        || read_index(Path::new("source-cas/PACKAGES.tsv"))? != package_index.as_bytes()
    {
        return Ok(blocked("r_runtime_source_cas_index_content_mismatch"));
    }
    for entry in packages {
        let Some(file) = entry.get("file").and_then(Value::as_str) else {
            return Ok(blocked("r_runtime_source_cas_manifest_drift"));
        };
        let relative = Path::new("source-cas/src/contrib").join(file);
        let (actual_hash, actual_bytes) = if ordinary {
            observed.status_archive_v1(&relative, MAX_ARCHIVE_BYTES)?
        } else {
            observed.archive(&relative, MAX_ARCHIVE_BYTES)?
        };
        if actual_bytes != entry.get("bytes").and_then(Value::as_u64).unwrap_or(0)
            || actual_hash
                != entry
                    .get("sha256")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
        {
            return Ok(blocked(format!(
                "r_runtime_source_cas_archive_hash_mismatch:{}",
                entry
                    .get("package")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )));
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
    checkpoint();
    observed.assert_current()?;
    Ok(json!({
        "ready": true,
        "status": "r_runtime_source_cas_verified",
        "manifestHash": manifest_hash,
        "packageCount": packages.len(),
        "lockfileHash": lockfile_hash,
        "definitionPaths": definition_paths,
        "blockers": [],
    }))
}

const MAX_TAR_LISTING_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DESCRIPTION_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
// One aggregate bound covers directories and irrelevant files too. Limiting
// only matching archives would still admit an unbounded pre-dispatch walk.
const MAX_SEED_ENTRIES: usize = 16_384;
const MAX_SEED_DEPTH: usize = 64;

fn archive_description_identity(
    path: &Path,
    execution: &mut ArchiveExecution<'_>,
) -> Result<(String, String), String> {
    let listing = execution.output(&["-tzf"], path, None, MAX_TAR_LISTING_BYTES)?;
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
    let extracted = execution
        .output(
            &["-xOzf"],
            path,
            Some(description.as_str()),
            MAX_DESCRIPTION_BYTES,
        )
        .map_err(|error| {
            if matches!(
                error.as_str(),
                "r_runtime_source_cas_cancelled"
                    | "r_runtime_source_cas_archive_timeout"
                    | "r_runtime_source_cas_archive_cleanup_unverified"
            ) {
                error
            } else {
                "r_runtime_source_cas_description_invalid".to_owned()
            }
        })?;
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
    active: &mut dyn FnMut() -> Result<(), String>,
    remaining_entries: &mut usize,
    depth: usize,
) -> Result<(), String> {
    active()?;
    if depth > MAX_SEED_DEPTH {
        return Err("r_runtime_source_cas_seed_depth_exceeded".to_owned());
    }
    let directory =
        fs::read_dir(root).map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?;
    let mut entries = Vec::new();
    for entry in directory {
        active()?;
        // Check before retaining another entry, not after an unbounded collect.
        *remaining_entries = remaining_entries
            .checked_sub(1)
            .ok_or_else(|| "r_runtime_source_cas_seed_entry_limit_exceeded".to_owned())?;
        entries.push(entry.map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?);
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        active()?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?;
        if metadata.file_type().is_symlink() {
            return Err("r_runtime_source_cas_seed_symlink_invalid".to_owned());
        }
        if metadata.is_dir() {
            collect_seed_archives(&path, output, active, remaining_entries, depth + 1)?;
        } else if metadata.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if archive_file_name(&name) && output.insert(name.clone(), path).is_some() {
                return Err(format!("r_runtime_source_cas_seed_duplicate:{name}"));
            }
        }
    }
    active()
}

fn seed_archives(root: &Path, cancelled: &AtomicBool) -> Result<BTreeMap<String, PathBuf>, String> {
    require_active(cancelled)?;
    let root =
        fs::canonicalize(root).map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?;
    if !fs::symlink_metadata(&root)
        .map_err(|_| "r_runtime_source_cas_seed_unavailable".to_owned())?
        .is_dir()
    {
        return Err("r_runtime_source_cas_seed_unavailable".to_owned());
    }
    let mut output = BTreeMap::new();
    let mut remaining_entries = MAX_SEED_ENTRIES;
    collect_seed_archives(
        &root,
        &mut output,
        &mut || require_active(cancelled),
        &mut remaining_entries,
        0,
    )?;
    require_active(cancelled)?;
    Ok(output)
}

fn seed_archives_with_deadline(
    root: &Path,
    cancelled: &AtomicBool,
    deadline: std::time::Instant,
) -> Result<BTreeMap<String, PathBuf>, String> {
    require_acquisition_active(cancelled, Some(deadline))?;
    let root = fs::canonicalize(root).map_err(|_| "r_runtime_source_cas_seed_unavailable")?;
    let mut output = BTreeMap::new();
    let mut remaining = MAX_SEED_ENTRIES;
    collect_seed_archives(
        &root,
        &mut output,
        &mut || require_acquisition_active(cancelled, Some(deadline)),
        &mut remaining,
        0,
    )?;
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

// The controlled path retains this same seed-copy owner while bounding before
// allocation and rechecking named/held identity across the cooperative stream.
fn copy_seed_archive_with_control(
    source: &Path,
    destination: &Path,
    cancelled: &AtomicBool,
    deadline: std::time::Instant,
    expected: u64,
) -> Result<(), String> {
    use std::os::unix::fs::FileExt;
    require_acquisition_active(cancelled, Some(deadline))?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC).bits())
        .open(source)
        .map_err(|_| "r_runtime_source_cas_seed_file_invalid")?;
    let before = file
        .metadata()
        .map_err(|_| "r_runtime_source_cas_seed_file_invalid")?;
    let same = |a: &std::fs::Metadata, b: &std::fs::Metadata| {
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.mode() == b.mode()
            && a.uid() == b.uid()
            && a.gid() == b.gid()
            && a.nlink() == b.nlink()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    };
    if !before.is_file()
        || before.nlink() != 1
        || before.len() != expected
        || !(100..=MAX_ARCHIVE_BYTES).contains(&expected)
        || !same(
            &before,
            &fs::symlink_metadata(source).map_err(|_| "r_runtime_source_cas_seed_file_invalid")?,
        )
    {
        return Err("r_runtime_source_cas_seed_file_invalid".into());
    }
    let length = usize::try_from(expected).map_err(|_| "r_runtime_source_cas_seed_file_invalid")?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| "r_runtime_source_cas_observation_limit_exceeded")?;
    let mut buffer = [0u8; 64 * 1024];
    let mut offset = 0;
    while offset < expected {
        require_acquisition_active(cancelled, Some(deadline))?;
        let available = usize::try_from((expected - offset).min(buffer.len() as u64))
            .map_err(|_| "r_runtime_source_cas_seed_file_invalid")?;
        let count = file
            .read_at(&mut buffer[..available], offset)
            .map_err(|_| "r_runtime_source_cas_seed_file_invalid")?;
        if count == 0 {
            return Err("r_runtime_source_cas_seed_file_invalid".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        offset += count as u64;
    }
    require_acquisition_active(cancelled, Some(deadline))?;
    if !same(
        &before,
        &file
            .metadata()
            .map_err(|_| "r_runtime_source_cas_seed_file_invalid")?,
    ) || !same(
        &before,
        &fs::symlink_metadata(source).map_err(|_| "r_runtime_source_cas_seed_file_invalid")?,
    ) {
        return Err("r_runtime_source_cas_seed_file_invalid".into());
    }
    write_new_file(destination, &bytes)
}

fn verify_seed_archive(
    entry: &Value,
    destination: &Path,
    execution: &mut ArchiveExecution<'_>,
    observed: &mut SourceObservation<'_>,
) -> Result<Value, String> {
    let file = entry["file"]
        .as_str()
        .ok_or("r_runtime_source_cas_lock_entry_invalid")?;
    let (archive_hash, archive_bytes) =
        observed.archive(&Path::new("src/contrib").join(file), MAX_ARCHIVE_BYTES)?;
    if archive_bytes < 100 {
        return Err("archive_too_small".to_owned());
    }
    let (package, version) = archive_description_identity(destination, execution)?;
    // The tool's output cannot rebind the bytes we actually hashed. Retain all
    // prior archive identities until the original publisher's pre-rename check.
    observed.assert_current()?;
    if package != entry["package"] || version != entry["version"] {
        return Err("description_identity_mismatch".to_owned());
    }
    let mut object = entry
        .as_object()
        .cloned()
        .ok_or_else(|| "r_runtime_source_cas_lock_entry_invalid".to_owned())?;
    object.insert("bytes".to_owned(), json!(archive_bytes));
    object.insert("sha256".to_owned(), Value::String(archive_hash));
    Ok(Value::Object(object))
}

fn open_directory(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC).bits())
        .open(path)
        .map_err(|_| "r_runtime_source_cas_directory_invalid".to_owned())
}

fn retains_directory(path: &Path, retained: &File) -> bool {
    let Ok(opened) = retained.metadata() else {
        return false;
    };
    fs::symlink_metadata(path).is_ok_and(|named| {
        named.is_dir()
            && opened.is_dir()
            && named.dev() == opened.dev()
            && named.ino() == opened.ino()
            && named.uid() == opened.uid()
            && named.gid() == opened.gid()
            && named.mode() == opened.mode()
    })
}

fn require_parent(context: &Path, parent: &File) -> Result<(), String> {
    if !retains_directory(context, parent) {
        return Err("r_runtime_source_cas_parent_changed".to_owned());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicationBoundary {
    BeforePublish,
    AfterRename,
    AfterDirectorySync,
}

fn publish_staging(
    staging: &Path,
    context: &Path,
    parent: &File,
    stage: &File,
    publication_attempted: &mut bool,
    observe: &mut impl FnMut(PublicationBoundary, &Path) -> Result<(), String>,
) -> Result<(), String> {
    require_parent(context, parent)?;
    if !retains_directory(staging, stage) {
        return Err("r_runtime_source_cas_staging_changed".to_owned());
    }
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
    require_parent(context, parent)?;
    if !retains_directory(staging, stage) {
        return Err("r_runtime_source_cas_staging_changed".to_owned());
    }
    // After attempting the publication syscall, an error or subsequent path
    // movement is not permission to treat these bytes as unpublished garbage.
    *publication_attempted = true;
    renameat2(
        parent.as_fd(),
        stage_name,
        parent.as_fd(),
        Path::new("source-cas"),
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|_| "r_runtime_source_cas_existing_invalid".to_owned())?;
    observe(PublicationBoundary::AfterRename, staging)?;
    parent
        .sync_all()
        .map_err(|_| "r_runtime_source_cas_publication_failed".to_owned())?;
    observe(PublicationBoundary::AfterDirectorySync, staging)
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
    acquire_with_observation(repository_root, seed_source_directory, &mut |_, _| Ok(()))
}

/// Ordinary CLI cancellation shares the same archive and publication owner.
pub fn acquire_runtime_source_cas_from_seed_with_cancellation_v1(
    repository_root: &Path,
    seed_source_directory: &Path,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    acquire_with_controls(
        repository_root,
        seed_source_directory,
        cancelled,
        &mut |_, _| Ok(()),
    )
}

// Internal fault observations exercise this same publisher, not another owner.
fn acquire_with_observation(
    repository_root: &Path,
    seed_source_directory: &Path,
    observe: &mut impl FnMut(PublicationBoundary, &Path) -> Result<(), String>,
) -> Result<Value, String> {
    acquire_with_controls(
        repository_root,
        seed_source_directory,
        &AtomicBool::new(false),
        observe,
    )
}

#[derive(Clone, Copy)]
enum AcquisitionSource<'a> {
    Seed(&'a Path),
    FixedSnapshot,
    MixedSnapshot {
        seed: Option<&'a Path>,
        concurrency: usize,
        deadline: std::time::Instant,
    },
}

/// Normal acquisition reuses this locked publisher with the original mixed
/// seed/fixed-origin behavior. Controls do not grant publisher/runtime authority.
pub fn acquire_runtime_source_cas_mixed_with_control_v1(
    repository_root: &Path,
    seed: Option<&Path>,
    concurrency: usize,
    cancelled: &AtomicBool,
    deadline: std::time::Instant,
) -> Result<Value, String> {
    if !(1..=16).contains(&concurrency) {
        return Err("r_runtime_source_cas_concurrency_invalid".into());
    }
    acquire_from_source_with_controls(
        repository_root,
        AcquisitionSource::MixedSnapshot {
            seed,
            concurrency,
            deadline,
        },
        cancelled,
        &mut |_, _| Ok(()),
    )
}

fn require_acquisition_active(
    cancelled: &AtomicBool,
    deadline: Option<std::time::Instant>,
) -> Result<(), String> {
    require_active(cancelled)?;
    if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
        return Err("r_runtime_source_cas_deadline_exceeded".into());
    }
    Ok(())
}
fn acquisition_observation<'a>(
    context: &Path,
    cancelled: &'a AtomicBool,
    deadline: Option<std::time::Instant>,
) -> Result<SourceObservation<'a>, String> {
    match deadline {
        Some(deadline) => SourceObservation::new_with_deadline(context, cancelled, deadline),
        None => SourceObservation::new(context, cancelled),
    }
}
fn acquisition_status(
    root: &Path,
    cancelled: &AtomicBool,
    deadline: Option<std::time::Instant>,
) -> Result<Value, String> {
    match deadline {
        None => Ok(inspect_runtime_source_cas_with_cancellation_v1(
            root, cancelled,
        )),
        Some(deadline) => {
            let observed = ordinary_status::inspect_retained_status_v1(root, cancelled, deadline)?;
            observed.assert_current()?;
            Ok(observed.report)
        }
    }
}

/// Explicit fixed-snapshot HTTPS acquisition through the SAME locked publisher.
/// Existing valid CAS replay remains offline; this never changes the lockfile,
/// follows redirects, runs Node, installs R packages or grants runtime authority.
pub fn acquire_runtime_source_cas_from_snapshot_with_cancellation_v1(
    repository_root: &Path,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    acquire_from_source_with_controls(
        repository_root,
        AcquisitionSource::FixedSnapshot,
        cancelled,
        &mut |_, _| Ok(()),
    )
}

fn acquire_with_controls(
    repository_root: &Path,
    seed_source_directory: &Path,
    cancelled: &AtomicBool,
    observe: &mut impl FnMut(PublicationBoundary, &Path) -> Result<(), String>,
) -> Result<Value, String> {
    acquire_from_source_with_controls(
        repository_root,
        AcquisitionSource::Seed(seed_source_directory),
        cancelled,
        observe,
    )
}

fn acquire_from_source_with_controls(
    repository_root: &Path,
    source: AcquisitionSource<'_>,
    cancelled: &AtomicBool,
    observe: &mut impl FnMut(PublicationBoundary, &Path) -> Result<(), String>,
) -> Result<Value, String> {
    let deadline = match source {
        AcquisitionSource::MixedSnapshot { deadline, .. } => Some(deadline),
        _ => None,
    };
    require_acquisition_active(cancelled, deadline)?;
    let mut observe = |boundary, path: &Path| {
        observe(boundary, path)?;
        require_acquisition_active(cancelled, deadline)
    };
    let context = fs::canonicalize(repository_root.join("runtime-images/r-scientific"))
        .map_err(|_| "r_runtime_source_cas_unavailable".to_owned())?;
    let parent = open_directory(&context)?;
    // One advisory lock on the existing directory; no second journal, writer
    // database or installation authority is created. Process death releases it.
    let _lock = Flock::lock(
        parent
            .try_clone()
            .map_err(|_| "r_runtime_source_cas_directory_invalid".to_owned())?,
        FlockArg::LockExclusiveNonblock,
    )
    .map_err(|_| "r_runtime_source_cas_owner_busy".to_owned())?;
    require_parent(&context, &parent)?;
    let destination = context.join("source-cas");
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.is_dir() => {
            let installed = open_directory(&destination)?;
            let current = acquisition_status(repository_root, cancelled, deadline)?;
            require_acquisition_active(cancelled, deadline)?;
            if current["ready"] != Value::Bool(true) || !retains_directory(&destination, &installed)
            {
                return Err("r_runtime_source_cas_existing_invalid".to_owned());
            }
            // A previous process may have died after rename but before parent
            // fsync. Complete that barrier; never recopy, delete or republish.
            installed
                .sync_all()
                .and_then(|()| parent.sync_all())
                .map_err(|_| "r_runtime_source_cas_publication_failed".to_owned())?;
            require_parent(&context, &parent)?;
            if !retains_directory(&destination, &installed) {
                return Err("r_runtime_source_cas_existing_invalid".to_owned());
            }
            let mut report = current;
            report["acquired"] = Value::Bool(false);
            return Ok(report);
        }
        Ok(_) => return Err("r_runtime_source_cas_existing_invalid".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("r_runtime_source_cas_existing_invalid".to_owned()),
    }
    let mut input_observation = acquisition_observation(&context, cancelled, deadline)?;
    let lock_bytes = input_observation.document(Path::new("renv.lock"))?;
    let (expected, lockfile_hash) = parse_lock(&lock_bytes)?;
    let seeds = match source {
        AcquisitionSource::Seed(directory) => Some(seed_archives(directory, cancelled)?),
        AcquisitionSource::FixedSnapshot => None,
        AcquisitionSource::MixedSnapshot { seed, .. } => match seed {
            Some(directory) => Some(seed_archives_with_deadline(
                directory,
                cancelled,
                deadline.ok_or("r_runtime_source_cas_deadline_invalid")?,
            )?),
            None => None,
        },
    };
    require_acquisition_active(cancelled, deadline)?;
    let staging = begin_staging(&context)?;
    let stage = open_directory(&staging)?;
    let mut publication_attempted = false;
    let mut execution = match deadline {
        Some(deadline) => ArchiveExecution::new_with_deadline(cancelled, deadline),
        None => ArchiveExecution::new(cancelled),
    };
    let mut mixed_observations = Vec::new();
    let mut mixed_owned_archives = Vec::new();
    let mut mixed_publication_started = false;
    let result = (|| {
        let mut staged_observation = acquisition_observation(&staging, cancelled, deadline)?;
        let mut budget = ObservationBudget::default();
        budget.account(lock_bytes.len() as u64, MAX_DOCUMENT_BYTES)?;
        let mut packages = Vec::with_capacity(expected.len());
        if let AcquisitionSource::MixedSnapshot {
            concurrency,
            deadline,
            ..
        } = source
        {
            let outcome = mixed_acquisition::acquire(
                &expected,
                &staging,
                seeds.as_ref(),
                concurrency,
                cancelled,
                deadline,
                lock_bytes.len() as u64,
            );
            if !outcome.cleanup_verified {
                execution.retain_unknown_cleanup();
            }
            mixed_observations = outcome.retained;
            mixed_owned_archives = outcome.owned_archives;
            let ordered = outcome.result?;
            for package in ordered {
                budget.account(
                    package["bytes"]
                        .as_u64()
                        .ok_or("r_runtime_source_cas_archive_invalid")?,
                    MAX_ARCHIVE_BYTES,
                )?;
                packages.push(package);
            }
        } else {
            for entry in &expected {
                require_acquisition_active(cancelled, deadline)?;
                let file = entry["file"]
                    .as_str()
                    .ok_or_else(|| "r_runtime_source_cas_lock_entry_invalid".to_owned())?;
                let target = staging.join("src/contrib").join(file);
                if let Some(seeds) = &seeds {
                    let source = seeds
                        .get(file)
                        .ok_or_else(|| format!("r_runtime_source_cas_seed_missing:{file}"))?;
                    copy_seed_archive(source, &target)?;
                } else {
                    let bytes = execution.snapshot_archive(entry, &target)?;
                    require_acquisition_active(cancelled, deadline)?;
                    write_new_file(&target, &bytes)?;
                }
                let package =
                    verify_seed_archive(entry, &target, &mut execution, &mut staged_observation)?;
                budget.account(
                    package["bytes"]
                        .as_u64()
                        .ok_or_else(|| "r_runtime_source_cas_archive_invalid".to_owned())?,
                    MAX_ARCHIVE_BYTES,
                )?;
                packages.push(package);
            }
        }
        mixed_publication_started = deadline.is_some();
        let (sums, package_index) = expected_indexes(&packages);
        budget.account(sums.len() as u64, MAX_DOCUMENT_BYTES)?;
        budget.account(package_index.len() as u64, MAX_DOCUMENT_BYTES)?;
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
        let manifest_value = Value::Object(manifest);
        let manifest_bytes = if let Some(deadline) = deadline {
            mixed_acquisition::encode_manifest(&manifest_value, cancelled, deadline)?
        } else {
            let mut bytes = serde_json::to_vec_pretty(&manifest_value)
                .map_err(|_| "r_runtime_source_cas_manifest_write_failed".to_owned())?;
            bytes.push(b'\n');
            bytes
        };
        budget.account(manifest_bytes.len() as u64, MAX_DOCUMENT_BYTES)?;
        write_new_file(&staging.join("manifest.json"), &manifest_bytes)?;
        // Fresh publication and later status consume the same bounded pinned
        // byte/namespace observer, not independently drifting validation rules.
        for (name, bytes) in [
            ("SHA256SUMS", sums.as_bytes()),
            ("PACKAGES.tsv", package_index.as_bytes()),
            ("manifest.json", manifest_bytes.as_slice()),
        ] {
            if staged_observation.document(Path::new(name))? != bytes {
                return Err("r_runtime_source_cas_input_changed".to_owned());
            }
        }
        let mut files = staged_observation.files(Path::new(""))?;
        files.sort();
        if files != expected_cas_files(&packages) {
            return Err("r_runtime_source_cas_file_closure_mismatch".to_owned());
        }
        observe(PublicationBoundary::BeforePublish, &staging)?;
        staged_observation.assert_current()?;
        for observed in &mixed_observations {
            observed.assert_current()?;
        }
        require_parent(&context, &parent)?;
        if input_observation.assert_current().is_err() {
            require_acquisition_active(cancelled, deadline)?;
            return Err("r_runtime_source_cas_lock_changed".to_owned());
        }
        publish_staging(
            &staging,
            &context,
            &parent,
            &stage,
            &mut publication_attempted,
            &mut observe,
        )?;
        let verified = acquisition_status(repository_root, cancelled, deadline)?;
        require_acquisition_active(cancelled, deadline)?;
        if verified["ready"] != Value::Bool(true) {
            // Rename is the publication boundary. A failed later observation
            // cannot revoke or erase these potentially consumed bytes. Keep the
            // exact target for inspection; a valid retry rechecks it in place.
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
        require_parent(&context, &parent)?;
        if !retains_directory(&destination, &stage) {
            return Err("r_runtime_source_cas_published_identity_changed".to_owned());
        }
        let mut report = verified;
        report["acquired"] = Value::Bool(true);
        Ok(report)
    })();
    if result.is_err() && deadline.is_some() && !publication_attempted {
        let known = if mixed_publication_started {
            false
        } else {
            match acquisition_observation(&staging, cancelled, deadline) {
                Ok(mut observed) => mixed_acquisition::known_failed_namespace(
                    &mut observed,
                    &mixed_observations,
                    &mixed_owned_archives,
                )
                .is_ok(),
                Err(_) => false,
            }
        };
        if !known {
            execution.retain_unknown_cleanup();
        }
    }
    if result.is_err()
        && execution.cleanup_verified()
        && !publication_attempted
        && retains_directory(&context, &parent)
        && retains_directory(&staging, &stage)
    {
        // Best-effort cleanup is limited to the original unpublished directory.
        // Rebound names, unknown process cleanup and published results are retained.
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests;
