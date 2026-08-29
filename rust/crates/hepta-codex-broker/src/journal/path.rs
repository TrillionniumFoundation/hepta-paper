use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};

pub(super) const INITIALIZATION_MARKER_SUFFIX: &str = ".initializing";
pub(super) const INITIALIZATION_MARKER_BYTES: &[u8] = b"HEPTA_BROKER_JOURNAL_INIT_V2\n";

use super::{
    schema::{APPLICATION_ID, EXPECTED_SCHEMA_OBJECTS, SCHEMA_SQL, SCHEMA_VERSION, USER_VERSION},
    store::{BrokerJournalError, BrokerJournalPolicyV1},
};

pub(super) fn open_secure_database(
    requested: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(PathBuf, Connection), BrokerJournalError> {
    let (path, initialization_marker) = prepare_database_path(requested, policy)?;
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = Connection::open_with_flags(&path, flags)?;
    connection.busy_timeout(Duration::from_millis(policy.busy_timeout_ms))?;
    configure_safety_pragmas(&connection)?;
    if initialization_marker.is_some() {
        verify_initialization_candidate(&connection)?;
    } else {
        verify_database_identity(&connection)?;
    }
    connection.execute_batch(SCHEMA_SQL)?;
    configure_size_limit(&connection, policy.maximum_database_bytes)?;
    verify_database_contract(&connection)?;
    inspect_database_envelope(&path, policy)?;
    if let Some(marker) = initialization_marker {
        finish_initialization(&marker)?;
    }
    Ok((path, connection))
}

fn prepare_database_path(
    requested: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(PathBuf, Option<PathBuf>), BrokerJournalError> {
    if !requested.is_absolute() || requested.file_name().is_none() {
        return Err(BrokerJournalError::DatabasePathInvalid);
    }
    let parent = requested
        .parent()
        .ok_or(BrokerJournalError::DatabasePathInvalid)?;
    inspect_database_parent(parent, policy)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| BrokerJournalError::Filesystem("journal_parent", error.kind()))?;
    let canonical_path = canonical_parent.join(
        requested
            .file_name()
            .ok_or(BrokerJournalError::DatabasePathInvalid)?,
    );
    if canonical_path != requested {
        return Err(BrokerJournalError::DatabasePathNonCanonical);
    }

    let marker = initialization_marker_path(&canonical_path);
    let mut initializing = match fs::symlink_metadata(&marker) {
        Ok(_) => {
            inspect_initialization_marker(&marker, policy)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(BrokerJournalError::Filesystem(
                "journal_initialization_marker",
                error.kind(),
            ));
        }
    };

    match fs::symlink_metadata(&canonical_path) {
        Ok(_) => inspect_database_file(&canonical_path, policy)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !initializing {
                create_initialization_marker(&marker, policy)?;
                initializing = true;
            }
            create_private_database_file(&canonical_path)?;
            sync_directory(&canonical_parent)?;
        }
        Err(error) => {
            return Err(BrokerJournalError::Filesystem(
                "journal_database",
                error.kind(),
            ));
        }
    }

    Ok((canonical_path, initializing.then_some(marker)))
}

fn initialization_marker_path(database: &Path) -> PathBuf {
    let mut value = OsString::from(database.as_os_str());
    value.push(INITIALIZATION_MARKER_SUFFIX);
    PathBuf::from(value)
}

fn create_initialization_marker(
    marker: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(), BrokerJournalError> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(marker)
        .map_err(|error| {
            BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
        })?;
    file.write_all(INITIALIZATION_MARKER_BYTES)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
        })?;
    inspect_initialization_marker(marker, policy)?;
    let parent = marker
        .parent()
        .ok_or(BrokerJournalError::DatabasePathInvalid)?;
    sync_directory(parent)
}

