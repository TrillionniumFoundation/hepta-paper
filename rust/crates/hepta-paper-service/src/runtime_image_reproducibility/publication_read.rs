//! Status-only private snapshots. Writer helpers in the parent stay unchanged.
use super::*;
use rusqlite::{limits::Limit, types::ValueRef};
use std::{collections::BTreeSet, fs::Metadata, io::Read, time::Duration};

const FILE_INVALID: &str = "runtime_reproducibility_receipt_file_invalid";
const CHANGED: &str = "runtime_reproducibility_receipt_database_changed";
const MIRROR_DRIFT: &str = "runtime_reproducibility_receipt_mirror_drift";
const DATABASE_INVALID: &str = "runtime_reproducibility_publication_database_invalid";
const AUTHORITY_INVALID: &str = "runtime_reproducibility_receipt_authority_state_invalid";
const SCHEMA_UNSUPPORTED: &str = "runtime_reproducibility_receipt_schema_unsupported";
const MAXIMUM_SCHEMA_ENTRIES: usize = 128;
const MAXIMUM_COLUMNS: usize = 64;
const MAXIMUM_SCHEMA_SQL_BYTES: usize = 65_536;
const MAXIMUM_METADATA_BYTES: i64 = 4096;

pub(super) fn read_publication(
    receipt_path: &Path,
    context: &ReceiptVerificationContext<'_>,
) -> Result<Option<Value>> {
    let candidate = PathBuf::from(format!("{}.publication.sqlite", receipt_path.display()));
    ensure(
        receipt_path.is_absolute(),
        "runtime_reproducibility_receipt_path_invalid",
    )?;
    if !candidate.try_exists()? {
        return Ok(None);
    }
    // Preserve the original initial policy, including early rejection of an
    // existing unsafe mirror even when there is no authority row.
    let database_path = paths(receipt_path)?;
    let parent = private_parent(receipt_path, false)?;
    let policy = SourcePolicy::capture(receipt_path, database_path, parent)?;
    // No regular mirror FD escapes capture. Absence/read errors remain deferred
    // until after the actual authority row has been found and validated.
    let mirror = Mirror::capture(receipt_path, &policy.parent);
    policy.assert_current()?;
    let parent_path = receipt_path
        .parent()
        .ok_or("runtime_reproducibility_receipt_path_invalid")?;
    let relative = leaf(&policy.database_path)?;
    let result = crate::state_database_inventory::with_database_effective_snapshot_path_v1(
        parent_path,
        relative,
        "runtime-reproducibility-publication",
        |snapshot| {
            // This is the policy of the original effective UID, not the shared
            // helper's optional real-UID profile. Check retained source/sidecar
            // owners before and after private SQLite, without reopening them.
            policy.assert_current().map_err(|error| error.0)?;
            let authority = read_snapshot(snapshot);
            policy.assert_current().map_err(|error| error.0)?;
            authority.map_err(|error| error.0)
        },
    );
    policy.assert_current()?;
    let Some(authority) = result.map_err(snapshot_error)? else {
        return Ok(None);
    };
    let mirror = mirror.map_err(|_| Error(MIRROR_DRIFT.into()))?;
    ensure(
        mirror.bytes == authority.bytes && parse(&mirror.bytes)? == authority.receipt,
        MIRROR_DRIFT,
    )?;
    let inspection = verify_runtime_image_reproducibility_receipt_v2(&authority.receipt, context)?;
    mirror.assert_current(receipt_path, &policy.parent)?;
    policy.assert_current()?;
    Ok(Some(json!({
        "receipt": authority.receipt,
        "inspection": inspection,
        "receiptContentHash": authority.content_hash,
        "publicationGeneration": authority.generation,
    })))
}

fn snapshot_error(
    error: crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError,
) -> Error {
    if error.code.starts_with("runtime_reproducibility_") {
        return Error(error.code);
    }
    let code = match error.code.as_str() {
        "autonomous_research_state_database_file_unsafe"
        | "autonomous_research_state_database_inventory_limit_exceeded" => FILE_INVALID,
        "autonomous_research_state_database_rollback_journal_pending" => {
            "runtime_reproducibility_receipt_rollback_journal_pending"
        }
        _ => CHANGED,
    };
    Error(code.into())
}

