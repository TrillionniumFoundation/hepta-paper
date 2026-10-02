//! Ordinary, bounded read-only inspection. This handle grants no migration authority.
use crate::{
    NodeLogicalTableV1, ReadOnlyStoreError, digest,
    node_receipts::{self, NodeValue},
    node_snapshot, percent_encode_path, sidecar,
};
use hepta_codex_protocol::Sha256Digest;
use nix::fcntl::{OFlag, open, openat};
use nix::sys::stat::Mode;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileExt, MetadataExt},
    },
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// Same production report fields, with raw JSON retained for ECMAScript values.
/// Serialize this report directly; converting it to `serde_json::Value` loses that scope.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrdinaryNodeLogicalIntegrityReportV1 {
    pub version: u8,
    pub kind: String,
    pub status: String,
    pub db_path: String,
    pub byte_hash_before: Sha256Digest,
    pub byte_hash_after: Sha256Digest,
    pub readonly_check_mutated_database: bool,
    pub logical_database_hash: Sha256Digest,
    pub schema_hash: Sha256Digest,
    pub table_count: usize,
    pub total_row_count: u64,
    pub tables: Vec<NodeLogicalTableV1>,
    pub quick_check: String,
    pub foreign_key_violation_count: u64,
    pub receipt_ledger_row_count: u64,
    pub invalid_receipt_hash_count: u64,
    pub invalid_receipt_rows: Vec<Box<RawValue>>,
    pub blockers: Vec<String>,
}

