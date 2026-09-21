//! Fresh external coordinator storage. The adjacent marker remains mandatory:
//! older writers see enrollment and fail closed instead of running unmanaged.
use super::*;
use nix::{libc, unistd::Uid};
use std::os::unix::fs::DirBuilderExt;

/// Select storage only while enrolling a database that has no enrollment.
/// Opening always follows its existing marker; this never migrates a journal.
pub enum DurableCutoverStorageV2 {
    AdjacentSidecars,
    ExternalRoot { root: PathBuf },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalEnrollment {
    version: u16,
    kind: String,
    database_path: String,
    database_identity: String,
    storage_root: String,
    storage_root_identity: String,
    storage_slot: String,
    storage_slot_identity: String,
    journal_identity: String,
    marker_identity: String,
}

struct Pin {
    path: PathBuf,
    file: Option<File>,
    initial: fs::Metadata,
    directory: bool,
}
impl Pin {
    fn open(path: &Path, directory: bool, private: bool) -> Result<Self, DurableCutoverError> {
        canonical(path)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(
                libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK
                    | if directory { libc::O_DIRECTORY } else { 0 },
            )
            .open(path)?;
        let initial = file.metadata()?;
        let result = Self {
            path: path.into(),
            file: Some(file),
            initial,
            directory,
        };
        result.assert_current()?;
        if private && result.initial.mode() & 0o7777 != if directory { 0o700 } else { 0o600 } {
            return Err(DurableCutoverError::IdentityChanged);
        }
        Ok(result)
    }
    // SQLite owns handles for its database files. An extra raw descriptor's
    // close can release another same-process connection's POSIX locks.
    fn sqlite(path: &Path, private: bool) -> Result<Self, DurableCutoverError> {
        canonical(path)?;
        let result = Self {
            path: path.into(),
            file: None,
            initial: fs::symlink_metadata(path)?,
            directory: false,
        };
        result.assert_current()?;
        if private && result.initial.mode() & 0o7777 != 0o600 {
            return Err(DurableCutoverError::IdentityChanged);
        }
        Ok(result)
    }
    fn assert_current(&self) -> Result<(), DurableCutoverError> {
        canonical(&self.path)?;
        let mut observations = vec![fs::symlink_metadata(&self.path)?];
        if let Some(file) = &self.file {
            observations.push(file.metadata()?);
        }
        for observed in observations {
            if identity(&observed) != identity(&self.initial)
                || observed.mode() != self.initial.mode()
                || observed.uid() != self.initial.uid()
                || observed.uid() != Uid::effective().as_raw()
                || observed.mode() & 0o022 != 0
                || if self.directory {
                    !observed.is_dir()
                } else {
                    !observed.is_file() || observed.nlink() != 1
                }
            {
                return Err(DurableCutoverError::IdentityChanged);
            }
        }
        Ok(())
    }
    fn bytes(&self) -> Result<Vec<u8>, DurableCutoverError> {
        use std::os::unix::fs::FileExt;
        self.assert_current()?;
        let file = self
            .file
            .as_ref()
            .ok_or(DurableCutoverError::InvalidInput)?;
        let size = file.metadata()?.len();
        if size > 16_384 {
            return Err(DurableCutoverError::IdentityChanged);
        }
        let mut bytes =
            vec![0; usize::try_from(size).map_err(|_| DurableCutoverError::IdentityChanged)?];
        file.read_exact_at(&mut bytes, 0)?;
        self.assert_current()?;
        if file.metadata()?.len() != size {
            return Err(DurableCutoverError::IdentityChanged);
        }
        Ok(bytes)
    }
}
pub(super) struct ExternalStorageV2 {
    binding: ExternalEnrollment,
    target: Pin,
    root: Pin,
    slot: Pin,
    marker: Pin,
    journal: Pin,
    marker_hash: String,
}
fn canonical(path: &Path) -> Result<(), DurableCutoverError> {
    if !path.is_absolute()
        || fs::canonicalize(path)?.as_os_str() != path.as_os_str()
        || fs::symlink_metadata(path)?.file_type().is_symlink()
    {
        return Err(DurableCutoverError::IdentityChanged);
    }
    Ok(())
}
fn present(path: &Path) -> Result<bool, DurableCutoverError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
pub(super) fn read_marker(path: &Path) -> Result<Vec<u8>, DurableCutoverError> {
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || before.nlink() != 1 || before.len() > 16_384 {
        return Err(DurableCutoverError::IdentityChanged);
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    let held = file.metadata()?;
    if identity(&before) != identity(&held) {
        return Err(DurableCutoverError::IdentityChanged);
    }
    let mut bytes = Vec::new();
    file.take(16_385).read_to_end(&mut bytes)?;
    if bytes.len() > 16_384 || identity(&fs::symlink_metadata(path)?) != identity(&held) {
        return Err(DurableCutoverError::IdentityChanged);
    }
    Ok(bytes)
}
fn legacy_absent(target: &Path) -> Result<(), DurableCutoverError> {
    let (journal, _) = sidecars(target);
    for suffix in ["", "-wal", "-shm", "-journal"] {
        if present(&PathBuf::from(format!("{}{suffix}", journal.display())))? {
            return Err(DurableCutoverError::AlreadyEnrolled);
        }
    }
    Ok(())
}
fn slot_name(target: &Path, target_identity: &str) -> Result<String, DurableCutoverError> {
    let bytes = serde_json::to_vec(&serde_json::json!([
        "HeptaDurableCutoverExternalStorageV2",
        path_string(target)?,
        target_identity
    ]))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}
fn disjoint(root: &Path, target: &Path) -> Result<(), DurableCutoverError> {
    let parent = target.parent().ok_or(DurableCutoverError::InvalidInput)?;
    if root.starts_with(parent) || parent.starts_with(root) {
        return Err(DurableCutoverError::InvalidInput);
    }
    Ok(())
}
fn schema_rows(
    connection: &Connection,
) -> Result<Vec<(String, String, String, String)>, DurableCutoverError> {
    let mut statement = connection.prepare("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")?;
    Ok(statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
fn assert_schema(connection: &Connection) -> Result<(), DurableCutoverError> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA)?;
    if schema_rows(connection)? != schema_rows(&expected)? {
        return Err(DurableCutoverError::JournalCorrupt);
    }
    Ok(())
}
impl ExternalStorageV2 {
    pub(super) fn assert_current(
        &self,
        target: &Path,
        connection: &Connection,
    ) -> Result<(), DurableCutoverError> {
        for pin in [
            &self.target,
            &self.root,
            &self.slot,
            &self.marker,
            &self.journal,
        ] {
            pin.assert_current()?;
        }
        legacy_absent(target)?;
        if target != self.target.path
            || hash_bytes(&self.marker.bytes()?) != self.marker_hash
            || load_state(connection)?.database_path != self.binding.database_path
        {
            return Err(DurableCutoverError::IdentityChanged);
        }
        // Journal sidecars are mutable SQLite files, never alternative journals.
        // Refuse symlinks/special files without pinning their changing lifetime.
        for suffix in ["-wal", "-shm", "-journal"] {
            let path = PathBuf::from(format!("{}{suffix}", self.journal.path.display()));
            if present(&path)? {
                // Never open/close a SQLite-managed descriptor as an identity
                // probe: POSIX close can release this process's SQLite locks.
                canonical(&path)?;
                let stat = fs::symlink_metadata(&path)?;
                if !stat.is_file()
                    || stat.nlink() != 1
                    || stat.mode() & 0o7777 != 0o600
                    || stat.uid() != Uid::effective().as_raw()
                {
                    return Err(DurableCutoverError::IdentityChanged);
                }
            }
        }
        assert_schema(connection)
    }
}
pub(super) fn open_external(
    target: PathBuf,
    bytes: &[u8],
) -> Result<DurableCutoverCoordinatorV1, DurableCutoverError> {
    let binding: ExternalEnrollment = serde_json::from_slice(bytes)?;
    if binding.version != 2
        || binding.kind != "HeptaDurableCutoverExternalEnrollment"
        || binding.database_path != path_string(&target)?
    {
        return Err(DurableCutoverError::IdentityChanged);
    }
    legacy_absent(&target)?;
    let target_pin = Pin::sqlite(&target, false)?;
    let root_path = PathBuf::from(&binding.storage_root);
    disjoint(&root_path, &target)?;
    let root = Pin::open(&root_path, true, true)?;
    if binding.database_identity != identity(&target_pin.initial)
        || binding.storage_root_identity != identity(&root.initial)
        || binding.storage_slot != slot_name(&target, &binding.database_identity)?
    {
        return Err(DurableCutoverError::IdentityChanged);
    }
    let slot = Pin::open(&root.path.join(&binding.storage_slot), true, true)?;
    let journal = Pin::sqlite(&slot.path.join("journal.sqlite"), true)?;
    let marker = Pin::open(&sidecars(&target).1, false, true)?;
    if binding.storage_slot_identity != identity(&slot.initial)
        || binding.journal_identity != identity(&journal.initial)
        || binding.marker_identity != identity(&marker.initial)
        || marker.bytes()? != bytes
    {
        return Err(DurableCutoverError::IdentityChanged);
    }
    let connection = open_connection(&journal.path)?;
    let enrollment = Enrollment {
        version: 2,
        database_path: binding.database_path.clone(),
        database_identity: binding.database_identity.clone(),
        journal_identity: binding.journal_identity.clone(),
    };
    let coordinator = DurableCutoverCoordinatorV1 {
        database_path: target,
        journal_path: journal.path.clone(),
        marker_path: marker.path.clone(),
        enrollment,
        connection,
        external_storage: Some(ExternalStorageV2 {
            binding,
            target: target_pin,
            root,
            slot,
            marker,
            journal,
            marker_hash: hash_bytes(bytes),
        }),
    };
    coordinator.validate_identity()?;
    coordinator.verify_journal()?;
    Ok(coordinator)
}
impl DurableCutoverCoordinatorV1 {
    /// Fresh enrollment only. Existing, partial, or mixed enrollments are never
    /// moved or removed. The adjacent sentinel is published before external I/O.
    pub fn create_with_storage_v2(
        database_path: impl AsRef<Path>,
        cutover_id: &str,
        old_writer_id: &str,
        new_writer_id: &str,
        mode: DurableCutoverModeV1,
        storage: DurableCutoverStorageV2,
    ) -> Result<Self, DurableCutoverError> {
        let DurableCutoverStorageV2::ExternalRoot { root } = storage else {
            return Self::create(
                database_path,
                cutover_id,
                old_writer_id,
                new_writer_id,
                mode,
            );
        };
        if !super::super::valid_identifier(cutover_id)
            || !super::super::valid_identifier(old_writer_id)
            || !super::super::valid_identifier(new_writer_id)
            || old_writer_id == new_writer_id
        {
            return Err(DurableCutoverError::InvalidInput);
        }
        let target = canonical_file(database_path.as_ref())?;
        let target_pin = Pin::sqlite(&target, false)?;
        disjoint(&root, &target)?;
        let root = Pin::open(&root, true, true)?;
        let marker_path = sidecars(&target).1;
        if present(&marker_path)? {
            return Err(DurableCutoverError::AlreadyEnrolled);
        }
        legacy_absent(&target)?;
        let name = slot_name(&target, &identity(&target_pin.initial))?;
        let slot_path = root.path.join(&name);
        if present(&slot_path)? {
            return Err(DurableCutoverError::AlreadyEnrolled);
        }
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&marker_path)?;
        marker.write_all(b"{\"version\":2,\"kind\":\"HeptaDurableCutoverEnrollmentPending\"}")?;
        marker.sync_all()?;
        sync_parent(&marker_path)?;
        // Failures after this point intentionally leave the sentinel in place.
        fs::DirBuilder::new().mode(0o700).create(&slot_path)?;
        root.file
            .as_ref()
            .ok_or(DurableCutoverError::InvalidInput)?
            .sync_all()?;
        let slot = Pin::open(&slot_path, true, true)?;
        let journal_path = slot.path.join("journal.sqlite");
        let journal = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&journal_path)?;
        journal.sync_all()?;
        let mut connection = open_connection(&journal_path)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        let state = DurableCutoverStateV1 {
            version: 1,
            cutover_id: cutover_id.into(),
            database_path: path_string(&target)?,
            mode,
            phase: DurableCutoverPhaseV1::Planned,
            old_writer_id: old_writer_id.into(),
            new_writer_id: new_writer_id.into(),
            writer_id: Some(old_writer_id.into()),
            generation: 1,
            token: format!("{cutover_id}:1"),
            revision: 0,
            shadow_cases: 0,
            shadow_mismatches: 0,
            canary_scopes: Vec::new(),
            production_activation: false,
            activation_receipt_hash: None,
        };
        append(
            &tx,
            &state,
            "enrolled",
            &serde_json::json!({"productionQualification":false}),
            "",
        )?;
        tx.commit()?;
        drop(connection);
        slot.file
            .as_ref()
            .ok_or(DurableCutoverError::InvalidInput)?
            .sync_all()?;
        let journal_identity = identity(&journal.metadata()?);
        drop(journal);
        let binding = ExternalEnrollment {
            version: 2,
            kind: "HeptaDurableCutoverExternalEnrollment".into(),
            database_path: path_string(&target)?,
            database_identity: identity(&target_pin.initial),
            storage_root: path_string(&root.path)?,
            storage_root_identity: identity(&root.initial),
            storage_slot: name,
            storage_slot_identity: identity(&slot.initial),
            journal_identity,
            marker_identity: identity(&marker.metadata()?),
        };
        target_pin.assert_current()?;
        root.assert_current()?;
        slot.assert_current()?;
        legacy_absent(&target)?;
        if identity(&marker.metadata()?) != identity(&fs::symlink_metadata(&marker_path)?) {
            return Err(DurableCutoverError::IdentityChanged);
        }
        let bytes = serde_json::to_vec(&binding)?;
        marker.set_len(0)?;
        use std::io::{Seek, SeekFrom};
        marker.seek(SeekFrom::Start(0))?;
        marker.write_all(&bytes)?;
        marker.sync_all()?;
        sync_parent(&marker_path)?;
        open_external(target, &bytes)
    }
    /// An expected root/hash can only narrow the existing marker's selection.
    pub fn open_with_expected_external_storage_v2(
        database_path: impl AsRef<Path>,
        expected_root: &Path,
        expected_enrollment_hash: Option<&str>,
    ) -> Result<Self, DurableCutoverError> {
        let target = canonical_file(database_path.as_ref())?;
        let bytes = read_marker(&sidecars(&target).1)?;
        let binding: ExternalEnrollment = serde_json::from_slice(&bytes)?;
        if Path::new(&binding.storage_root).as_os_str() != expected_root.as_os_str()
            || expected_enrollment_hash.is_some_and(|hash| hash != hash_bytes(&bytes))
        {
            return Err(DurableCutoverError::IdentityChanged);
        }
        open_external(target, &bytes)
    }
    /// Diagnostic hash of the retained immutable marker; not writer authority.
    pub fn external_storage_enrollment_hash_v2(&self) -> Option<&str> {
        self.external_storage
            .as_ref()
            .map(|s| s.marker_hash.as_str())
    }
}