/// O_PATH pins preserve actual source identity/ownership without regular-file
/// close effects on SQLite locks. Only the shared snapshot owner reads bytes.
struct SourcePin {
    path: PathBuf,
    held: Option<(File, Metadata)>,
}
impl SourcePin {
    fn capture(path: PathBuf, parent: &File) -> Result<Self> {
        let held = match openat(
            parent.as_fd(),
            leaf(&path)?,
            OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => {
                let held = File::from(fd);
                let metadata = held.metadata()?;
                safe_metadata(&metadata)?;
                Some((held, metadata))
            }
            Err(nix::errno::Errno::ENOENT) => None,
            Err(_) => return Err(FILE_INVALID.into()),
        };
        let result = Self { path, held };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        match &self.held {
            Some((held, original)) => {
                let named = fs::symlink_metadata(&self.path).map_err(|_| Error(CHANGED.into()))?;
                let current = held.metadata()?;
                safe_metadata(&current)?;
                safe_metadata(&named)?;
                ensure(
                    !named.is_symlink()
                        && same_snapshot(original, &current)
                        && same_snapshot(original, &named),
                    CHANGED,
                )
            }
            None => ensure(
                matches!(fs::symlink_metadata(&self.path), Err(error) if error.kind() == std::io::ErrorKind::NotFound),
                CHANGED,
            ),
        }
    }
}

struct SourcePolicy {
    receipt_path: PathBuf,
    database_path: PathBuf,
    parent: File,
    sources: Vec<SourcePin>,
}
impl SourcePolicy {
    fn capture(receipt_path: &Path, database_path: PathBuf, parent: File) -> Result<Self> {
        verify_parent(receipt_path, &parent)?;
        let mut sources = Vec::with_capacity(4);
        for suffix in ["", "-wal", "-shm", "-journal"] {
            sources.push(SourcePin::capture(
                PathBuf::from(format!("{}{suffix}", database_path.display())),
                &parent,
            )?);
        }
        ensure(
            sources.first().is_some_and(|source| source.held.is_some()),
            FILE_INVALID,
        )?;
        let result = Self {
            receipt_path: receipt_path.to_owned(),
            database_path,
            parent,
            sources,
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        verify_parent(&self.receipt_path, &self.parent)?;
        for source in &self.sources {
            source.assert_current()?;
        }
        verify_parent(&self.receipt_path, &self.parent)
    }
}

/// Completed data only; the regular FD is closed before the snapshot callback.
struct Mirror {
    bytes: Vec<u8>,
    metadata: Metadata,
}
impl Mirror {
    fn capture(path: &Path, parent: &File) -> Result<Self> {
        verify_parent(path, parent)?;
        let mut file = open_leaf(parent, path, OFlag::O_RDONLY)?;
        let metadata = file.metadata()?;
        safe_metadata(&metadata)?;
        ensure(metadata.len() <= MAX, MIRROR_DRIFT)?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(metadata.len() + 1)
            .read_to_end(&mut bytes)?;
        ensure(
            bytes.len() as u64 == metadata.len() && same_snapshot(&metadata, &file.metadata()?),
            MIRROR_DRIFT,
        )?;
        let result = Self { bytes, metadata };
        result.assert_current(path, parent)?;
        drop(file);
        Ok(result)
    }
    fn assert_current(&self, path: &Path, parent: &File) -> Result<()> {
        verify_parent(path, parent)?;
        let named = fs::symlink_metadata(path).map_err(|_| Error(MIRROR_DRIFT.into()))?;
        ensure(
            named.is_file() && !named.is_symlink() && same_snapshot(&self.metadata, &named),
            MIRROR_DRIFT,
        )
    }
}

fn read_snapshot(path: &Path) -> Result<Option<Authority>> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    for (limit, value) in [
        (Limit::SQLITE_LIMIT_LENGTH, (MAX + 65_536) as i32),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, 512 * 1024),
        (Limit::SQLITE_LIMIT_COLUMN, MAXIMUM_COLUMNS as i32),
        (Limit::SQLITE_LIMIT_EXPR_DEPTH, 100),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_WORKER_THREADS, 0),
    ] {
        connection.set_limit(limit, value)?;
    }
    connection.busy_timeout(Duration::from_secs(1))?;
    let mut ticks = 0u32;
    connection.progress_handler(
        1000,
        Some(move || {
            ticks = ticks.saturating_add(1);
            ticks > 10_000
        }),
    )?;
    connection.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
    ordinary_schema(&connection)?;
    bounded_row(&connection)?;
    // Preserve the original parser/hash/fence validation and its error codes.
    // The private copy cannot be mutated by a source writer between these reads.
    let result = authority(&connection);
    drop(connection);
    result
}