/// SQLite may create shared-memory coordination during an ordinary WAL read.
/// This is an observation of this open handle, never a writer-fencing claim.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdinaryCoordinationObservationV1 {
    pub version: u8,
    pub shm_present_before_open: bool,
    pub shm_present_after_open: bool,
    pub shm_created_by_read_open: bool,
    pub wal_created_by_coordination_preparation: bool,
    pub shm_created_by_coordination_preparation: bool,
    pub migration_authority: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
}
impl Identity {
    fn of(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            mode: m.mode(),
            uid: m.uid(),
            gid: m.gid(),
            links: m.nlink(),
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
struct FullIdentity {
    core: Identity,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}
impl FullIdentity {
    fn of(m: &Metadata) -> Self {
        Self {
            core: Identity::of(m),
            size: m.size(),
            mtime: m.mtime(),
            mtime_nsec: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_nsec: m.ctime_nsec(),
        }
    }
}
#[derive(Clone)]
pub(crate) struct ReadControl {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    #[cfg(test)]
    pub(crate) observed_sqlite_progress: Option<Arc<AtomicBool>>,
}
impl ReadControl {
    pub(crate) fn new(cancelled: Arc<AtomicBool>, deadline: Instant) -> Self {
        Self {
            cancelled,
            deadline,
            #[cfg(test)]
            observed_sqlite_progress: None,
        }
    }
    pub(crate) fn install_sqlite_progress(
        &self,
        connection: &Connection,
    ) -> Result<(), ReadOnlyStoreError> {
        let progress = self.clone();
        connection.progress_handler(
            1000,
            Some(move || {
                #[cfg(test)]
                if let Some(observed) = &progress.observed_sqlite_progress {
                    observed.store(true, Ordering::Release);
                }
                progress.check().is_err()
            }),
        )?;
        Ok(())
    }
    pub(crate) fn check(&self) -> Result<(), ReadOnlyStoreError> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(ReadOnlyStoreError::OrdinaryCancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(ReadOnlyStoreError::OrdinaryDeadlineExceeded);
        }
        Ok(())
    }
    pub(crate) fn map(&self, error: ReadOnlyStoreError) -> ReadOnlyStoreError {
        self.check().err().unwrap_or(error)
    }
}
struct HeldFile {
    path: PathBuf,
    file: File,
    identity: FullIdentity,
    hash: Option<Sha256Digest>,
    control: ReadControl,
}
impl HeldFile {
    fn open(path: PathBuf, hash: bool, control: ReadControl) -> Result<Self, ReadOnlyStoreError> {
        control.check()?;
        let fd = open(
            &path,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| ReadOnlyStoreError::DatabasePathInvalid)?;
        let file = File::from(fd);
        let m = file
            .metadata()
            .map_err(|e| ReadOnlyStoreError::Filesystem("ordinary_held_metadata", e.kind()))?;
        if !m.is_file() || m.size() > crate::MAXIMUM_DATABASE_BYTES {
            return Err(ReadOnlyStoreError::DatabasePathInvalid);
        }
        let identity = FullIdentity::of(&m);
        let mut held = Self {
            path,
            file,
            identity,
            hash: None,
            control,
        };
        if hash {
            held.hash = Some(held.hash_bytes()?);
        }
        held.verify(hash)?;
        Ok(held)
    }
    fn hash_bytes(&self) -> Result<Sha256Digest, ReadOnlyStoreError> {
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 65536];
        let mut offset = 0;
        loop {
            self.control.check()?;
            let read = self
                .file
                .read_at(&mut buffer, offset)
                .map_err(|e| ReadOnlyStoreError::Filesystem("ordinary_held_hash", e.kind()))?;
            if read == 0 {
                break;
            }
            offset += read as u64;
            if offset > crate::MAXIMUM_DATABASE_BYTES {
                return Err(ReadOnlyStoreError::DatabaseTooLarge);
            }
            hasher.update(&buffer[..read]);
        }
        digest(hasher)
    }
    fn verify(&self, hash: bool) -> Result<(), ReadOnlyStoreError> {
        self.control.check()?;
        let named =
            fs::symlink_metadata(&self.path).map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        let held = self
            .file
            .metadata()
            .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        if !named.is_file()
            || !held.is_file()
            || Identity::of(&named) != self.identity.core
            || Identity::of(&held) != self.identity.core
        {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        if hash
            && (FullIdentity::of(&named) != self.identity
                || FullIdentity::of(&held) != self.identity
                || self.hash.as_ref() != Some(&self.hash_bytes()?))
        {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        let after = self
            .file
            .metadata()
            .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        let after_named =
            fs::symlink_metadata(&self.path).map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        if hash
            && (FullIdentity::of(&after) != self.identity
                || FullIdentity::of(&after_named) != self.identity)
        {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        Ok(())
    }
}
struct HeldDirectory {
    path: PathBuf,
    file: File,
    identity: FullIdentity,
}
impl HeldDirectory {
    fn names(
        &self,
    ) -> Result<std::collections::BTreeMap<std::ffi::OsString, Identity>, ReadOnlyStoreError> {
        let mut names = std::collections::BTreeMap::new();
        let anchor = PathBuf::from(format!(
            "/proc/self/fd/{}",
            std::os::fd::AsRawFd::as_raw_fd(&self.file)
        ));
        for entry in fs::read_dir(&anchor).map_err(|_| ReadOnlyStoreError::DatabaseChanged)? {
            if names.len() >= 4096 {
                return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                    "parent_entries_v1",
                ));
            }
            let entry = entry.map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
            names.insert(entry.file_name(), Identity::of(&metadata));
        }
        Ok(names)
    }
    fn accept_sidecar_creation(
        &mut self,
        mut before: std::collections::BTreeMap<std::ffi::OsString, Identity>,
        shm: &HeldFile,
    ) -> Result<(), ReadOnlyStoreError> {
        let named =
            fs::symlink_metadata(&self.path).map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        let held = self
            .file
            .metadata()
            .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        if Identity::of(&named) != self.identity.core || Identity::of(&held) != self.identity.core {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        let name = shm
            .path
            .file_name()
            .ok_or(ReadOnlyStoreError::DatabaseChanged)?
            .to_owned();
        if before.insert(name, shm.identity.core.clone()).is_some() || before != self.names()? {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        self.identity = FullIdentity::of(&held);
        self.verify()
    }
    fn open(path: PathBuf) -> Result<Self, ReadOnlyStoreError> {
        let fd = open(
            &path,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| ReadOnlyStoreError::DatabasePathInvalid)?;
        let file = File::from(fd);
        let metadata = file
            .metadata()
            .map_err(|_| ReadOnlyStoreError::DatabasePathInvalid)?;
        Ok(Self {
            path,
            file,
            identity: FullIdentity::of(&metadata),
        })
    }
    fn verify(&self) -> Result<(), ReadOnlyStoreError> {
        let named =
            fs::symlink_metadata(&self.path).map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        let held = self
            .file
            .metadata()
            .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        if !named.is_dir()
            || FullIdentity::of(&named) != self.identity
            || FullIdentity::of(&held) != self.identity
        {
            #[cfg(test)]
            eprintln!(
                "ordinary_directory_changed:{} expected:{:?} held:{:?} named:{:?}",
                self.path.display(),
                self.identity,
                FullIdentity::of(&held),
                FullIdentity::of(&named)
            );
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        Ok(())
    }
}
fn optional(
    path: PathBuf,
    hash: bool,
    control: &ReadControl,
) -> Result<Option<HeldFile>, ReadOnlyStoreError> {
    match fs::symlink_metadata(&path) {
        Ok(_) => HeldFile::open(path, hash, control.clone()).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ReadOnlyStoreError::Filesystem("ordinary_sidecar", e.kind())),
    }
}
fn create_coordination_leaf(
    parent: &HeldDirectory,
    path: &Path,
    main_mode: u32,
    control: &ReadControl,
) -> Result<HeldFile, ReadOnlyStoreError> {
    control.check()?;
    // A zero coordination leaf is prepared only with atomic NoReplace. It is
    // never removed on error: another SQLite reader may already be using it.
    let fd = openat(
        &parent.file,
        Path::new(
            path.file_name()
                .ok_or(ReadOnlyStoreError::DatabasePathInvalid)?,
        ),
        OFlag::O_RDWR
            | OFlag::O_CREAT
            | OFlag::O_EXCL
            | OFlag::O_NOFOLLOW
            | OFlag::O_NONBLOCK
            | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(main_mode & 0o666),
    )
    .map_err(|_| ReadOnlyStoreError::DatabasePathInvalid)?;
    let created = File::from(fd);
    let metadata = created
        .metadata()
        .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.size() != 0
        || metadata.uid() != nix::unistd::geteuid().as_raw()
    {
        return Err(ReadOnlyStoreError::DatabaseChanged);
    }
    let held = HeldFile::open(
        path.to_path_buf(),
        path.as_os_str().as_bytes().ends_with(b"-wal"),
        control.clone(),
    )?;
    if held.identity != FullIdentity::of(&metadata) {
        return Err(ReadOnlyStoreError::DatabaseChanged);
    }
    Ok(held)
}
fn verify_optional(
    file: &Option<HeldFile>,
    path: &Path,
    hash: bool,
) -> Result<(), ReadOnlyStoreError> {
    if let Some(file) = file {
        file.verify(hash)
    } else {
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(ReadOnlyStoreError::DatabaseChanged),
        }
    }
}

/// Bounded native profile v1: 16 GiB per main/WAL/journal, 4096 schema objects,
/// 2 million rows per table, 1 MiB borrowed cell, 16 MiB encoded row, 4 GiB input.
/// These are native safety refusals, not claims that Node has matching limits.
pub struct OrdinaryReadOnlyStoreV1 {
    requested: PathBuf,
    path: PathBuf,
    pub(crate) connection: Connection,
    pub(crate) control: ReadControl,
    directories: Vec<HeldDirectory>,
    main: HeldFile,
    wal: Option<HeldFile>,
    journal: Option<HeldFile>,
    shm: Option<HeldFile>,
    coordination: OrdinaryCoordinationObservationV1,
}
impl OrdinaryReadOnlyStoreV1 {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ReadOnlyStoreError> {
        Self::open_with_cancellation(
            path,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(300),
        )
    }
    /// Uses the existing CLI cancellation flag. One absolute deadline covers this handle.
    /// SQLite VM progress is interruptible; an OS filesystem call or SQLite busy wait
    /// finishes before the next check (busy wait remains bounded at ten seconds).
    pub fn open_with_cancellation(
        path: impl AsRef<Path>,
        cancelled: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Self, ReadOnlyStoreError> {
        let maximum = Instant::now()
            .checked_add(Duration::from_secs(300))
            .ok_or(ReadOnlyStoreError::OrdinaryDeadlineExceeded)?;
        let control = ReadControl::new(cancelled, deadline.min(maximum));
        Self::open_inner(path.as_ref(), control.clone()).map_err(|error| control.map(error))
    }
    fn open_inner(path: &Path, control: ReadControl) -> Result<Self, ReadOnlyStoreError> {
        control.check()?;
        let requested = path.to_path_buf();
        if !requested.is_absolute() || requested.as_os_str().as_bytes().contains(&0) {
            return Err(ReadOnlyStoreError::DatabasePathInvalid);
        }
        let path = fs::canonicalize(&requested)
            .map_err(|e| ReadOnlyStoreError::Filesystem("ordinary_canonical", e.kind()))?;
        let _ = percent_encode_path(&path)?;
        let mut directories = path
            .parent()
            .ok_or(ReadOnlyStoreError::DatabasePathInvalid)?
            .ancestors()
            .map(|p| HeldDirectory::open(p.to_path_buf()))
            .collect::<Result<Vec<_>, _>>()?;
        let main = HeldFile::open(path.clone(), true, control.clone())?;
        let mut wal = optional(sidecar(&path, "-wal"), true, &control)?;
        let journal = optional(sidecar(&path, "-journal"), true, &control)?;
        let before_shm = optional(sidecar(&path, "-shm"), false, &control)?;
        let shm_present_before = before_shm.is_some();
        let mut shm = before_shm;
        let mut wal_created = false;
        let mut shm_created = false;
        for directory in &directories {
            directory.verify()?;
        }
        let mut header = [0_u8; 20];
        if main
            .file
            .read_at(&mut header, 0)
            .map_err(|e| ReadOnlyStoreError::Filesystem("ordinary_header", e.kind()))?
            == 20
            && &header[..16] == b"SQLite format 3\0"
            && header[18] == 2
            && header[19] == 2
        {
            for (suffix, is_missing) in [("-wal", wal.is_none()), ("-shm", shm.is_none())] {
                if !is_missing {
                    continue;
                }
                control.check()?;
                for directory in &directories {
                    directory.verify()?;
                }
                main.verify(true)?;
                if let Some(wal) = &wal {
                    wal.verify(true)?;
                }
                if let Some(journal) = &journal {
                    journal.verify(true)?;
                }
                if let Some(shm) = &shm {
                    shm.verify(false)?;
                }
                let before_names = directories[0].names()?;
                let side_path = sidecar(&path, suffix);
                let created = create_coordination_leaf(
                    &directories[0],
                    &side_path,
                    main.identity.core.mode,
                    &control,
                )?;
                directories[0].accept_sidecar_creation(before_names, &created)?;
                if suffix == "-wal" {
                    wal_created = true;
                    wal = Some(created);
                } else {
                    shm_created = true;
                    shm = Some(created);
                }
                control.check()?;
            }
        }
        for directory in &directories {
            directory.verify()?;
        }
        let connection = Connection::open_with_flags(
            format!("file:{}?mode=ro", percent_encode_path(&path)?),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        control.install_sqlite_progress(&connection)?;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            16 * 1024 * 1024,
        )?;
        connection.busy_timeout(Duration::from_secs(10))?;
        connection.execute_batch("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN DEFERRED")?;
        let query_only: i64 = connection.query_row("PRAGMA query_only", [], |row| row.get(0))?;
        if query_only != 1 {
            return Err(ReadOnlyStoreError::QueryOnlyUnavailable);
        }
        // Establish the consistent read snapshot and observe any SQLite SHM creation.
        connection.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        if let Some(before) = &shm {
            before.verify(false)?;
        }
        let coordination = OrdinaryCoordinationObservationV1 {
            version: 1,
            shm_present_before_open: shm_present_before,
            shm_present_after_open: shm.is_some(),
            shm_created_by_read_open: !shm_present_before && shm.is_some(),
            wal_created_by_coordination_preparation: wal_created,
            shm_created_by_coordination_preparation: shm_created,
            migration_authority: false,
        };
        let store = Self {
            requested,
            path,
            connection,
            control,
            directories,
            main,
            wal,
            journal,
            shm,
            coordination,
        };
        store.verify_unchanged()?;
        Ok(store)
    }
    pub fn coordination_observation(&self) -> &OrdinaryCoordinationObservationV1 {
        &self.coordination
    }
    pub fn verify_unchanged(&self) -> Result<(), ReadOnlyStoreError> {
        self.control.check()?;
        if fs::canonicalize(&self.requested).map_err(|_| ReadOnlyStoreError::DatabaseChanged)?
            != self.path
        {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        for directory in &self.directories {
            directory.verify()?;
        }
        self.main.verify(true)?;
        verify_optional(&self.wal, &sidecar(&self.path, "-wal"), true)?;
        verify_optional(&self.journal, &sidecar(&self.path, "-journal"), true)?;
        verify_optional(&self.shm, &sidecar(&self.path, "-shm"), false)?;
        Ok(())
    }
    pub fn node_logical_integrity_report(
        &self,
    ) -> Result<OrdinaryNodeLogicalIntegrityReportV1, ReadOnlyStoreError> {
        self.report_inner().map_err(|error| self.control.map(error))
    }
    fn report_inner(&self) -> Result<OrdinaryNodeLogicalIntegrityReportV1, ReadOnlyStoreError> {
        self.verify_unchanged()?;
        let snapshot = node_snapshot::capture(&self.connection, 0, true, &|| self.control.check())?;
        let quick_check: String = self
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        let foreign_key_violation_count: i64 = self.connection.query_row(
            "SELECT count(*) FROM pragma_foreign_key_check",
            [],
            |row| row.get(0),
        )?;
        let foreign_key_violation_count = u64::try_from(foreign_key_violation_count)
            .map_err(|_| ReadOnlyStoreError::NumericOverflow)?;
        let receipt_ledger_row_count = snapshot
            .tables
            .iter()
            .find(|table| table.name == "receipt_ledger")
            .map_or(0, |table| table.row_count);
        let mut invalid_receipt_rows = Vec::new();
        let mut invalid_receipt_hash_count = 0;
        let mut receipt_output_bytes = 0;
        if snapshot
            .tables
            .iter()
            .any(|table| table.name == "receipt_ledger")
        {
            let mut query=self.connection.prepare("SELECT receipt_id,receipt_json,receipt_sha256 FROM receipt_ledger ORDER BY receipt_id")?;
            let mut rows = query.query([])?;
            let mut count = 0;
            while let Some(row) = rows.next()? {
                self.control.check()?;
                count += 1;
                if count > receipt_ledger_row_count {
                    return Err(ReadOnlyStoreError::DatabaseChanged);
                }
                let id = NodeValue::from_sql(row.get_ref(0)?, true)?;
                let input = NodeValue::from_sql(row.get_ref(1)?, true)?;
                let actual = NodeValue::from_sql(row.get_ref(2)?, true)?;
                if let Some(invalid) = node_receipts::inspect_row(&id, &input, &actual)? {
                    invalid_receipt_hash_count += 1;
                    if invalid_receipt_rows.len() < 20 {
                        receipt_output_bytes += invalid.get().len();
                        if receipt_output_bytes > 4 * 1024 * 1024 {
                            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                                "invalid_receipt_output_bytes_v1",
                            ));
                        }
                        invalid_receipt_rows.push(invalid);
                    }
                }
            }
            if count != receipt_ledger_row_count {
                return Err(ReadOnlyStoreError::DatabaseChanged);
            }
        }
        self.verify_unchanged()?;
        let hash = self
            .main
            .hash
            .clone()
            .ok_or(ReadOnlyStoreError::DigestConstruction)?;
        let mut blockers = Vec::new();
        if quick_check != "ok" {
            blockers.push("sqlite_quick_check_failed".into());
        }
        if foreign_key_violation_count != 0 {
            blockers.push("sqlite_foreign_key_check_failed".into());
        }
        if invalid_receipt_hash_count != 0 {
            blockers.push("receipt_ledger_hash_mismatch".into());
        }
        let report = OrdinaryNodeLogicalIntegrityReportV1 {
            version: 1,
            kind: "SqliteLogicalIntegrityReport".into(),
            status: if blockers.is_empty() {
                "sqlite_logical_integrity_verified"
            } else {
                "sqlite_logical_integrity_blocked"
            }
            .into(),
            db_path: self.requested.display().to_string(),
            byte_hash_before: hash.clone(),
            byte_hash_after: hash,
            readonly_check_mutated_database: false,
            logical_database_hash: snapshot.logical_database_hash,
            schema_hash: snapshot.schema_hash,
            table_count: snapshot.table_count,
            total_row_count: snapshot.total_row_count,
            tables: snapshot.tables,
            quick_check,
            foreign_key_violation_count,
            receipt_ledger_row_count,
            invalid_receipt_hash_count,
            invalid_receipt_rows,
            blockers,
        };
        crate::node_snapshot::validate_serialized_budget(
            &report,
            8 * 1024 * 1024,
            "report_bytes_v1",
        )?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests;
