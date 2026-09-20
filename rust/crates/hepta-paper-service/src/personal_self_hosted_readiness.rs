//! Read-only personal self-hosted readiness inspection.
//!
//! This is the local-only profile used by the incumbent
//! `personal-self-hosted-readiness` command.  The profile never grants an
//! external release or submission authority.  Every receipt is read through
//! a pinned, private regular file and every missing or incomplete local
//! prerequisite remains explicitly blocked.

#![forbid(unsafe_code)]

use crate::{
    external_authority_intake::unix_millis_to_iso_v1, operational_status,
    personal_self_hosted_formal, personal_self_hosted_gpu,
};
use hepta_legacy_compatibility::production_hash_record_v1;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

const PROFILE_HASH: &str =
    "sha256:c98b607a8efa30dac3d7fa9206c7af4d3a0eac5fcc5eaddc7bb82ba008196eab";
const MAX_RECEIPT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EVIDENCE_AGE_MS: i64 = 24 * 60 * 60 * 1000;
const MIN_SCHEMA_VERSION: i64 = 25;
const DATABASE_RELATIVE_PATH: &str = "hepta-paper.sqlite";
const ANTI_ROLLBACK_RELATIVE_PATH: &str = "deployment/personal-database-anti-rollback.json";
const EMPTY_INDEX_HASH: &str =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NOT_APPLICABLE: [(&str, &str); 7] = [
    (
        "hardware-kms-hsm",
        "no-distributed-release-signing-key-is-used",
    ),
    (
        "independent-external-authority-roles",
        "no-external-authority-or-multi-operator-release-claim",
    ),
    ("kubernetes-release-digest", "no-kubernetes-deployment"),
    (
        "local-author-review-session-separation",
        "single-operator-no-review-workflow",
    ),
    ("oci-registry-attestation", "no-oci-registry-distribution"),
    (
        "offhost-worm-custody",
        "private-single-host-scope-with-local-backup-contract",
    ),
    (
        "venue-portal-live-submission",
        "no-external-submission-or-publishing-action",
    ),
];
const CONTROL_IDS: [&str; 7] = [
    "credential-and-runtime-boundary",
    "database-inventory-and-schema",
    "database-restore-drill",
    "enabled-scientific-oracles",
    "exact-code-provenance",
    "formal-operational-zero-skipped",
    "online-anti-rollback",
];

#[derive(Debug, Error)]
pub enum PersonalSelfHostedReadinessError {
    #[error("personal self-hosted readiness path is invalid")]
    Path,
    #[error("personal self-hosted readiness clock is invalid")]
    Clock,
    #[error("personal self-hosted readiness hash failed")]
    Hash,
    #[error("personal self-hosted readiness filesystem operation failed")]
    Filesystem,
    #[error("personal self-hosted readiness database operation failed")]
    Database,
}

#[derive(Clone, Debug)]
pub struct PersonalSelfHostedReadinessOptions {
    pub workspace_root: PathBuf,
    pub runtime_root: PathBuf,
    pub cpu_receipt: Option<PathBuf>,
    pub gpu_receipt: Option<PathBuf>,
    pub gpu_enabled: bool,
    pub observed_at: String,
    pub environment: BTreeMap<String, String>,
}

fn hash_record(kind: &str, value: &Value) -> Result<String, PersonalSelfHostedReadinessError> {
    production_hash_record_v1(kind, value)
        .map(|value| value.as_str().to_owned())
        .map_err(|_| PersonalSelfHostedReadinessError::Hash)
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn sqlite_immutable_uri(path: &Path) -> String {
    format!(
        "file:{}?mode=ro&immutable=1",
        path.to_string_lossy()
            .replace('%', "%25")
            .replace('?', "%3F")
            .replace('#', "%23")
            .replace(' ', "%20")
    )
}

/// Return the hash of a SQLite online-backup snapshot, matching the Node
/// inspector's `consistentSnapshot` boundary.  Hashing the live file itself
/// is insufficient when SQLite has a WAL or when the backup normalizes page
/// state, so the snapshot is created in a private temporary directory and
/// removed before the caller publishes its report.
fn consistent_database_hash(db_path: &Path) -> Result<String, PersonalSelfHostedReadinessError> {
    let source_before =
        fs::symlink_metadata(db_path).map_err(|_| PersonalSelfHostedReadinessError::Filesystem)?;
    let source_header =
        fs::read(db_path).map_err(|_| PersonalSelfHostedReadinessError::Filesystem)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PersonalSelfHostedReadinessError::Filesystem)?
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("hepta-personal-db-{}-{stamp}", std::process::id()));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .map_err(|_| PersonalSelfHostedReadinessError::Filesystem)?;
    let snapshot = root.join("snapshot.sqlite");
    let result = (|| {
        let source = Connection::open_with_flags(
            sqlite_immutable_uri(db_path),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|_| PersonalSelfHostedReadinessError::Database)?;
        let mut target =
            Connection::open(&snapshot).map_err(|_| PersonalSelfHostedReadinessError::Database)?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut target)
                .map_err(|_| PersonalSelfHostedReadinessError::Database)?;
            backup
                .run_to_completion(128, std::time::Duration::ZERO, None)
                .map_err(|_| PersonalSelfHostedReadinessError::Database)?;
        }
        drop(target);
        drop(source);
        let source_after = fs::symlink_metadata(db_path)
            .map_err(|_| PersonalSelfHostedReadinessError::Filesystem)?;
        if !same_metadata(&source_before, &source_after) {
            return Err(PersonalSelfHostedReadinessError::Filesystem);
        }
        let mut bytes =
            fs::read(&snapshot).map_err(|_| PersonalSelfHostedReadinessError::Filesystem)?;
        // SQLite stores the library build number in the page-one header. The
        // incumbent Node backup preserves the source stamp while the bundled
        // Rust SQLite library rewrites it during backup. Preserve those four
        // header bytes in the temporary hash image so an identical logical
        // snapshot has the same cross-runtime digest.
        if source_header.len() >= 100 && bytes.len() >= 100 {
            bytes[96..100].copy_from_slice(&source_header[96..100]);
        }
        Ok(sha256(&bytes))
    })();
    let _ = fs::remove_dir_all(&root);
    result
}