fn ordinary_schema(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT type,name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql END FROM sqlite_schema LIMIT 129",
    ).map_err(|_| Error(SCHEMA_UNSUPPORTED.into()))?;
    let mut rows = statement
        .query([])
        .map_err(|_| Error(SCHEMA_UNSUPPORTED.into()))?;
    let mut count = 0usize;
    let mut found = false;
    while let Some(row) = rows.next().map_err(|_| Error(SCHEMA_UNSUPPORTED.into()))? {
        count += 1;
        ensure(count <= MAXIMUM_SCHEMA_ENTRIES, SCHEMA_UNSUPPORTED)?;
        let kind = small_text(row, 0, 16)?;
        let name = small_text(row, 1, 256)?;
        match row
            .get_ref(2)
            .map_err(|_| Error(SCHEMA_UNSUPPORTED.into()))?
        {
            ValueRef::Null if kind == "index" && name.starts_with("sqlite_autoindex_") => (),
            ValueRef::Text(bytes) if bytes.len() <= MAXIMUM_SCHEMA_SQL_BYTES => {
                if name == TABLE {
                    let text =
                        std::str::from_utf8(bytes).map_err(|_| Error(SCHEMA_UNSUPPORTED.into()))?;
                    let mut words = text.split_whitespace();
                    ensure(
                        kind == "table"
                            && words
                                .next()
                                .is_some_and(|word| word.eq_ignore_ascii_case("CREATE"))
                            && words
                                .next()
                                .is_some_and(|word| word.eq_ignore_ascii_case("TABLE")),
                        SCHEMA_UNSUPPORTED,
                    )?;
                    found = true;
                }
            }
            _ => return Err(SCHEMA_UNSUPPORTED.into()),
        }
    }
    ensure(found, DATABASE_INVALID)?;
    let mut statement =
        connection.prepare("PRAGMA table_xinfo(runtime_image_reproducibility_receipt)")?;
    let mut rows = statement.query([])?;
    let mut names = BTreeSet::new();
    while let Some(row) = rows.next()? {
        ensure(names.len() < MAXIMUM_COLUMNS, SCHEMA_UNSUPPORTED)?;
        let name = small_text(row, 1, 128)?;
        let hidden: i64 = row.get(6)?;
        ensure(hidden == 0 && names.insert(name), SCHEMA_UNSUPPORTED)?;
    }
    ensure(
        [
            "singleton_id",
            "receipt_json",
            "receipt_content_hash",
            "receipt_hash",
            "issued_at",
            "expires_at",
            "publication_generation",
        ]
        .iter()
        .all(|name| names.contains(*name)),
        DATABASE_INVALID,
    )
}
fn small_text(row: &rusqlite::Row<'_>, index: usize, maximum: usize) -> Result<String> {
    match row
        .get_ref(index)
        .map_err(|_| Error(SCHEMA_UNSUPPORTED.into()))?
    {
        ValueRef::Text(bytes) if bytes.len() <= maximum => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| Error(SCHEMA_UNSUPPORTED.into())),
        _ => Err(SCHEMA_UNSUPPORTED.into()),
    }
}
fn bounded_row(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT typeof(receipt_json),length(CAST(receipt_json AS BLOB)),typeof(receipt_content_hash),length(CAST(receipt_content_hash AS BLOB)),typeof(receipt_hash),length(CAST(receipt_hash AS BLOB)),typeof(issued_at),length(CAST(issued_at AS BLOB)),typeof(expires_at),length(CAST(expires_at AS BLOB)),typeof(publication_generation) FROM runtime_image_reproducibility_receipt WHERE singleton_id=1 LIMIT 2",
    )?;
    let mut rows = statement.query([])?;
    if let Some(row) = rows.next()? {
        for index in [0, 2, 4, 6, 8] {
            ensure(row.get::<_, String>(index)? == "text", DATABASE_INVALID)?;
            let length: i64 = row.get(index + 1)?;
            let maximum = if index == 0 {
                MAX as i64
            } else {
                MAXIMUM_METADATA_BYTES
            };
            ensure((0..=maximum).contains(&length), AUTHORITY_INVALID)?;
        }
        ensure(row.get::<_, String>(10)? == "integer", DATABASE_INVALID)?;
        ensure(rows.next()?.is_none(), AUTHORITY_INVALID)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "publication_read_tests.rs"]
mod tests;