fn inspect_initialization_marker(
    marker: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(), BrokerJournalError> {
    let metadata = fs::symlink_metadata(marker).map_err(|error| {
        BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BrokerJournalError::InitializationMarkerInvalid);
    }
    validate_owner(
        &metadata,
        policy.owner_uid,
        policy.owner_gid,
        "journal_initialization_marker",
    )?;
    let mode = metadata.mode() & 0o7777;
    if mode != 0o600
        || metadata.nlink() != 1
        || metadata.size()
            != u64::try_from(INITIALIZATION_MARKER_BYTES.len())
                .map_err(|_| BrokerJournalError::NumericOverflow)?
    {
        return Err(BrokerJournalError::InitializationMarkerInvalid);
    }
    let mut file = File::open(marker).map_err(|error| {
        BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
    })?;
    let opened = file.metadata().map_err(|error| {
        BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
    })?;
    if opened.dev() != metadata.dev()
        || opened.ino() != metadata.ino()
        || opened.mode() != metadata.mode()
        || opened.uid() != metadata.uid()
        || opened.gid() != metadata.gid()
        || opened.nlink() != metadata.nlink()
        || opened.size() != metadata.size()
    {
        return Err(BrokerJournalError::InitializationMarkerInvalid);
    }
    let mut bytes = vec![0_u8; INITIALIZATION_MARKER_BYTES.len()];
    file.read_exact(&mut bytes).map_err(|error| {
        BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
    })?;
    let mut trailing = [0_u8; 1];
    let trailing_bytes = file.read(&mut trailing).map_err(|error| {
        BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
    })?;
    let after = fs::symlink_metadata(marker).map_err(|error| {
        BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
    })?;
    if bytes != INITIALIZATION_MARKER_BYTES
        || trailing_bytes != 0
        || after.dev() != opened.dev()
        || after.ino() != opened.ino()
        || after.mode() != opened.mode()
        || after.uid() != opened.uid()
        || after.gid() != opened.gid()
        || after.nlink() != opened.nlink()
        || after.size() != opened.size()
    {
        return Err(BrokerJournalError::InitializationMarkerInvalid);
    }
    Ok(())
}

fn create_private_database_file(path: &Path) -> Result<(), BrokerJournalError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| BrokerJournalError::Filesystem("journal_create", error.kind()))?;
    file.sync_all()
        .map_err(|error| BrokerJournalError::Filesystem("journal_create", error.kind()))
}

fn finish_initialization(marker: &Path) -> Result<(), BrokerJournalError> {
    fs::remove_file(marker).map_err(|error| {
        BrokerJournalError::Filesystem("journal_initialization_marker", error.kind())
    })?;
    let parent = marker
        .parent()
        .ok_or(BrokerJournalError::DatabasePathInvalid)?;
    sync_directory(parent)
}

fn sync_directory(path: &Path) -> Result<(), BrokerJournalError> {
    let directory = File::open(path)
        .map_err(|error| BrokerJournalError::Filesystem("journal_parent_sync", error.kind()))?;
    directory
        .sync_all()
        .map_err(|error| BrokerJournalError::Filesystem("journal_parent_sync", error.kind()))
}

pub(super) fn inspect_database_envelope(
    path: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(), BrokerJournalError> {
    let parent = path
        .parent()
        .ok_or(BrokerJournalError::DatabasePathInvalid)?;
    inspect_database_parent(parent, policy)?;
    inspect_database_file(path, policy)?;
    for suffix in ["-wal", "-shm"] {
        inspect_optional_sidecar(path, suffix, policy)?;
    }
    Ok(())
}

fn inspect_database_parent(
    parent: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(), BrokerJournalError> {
    let canonical = fs::canonicalize(parent)
        .map_err(|error| BrokerJournalError::Filesystem("journal_parent", error.kind()))?;
    if canonical != parent {
        return Err(BrokerJournalError::DatabasePathNonCanonical);
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| BrokerJournalError::Filesystem("journal_parent", error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(BrokerJournalError::DatabaseParentInvalid);
    }
    validate_owner(
        &metadata,
        policy.owner_uid,
        policy.owner_gid,
        "journal_parent",
    )?;
    let mode = metadata.mode() & 0o7777;
    if mode != 0o700 {
        return Err(BrokerJournalError::DatabaseParentPermissionsInvalid(mode));
    }
    Ok(())
}

pub(super) fn inspect_database_file(
    path: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(), BrokerJournalError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| BrokerJournalError::Filesystem("journal_database", error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BrokerJournalError::DatabaseFileInvalid);
    }
    validate_owner(
        &metadata,
        policy.owner_uid,
        policy.owner_gid,
        "journal_database",
    )?;
    let mode = metadata.mode() & 0o7777;
    if mode != 0o600 {
        return Err(BrokerJournalError::DatabaseFilePermissionsInvalid(mode));
    }
    if metadata.nlink() != 1 {
        return Err(BrokerJournalError::DatabaseFileLinkCountInvalid(
            metadata.nlink(),
        ));
    }
    if metadata.size() > policy.maximum_database_bytes {
        return Err(BrokerJournalError::DatabaseFileTooLarge {
            observed: metadata.size(),
            maximum: policy.maximum_database_bytes,
        });
    }
    Ok(())
}

fn inspect_optional_sidecar(
    database: &Path,
    suffix: &str,
    policy: BrokerJournalPolicyV1,
) -> Result<(), BrokerJournalError> {
    let mut value = OsString::from(database.as_os_str());
    value.push(suffix);
    let sidecar = PathBuf::from(value);
    let metadata = match fs::symlink_metadata(&sidecar) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(BrokerJournalError::Filesystem(
                "journal_sidecar",
                error.kind(),
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BrokerJournalError::DatabaseSidecarInvalid(
            suffix.to_owned(),
        ));
    }
    validate_owner(
        &metadata,
        policy.owner_uid,
        policy.owner_gid,
        "journal_sidecar",
    )?;
    let mode = metadata.mode() & 0o7777;
    if mode & 0o022 != 0 || mode & 0o7000 != 0 {
        return Err(BrokerJournalError::DatabaseSidecarPermissionsInvalid {
            suffix: suffix.to_owned(),
            mode,
        });
    }
    if metadata.nlink() != 1 {
        return Err(BrokerJournalError::DatabaseSidecarLinkCountInvalid {
            suffix: suffix.to_owned(),
            link_count: metadata.nlink(),
        });
    }
    if metadata.size() > policy.maximum_database_bytes {
        return Err(BrokerJournalError::DatabaseSidecarTooLarge {
            suffix: suffix.to_owned(),
            observed: metadata.size(),
            maximum: policy.maximum_database_bytes,
        });
    }
    Ok(())
}

fn validate_owner(
    metadata: &fs::Metadata,
    expected_uid: u32,
    expected_gid: Option<u32>,
    subject: &'static str,
) -> Result<(), BrokerJournalError> {
    if metadata.uid() != expected_uid || expected_gid.is_some_and(|gid| metadata.gid() != gid) {
        return Err(BrokerJournalError::OwnerMismatch {
            subject,
            expected_uid,
            observed_uid: metadata.uid(),
            expected_gid,
            observed_gid: metadata.gid(),
        });
    }
    Ok(())
}

fn configure_safety_pragmas(connection: &Connection) -> Result<(), BrokerJournalError> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

fn configure_size_limit(
    connection: &Connection,
    maximum_database_bytes: u64,
) -> Result<(), BrokerJournalError> {
    let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let page_size = u64::try_from(page_size)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("page_size"))?;
    if page_size == 0 {
        return Err(BrokerJournalError::CorruptDatabaseValue("page_size"));
    }
    let maximum_pages = maximum_database_bytes
        .checked_div(page_size)
        .ok_or(BrokerJournalError::NumericOverflow)?
        .max(1);
    connection.execute_batch(&format!("PRAGMA max_page_count = {maximum_pages};"))?;
    Ok(())
}

pub(super) fn verify_database_contract(connection: &Connection) -> Result<(), BrokerJournalError> {
    verify_connection_pragmas(connection)?;
    verify_schema_version(connection)?;
    verify_schema_shape(connection)
}

fn verify_initialization_candidate(connection: &Connection) -> Result<(), BrokerJournalError> {
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    match (application_id, user_version) {
        (0, 0) => {
            let object_count: i64 = connection.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )?;
            if object_count != 0 {
                return Err(BrokerJournalError::InitializationCandidateForeignSchema);
            }
        }
        (APPLICATION_ID, USER_VERSION) => {}
        _ => {
            return Err(BrokerJournalError::DatabaseIdentityMismatch {
                application_id,
                user_version,
            });
        }
    }
    Ok(())
}

