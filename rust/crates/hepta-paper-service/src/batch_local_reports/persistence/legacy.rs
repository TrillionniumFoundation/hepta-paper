//! Read-only retention of incumbent completed local receipt materializations.
//! Recognition does not adopt authority or provide fencing against Node writers.
use super::*;
use crate::state_recoverability::files::ObservedFile;
const MAXIMUM_FILES: usize = 1024;
const MAXIMUM_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const RECORD_MAXIMUM_BYTES: u64 = 64 * 1024;
pub(super) struct LegacyVault {
    path: PathBuf,
    directory: Option<Directory>,
    directory_before: Option<publication::Witness>,
    sources: Vec<ObservedFile>,
    names: Vec<String>,
    completed: usize,
}
fn fail() -> String {
    "native_local_report_legacy_receipt_recovery_unknown_v1_retained".into()
}
fn closed(value: &Json, names: &[&str]) -> Result<(), String> {
    let Json::Object(fields) = value else {
        return Err(fail());
    };
    if fields.len() != names.len() || fields.iter().zip(names).any(|((k, _), n)| *k != key(n)) {
        return Err(fail());
    }
    Ok(())
}
fn raw_hash(value: &Json, cancelled: &AtomicBool, deadline: Instant) -> Result<String, String> {
    active(cancelled, deadline)?;
    let limits = ProductionJsonEncodingLimitsV1 {
        maximum_bytes: RECORD_MAXIMUM_BYTES as usize,
        maximum_values: 4096,
        maximum_utf16_units: RECORD_MAXIMUM_BYTES as usize,
    };
    let bytes =
        production_json_stringify_with_limits_v1(value, limits, cancelled).map_err(|_| fail())?;
    active(cancelled, deadline)?;
    Ok(publication::hash_bytes(&bytes))
}
fn number(value: &Json, expected: f64) -> bool {
    matches!(value, Json::Number(actual) if *actual == expected)
}
fn same_value(
    first: &Json,
    second: &Json,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<bool, String> {
    Ok(raw_hash(first, cancelled, deadline)? == raw_hash(second, cancelled, deadline)?)
}
fn verify_hash(
    value: &Json,
    field: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let Json::Object(fields) = value else {
        return Err(fail());
    };
    if fields.last().map(|v| &v.0) != Some(&key(field)) {
        return Err(fail());
    }
    let payload = Json::Object(fields[..fields.len() - 1].to_vec());
    if text(get(value, field)?)? != raw_hash(&payload, cancelled, deadline)? {
        return Err(fail());
    }
    Ok(())
}
fn identity(value: &Json, metadata: &fs::Metadata) -> Result<(), String> {
    closed(
        value,
        &["device", "inode", "mode", "size", "mtimeNs", "linkCount"],
    )?;
    let mtime = (metadata.mtime() as i128) * 1_000_000_000 + metadata.mtime_nsec() as i128;
    if text(get(value, "device")?)? != metadata.dev().to_string()
        || text(get(value, "inode")?)? != metadata.ino().to_string()
        || text(get(value, "mode")?)? != metadata.mode().to_string()
        || !number(get(value, "size")?, metadata.len() as f64)
        || text(get(value, "mtimeNs")?)? != mtime.to_string()
        || !number(get(value, "linkCount")?, metadata.nlink() as f64)
    {
        return Err(fail());
    }
    Ok(())
}
fn directory_identity(
    value: &Json,
    directory: &LocalReportDirectoryV1,
    root: bool,
) -> Result<(), String> {
    let m = directory.held.metadata().map_err(|_| fail())?;
    if root {
        closed(value, &["realPath", "device", "inode", "mode"])?;
        if text(get(value, "realPath")?)? != directory.path.to_str().ok_or_else(fail)? {
            return Err(fail());
        }
    } else {
        closed(value, &["device", "inode", "mode"])?;
    }
    if text(get(value, "device")?)? != m.dev().to_string()
        || text(get(value, "inode")?)? != m.ino().to_string()
        || text(get(value, "mode")?)? != m.mode().to_string()
    {
        return Err(fail());
    }
    directory.assert_current().map_err(|_| fail())
}
fn new_snapshot(value: &Json, present: bool, with_identity: bool) -> Result<(), String> {
    closed(
        value,
        if with_identity {
            &["exists", "hash", "bytes", "identity"]
        } else {
            &["exists", "hash", "bytes"]
        },
    )?;
    if !matches!(get(value, "exists")?, Json::Bool(actual) if *actual == present) {
        return Err(fail());
    }
    if !present
        && (!matches!(get(value, "hash")?, Json::Null)
            || !number(get(value, "bytes")?, 0.0)
            || with_identity && !matches!(get(value, "identity")?, Json::Null))
    {
        return Err(fail());
    }
    Ok(())
}
fn semantic(binding: &Json) -> Result<Json, String> {
    let snapshot = |value: &Json| -> Result<Json, String> {
        Ok(object(vec![
            ("exists", get(value, "exists")?.clone()),
            ("hash", get(value, "hash")?.clone()),
            ("bytes", get(value, "bytes")?.clone()),
        ]))
    };
    Ok(object(vec![
        ("operationId", get(binding, "operationId")?.clone()),
        ("operation", get(binding, "operation")?.clone()),
        ("relative", get(binding, "relative")?.clone()),
        (
            "expectedPreimage",
            snapshot(get(binding, "expectedPreimage")?)?,
        ),
        ("postimage", snapshot(get(binding, "postimage")?)?),
    ]))
}
fn completed_binding(
    value: &Json,
    runtime: &LocalReportDirectoryV1,
    ledger: &LocalReportDirectoryV1,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(String, Json, ObservedFile), String> {
    closed(
        value,
        &[
            "version",
            "kind",
            "status",
            "binding",
            "bindingHash",
            "preimage",
            "targetName",
            "token",
            "recoveryEntryName",
            "recoveryEntryIdentity",
            "localPreimageName",
            "localPreimageIdentity",
            "temporaryName",
            "stagedPostimageIdentity",
            "targetLockName",
            "targetLockIdentity",
            "owner",
            "completedPostimageIdentity",
            "scopedMaterializationOperationRecordHash",
        ],
    )?;
    if !number(get(value, "version")?, 2.0)
        || text(get(value, "kind")?)? != "ScopedMaterializationOperationRecord"
        || text(get(value, "status")?)? != "completed"
    {
        return Err(fail());
    }
    verify_hash(
        value,
        "scopedMaterializationOperationRecordHash",
        cancelled,
        deadline,
    )?;
    let binding = get(value, "binding")?;
    closed(
        binding,
        &[
            "operationId",
            "operation",
            "relative",
            "expectedPreimage",
            "postimage",
            "parentRelative",
            "parentIdentity",
            "scopeRoot",
        ],
    )?;
    let token = text(get(binding, "operationId")?)?;
    let name = token.strip_prefix("report-receipt:").ok_or_else(fail)?;
    if !digest_name(name, ".json")
        || text(get(binding, "operation")?)? != "replace"
        || text(get(binding, "relative")?)? != format!("report-receipts/{name}")
        || text(get(binding, "parentRelative")?)? != "report-receipts"
        || text(get(value, "targetName")?)? != name
        || text(get(value, "token")?)? != token
        || text(get(value, "bindingHash")?)? != raw_hash(binding, cancelled, deadline)?
    {
        return Err(fail());
    }
    let operation = publication::hash_bytes(token.as_bytes());
    if text(get(value, "temporaryName")?)? != format!(".{name}.hepta-{}.tmp", &operation[7..])
        || text(get(value, "targetLockName")?)? != format!(".{name}.hepta-materialization.lock")
    {
        return Err(fail());
    }
    for field in [
        "recoveryEntryName",
        "recoveryEntryIdentity",
        "localPreimageName",
        "localPreimageIdentity",
    ] {
        if !matches!(get(value, field)?, Json::Null) {
            return Err(fail());
        }
    }
    new_snapshot(get(binding, "expectedPreimage")?, false, true)?;
    if !same_value(
        get(value, "preimage")?,
        get(binding, "expectedPreimage")?,
        cancelled,
        deadline,
    )? {
        return Err(fail());
    }
    let post = get(binding, "postimage")?;
    new_snapshot(post, true, true)?;
    let source = ObservedFile::open(&ledger.path.join(name), 128 * 1024).map_err(|_| fail())?;
    let metadata = source.file.metadata().map_err(|_| fail())?;
    let bytes = source.bytes(128 * 1024).map_err(|_| fail())?;
    if text(get(post, "hash")?)? != publication::hash_bytes(&bytes)
        || !number(get(post, "bytes")?, bytes.len() as f64)
        || !same_value(
            get(value, "stagedPostimageIdentity")?,
            get(post, "identity")?,
            cancelled,
            deadline,
        )?
        || !same_value(
            get(value, "completedPostimageIdentity")?,
            get(post, "identity")?,
            cancelled,
            deadline,
        )?
    {
        return Err(fail());
    }
    identity(get(post, "identity")?, &metadata)?;
    source.assert_current().map_err(|_| fail())?;
    directory_identity(get(binding, "scopeRoot")?, runtime, true)?;
    directory_identity(get(binding, "parentIdentity")?, ledger, false)?;
    let owner = get(value, "owner")?;
    closed(owner, &["pid", "pidStartTime"])?;
    let Json::Number(pid) = get(owner, "pid")? else {
        return Err(fail());
    };
    let start = text(get(owner, "pidStartTime")?)?;
    if !pid.is_finite()
        || *pid < 1.0
        || *pid > i32::MAX as f64
        || pid.fract() != 0.0
        || start.is_empty()
        || start.len() > 32
        || !start.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(fail());
    }
    let lock = get(value, "targetLockIdentity")?;
    closed(
        lock,
        &["device", "inode", "mode", "size", "mtimeNs", "linkCount"],
    )?;
    for field in ["device", "inode", "mode", "mtimeNs"] {
        let v = text(get(lock, field)?)?;
        if v.is_empty() || v.len() > 32 || !v.bytes().all(|b| b.is_ascii_digit()) {
            return Err(fail());
        }
    }
    let Json::Number(size) = get(lock, "size")? else {
        return Err(fail());
    };
    if !size.is_finite()
        || *size < 1.0
        || *size > 4096.0
        || size.fract() != 0.0
        || !matches!(get(lock, "linkCount")?, Json::Number(count) if *count == 1.0 || *count == 2.0)
    {
        return Err(fail());
    }
    Ok((token.clone(), semantic(binding)?, source))
}
impl LegacyVault {
    pub(super) fn capture(
        runtime: &LocalReportDirectoryV1,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Self, String> {
        active(cancelled, deadline)?;
        runtime.assert_current().map_err(|_| fail())?;
        let path = runtime.path.join(".hepta-materialization-recovery");
        if matches!(fs::symlink_metadata(&path),Err(e) if e.kind()==std::io::ErrorKind::NotFound) {
            return Ok(Self {
                path,
                directory: None,
                directory_before: None,
                sources: vec![],
                names: vec![],
                completed: 0,
            });
        }
        let directory = Directory::open_or_create(&path, false).map_err(|_| fail())?;
        if directory.held.metadata().map_err(|_| fail())?.mode() & 0o077 != 0 {
            return Err(fail());
        }
        let before = publication::Witness::of(&directory.held.metadata().map_err(|_| fail())?);
        let ledger =
            LocalReportDirectoryV1::open_or_create(&runtime.path.join("report-receipts"), false)
                .map_err(|_| fail())?;
        let mut names = vec![];
        let mut sources = vec![];
        let mut values = BTreeMap::new();
        let mut total = 0u64;
        for entry in fs::read_dir(&path).map_err(|_| fail())? {
            active(cancelled, deadline)?;
            if names.len() >= MAXIMUM_FILES {
                return Err(fail());
            }
            let entry = entry.map_err(|_| fail())?;
            let name = entry.file_name().into_string().map_err(|_| fail())?;
            let source =
                ObservedFile::open(&entry.path(), RECORD_MAXIMUM_BYTES).map_err(|_| fail())?;
            total = total
                .checked_add(source.file.metadata().map_err(|_| fail())?.len())
                .ok_or_else(fail)?;
            if total > MAXIMUM_TOTAL_BYTES {
                return Err(fail());
            }
            let bytes = source.bytes(RECORD_MAXIMUM_BYTES).map_err(|_| fail())?;
            let value = parse_production_json_v1(&bytes).map_err(|_| fail())?;
            if values.insert(name.clone(), value).is_some() {
                return Err(fail());
            }
            sources.push(source);
            names.push(name);
        }
        let mut definitions = BTreeMap::new();
        let mut completions = BTreeMap::new();
        for (name, value) in &values {
            active(cancelled, deadline)?;
            if name.starts_with(".definition-") {
                closed(
                    value,
                    &[
                        "version",
                        "kind",
                        "definition",
                        "definitionHash",
                        "scopedMaterializationOperationDefinitionHash",
                    ],
                )?;
                if !number(get(value, "version")?, 1.0)
                    || text(get(value, "kind")?)? != "ScopedMaterializationOperationDefinition"
                {
                    return Err(fail());
                }
                verify_hash(
                    value,
                    "scopedMaterializationOperationDefinitionHash",
                    cancelled,
                    deadline,
                )?;
                let definition = get(value, "definition")?;
                closed(
                    definition,
                    &[
                        "operationId",
                        "operation",
                        "relative",
                        "expectedPreimage",
                        "postimage",
                    ],
                )?;
                new_snapshot(get(definition, "expectedPreimage")?, false, false)?;
                new_snapshot(get(definition, "postimage")?, true, false)?;
                let token = text(get(definition, "operationId")?)?;
                if *name
                    != format!(
                        ".definition-{}.json",
                        &publication::hash_bytes(token.as_bytes())[7..]
                    )
                    || text(get(value, "definitionHash")?)?
                        != raw_hash(definition, cancelled, deadline)?
                    || definitions
                        .insert(token, raw_hash(definition, cancelled, deadline)?)
                        .is_some()
                {
                    return Err(fail());
                }
            } else if name.starts_with(".operation-") && name.ends_with(".completed.json") {
                let (token, definition, ledger_source) =
                    completed_binding(value, runtime, &ledger, cancelled, deadline)?;
                sources.push(ledger_source);
                let relative = text(get(&definition, "relative")?)?;
                if *name
                    != format!(
                        ".operation-{}-{}.completed.json",
                        &publication::hash_bytes(token.as_bytes())[7..],
                        &publication::hash_bytes(relative.as_bytes())[7..]
                    )
                    || completions
                        .insert(token, raw_hash(&definition, cancelled, deadline)?)
                        .is_some()
                {
                    return Err(fail());
                }
            } else {
                return Err(fail());
            }
        }
        if definitions != completions {
            return Err(fail());
        }
        names.sort();
        let result = Self {
            path,
            directory: Some(directory),
            directory_before: Some(before),
            sources,
            names,
            completed: completions.len(),
        };
        result.verify(runtime, cancelled, deadline)?;
        Ok(result)
    }
    pub(super) fn verify(
        &self,
        runtime: &LocalReportDirectoryV1,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        active(cancelled, deadline)?;
        runtime.assert_current().map_err(|_| fail())?;
        if let Some(directory) = &self.directory {
            directory.assert_current().map_err(|_| fail())?;
            if Some(publication::Witness::of(
                &directory.held.metadata().map_err(|_| fail())?,
            )) != self.directory_before
            {
                return Err(fail());
            }
            let mut current = vec![];
            for entry in fs::read_dir(&self.path).map_err(|_| fail())? {
                if current.len() >= MAXIMUM_FILES {
                    return Err(fail());
                }
                current.push(
                    entry
                        .map_err(|_| fail())?
                        .file_name()
                        .into_string()
                        .map_err(|_| fail())?,
                )
            }
            current.sort();
            if current != self.names {
                return Err(fail());
            }
            for source in &self.sources {
                active(cancelled, deadline)?;
                source.assert_current().map_err(|_| fail())?;
            }
            directory.assert_current().map_err(|_| fail())?;
        } else if !matches!(fs::symlink_metadata(&self.path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            return Err(fail());
        }
        Ok(())
    }
    pub(super) fn completed(&self) -> usize {
        self.completed
    }
}