fn valid_hash(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.strip_prefix("sha256:"))
        .is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn valid_object_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        (40..=64).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn now_millis(value: &str) -> Result<i64, PersonalSelfHostedReadinessError> {
    if let Ok(value) = value.parse::<i64>()
        && value >= 0
    {
        return Ok(value);
    }
    let value = value
        .strip_suffix('Z')
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    let (date, time) = value
        .split_once('T')
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    let mut date_parts = date.split('-');
    let year = date_parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    let month = date_parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    let day = date_parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(PersonalSelfHostedReadinessError::Clock);
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day > days_in_month {
        return Err(PersonalSelfHostedReadinessError::Clock);
    }
    let (clock, millis) = time
        .split_once('.')
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    let mut clock_parts = clock.split(':');
    let hour = clock_parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    let minute = clock_parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    let second = clock_parts
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(PersonalSelfHostedReadinessError::Clock)?;
    if clock_parts.next().is_some()
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
        || millis.len() != 3
    {
        return Err(PersonalSelfHostedReadinessError::Clock);
    }
    let millis = millis
        .parse::<i64>()
        .map_err(|_| PersonalSelfHostedReadinessError::Clock)?;
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146097 + day_of_era - 719468;
    Ok(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
}

pub fn canonical_observed_at_v1(value: &str) -> Result<String, PersonalSelfHostedReadinessError> {
    unix_millis_to_iso_v1(now_millis(value)?).map_err(|_| PersonalSelfHostedReadinessError::Clock)
}

fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_contains(parent: &Path, candidate: &Path) -> bool {
    candidate == parent || candidate.strip_prefix(parent).is_ok()
}

fn private_directory(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    let uid = nix::unistd::Uid::current().as_raw();
    meta.is_dir()
        && !meta.file_type().is_symlink()
        && meta.uid() == uid
        && (meta.mode() & 0o077) == 0
        && canonical_path(path) == path
}

fn same_metadata(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.file_type() == right.file_type()
        && left.mode() == right.mode()
        && left.nlink() == right.nlink()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn read_private_bytes(path: &Path, maximum_bytes: u64) -> Option<Vec<u8>> {
    read_private_bytes_with_mode(path, maximum_bytes, false)
}

fn read_private_bytes_with_mode(
    path: &Path,
    maximum_bytes: u64,
    require_read_only: bool,
) -> Option<Vec<u8>> {
    let before = fs::symlink_metadata(path).ok()?;
    let uid = nix::unistd::Uid::current().as_raw();
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.nlink() != 1
        || before.uid() != uid
        || (before.mode() & 0o022) != 0
        || (require_read_only && (before.mode() & 0o222) != 0)
        || before.len() == 0
        || before.len() > maximum_bytes
        || canonical_path(path) != path
    {
        return None;
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let opened = file.metadata().ok()?;
    if !same_metadata(&before, &opened) {
        return None;
    }
    let mut bytes = Vec::new();
    (&mut &file)
        .take(maximum_bytes + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let after = file.metadata().ok()?;
    let named_after = fs::symlink_metadata(path).ok()?;
    if bytes.len() as u64 != before.len()
        || !same_metadata(&before, &after)
        || !same_metadata(&before, &named_after)
    {
        return None;
    }
    Some(bytes)
}

fn read_private_json(path: &Path) -> Option<Value> {
    let bytes = read_private_bytes(path, MAX_RECEIPT_BYTES)?;
    serde_json::from_slice(&bytes).ok()
}

fn read_private_json_read_only(path: &Path) -> Option<Value> {
    let bytes = read_private_bytes_with_mode(path, MAX_RECEIPT_BYTES, true)?;
    serde_json::from_slice(&bytes).ok()
}

fn evidence(
    status: &str,
    details: Value,
    observed_at: &str,
) -> Result<Value, PersonalSelfHostedReadinessError> {
    let payload = json!({
        "status": status,
        "source": "local-observation",
        "observedAt": observed_at,
        "details": details,
    });
    let mut value = payload.clone();
    value["evidenceHash"] =
        Value::String(hash_record("PersonalSelfHostedLocalEvidence", &payload)?);
    Ok(value)
}

fn blocked_evidence(
    details: Value,
    observed_at: &str,
) -> Result<Value, PersonalSelfHostedReadinessError> {
    evidence("blocked", details, observed_at)
}

fn inspect_runtime_boundary(workspace_root: &Path, runtime_root: &Path) -> Value {
    let workspace = canonical_path(workspace_root);
    let runtime = canonical_path(runtime_root);
    let overlap = path_contains(&workspace, &runtime) || path_contains(&runtime, &workspace);
    json!({
        "workspaceRoot": workspace,
        "runtimeRoot": runtime,
        "physicallyDecoupled": !overlap,
        "overlap": overlap,
        "blockers": if overlap { vec!["personal_self_hosted_runtime_overlaps_workspace"] } else { Vec::<&str>::new() },
    })
}

fn inspect_provenance(
    workspace_root: &Path,
    observed_at: &str,
) -> Result<(Option<Value>, Value), PersonalSelfHostedReadinessError> {
    match operational_status::current_operational_code_provenance_v1(workspace_root) {
        Ok(provenance) => {
            let clean = provenance["treeDirty"] == false
                && provenance["indexStateHash"] == EMPTY_INDEX_HASH;
            let details = json!({
                "clean": clean,
                "commit": provenance["commit"].clone(),
                "commitTree": provenance["commitTree"].clone(),
                "repositoryContentHash": provenance["repositoryContentHash"].clone(),
                "indexClean": provenance["indexStateHash"] == EMPTY_INDEX_HASH,
            });
            let ready = clean
                && valid_object_id(provenance.get("commit"))
                && valid_object_id(provenance.get("commitTree"))
                && valid_hash(provenance.get("repositoryContentHash"));
            let ev = if ready {
                evidence("verified", details, observed_at)?
            } else {
                blocked_evidence(details, observed_at)?
            };
            Ok((Some(provenance), ev))
        }
        Err(error) => {
            let details = json!({
                "clean": false,
                "commit": Value::Null,
                "commitTree": Value::Null,
                "repositoryContentHash": Value::Null,
                "indexClean": false,
                "error": error.to_string(),
            });
            Ok((None, blocked_evidence(details, observed_at)?))
        }
    }
}

fn inspect_formal(
    runtime_root: &Path,
    environment: &BTreeMap<String, String>,
    provenance: Option<&Value>,
    observed_at: &str,
) -> Result<Value, PersonalSelfHostedReadinessError> {
    let path = environment
        .get("HEPTA_FORMAL_OPERATIONAL_RECEIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_root.join("formal-operational/formal-operational-receipt.json"));
    let value = read_private_json(&path);
    let projection =
        personal_self_hosted_formal::inspect_formal_receipt(value.as_ref(), provenance);
    let details = json!({
        "zeroSkipped": projection["zeroSkipped"].clone(),
        "pass": projection["pass"].clone(),
        "fail": projection["fail"].clone(),
        "skipped": projection["skipped"].clone(),
        "todo": projection["todo"].clone(),
        "commit": projection["commit"].clone(),
    });
    if details["zeroSkipped"] == true {
        evidence("verified", details, observed_at)
    } else {
        blocked_evidence(details, observed_at)
    }
}

fn inspect_source_security(workspace_root: &Path) -> bool {
    crate::personal_self_hosted_source::inspect_source_security(workspace_root).unwrap_or(false)
}

fn open_file_descriptor_present(db_path: &Path) -> bool {
    let targets = [
        db_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", db_path.display())),
        PathBuf::from(format!("{}-shm", db_path.display())),
        PathBuf::from(format!("{}-journal", db_path.display())),
    ]
    .into_iter()
    .map(|path| canonical_path(&path).to_string_lossy().into_owned())
    .collect::<BTreeSet<_>>();
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(descriptors) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for descriptor in descriptors.flatten() {
            if let Ok(target) = fs::read_link(descriptor.path())
                && targets.contains(&target.to_string_lossy().into_owned())
            {
                return true;
            }
        }
    }
    false
}

fn sidecar_blockers(db_path: &Path) -> (Vec<Value>, Vec<String>) {
    let mut sidecars = Vec::new();
    let mut blockers = Vec::new();
    if open_file_descriptor_present(db_path) {
        blockers.push("personal_database_open_file_descriptor_present".to_owned());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let path = PathBuf::from(format!("{}{}", db_path.display(), suffix));
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let safe = meta.is_file()
            && !meta.file_type().is_symlink()
            && meta.nlink() == 1
            && meta.uid() == nix::unistd::Uid::current().as_raw()
            && (meta.mode() & 0o022) == 0;
        let bytes = meta.len();
        sidecars.push(json!({
            "suffix": suffix,
            "path": path,
            "bytes": bytes,
            "mode": meta.mode() & 0o7777,
            "safe": safe,
            "identity": {"device": meta.dev().to_string(), "inode": meta.ino().to_string(), "links": meta.nlink().to_string()},
        }));
        if !safe {
            blockers.push(format!("personal_database_sidecar_unsafe:{suffix}"));
        } else if suffix == "-wal" && bytes > 0 {
            blockers.push("personal_database_active_wal_present".into());
        } else if suffix == "-journal" && bytes > 0 {
            blockers.push("personal_database_active_journal_present".into());
        }
    }
    (sidecars, blockers)
}

fn inspect_anti_rollback(runtime_root: &Path, current_hash: Option<&str>) -> (Value, Vec<String>) {
    let path = runtime_root.join(ANTI_ROLLBACK_RELATIVE_PATH);
    let Some(value) = read_private_json_read_only(&path) else {
        return (
            json!({
                "path": path,
                "ready": false,
                "sequence": 0,
                "databaseSha256": Value::Null,
                "ledgerHash": Value::Null,
                "currentDatabaseSha256": current_hash.map(|value| Value::String(value.to_owned())).unwrap_or(Value::Null),
            }),
            vec!["personal_database_anti_rollback_state_missing".to_owned()],
        );
    };
    let mut blockers = Vec::new();
    if value["version"] != 1
        || value["kind"] != "PersonalDatabaseAntiRollbackLedger"
        || value["status"] != "active"
        || value["databaseRelativePath"] != DATABASE_RELATIVE_PATH
        || value["updatedAt"]
            .as_str()
            .is_none_or(|instant| now_millis(instant).is_err())
        || !valid_hash(value.get("ledgerHash"))
    {
        blockers.push("personal_database_anti_rollback_state_shape_invalid".to_owned());
    }
    let entries = value["entries"].as_array().cloned().unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut previous = Value::Null;
    for (index, entry) in entries.iter().enumerate() {
        let expected = (index + 1) as i64;
        let payload = json!({
            "sequence": entry["sequence"].clone(),
            "databaseSha256": entry["databaseSha256"].clone(),
            "schemaVersion": entry["schemaVersion"].clone(),
            "observedAt": entry["observedAt"].clone(),
            "previousEntryHash": entry.get("previousEntryHash").cloned().unwrap_or(Value::Null),
        });
        let valid_entry = entry["sequence"] == expected
            && valid_hash(entry.get("databaseSha256"))
            && entry["schemaVersion"]
                .as_i64()
                .is_some_and(|version| version >= 0)
            && entry["observedAt"]
                .as_str()
                .is_some_and(|instant| now_millis(instant).is_ok())
            && entry.get("previousEntryHash").unwrap_or(&Value::Null) == &previous
            && valid_hash(entry.get("entryHash"))
            && hash_record("PersonalDatabaseAntiRollbackEntry", &payload)
                .ok()
                .is_some_and(|hash| entry["entryHash"] == hash)
            && entry["databaseSha256"]
                .as_str()
                .is_some_and(|hash| seen.insert(hash.to_owned()));
        if !valid_entry {
            blockers.push(format!(
                "personal_database_anti_rollback_entry_invalid:{expected}"
            ));
        }
        previous = entry.get("entryHash").cloned().unwrap_or(Value::Null);
    }
    let ledger_hash = value["ledgerHash"].clone();
    let mut payload = value.clone();
    if let Some(object) = payload.as_object_mut() {
        object.remove("ledgerHash");
    }
    if valid_hash(Some(&ledger_hash))
        && hash_record("PersonalDatabaseAntiRollbackLedger", &payload)
            .ok()
            .is_some_and(|hash| ledger_hash != hash)
    {
        blockers.push("personal_database_anti_rollback_ledger_hash_invalid".to_owned());
    }
    let latest = entries.last();
    let sequence = latest
        .and_then(|entry| entry["sequence"].as_i64())
        .unwrap_or(0);
    let database_hash = latest.and_then(|entry| entry["databaseSha256"].as_str());
    if latest.is_none() {
        blockers.push("personal_database_anti_rollback_head_missing".to_owned());
    }
    if let (Some(current), Some(expected)) = (current_hash, database_hash)
        && current != expected
    {
        if entries
            .iter()
            .any(|entry| entry["databaseSha256"] == current)
        {
            blockers.push("personal_database_rollback_detected".to_owned());
        } else {
            blockers.push("personal_database_current_head_unrecorded".to_owned());
        }
    }
    let ready = blockers.is_empty() && latest.is_some();
    (
        json!({
            "path": path,
            "ready": ready,
            "sequence": sequence,
            "databaseSha256": database_hash.map(Value::from).unwrap_or(Value::Null),
            "ledgerHash": value["ledgerHash"].clone(),
            "currentDatabaseSha256": current_hash.map(Value::from).unwrap_or(Value::Null),
        }),
        blockers,
    )
}

fn inspect_backup_and_restore(
    runtime_root: &Path,
    latest_sequence: i64,
) -> (Option<Value>, Option<Value>, Vec<String>) {
    let root = runtime_root.join("backups/personal-database");
    let Ok(meta) = fs::symlink_metadata(&root) else {
        return (None, None, Vec::new());
    };
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != nix::unistd::Uid::current().as_raw()
        || (meta.mode() & 0o077) != 0
        || canonical_path(&root) != root
    {
        return (
            None,
            None,
            vec!["personal_database_backup_root_unsafe".to_owned()],
        );
    }
    let mut candidates = fs::read_dir(&root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("sqlite"))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let left_time = fs::metadata(left).and_then(|meta| meta.modified()).ok();
        let right_time = fs::metadata(right).and_then(|meta| meta.modified()).ok();
        right_time.cmp(&left_time).then_with(|| right.cmp(left))
    });
    let mut blockers = Vec::new();
    for path in candidates {
        let Some(bytes) = read_private_bytes(&path, 256 * 1024 * 1024) else {
            continue;
        };
        let receipt_path = PathBuf::from(format!("{}.receipt.json", path.display()));
        let Some(receipt) = read_private_json(&receipt_path) else {
            continue;
        };
        let mut receipt_payload = receipt.clone();
        let receipt_hash = receipt["receiptHash"].clone();
        if let Some(object) = receipt_payload.as_object_mut() {
            object.remove("receiptHash");
        }
        let valid = receipt["version"] == 1
            && receipt["kind"] == "PersonalDatabaseBackupReceipt"
            && receipt["status"] == "personal_database_backup_recorded"
            && receipt["databaseRelativePath"] == DATABASE_RELATIVE_PATH
            && receipt["backupPath"]
                .as_str()
                .is_some_and(|value| Path::new(value) == path)
            && receipt["backupSha256"] == sha256(&bytes)
            && receipt["bytes"].as_u64() == Some(bytes.len() as u64)
            && receipt["schemaVersion"]
                .as_i64()
                .is_some_and(|version| version >= 0)
            && receipt["createdAt"]
                .as_str()
                .is_some_and(|instant| now_millis(instant).is_ok())
            && valid_hash(Some(&receipt_hash))
            && hash_record("PersonalDatabaseBackupReceipt", &receipt_payload)
                .ok()
                .is_some_and(|hash| hash == receipt_hash);
        if !valid {
            continue;
        }
        let backup = json!({
            "path": path,
            "sha256": receipt["backupSha256"].clone(),
            "schemaVersion": receipt["schemaVersion"].clone(),
            "antiRollbackSequence": receipt["antiRollbackSequence"].clone(),
        });
        let restore_path = PathBuf::from(format!("{}.restore-drill.receipt.json", path.display()));
        let restore = read_private_json(&restore_path).filter(|value| {
            let mut payload = value.clone();
            let hash = value["receiptHash"].clone();
            if let Some(object) = payload.as_object_mut() {
                object.remove("receiptHash");
            }
            value["version"] == 1
                && value["kind"] == "PersonalDatabaseRestoreDrillReceipt"
                && value["status"] == "personal_database_restore_drill_passed"
                && value["backupPath"] == path.to_string_lossy().as_ref()
                && value["backupSha256"] == receipt["backupSha256"]
                && value["productionDatabaseMutated"] == false
                && value["blockers"].as_array().is_some_and(Vec::is_empty)
                && value["performedAt"]
                    .as_str()
                    .is_some_and(|instant| now_millis(instant).is_ok())
                && valid_hash(Some(&hash))
                && hash_record("PersonalDatabaseRestoreDrillReceipt", &payload)
                    .ok()
                    .is_some_and(|expected| expected == hash)
        });
        let restore_projection = restore.as_ref().map(|value| {
            json!({
                "path": restore_path,
                "receiptHash": value["receiptHash"].clone(),
                "performedAt": value["performedAt"].clone(),
            })
        });
        if latest_sequence > receipt["antiRollbackSequence"].as_i64().unwrap_or(0) {
            blockers.push("personal_database_backup_head_sequence_stale".to_owned());
        }
        return (Some(backup), restore_projection, blockers);
    }
    (None, None, blockers)
}

fn inspect_database(runtime_root: &Path) -> (bool, Value, bool, bool, bool) {
    let db_path = runtime_root.join(DATABASE_RELATIVE_PATH);
    // The Node inspector validates the runtime directory before touching the
    // native store.  Preserve that catch boundary so a missing or unsafe root
    // reports `personal_database_runtime_root_unsafe`, with no synthetic
    // native-store or anti-rollback projection.
    if !private_directory(runtime_root) {
        return (
            false,
            json!({
                "version": 1,
                "kind": "PersonalLocalDatabaseReadiness",
                "status": "personal_local_database_blocked",
                "ready": false,
                "runtimeRoot": runtime_root,
                "databasePath": db_path,
                "databaseRelativePath": DATABASE_RELATIVE_PATH,
                "schemaVersion": 0,
                "minimumSchemaVersion": MIN_SCHEMA_VERSION,
                "quickCheck": Value::Null,
                "foreignKeyViolationCount": Value::Null,
                "schemaHash": Value::Null,
                "activeLeaseCount": 0,
                "leases": {"jobs": 0, "campaigns": 0, "submissions": 0},
                "sidecars": [],
                "antiRollback": Value::Null,
                "backup": Value::Null,
                "restoreDrill": Value::Null,
                "blockers": ["personal_database_runtime_root_unsafe"],
            }),
            false,
            false,
            false,
        );
    }
    let mut blockers = Vec::new();
    let file_meta = fs::symlink_metadata(&db_path).ok();
    let owner = nix::unistd::Uid::current().as_raw();
    let safe_file = file_meta.as_ref().is_some_and(|meta| {
        meta.is_file()
            && !meta.file_type().is_symlink()
            && meta.nlink() == 1
            && meta.uid() == owner
            && (meta.mode() & 0o022) == 0
            && canonical_path(&db_path) == db_path
    });
    if !safe_file {
        blockers.push("personal_database_native_store_unsafe".to_owned());
    }
    let (sidecars, mut sidecar_blockers) = sidecar_blockers(&db_path);
    blockers.append(&mut sidecar_blockers);
    let mut quick_check = Value::Null;
    let mut fk_count = Value::Null;
    let mut schema_version = 0_i64;
    let mut schema_hash = Value::Null;
    let mut active_lease_count = 0_i64;
    let mut leases = json!({"jobs":0,"campaigns":0,"submissions":0});
    let mut current_hash = None;
    if safe_file {
        match consistent_database_hash(&db_path) {
            Ok(hash) => current_hash = Some(hash),
            Err(_) => blockers.push("personal_database_snapshot_failed".to_owned()),
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
        if let Ok(connection) = Connection::open_with_flags(sqlite_immutable_uri(&db_path), flags) {
            quick_check = connection
                .query_row("PRAGMA quick_check;", [], |row| row.get::<_, String>(0))
                .map(Value::String)
                .unwrap_or(Value::Null);
            fk_count = connection
                .prepare("PRAGMA foreign_key_check;")
                .and_then(|mut stmt| {
                    stmt.query_map([], |_| Ok(()))
                        .map(|rows| rows.count() as i64)
                })
                .map(Value::from)
                .unwrap_or(Value::Null);
            schema_version = connection
                .query_row(
                    "SELECT coalesce(max(version),0) FROM schema_migrations;",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0);
            let schema_rows = connection
                .prepare(
                    "SELECT type,name,tbl_name,coalesce(sql,'') AS sql \
                     FROM sqlite_schema \
                     WHERE name NOT LIKE 'sqlite_%' \
                     ORDER BY type,name,tbl_name,sql;",
                )
                .ok()
                .and_then(|mut statement| {
                    let rows = statement
                        .query_map([], |row| {
                            Ok(json!({
                                "type": row.get::<_, String>(0)?,
                                "name": row.get::<_, String>(1)?,
                                "tbl_name": row.get::<_, String>(2)?,
                                "sql": row.get::<_, String>(3)?,
                            }))
                        })
                        .ok()?;
                    Some(rows.filter_map(Result::ok).collect::<Vec<_>>())
                })
                .unwrap_or_default();
            if let Ok(hash) = hash_record("PersonalLocalDatabaseSchema", &Value::Array(schema_rows))
            {
                schema_hash = Value::String(hash);
            }
            let count = |table: &str, statuses: &[&str]| -> i64 {
                let names = connection
                    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';")
                    .ok()
                    .and_then(|mut statement| {
                        let rows = statement
                            .query_map([], |row| row.get::<_, String>(0))
                            .ok()?;
                        Some(rows.filter_map(Result::ok).collect::<BTreeSet<_>>())
                    })
                    .unwrap_or_default();
                if !names.contains(table) {
                    return 0;
                }
                let cols = connection
                    .prepare(&format!("PRAGMA table_info({table});"))
                    .ok()
                    .and_then(|mut statement| {
                        let rows = statement
                            .query_map([], |row| row.get::<_, String>(1))
                            .ok()?;
                        Some(rows.filter_map(Result::ok).collect::<BTreeSet<_>>())
                    })
                    .unwrap_or_default();
                let mut clauses = Vec::new();
                if cols.contains("status") {
                    clauses.extend(statuses.iter().map(|s| format!("status IN ({})", s)));
                }
                if cols.contains("state") {
                    clauses.extend(statuses.iter().map(|s| format!("state IN ({})", s)));
                }
                for col in [
                    "lease_owner",
                    "claimed_by",
                    "lease_token",
                    "lease_expires_at",
                ] {
                    if cols.contains(col) {
                        clauses.push(format!("{col} IS NOT NULL"));
                    }
                }
                if clauses.is_empty() {
                    return 0;
                }
                connection
                    .query_row(
                        &format!(
                            "SELECT count(*) FROM {table} WHERE {};",
                            clauses.join(" OR ")
                        ),
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
            };
            let jobs = count("jobs", &["'leased'", "'running'"]);
            let campaigns = count("campaign_nodes", &["'leased'", "'running'"]);
            let submissions = count("submission_outbox", &["'in_flight'"])
                + count("submission_response_consumption", &["'IN_PROGRESS'"]);
            active_lease_count = jobs + campaigns + submissions;
            leases = json!({"jobs":jobs,"campaigns":campaigns,"submissions":submissions});
        } else {
            blockers.push("personal_database_native_store_unreadable".to_owned());
        }
        if let (Some(before), Ok(after)) = (&file_meta, fs::symlink_metadata(&db_path))
            && !same_metadata(before, &after)
        {
            blockers.push("personal_database_changed_during_inspection".to_owned());
        }
    }
    if safe_file {
        if quick_check.as_str() != Some("ok") {
            blockers.push("personal_database_quick_check_failed".to_owned());
        }
        if fk_count.as_i64() != Some(0) {
            blockers.push("personal_database_foreign_key_check_failed".to_owned());
        }
        if schema_version < MIN_SCHEMA_VERSION {
            blockers.push(format!(
                "personal_database_schema_version_below_minimum:{schema_version}/{MIN_SCHEMA_VERSION}"
            ));
        }
        if active_lease_count != 0 {
            blockers.push("personal_database_active_leases_present".to_owned());
        }
    }
    // The incumbent catches an unsafe/missing native database before it
    // attempts ledger or backup inspection.  Preserve that boundary so a
    // missing database reports only the native-store blocker; the additional
    // local controls are evaluated once the database itself is safe.
    let (anti_rollback, backup, restore_drill) = if safe_file {
        let (anti_rollback, mut anti_rollback_blockers) =
            inspect_anti_rollback(runtime_root, current_hash.as_deref());
        blockers.append(&mut anti_rollback_blockers);
        let latest_sequence = anti_rollback["sequence"].as_i64().unwrap_or(0);
        let (backup, restore_drill, mut backup_blockers) =
            inspect_backup_and_restore(runtime_root, latest_sequence);
        blockers.append(&mut backup_blockers);
        if restore_drill.is_none() {
            blockers.push("personal_database_restore_drill_required".to_owned());
        }
        (anti_rollback, backup, restore_drill)
    } else {
        (
            json!({
                "path": runtime_root.join(ANTI_ROLLBACK_RELATIVE_PATH),
                "ready": false,
                "sequence": 0,
                "databaseSha256": Value::Null,
                "ledgerHash": Value::Null,
                "currentDatabaseSha256": current_hash.as_ref().map(|value| Value::from(value.as_str())).unwrap_or(Value::Null),
            }),
            None,
            None,
        )
    };
    let ready = safe_file && blockers.is_empty();
    let report = json!({
        "version":1,
        "kind":"PersonalLocalDatabaseReadiness",
        "status": if ready {"personal_local_database_ready"} else {"personal_local_database_blocked"},
        "ready":ready,
        "runtimeRoot":runtime_root,
        "databasePath":db_path,
        "databaseRelativePath":DATABASE_RELATIVE_PATH,
        "schemaVersion":schema_version,
        "minimumSchemaVersion":MIN_SCHEMA_VERSION,
        "quickCheck":quick_check,
        "foreignKeyViolationCount":fk_count,
        "schemaHash":schema_hash,
        "activeLeaseCount":active_lease_count,
        "leases":leases,
        "sidecars":sidecars,
        "antiRollback":anti_rollback,
        "backup":backup.unwrap_or(Value::Null),
        "restoreDrill":restore_drill.unwrap_or(Value::Null),
        "blockers":blockers,
    });
    (ready, report, false, false, current_hash.is_some())
}

fn inspect_cpu(
    runtime_root: &Path,
    environment: &BTreeMap<String, String>,
    provenance: Option<&Value>,
    observed_at: &str,
    observed_ms: i64,
) -> Result<Value, PersonalSelfHostedReadinessError> {
    let path = environment
        .get("HEPTA_PERSONAL_CPU_RECEIPT")
        .or_else(|| environment.get("HEPTA_PERSONAL_GPU_RECEIPT"))
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_root.join("gpu-personal/personal-gpu-operational-receipt.json"));
    let receipt = read_private_json(&path);
    let created_ms = receipt
        .as_ref()
        .and_then(|v| v.get("createdAtEpochMs"))
        .and_then(Value::as_i64);
    let valid = receipt.as_ref().is_some_and(|value| {
        personal_self_hosted_gpu::verify_personal_gpu_receipt(value)
            && provenance.is_some_and(|p| value["workspaceCommit"] == p["commit"])
            && value["externalActionPerformed"] == false
            && value["networkActionPerformed"] == false
            && value["pde"]["cpuOracleStatus"]
                == "process_isolated_pde_poisson_2d_cpu_oracle_verified"
            && valid_hash(value["pde"].get("cpuOracleHash"))
            && value["deepLearning"]["cpuOracleStatus"]
                == "process_isolated_deep_learning_cpu_oracle_verified"
            && valid_hash(value["deepLearning"].get("cpuOracleHash"))
            && value["deepLearning"]["deterministicReplay"] == true
            && value["ir"]["modelExecutableCodeEmbedded"] == false
            && value["ir"]["checkpointExecutablePayloadAllowed"] == false
            && value["ir"]["pickleAllowed"] == false
            && created_ms.is_some_and(|created| {
                created <= observed_ms && observed_ms - created <= MAX_EVIDENCE_AGE_MS
            })
    });
    let details = json!({
        "cpuOracleReady":valid,
        "deterministicReplay":valid,
        "errorBudgetVerified":valid,
        "modelDataCheckpointIrBound":valid,
        "pdeCpuOracleStatus":receipt.as_ref().and_then(|v|v["pde"]["cpuOracleStatus"].as_str()).map(Value::from).unwrap_or(Value::Null),
        "pdeCpuOracleHash":receipt.as_ref().and_then(|v|v["pde"]["cpuOracleHash"].as_str()).map(Value::from).unwrap_or(Value::Null),
        "deepLearningCpuOracleStatus":receipt.as_ref().and_then(|v|v["deepLearning"]["cpuOracleStatus"].as_str()).map(Value::from).unwrap_or(Value::Null),
        "deepLearningCpuOracleHash":receipt.as_ref().and_then(|v|v["deepLearning"]["cpuOracleHash"].as_str()).map(Value::from).unwrap_or(Value::Null),
        "receiptPath":path,
        "receiptObservedAt":created_ms.and_then(|value| unix_millis_to_iso_v1(value).ok()).map(Value::from).unwrap_or(Value::Null),
        "workspaceCommit":receipt.as_ref().and_then(|v|v["workspaceCommit"].as_str()).map(Value::from).unwrap_or(Value::Null),
    });
    let ev = if valid {
        evidence(
            "verified",
            details.clone(),
            &created_ms
                .and_then(|v| unix_millis_to_iso_v1(v).ok())
                .unwrap_or_else(|| observed_at.to_owned()),
        )?
    } else {
        blocked_evidence(details.clone(), observed_at)?
    };
    let observed = if valid {
        created_ms
            .and_then(|value| unix_millis_to_iso_v1(value).ok())
            .unwrap_or_else(|| observed_at.to_owned())
    } else {
        observed_at.to_owned()
    };
    Ok(json!({
        "enabled":true,
        "status":if valid {"verified"} else {"blocked"},
        "deterministicReplay":valid,
        "errorBudgetVerified":valid,
        "modelDataCheckpointIrBound":valid,
        "evidenceHash":if valid {ev["evidenceHash"].clone()} else {Value::Null},
        "observedAt":observed,
        "receiptPath":path,
        "receiptKind":receipt.as_ref().and_then(|v|v["kind"].as_str()).map(Value::from).unwrap_or(Value::Null),
        "blockers":if valid {Vec::<&str>::new()} else {vec!["personal_self_hosted_cpu_oracle_receipt_missing_or_invalid"]},
        "details":details,
    }))
}

fn inspect_gpu(
    runtime_root: &Path,
    environment: &BTreeMap<String, String>,
    provenance: Option<&Value>,
    observed_at: &str,
    observed_ms: i64,
    enabled: bool,
) -> Value {
    let path = environment
        .get("HEPTA_PERSONAL_GPU_RECEIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_root.join("gpu-personal/personal-gpu-operational-receipt.json"));
    if !enabled {
        return json!({
            "enabled":false,"status":"not_enabled","deterministicReplay":false,"sameDeviceReplay":false,
            "errorBudgetVerified":false,"modelDataCheckpointIrBound":false,"evidenceHash":Value::Null,
            "observedAt":observed_at,"disabledReason":environment.get("HEPTA_PERSONAL_GPU_DISABLED_REASON").cloned().unwrap_or_else(|| "GPU capability is not enabled; CPU readiness is evaluated separately from the process-isolated CPU oracle receipt.".into()),"receiptPath":path,
        });
    }
    let receipt = read_private_json(&path);
    let created_ms = receipt
        .as_ref()
        .and_then(|v| v.get("createdAtEpochMs"))
        .and_then(Value::as_i64);
    let valid = receipt.as_ref().is_some_and(|value| {
        personal_self_hosted_gpu::verify_personal_gpu_receipt(value)
            && provenance.is_some_and(|p| value["workspaceCommit"] == p["commit"])
            && value["externalActionPerformed"] == false
            && value["networkActionPerformed"] == false
            && value["pde"]["scientificChecksPassed"] == true
            && value["deepLearning"]["deterministicReplay"] == true
            && value["deepLearning"]["sameDeviceReplayHash"]
                .as_str()
                .is_some()
            && value["ir"]["modelExecutableCodeEmbedded"] == false
            && value["ir"]["checkpointExecutablePayloadAllowed"] == false
            && value["ir"]["pickleAllowed"] == false
            && created_ms.is_some_and(|created| {
                created <= observed_ms && observed_ms - created <= MAX_EVIDENCE_AGE_MS
            })
    });
    json!({
        "enabled":true,"status":if valid {"verified"} else {"blocked"},"deterministicReplay":valid,"sameDeviceReplay":valid,
        "errorBudgetVerified":valid,"modelDataCheckpointIrBound":valid,"evidenceHash":if valid {receipt.as_ref().and_then(|v|v["personalGpuOperationalReceiptHash"].clone().as_str().map(Value::from)).unwrap_or(Value::Null)} else {Value::Null},
        "observedAt":if valid {created_ms.and_then(|v|unix_millis_to_iso_v1(v).ok()).map(Value::from).unwrap_or_else(||Value::String(observed_at.to_owned()))} else {Value::String(observed_at.to_owned())},
        "receiptPath":path,"workspaceCommit":receipt.as_ref().and_then(|v|v["workspaceCommit"].as_str()).map(Value::from).unwrap_or(Value::Null),"receiptKind":receipt.as_ref().and_then(|v|v["kind"].as_str()).map(Value::from).unwrap_or(Value::Null),
        "blockers":if valid {Vec::<&str>::new()} else {vec!["personal_gpu_operational_receipt_missing_or_invalid"]},
    })
}

fn control_valid(value: Option<&Value>, control_id: &str, observed_ms: i64) -> bool {
    let Some(value) = value else { return false };
    if value["status"] != "verified"
        || value["source"] != "local-observation"
        || !valid_hash(value.get("evidenceHash"))
    {
        return false;
    }
    let Some(observed) = value["observedAt"]
        .as_str()
        .and_then(|v| now_millis(v).ok())
    else {
        return false;
    };
    if observed > observed_ms || observed_ms - observed > MAX_EVIDENCE_AGE_MS {
        return false;
    }
    let Some(details) = value.get("details") else {
        return false;
    };
    let payload = json!({"status":value["status"].clone(),"source":value["source"].clone(),"observedAt":value["observedAt"].clone(),"details":details.clone()});
    if hash_record("PersonalSelfHostedLocalEvidence", &payload)
        .ok()
        .as_deref()
        != value["evidenceHash"].as_str()
    {
        return false;
    }
    match control_id {
        "exact-code-provenance" => {
            details["clean"] == true
                && valid_object_id(details.get("commit"))
                && valid_object_id(details.get("commitTree"))
                && valid_hash(details.get("repositoryContentHash"))
        }
        "formal-operational-zero-skipped" => {
            details["zeroSkipped"] == true
                && details["pass"].as_i64().is_some_and(|v| v > 0)
                && details["fail"] == 0
                && details["skipped"] == 0
                && details["todo"] == 0
                && valid_object_id(details.get("commit"))
        }
        "credential-and-runtime-boundary" => {
            details["privateKeyMaterialAbsent"] == true
                && details["secretLeakScanPassed"] == true
                && details["runtimeOwnerOnly"] == true
        }
        "database-inventory-and-schema" => {
            details["inventoryReady"] == true
                && details["databaseCount"].as_i64().is_some_and(|v| v > 0)
                && details["databaseCount"] == details["databaseReadyCount"]
        }
        "database-restore-drill" => {
            details["restoreDrillReady"] == true && valid_hash(details.get("restoreReceiptHash"))
        }
        "online-anti-rollback" => {
            details["antiRollbackReady"] == true && valid_hash(details.get("integrityPinHash"))
        }
        "enabled-scientific-oracles" => {
            details["enabledCapabilitiesReady"] == true
                && details["enabledCapabilities"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|x| x == "cpu"))
        }
        _ => false,
    }
}

fn build_control_result(value: Option<&Value>, control_id: &str, observed_ms: i64) -> Value {
    let valid = control_valid(value, control_id, observed_ms);
    let blocker = if valid {
        Value::Null
    } else {
        Value::String(format!(
            "personal_self_hosted_control_not_verified:{control_id}"
        ))
    };
    json!({"status":if valid {"verified"} else {"blocked"},"blocker":blocker,"evidenceHash":value.and_then(|v|v["evidenceHash"].clone().as_str().map(Value::from)).unwrap_or(Value::Null),"observedAt":value.and_then(|v|v["observedAt"].clone().as_str().map(Value::from)).unwrap_or(Value::Null),"details":value.and_then(|v|v.get("details")).cloned().unwrap_or(Value::Null)})
}

pub fn personal_self_hosted_readiness_help_json_v1() -> Value {
    json!({
        "version":1,
        "kind":"PersonalSelfHostedReadinessUsage",
        "usage":"personal-self-hosted-readiness [--root CODE_WORKSPACE] [--runtime-root PATH] [--cpu-receipt PATH] [--gpu-enabled --gpu-receipt PATH] [--require-ready]",
        "profile":"personal-self-hosted-v1",
        "scope":"single-user-private-local-only",
        "effects":"read-only; runs immutable local DB inspection, source scan, and reads canonical scientific/formal receipts; never mints authority or performs external actions",
        "localEvidenceInputs":{
            "root":"code workspace used for exact commit/provenance and tracked-source scan (defaults to HEPTA_WORKSPACE_ROOT or process.cwd())",
            "database":"personal-local-database status/ledger/backup/restore-drill (schema floor 25)",
            "formal":"HEPTA_FORMAL_OPERATIONAL_RECEIPT or runtime/formal-operational/formal-operational-receipt.json",
            "cpu":"HEPTA_PERSONAL_CPU_RECEIPT or the CPU-oracle fields in runtime/gpu-personal/personal-gpu-operational-receipt.json; CPU is always enabled and requires a current process-isolated oracle receipt",
            "gpu":"HEPTA_PERSONAL_GPU_RECEIPT or runtime/gpu-personal/personal-gpu-operational-receipt.json (required with --gpu-enabled; GPU adds same-device replay)",
            "runtimeBoundary":"runtime defaults to the external sibling HEPTA_PAPER_RUNTIME_ROOT and must not overlap the code workspace",
            "credentials":"direct tracked-source secret scan plus owner-only runtime directory mode; no hand-authored receipt",
            "authorReviewer":"not applicable: single-operator-no-review-workflow",
            "slo":"optional automatic local health diagnostic; no hand-authored receipt"
        },
        "notApplicable":[
            "independent-external-authority-roles",
            "hardware-kms-hsm",
            "local-author-review-session-separation",
            "offhost-worm-custody",
            "venue-portal-live-submission",
            "oci-registry-attestation",
            "kubernetes-release-digest"
        ],
        "exitCodes":{"ready":0,"blocked":2,"invalid":1}
    })
}

pub fn inspect_personal_self_hosted_readiness_v1(
    options: &PersonalSelfHostedReadinessOptions,
) -> Result<Value, PersonalSelfHostedReadinessError> {
    let observed_ms = now_millis(&options.observed_at)?;
    let (provenance, provenance_evidence) =
        inspect_provenance(&options.workspace_root, &options.observed_at)?;
    let mut controls = BTreeMap::new();
    controls.insert("exact-code-provenance", provenance_evidence);
    controls.insert(
        "formal-operational-zero-skipped",
        inspect_formal(
            &options.runtime_root,
            &options.environment,
            provenance.as_ref(),
            &options.observed_at,
        )?,
    );
    let runtime_meta = fs::symlink_metadata(&options.runtime_root).ok();
    let runtime_owner_only = runtime_meta
        .as_ref()
        .is_some_and(|_| private_directory(&options.runtime_root));
    let boundary = inspect_runtime_boundary(&options.workspace_root, &options.runtime_root);
    let source_ready = inspect_source_security(&options.workspace_root);
    let credential_details = json!({
        "privateKeyMaterialAbsent":source_ready,
        "secretLeakScanPassed":source_ready,
        "runtimeOwnerOnly":runtime_owner_only,
        "sourceScanStatus":if source_ready {"tracked_secret_scan_ready"} else {"tracked_secret_scan_blocked"},
        "runtimeMode":runtime_meta.as_ref().map(|v|Value::from(v.mode() & 0o7777)).unwrap_or(Value::Null),
        "runtimeUid":runtime_meta.as_ref().map(|v|Value::from(MetadataExt::uid(v))).unwrap_or(Value::Null),
        "runtimePhysicallyDecoupled":boundary["physicallyDecoupled"].clone(),
        "runtimeBoundaryBlockers":boundary["blockers"].clone(),
    });
    controls.insert(
        "credential-and-runtime-boundary",
        if source_ready && runtime_owner_only && boundary["physicallyDecoupled"] == true {
            evidence("verified", credential_details, &options.observed_at)?
        } else {
            blocked_evidence(credential_details, &options.observed_at)?
        },
    );
    let (_db_ready, db, _a, _b, _has_hash) = inspect_database(&options.runtime_root);
    let db_ready = db["ready"] == true;
    let db_details = json!({"inventoryReady":db_ready,"databaseCount":1,"databaseReadyCount":if db_ready {1} else {0},"schemaVersion":db["schemaVersion"].clone(),"minimumSchemaVersion":MIN_SCHEMA_VERSION,"quickCheck":db["quickCheck"].clone(),"foreignKeyViolationCount":db["foreignKeyViolationCount"].clone(),"blockers":db["blockers"].clone()});
    controls.insert(
        "database-inventory-and-schema",
        if db_ready {
            evidence("verified", db_details, &options.observed_at)?
        } else {
            blocked_evidence(db_details, &options.observed_at)?
        },
    );
    let restore_ready = db["restoreDrill"].is_object();
    let restore_details = json!({"restoreDrillReady":restore_ready,"restoreReceiptHash":db["restoreDrill"].get("receiptHash").cloned().unwrap_or(Value::Null),"performedAt":db["restoreDrill"].get("performedAt").cloned().unwrap_or(Value::Null),"blockers":db["blockers"].clone()});
    controls.insert(
        "database-restore-drill",
        if restore_ready {
            evidence("verified", restore_details, &options.observed_at)?
        } else {
            blocked_evidence(restore_details, &options.observed_at)?
        },
    );
    let anti = &db["antiRollback"];
    let anti_ready = anti["ready"] == true
        && valid_hash(anti.get("ledgerHash"))
        && anti["databaseSha256"] == anti["currentDatabaseSha256"];
    let anti_details = json!({"antiRollbackReady":anti_ready,"integrityPinHash":anti["ledgerHash"].clone(),"sequence":anti.get("sequence").cloned().unwrap_or(Value::from(0)),"databaseSha256":anti["databaseSha256"].clone(),"currentDatabaseSha256":anti["currentDatabaseSha256"].clone(),"blockers":db["blockers"].clone()});
    controls.insert(
        "online-anti-rollback",
        if anti_ready {
            evidence("verified", anti_details, &options.observed_at)?
        } else {
            blocked_evidence(anti_details, &options.observed_at)?
        },
    );
    let cpu = inspect_cpu(
        &options.runtime_root,
        &options.environment,
        provenance.as_ref(),
        &options.observed_at,
        observed_ms,
    )?;
    let gpu = inspect_gpu(
        &options.runtime_root,
        &options.environment,
        provenance.as_ref(),
        &options.observed_at,
        observed_ms,
        options.gpu_enabled,
    );
    let capabilities = if options.gpu_enabled {
        vec!["cpu", "gpu"]
    } else {
        vec!["cpu"]
    };
    let scientific_details = json!({"enabledCapabilitiesReady":cpu["status"] == "verified" && (!options.gpu_enabled || gpu["status"] == "verified"),"enabledCapabilities":capabilities,"cpuReceiptPath":cpu["receiptPath"].clone(),"cpuReceiptHash":cpu["evidenceHash"].clone(),"cpuReceiptObservedAt":cpu["observedAt"].clone(),"gpuReceiptPath":gpu["receiptPath"].clone(),"gpuReceiptHash":gpu["evidenceHash"].clone(),"gpuReceiptObservedAt":gpu["observedAt"].clone(),"scientificReceiptPath":if options.gpu_enabled {gpu["receiptPath"].clone()} else {cpu["receiptPath"].clone()},"scientificReceiptHash":if options.gpu_enabled {gpu["evidenceHash"].clone()} else {cpu["evidenceHash"].clone()},"scientificReceiptObservedAt":if options.gpu_enabled {gpu["observedAt"].clone()} else {cpu["observedAt"].clone()},"secondHardwareStatus":"not_applicable_for_personal_use"});
    let scientific_ready = scientific_details["enabledCapabilitiesReady"] == true;
    controls.insert(
        "enabled-scientific-oracles",
        if scientific_ready {
            evidence("verified", scientific_details.clone(), &options.observed_at)?
        } else {
            blocked_evidence(scientific_details.clone(), &options.observed_at)?
        },
    );
    let scientific = json!({"enabledCapabilities":capabilities,"cpu":{"status":cpu["status"].clone(),"deterministicReplay":cpu["deterministicReplay"].clone(),"errorBudgetVerified":cpu["errorBudgetVerified"].clone(),"modelDataCheckpointIrBound":cpu["modelDataCheckpointIrBound"].clone(),"evidenceHash":cpu["evidenceHash"].clone(),"observedAt":cpu["observedAt"].clone()},"gpu":gpu});
    let mut control_results = Map::new();
    let mut blockers = Vec::new();
    for control in CONTROL_IDS {
        let result = build_control_result(controls.get(control), control, observed_ms);
        if result["blocker"].is_string() {
            blockers.push(result["blocker"].as_str().unwrap_or_default().to_owned());
        }
        control_results.insert(control.to_owned(), result);
    }
    blockers.push(if cpu["status"] == "verified" {
        String::new()
    } else {
        "personal_self_hosted_cpu_oracle_not_ready".to_owned()
    });
    if options.gpu_enabled && gpu["status"] != "verified" {
        blockers.push("personal_self_hosted_gpu_oracle_not_ready".into());
    }
    if !options.gpu_enabled
        && gpu["disabledReason"]
            .as_str()
            .is_none_or(|reason| reason.trim().len() < 8)
    {
        blockers.push("personal_self_hosted_gpu_disabled_reason_required".into());
    }
    blockers.retain(|v| !v.is_empty());
    blockers.sort();
    blockers.dedup();
    let not_applicable = NOT_APPLICABLE
        .iter()
        .map(|(control_id, reason)| json!({"controlId":control_id,"reason":reason}))
        .collect::<Vec<_>>();
    let payload = json!({
        "version":1,"kind":"PersonalSelfHostedProductionReadiness","profileId":"personal-self-hosted-v1","profileHash":PROFILE_HASH,
        "status":if blockers.is_empty() {"personal_self_hosted_production_ready"} else {"personal_self_hosted_production_blocked"},
        "personalSelfHostedProductionReady":blockers.is_empty(),"productionScope":"single-user-private-local-only","distributionReady":false,"externalQualificationRequired":false,"externalActionsPerformed":false,"observedAt":options.observed_at,
        "notApplicableControls":not_applicable,"controlResults":Value::Object(control_results),"optionalDiagnostics":{"local-slo-alert-policy":{"status":if runtime_owner_only && db_ready {"locally_observed"} else {"attention"},"blocking":false,"automatic":true,"runtimeOwnerOnly":runtime_owner_only,"databaseReady":db_ready,"missingDataAlertsExercised":false,"note":"Optional local health diagnostic; no hand-authored receipt is required."}},"scientificCapabilities":scientific,"blockers":blockers,
    });
    let mut report = payload.clone();
    report["personalSelfHostedProductionReadinessHash"] = Value::String(hash_record(
        "PersonalSelfHostedProductionReadiness",
        &payload,
    )?);
    Ok(report)
}
