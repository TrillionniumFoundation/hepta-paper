//! SQLite's native backup API, bounded to isolated source/destination files.
use super::*;
use super::{files::ObservedFile, publication::Directory};
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt},
    },
    path::Path,
    time::{Duration, Instant},
};
pub(super) struct Scratch {
    pub directory: Directory,
}
impl Scratch {
    pub fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "hepta-state-restore-drill-{}",
            super::publication::nonce()?
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| error("autonomous_research_state_restore_scratch_create_failed"))?;
        Ok(Self {
            directory: Directory::open_or_create(&path, false)?,
        })
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if self.directory.assert_current().is_ok() {
            let _ = fs::remove_dir_all(&self.directory.path);
        }
    }
}
pub(super) fn inspection(db: &Connection) -> Result<Value> {
    let mut statement = db.prepare("PRAGMA quick_check")?;
    let mut rows = statement.query([])?;
    let first = rows.next()?.map(|r| r.get::<_, String>(0)).transpose()?;
    ensure(
        first.as_deref() == Some("ok") && rows.next()?.is_none(),
        "autonomous_research_state_backup_copy_invalid",
    )?;
    let mut foreign = db.prepare("PRAGMA foreign_key_check")?;
    ensure(
        foreign.query([])?.next()?.is_none(),
        "autonomous_research_state_backup_copy_invalid",
    )?;
    let user: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let app: i64 = db.pragma_query_value(None, "application_id", |r| r.get(0))?;
    Ok(
        json!({"quickCheck":"ok","foreignKeyViolationCount":0,"schemaHash":crate::sqlite_mutation_coordinator::storage::exact_schema_hash_v1(db)?,"userVersion":user,"applicationId":app}),
    )
}
pub(super) fn copy(
    source_path: &Path,
    destination: &Directory,
    name: &str,
    immutable: bool,
) -> Result<Value> {
    destination.assert_current()?;
    let source = ObservedFile::open(source_path, 256 * 1024 * 1024)?;
    // Stored bundles are checked as immutable bytes. SQLite must never reopen
    // their mutable pathname while resolving a /proc descriptor URI. Materialize
    // exactly the held, checked bytes in our private directory first.
    let frozen = if immutable {
        let snapshot = Scratch::new()?;
        snapshot
            .directory
            .write_new("source.sqlite", &source.bytes(256 * 1024 * 1024)?)?;
        source.assert_current()?;
        Some(snapshot)
    } else {
        // The only non-immutable caller receives an inventory-owned private
        // DB/WAL copy; preserve its WAL while SQLite performs the native backup.
        None
    };
    let uri = if let Some(snapshot) = &frozen {
        format!(
            "file:{}?mode=ro&immutable=1",
            snapshot.directory.path.join("source.sqlite").display()
        )
    } else {
        format!("file:/proc/self/fd/{}?mode=ro", source.file.as_raw_fd())
    };
    let from = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    from.pragma_update(None, "trusted_schema", false)?;
    destination.write_new(name, b"")?;
    let path = destination.path.join(name);
    let before = fs::symlink_metadata(&path)
        .map_err(|_| error("sqlite_copy_destination_identity_invalid"))?;
    let mut to = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    to.pragma_update(None, "trusted_schema", false)?;
    let backup = Backup::new(&from, &mut to)?;
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(60) {
            return Err(error("autonomous_research_state_backup_copy_timeout"));
        }
        match backup.step(256)? {
            StepResult::Done => break,
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(2)),
            _ => return Err(error("autonomous_research_state_backup_copy_failed")),
        }
    }
    drop(backup);
    let observed = inspection(&to)?;
    drop(to);
    drop(from);
    source.assert_current()?;
    destination.assert_current()?;
    let current = ObservedFile::open(&path, 256 * 1024 * 1024)?;
    let after = current
        .file
        .metadata()
        .map_err(|_| error("sqlite_copy_destination_identity_invalid"))?;
    ensure(
        before.dev() == after.dev() && before.ino() == after.ino() && after.mode() & 0o777 == 0o600,
        "sqlite_copy_destination_identity_invalid",
    )?;
    super::files::no_sidecars(&path)?;
    current
        .file
        .sync_all()
        .map_err(|_| error("sqlite_copy_fsync_failed"))?;
    let mut result = observed;
    result["backupSha256"] = hash_bytes(&current.bytes(256 * 1024 * 1024)?).into();
    result["bytes"] = after.len().into();
    Ok(result)
}
