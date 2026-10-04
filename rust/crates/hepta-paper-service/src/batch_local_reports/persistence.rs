use super::*;
use crate::state_recoverability::publication::{
    Directory, LocalReportDirectoryV1, ObservedEmptyLock,
};
use nix::{
    fcntl::{Flock, FlockArg, OFlag, openat},
    sys::stat::Mode,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
};
mod legacy;
mod publication;
mod receipts;
#[derive(Debug)]
pub struct NativeLocalReportPersistenceV1 {
    pub receipts: Vec<Vec<u8>>,
    pub retained_unprepared: Vec<PathBuf>,
    pub writer_trusted: bool,
    pub business_store_mutated: bool,
    pub legacy_completed_receipts_retained: usize,
    pub old_authority_records_adopted: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRecords {
    version: u32,
    kind: String,
    operation: String,
    role: String,
    manifest_name: String,
    manifest: Vec<u8>,
    ledger_name: String,
    ledger: Vec<u8>,
    receipt: Vec<u8>,
    postimage: publication::Witness,
    authority_granted: bool,
}
struct Writer {
    runtime: LocalReportDirectoryV1,
    namespace: Directory,
    reports: LocalReportDirectoryV1,
    cas: LocalReportDirectoryV1,
    manifests: LocalReportDirectoryV1,
    ledger: LocalReportDirectoryV1,
    binding: String,
    _lock: Flock<File>,
    lock: ObservedEmptyLock,
    retained: Vec<PathBuf>,
    legacy: legacy::LegacyVault,
}
fn current(writer: &Writer, cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    active(cancelled, deadline)?;
    writer.runtime.assert_current().map_err(|_| refused())?;
    writer.legacy.verify(&writer.runtime, cancelled, deadline)?;
    writer.namespace.assert_current().map_err(|_| refused())?;
    writer.lock.assert_current().map_err(|_| refused())
}
fn created_at() -> Result<String, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| refused())?
        .as_millis();
    crate::sqlite_mutation_coordinator::clock::iso(i64::try_from(millis).map_err(|_| refused())?)
        .map_err(|_| refused())
}
fn open(runtime: &Path, cancelled: &AtomicBool, deadline: Instant) -> Result<Writer, String> {
    active(cancelled, deadline)?;
    let runtime = LocalReportDirectoryV1::open_or_create(runtime, false).map_err(|_| refused())?;
    let m = runtime.held.metadata().map_err(|_| refused())?;
    let legacy = legacy::LegacyVault::capture(&runtime, cancelled, deadline)?;
    let namespace =
        Directory::open_or_create(&runtime.path.join("local-report-publication-v1"), true)
            .map_err(|_| refused())?;
    let n = namespace.held.metadata().map_err(|_| refused())?;
    if n.mode() & 0o077 != 0 || n.dev() != m.dev() {
        return Err(refused());
    }
    let lock_file = File::from(
        openat(
            namespace.held.as_fd(),
            ".lock",
            OFlag::O_RDWR
                | OFlag::O_CREAT
                | OFlag::O_NOFOLLOW
                | OFlag::O_CLOEXEC
                | OFlag::O_NONBLOCK,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| refused())?,
    );
    let lock = Flock::lock(lock_file, FlockArg::LockExclusiveNonblock)
        .map_err(|_| "native_local_report_publication_busy_v1")?;
    let observed_lock = namespace
        .observe_empty_lock(".lock")
        .map_err(|_| refused())?;
    let binding_payload = object(vec![
        ("version", Json::Number(1.0)),
        ("kind", string("NativeLocalReportRootBinding")),
        (
            "runtimeRoot",
            string(runtime.path.to_str().ok_or_else(refused)?),
        ),
        ("device", string(&m.dev().to_string())),
        ("inode", string(&m.ino().to_string())),
        ("uid", Json::Number(m.uid() as f64)),
        ("gid", Json::Number(m.gid() as f64)),
        ("mode", Json::Number((m.mode() & 0o7777) as f64)),
        ("authorityGranted", Json::Bool(false)),
    ]);
    let binding = hash(
        "NativeLocalReportRootBinding",
        &binding_payload,
        cancelled,
        deadline,
    )?;
    publication::immutable(
        &namespace,
        "binding.json",
        &pretty(&binding_payload, cancelled, deadline)?,
        false,
    )?;
    let reports = LocalReportDirectoryV1::open_or_create(&runtime.path.join("reports"), true)
        .map_err(|_| refused())?;
    let cas =
        LocalReportDirectoryV1::open_or_create(&runtime.path.join("report-artifact-cas"), true)
            .map_err(|_| refused())?;
    let manifests = LocalReportDirectoryV1::open_or_create(&cas.path.join("manifests"), true)
        .map_err(|_| refused())?;
    let ledger =
        LocalReportDirectoryV1::open_receipt_ledger(&runtime.path.join("report-receipts"), true)
            .map_err(|_| refused())?;
    for directory in [&reports, &cas, &manifests, &ledger] {
        if directory.held.metadata().map_err(|_| refused())?.dev() != m.dev() {
            return Err(refused());
        }
    }
    namespace.sync_with_parents().map_err(|_| refused())?;
    Ok(Writer {
        runtime,
        namespace,
        reports,
        cas,
        manifests,
        ledger,
        binding,
        _lock: lock,
        lock: observed_lock,
        retained: vec![],
        legacy,
    })
}
fn digest_name(v: &str, suffix: &str) -> bool {
    v.strip_suffix(suffix).is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn validate_record(
    record: &StoredRecords,
    prepared: &publication::Prepared,
    writer: &Writer,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Json, String> {
    if record.version != 1
        || record.kind != "NativeLocalReportArtifactRecords"
        || record.authority_granted
        || record.operation != prepared.operation()
        || record.role != prepared.role()
        || !digest_name(&record.manifest_name, ".json")
        || !digest_name(&record.ledger_name, ".json")
        || record.manifest.len() > 64 * 1024
        || record.ledger.len() > 128 * 1024
        || record.receipt.len() > 64 * 1024
    {
        return Err(refused());
    }
    let receipt = parse_production_json_v1(&record.receipt).map_err(|_| refused())?;
    let relative = prepared
        .target()
        .strip_prefix(&writer.reports.path)
        .map_err(|_| refused())?
        .to_str()
        .ok_or_else(refused)?;
    let content = prepared.content()?;
    let rebuilt = receipts::records(
        &writer.reports.path,
        &writer.cas.path,
        receipts::RecordInput {
            role: prepared.role(),
            content_type: prepared.content_type(),
            relative,
            content: &content,
            object_created: match get(&receipt, "objectCreated")? {
                Json::Bool(v) => *v,
                _ => return Err(refused()),
            },
            created_at: prepared.created_at(),
            identity_hash: &text(get(&receipt, "scopedWriteTargetIdentityHash")?)?,
        },
        cancelled,
        deadline,
    )?;
    if rebuilt.manifest != record.manifest
        || rebuilt.manifest_name != record.manifest_name
        || rebuilt.ledger != record.ledger
        || rebuilt.ledger_name != record.ledger_name
        || pretty(&rebuilt.receipt, cancelled, deadline)? != record.receipt
    {
        return Err(refused());
    }
    Ok(receipt)
}
fn public_object(
    writer: &Writer,
    content: &[u8],
) -> Result<(LocalReportDirectoryV1, String, bool), String> {
    let hash = publication::hash_bytes(content);
    let raw = &hash[7..];
    let directory = LocalReportDirectoryV1::open_or_create(
        &writer.cas.path.join("objects/sha256").join(&raw[..2]),
        true,
    )
    .map_err(|_| refused())?;
    let name = raw[2..].to_string();
    let created = match crate::state_recoverability::files::ObservedFile::open(
        &directory.path.join(&name),
        16 * 1024 * 1024,
    ) {
        Ok(file) => {
            if file.bytes(16 * 1024 * 1024).map_err(|_| refused())? != content {
                return Err(refused());
            }
            false
        }
        Err(_) if matches!(fs::symlink_metadata(directory.path.join(&name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound) => {
            true
        }
        Err(_) => return Err(refused()),
    };
    Ok((directory, name, created))
}
fn finish(
    writer: &Writer,
    prepared: &publication::Prepared,
    cancelled: &AtomicBool,
    deadline: Instant,
    hook: &dyn Fn(&str) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    current(writer, cancelled, deadline)?;
    let content = prepared.content()?;
    let (object_directory, object_name, _) = public_object(writer, &content)?;
    let done = prepared.read_record("done.json")?;
    if let Some(wire) = prepared.read_record("records.json")? {
        let record: StoredRecords = serde_json::from_slice(&wire).map_err(|_| refused())?;
        validate_record(&record, prepared, writer, cancelled, deadline)?;
        if let Some(done) = &done
            && done != &wire
        {
            return Err(refused());
        }
        if done.is_none() {
            let target = prepared.materialize(cancelled, deadline, hook)?;
            if publication::Witness::of(&target.file.metadata().map_err(|_| refused())?)
                != record.postimage
            {
                return Err(refused());
            }
        }
        publication::immutable_from(
            prepared.directory(),
            &object_directory,
            &object_name,
            &content,
            true,
            hook,
        )?;
        publication::immutable_from(
            prepared.directory(),
            &writer.manifests,
            &record.manifest_name,
            &record.manifest,
            true,
            hook,
        )?;
        publication::immutable_from(
            prepared.directory(),
            &writer.ledger,
            &record.ledger_name,
            &record.ledger,
            true,
            hook,
        )?;
        prepared.record("done.json", &wire, hook)?;
        prepared.compact(cancelled, deadline, hook)?;
        return Ok(record.receipt);
    }
    if done.is_some() {
        return Err(refused());
    }
    publication::immutable_from(
        prepared.directory(),
        &object_directory,
        &object_name,
        &content,
        true,
        hook,
    )?;
    hook("public_cas")?;
    let target = prepared.materialize(cancelled, deadline, hook)?;
    let parent = LocalReportDirectoryV1::open_or_create(
        prepared.target().parent().ok_or_else(refused)?,
        false,
    )
    .map_err(|_| refused())?;
    let identity_hash =
        receipts::target_identity(&writer.reports, &parent, &target, cancelled, deadline)?;
    let relative = prepared
        .target()
        .strip_prefix(&writer.reports.path)
        .map_err(|_| refused())?
        .to_str()
        .ok_or_else(refused)?;
    let records = receipts::records(
        &writer.reports.path,
        &writer.cas.path,
        receipts::RecordInput {
            role: prepared.role(),
            content_type: prepared.content_type(),
            relative,
            content: &content,
            object_created: prepared.object_created(),
            created_at: prepared.created_at(),
            identity_hash: &identity_hash,
        },
        cancelled,
        deadline,
    )?;
    let stored = StoredRecords {
        version: 1,
        kind: "NativeLocalReportArtifactRecords".into(),
        operation: prepared.operation().into(),
        role: prepared.role().into(),
        manifest_name: records.manifest_name,
        manifest: records.manifest,
        ledger_name: records.ledger_name,
        ledger: records.ledger,
        receipt: pretty(&records.receipt, cancelled, deadline)?,
        postimage: publication::Witness::of(&target.file.metadata().map_err(|_| refused())?),
        authority_granted: false,
    };
    let wire = serde_json::to_vec(&stored).map_err(|_| refused())?;
    if wire.len() > 512 * 1024 {
        return Err(refused());
    }
    prepared.record("records.json", &wire, hook)?;
    hook("records_prepared")?;
    publication::immutable_from(
        prepared.directory(),
        &writer.manifests,
        &stored.manifest_name,
        &stored.manifest,
        true,
        hook,
    )?;
    hook("manifest")?;
    publication::immutable_from(
        prepared.directory(),
        &writer.ledger,
        &stored.ledger_name,
        &stored.ledger,
        true,
        hook,
    )?;
    hook("ledger")?;
    target.assert_current().map_err(|_| refused())?;
    current(writer, cancelled, deadline)?;
    prepared.record("done.json", &wire, hook)?;
    hook("done")?;
    prepared.compact(cancelled, deadline, hook)?;
    Ok(stored.receipt)
}
fn recover(
    writer: &mut Writer,
    operation: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
    hook: &dyn Fn(&str) -> Result<(), String>,
) -> Result<BTreeMap<(String, String), Vec<u8>>, String> {
    current(writer, cancelled, deadline)?;
    let before = writer.namespace.held.metadata().map_err(|_| refused())?;
    let mut names = Vec::new();
    for entry in fs::read_dir(&writer.namespace.path).map_err(|_| refused())? {
        if names.len() >= 256 {
            return Err("native_local_report_retained_attempt_limit_v1_exceeded".into());
        }
        names.push(
            entry
                .map_err(|_| refused())?
                .file_name()
                .into_string()
                .map_err(|_| refused())?,
        );
    }
    names.sort();
    let after = writer.namespace.held.metadata().map_err(|_| refused())?;
    if (
        before.dev(),
        before.ino(),
        before.mtime(),
        before.mtime_nsec(),
        before.ctime(),
        before.ctime_nsec(),
    ) != (
        after.dev(),
        after.ino(),
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    ) {
        return Err(refused());
    }
    let mut recovered = BTreeMap::new();
    for name in names {
        current(writer, cancelled, deadline)?;
        if [".lock", "binding.json"].contains(&name.as_str()) {
            continue;
        }
        if name.strip_prefix(".unprepared-").is_some_and(|v| {
            v.len() == 32
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }) || name.strip_prefix(".unprepared-copy-").is_some_and(|v| {
            v.len() == 32
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }) {
            let path = writer.namespace.path.join(name);
            let metadata = fs::symlink_metadata(&path).map_err(|_| refused())?;
            if metadata.uid() != nix::unistd::getuid().as_raw()
                || metadata.mode() & 0o077 != 0
                || metadata.dev()
                    != writer
                        .namespace
                        .held
                        .metadata()
                        .map_err(|_| refused())?
                        .dev()
                || (!metadata.is_dir() && !metadata.is_file())
                || metadata.is_file() && (metadata.nlink() != 1 || metadata.len() > 512 * 1024)
            {
                return Err("native_local_report_foreign_unprepared_entry_v1_retained".into());
            }
            writer.retained.push(path);
            continue;
        }
        if !name.strip_prefix("prepared-").is_some_and(|v| {
            v.len() == 32
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }) {
            return Err("native_local_report_foreign_recovery_entry_v1_retained".into());
        }
        let prepared = publication::Prepared::open(
            &writer.namespace,
            &name,
            &writer.binding,
            &writer.runtime.path,
        )?;
        let receipt = finish(writer, &prepared, cancelled, deadline, hook)?;
        writer.retained.extend(prepared.retained_unprepared()?);
        if prepared.operation() == operation {
            let target = prepared.materialize(cancelled, deadline, hook)?;
            let record: StoredRecords =
                serde_json::from_slice(&prepared.read_record("records.json")?.ok_or_else(refused)?)
                    .map_err(|_| refused())?;
            if publication::Witness::of(&target.file.metadata().map_err(|_| refused())?)
                != record.postimage
            {
                return Err(refused());
            }
        }
        let key = (prepared.operation().into(), prepared.role().into());
        if recovered.insert(key, receipt).is_some() {
            return Err("native_local_report_duplicate_prepared_artifact_v1_retained".into());
        }
    }
    Ok(recovered)
}
/// Local report persistence has no business database or external action handle.
/// It writes the five report/CAS/manifest/receipt artifacts under the selected
/// held runtime and uses versioned private intents instead of Node's report
/// receipt repository materialization records. Unknown bytes remain untouched.
pub fn persist_native_local_batch_report_v1(
    runtime: &Path,
    wire: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<NativeLocalReportPersistenceV1, String> {
    persist(runtime, wire, cancelled, deadline, &|_| Ok(()))
}
fn persist(
    runtime: &Path,
    wire: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
    hook: &dyn Fn(&str) -> Result<(), String>,
) -> Result<NativeLocalReportPersistenceV1, String> {
    let report = admission(wire, cancelled, deadline)?;
    if text(get(&report, "runtimeRoot")?)? != runtime.to_str().ok_or_else(refused)? {
        return Err(refused());
    }
    let operation = text(get(&report, "reportHash")?)?;
    let mut writer = open(runtime, cancelled, deadline)
        .map_err(|e| format!("native_local_report_writer_admission:{e}"))?;
    let recovered = recover(&mut writer, &operation, cancelled, deadline, hook)
        .map_err(|e| format!("native_local_report_recovery:{e}"))?;
    let mut artifacts =
        vec![prepare_native_local_report_detail_v1(wire, cancelled, deadline)?.artifact];
    let mut receipts = vec![];
    for index in 0..5 {
        active(cancelled, deadline)?;
        let artifact = &artifacts[index];
        let result =
            if let Some(existing) = recovered.get(&(operation.clone(), artifact.role.into())) {
                let receipt = parse_production_json_v1(existing).map_err(|_| refused())?;
                if text(get(&receipt, "hash")?)? != publication::hash_bytes(&artifact.bytes)
                    || text(get(&receipt, "path")?)? != artifact.relative_path
                {
                    return Err(refused());
                }
                existing.clone()
            } else {
                let target = LocalReportDirectoryV1::open_or_create(
                    &writer.reports.path.join(
                        Path::new(&artifact.relative_path)
                            .parent()
                            .unwrap_or(Path::new("")),
                    ),
                    true,
                )
                .map_err(|_| refused())?;
                let (_, _, object_created) = public_object(&writer, &artifact.bytes)?;
                let created = created_at()?;
                let prepared = publication::Prepared::prepare(publication::PrepareInput {
                    namespace: &writer.namespace,
                    binding: &writer.binding,
                    operation: &operation,
                    target: &target,
                    artifact,
                    created_at: &created,
                    object_created,
                    cancelled,
                    deadline,
                    hook,
                })?;
                let receipt = finish(&writer, &prepared, cancelled, deadline, hook)
                    .map_err(|e| format!("native_local_report_artifact_completion:{e}"))?;
                writer.retained.extend(prepared.retained_unprepared()?);
                receipt
            };
        if index == 0 {
            artifacts.extend(prepare_native_local_report_outputs_v1(
                wire, &result, cancelled, deadline,
            )?);
        }
        receipts.push(result);
    }
    current(&writer, cancelled, deadline)?;
    Ok(NativeLocalReportPersistenceV1 {
        receipts,
        retained_unprepared: writer.retained,
        writer_trusted: false,
        business_store_mutated: false,
        legacy_completed_receipts_retained: writer.legacy.completed(),
        old_authority_records_adopted: false,
    })
}

#[cfg(test)]
mod tests;
