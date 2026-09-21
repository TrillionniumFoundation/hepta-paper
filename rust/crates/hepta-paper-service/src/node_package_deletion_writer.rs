//! Incumbent package-deletion writer exclusion for an admitted native writer.
//!
//! This is only a filesystem scope guard; it grants no database, cutover or
//! external authority. Its flock shares Node's actual repository lock inode.
use hepta_legacy_compatibility::production_hash_record_v1;
use nix::{
    fcntl::{Flock, FlockArg},
    libc,
    unistd::Uid,
};
use serde_json::Value;
use std::{
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};

const ROOT: &str = ".hepta-package-deletion-fences";
const LOCK: &str = ".repository.lock";
const MAX_RECORD: u64 = 256 * 1024;
const KEYS: &[&str] = &[
    "abortReasonHash",
    "abortedAt",
    "authoritySnapshotHash",
    "deletedAt",
    "deletingAt",
    "deletionIntentHash",
    "fenceTokenHash",
    "generation",
    "kind",
    "operationId",
    "packageContentHash",
    "packageLifecycleReceiptHash",
    "packagePath",
    "preparedAt",
    "previousFenceHash",
    "recoveryBindingHash",
    "revision",
    "runtimeRetentionPackageDeletionFenceHash",
    "runtimeRoot",
    "status",
    "transitionId",
    "updatedAt",
    "version",
];

#[derive(Debug, thiserror::Error)]
#[error("runtime_retention_package_deletion_fence_{0}")]
pub(crate) struct PackageDeletionWriterError(&'static str);
type Result<T> = std::result::Result<T, PackageDeletionWriterError>;
fn err(code: &'static str) -> PackageDeletionWriterError {
    PackageDeletionWriterError(code)
}
fn require(value: bool, code: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(err(code)) }
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.file_type() == b.file_type()
}
fn pinned(a: &Metadata, b: &Metadata) -> bool {
    same(a, b)
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn owned(m: &Metadata) -> bool {
    m.uid() == Uid::effective().as_raw()
}
fn descriptor_path(file: &File) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}
fn metadata(path: &Path, code: &'static str) -> Result<Metadata> {
    fs::symlink_metadata(path).map_err(|_| err(code))
}
fn held_metadata(file: &File, code: &'static str) -> Result<Metadata> {
    file.metadata().map_err(|_| err(code))
}
fn lexical_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && path.components().collect::<PathBuf>().as_os_str() == path.as_os_str()
        && path
            .to_str()
            .is_some_and(|s| !s.contains("//") && (s == "/" || !s.ends_with('/')))
}
fn open_dir(path: &Path, private: bool, code: &'static str) -> Result<(File, Metadata)> {
    let before = metadata(path, code)?;
    require(
        before.is_dir()
            && !before.file_type().is_symlink()
            && owned(&before)
            && (!private || before.mode() & 0o7777 == 0o700),
        code,
    )?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| err(code))?;
    let opened = held_metadata(&file, code)?;
    require(
        same(&before, &opened) && owned(&opened) && (!private || opened.mode() & 0o7777 == 0o700),
        code,
    )?;
    Ok((file, opened))
}