fn verify_database_identity(connection: &Connection) -> Result<(), BrokerJournalError> {
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if application_id != APPLICATION_ID || user_version != USER_VERSION {
        return Err(BrokerJournalError::DatabaseIdentityMismatch {
            application_id,
            user_version,
        });
    }
    Ok(())
}

fn verify_connection_pragmas(connection: &Connection) -> Result<(), BrokerJournalError> {
    verify_database_identity(connection)?;
    let foreign_keys: i64 = connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    let trusted_schema: i64 =
        connection.query_row("PRAGMA trusted_schema", [], |row| row.get(0))?;
    let synchronous: i64 = connection.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
    let journal_mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    if foreign_keys != 1
        || trusted_schema != 0
        || synchronous != 2
        || !journal_mode.eq_ignore_ascii_case("wal")
    {
        return Err(BrokerJournalError::ConnectionPragmaMismatch);
    }
    Ok(())
}

fn verify_schema_version(connection: &Connection) -> Result<(), BrokerJournalError> {
    let rows = connection.query_row(
        "SELECT count(*),
                sum(CASE WHEN key = 'schema_version' AND value = ?1 THEN 1 ELSE 0 END)
         FROM broker_metadata",
        [SCHEMA_VERSION],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    if rows != (1, 1) {
        return Err(BrokerJournalError::BrokerMetadataMismatch);
    }
    Ok(())
}

fn verify_schema_shape(connection: &Connection) -> Result<(), BrokerJournalError> {
    let mut statement = connection.prepare(
        "SELECT type, name FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )?;
    let observed = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let expected = EXPECTED_SCHEMA_OBJECTS
        .iter()
        .map(|(object_type, name)| ((*object_type).to_owned(), (*name).to_owned()))
        .collect::<Vec<_>>();
    if observed != expected {
        return Err(BrokerJournalError::SchemaObjectMismatch { expected, observed });
    }
    for table in [
        "broker_metadata",
        "operations",
        "capability_nonces",
        "operation_processes",
        "operation_transitions",
    ] {
        let strict: i64 = connection.query_row(
            "SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        if strict != 1 {
            return Err(BrokerJournalError::TableNotStrict(table));
        }
    }
    Ok(())
}