/// Keep this value alive through the complete writer callback, including commit.
/// Call `assert_current` immediately before committing any business transaction.
/// Dropping it releases the shared Node/Rust flock, including unwinding paths.
pub(crate) struct PackageDeletionWriterGuard {
    runtime_path: PathBuf,
    runtime: File,
    runtime_identity: Metadata,
    repository: File,
    repository_identity: Metadata,
    lock_identity: Metadata,
    lock: Flock<File>,
}
impl PackageDeletionWriterGuard {
    pub(crate) fn acquire(runtime_root: &Path, operation_id: &str) -> Result<Self> {
        require(valid_operation(operation_id), "selector_invalid")?;
        require(
            lexical_absolute(runtime_root)
                && runtime_root.parent().is_some()
                && fs::canonicalize(runtime_root).ok().as_deref() == Some(runtime_root),
            "runtime_root_invalid",
        )?;
        let (runtime, runtime_identity) = open_dir(runtime_root, false, "runtime_root_invalid")?;
        let repository_path = descriptor_path(&runtime).join(ROOT);
        match DirBuilder::new().mode(0o700).create(&repository_path) {
            Ok(()) => runtime.sync_all().map_err(|_| err("root_invalid"))?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(err("root_invalid")),
        }
        let (repository, repository_identity) = open_dir(&repository_path, true, "root_invalid")?;
        let lock_path = descriptor_path(&repository).join(LOCK);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&lock_path)
            .map_err(|_| err("lock_invalid"))?;
        let lock_identity = held_metadata(&file, "lock_invalid")?;
        let selected = metadata(&lock_path, "lock_invalid")?;
        require(
            same(&lock_identity, &selected)
                && safe_file(&lock_identity)
                && lock_identity.len() == 0,
            "lock_invalid",
        )?;
        repository.sync_all().map_err(|_| err("lock_invalid"))?;
        let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, e)| {
            err(if e == nix::errno::Errno::EWOULDBLOCK {
                "lock_unavailable"
            } else {
                "lock_acquisition_failed"
            })
        })?;
        let guard = Self {
            runtime_path: runtime_root.to_owned(),
            runtime,
            runtime_identity,
            repository,
            repository_identity,
            lock_identity,
            lock,
        };
        guard.assert_current()?;
        guard.check_records(operation_id)?;
        guard.assert_current()?;
        Ok(guard)
    }

    pub(crate) fn assert_current(&self) -> Result<()> {
        let code = "scope_changed";
        let runtime_held = held_metadata(&self.runtime, code)?;
        let runtime_named = metadata(&self.runtime_path, code)?;
        require(
            same(&self.runtime_identity, &runtime_held)
                && same(&self.runtime_identity, &runtime_named)
                && owned(&runtime_held)
                && owned(&runtime_named)
                && fs::canonicalize(&self.runtime_path).ok().as_deref()
                    == Some(self.runtime_path.as_path()),
            code,
        )?;
        let repository_held = held_metadata(&self.repository, code)?;
        let repository_named = metadata(&self.runtime_path.join(ROOT), code)?;
        require(
            same(&self.repository_identity, &repository_held)
                && same(&self.repository_identity, &repository_named)
                && repository_held.mode() & 0o7777 == 0o700
                && repository_named.mode() & 0o7777 == 0o700
                && owned(&repository_held)
                && owned(&repository_named),
            code,
        )?;
        let code = "lock_identity_changed";
        let held = held_metadata(&self.lock, code)?;
        let selected = metadata(&self.runtime_path.join(ROOT).join(LOCK), code)?;
        require(
            same(&self.lock_identity, &held)
                && same(&self.lock_identity, &selected)
                && safe_file(&held)
                && safe_file(&selected)
                && held.len() == 0
                && selected.len() == 0,
            code,
        )
    }

    fn check_records(&self, operation_id: &str) -> Result<()> {
        let directory = descriptor_path(&self.repository);
        let mut names = fs::read_dir(&directory)
            .map_err(|_| err("inventory_invalid"))?
            .map(|e| {
                e.map(|e| e.file_name())
                    .map_err(|_| err("inventory_invalid"))
            })
            .collect::<Result<Vec<_>>>()?;
        names.sort();
        let mut active = false;
        let mut deleted = false;
        for name in names {
            let name = name.to_str().ok_or_else(|| err("inventory_invalid"))?;
            if name == LOCK {
                continue;
            }
            let path = directory.join(name);
            if name.strip_prefix(".fence-tmp-").is_some_and(|s| {
                !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }) {
                let (file, identity) = open_record(&path, false, "temporary_invalid")?;
                self.assert_current()?;
                require(
                    pinned(&identity, &metadata(&path, "temporary_invalid")?),
                    "temporary_invalid",
                )?;
                fs::remove_file(&path).map_err(|_| err("temporary_invalid"))?;
                self.repository
                    .sync_all()
                    .map_err(|_| err("temporary_invalid"))?;
                drop(file);
                continue;
            }
            let hash = name
                .strip_suffix(".json")
                .filter(|s| valid_hex(s))
                .ok_or_else(|| err("inventory_invalid"))?;
            let lifecycle_hash = format!("sha256:{hash}");
            let (file, identity) = open_record(&path, true, "record_invalid")?;
            let mut bytes = Vec::new();
            (&file)
                .take(MAX_RECORD + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| err("record_invalid"))?;
            require(
                bytes.len() <= MAX_RECORD as usize
                    && pinned(&identity, &held_metadata(&file, "record_invalid")?)
                    && pinned(&identity, &metadata(&path, "record_invalid")?),
                "record_invalid",
            )?;
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| err("record_invalid"))?;
            require(
                valid_record(&value, &self.runtime_path, &lifecycle_hash),
                "record_invalid",
            )?;
            active |= matches!(value["status"].as_str(), Some("prepared" | "deleting"));
            deleted |= value["status"] == "deleted" && value["operationId"] == operation_id;
        }
        require(!active, "reachability_mutation_blocked")?;
        require(!deleted, "package_deleted")
    }
}
fn safe_file(m: &Metadata) -> bool {
    m.is_file() && m.nlink() == 1 && m.mode() & 0o7777 == 0o600 && owned(m)
}
fn open_record(path: &Path, bounded: bool, code: &'static str) -> Result<(File, Metadata)> {
    let before = metadata(path, code)?;
    require(
        safe_file(&before) && (!bounded || (1..=MAX_RECORD).contains(&before.len())),
        code,
    )?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| err(code))?;
    let opened = held_metadata(&file, code)?;
    require(pinned(&before, &opened), code)?;
    Ok((file, opened))
}
fn valid_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_hash(v: &Value) -> bool {
    v.as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .is_some_and(valid_hex)
}
fn valid_operation(s: &str) -> bool {
    (2..=192).contains(&s.len())
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
// The incumbent verifier applies String(operationId || '') before its regex,
// while selector matching still compares the original value without coercion.
fn operation_text(value: &Value) -> String {
    fn string(value: &Value) -> String {
        match value {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n
                .as_f64()
                .map(|n| ryu_js::Buffer::new().format(n).to_owned())
                .unwrap_or_default(),
            Value::Array(a) => a.iter().map(string).collect::<Vec<_>>().join(","),
            Value::Object(_) => "[object Object]".to_owned(),
        }
    }
    if value == false || value.as_f64() == Some(0.0) {
        String::new()
    } else {
        string(value)
    }
}
fn instant(v: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(v.as_str()?)
}
fn valid_record(v: &Value, runtime: &Path, lifecycle: &str) -> bool {
    let Some(object) = v.as_object() else {
        return false;
    };
    let Some(package) = v["packagePath"].as_str().map(Path::new) else {
        return false;
    };
    if object.len() != KEYS.len()
        || KEYS.iter().any(|key| !object.contains_key(*key))
        || v["version"].as_f64() != Some(1.0)
        || v["kind"] != "RuntimeRetentionPackageDeletionFence"
        || v["runtimeRoot"].as_str() != runtime.to_str()
        || v["packageLifecycleReceiptHash"] != lifecycle
        || !lexical_absolute(package)
        || package.parent() != Some(runtime.join("packages").as_path())
        || ![
            "packageLifecycleReceiptHash",
            "packageContentHash",
            "deletionIntentHash",
            "recoveryBindingHash",
            "authoritySnapshotHash",
            "fenceTokenHash",
            "transitionId",
            "runtimeRetentionPackageDeletionFenceHash",
        ]
        .iter()
        .all(|key| valid_hash(&v[key]))
        || !valid_operation(&operation_text(&v["operationId"]))
        || !["generation", "revision"].iter().all(|key| {
            v[key]
                .as_f64()
                .is_some_and(|n| (1.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0)
        })
        || !(v["previousFenceHash"].is_null() || valid_hash(&v["previousFenceHash"]))
    {
        return false;
    }
    let Some(prepared) = instant(&v["preparedAt"]) else {
        return false;
    };
    let Some(updated) = instant(&v["updatedAt"]) else {
        return false;
    };
    if updated < prepared
        || ["deletingAt", "deletedAt", "abortedAt"]
            .iter()
            .any(|key| !v[key].is_null() && !instant(&v[key]).is_some_and(|at| at >= prepared))
    {
        return false;
    }
    let state_ok = match v["status"].as_str() {
        Some("prepared") => {
            v["deletingAt"].is_null()
                && v["deletedAt"].is_null()
                && v["abortedAt"].is_null()
                && v["abortReasonHash"].is_null()
        }
        Some("deleting") => {
            !v["deletingAt"].is_null()
                && v["deletedAt"].is_null()
                && v["abortedAt"].is_null()
                && v["abortReasonHash"].is_null()
                && v["updatedAt"] == v["deletingAt"]
        }
        Some("deleted") => {
            !v["deletingAt"].is_null()
                && !v["deletedAt"].is_null()
                && v["abortedAt"].is_null()
                && v["abortReasonHash"].is_null()
                && instant(&v["deletedAt"]) >= instant(&v["deletingAt"])
                && v["updatedAt"] == v["deletedAt"]
        }
        Some("aborted") => {
            v["deletedAt"].is_null()
                && !v["abortedAt"].is_null()
                && valid_hash(&v["abortReasonHash"])
                && (v["deletingAt"].is_null()
                    || instant(&v["abortedAt"]) >= instant(&v["deletingAt"]))
                && v["updatedAt"] == v["abortedAt"]
        }
        _ => false,
    };
    let mut payload = v.clone();
    payload
        .as_object_mut()
        .expect("object checked")
        .remove("runtimeRetentionPackageDeletionFenceHash");
    state_ok
        && production_hash_record_v1("RuntimeRetentionPackageDeletionFence", &payload)
            .ok()
            .is_some_and(|hash| v["runtimeRetentionPackageDeletionFenceHash"] == hash.as_str())
}

#[cfg(test)]
mod tests;
