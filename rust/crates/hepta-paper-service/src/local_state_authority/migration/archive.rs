//! Original-format, complete SQLite backup image of a verified held snapshot.
//! Only the pinned history owner calls this private builder. No source-family
//! file descriptor, destination path, publisher or maintenance claim is used.
use crate::sqlite_mutation_coordinator::{Result, error, hash_bytes};
use rusqlite::{
    Connection, MAIN_DB, TransactionState,
    backup::{Backup, StepResult},
};
use serde_json::{Value, json};

const INVALID: &str = "local_authority_archive_invalid";
const LIMIT: &str = "local_authority_archive_limit_exceeded";
const MAX_BYTES: i64 = 192 * 1024 * 1024;
const STEP_PAGES: i32 = 128;

/// Original Node-format SQLite bytes, including every page copied by SQLite.
/// This is neither a source file byte-for-byte copy nor a WAL file archive.
/// The returned image contains the complete held logical snapshot. Its journal
/// header mode is preserved; WAL-format images reopen as ordinary SQLite files,
/// but SQLite's in-memory deserialize API cannot consume that mode unchanged.
/// There is no public constructor, deserializer, writable handle or publisher.
pub struct OfflineLegacyAuthorityArchiveV1 {
    bytes: Vec<u8>,
    report: Value,
}
impl OfflineLegacyAuthorityArchiveV1 {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn report(&self) -> &Value {
        &self.report
    }
}

fn scalar(db: &Connection, name: &str) -> Result<i64> {
    Ok(db.pragma_query_value(Some("main"), name, |row| row.get(0))?)
}
pub(super) fn require_read_snapshot(db: &Connection) -> Result<()> {
    if db.is_autocommit() || db.transaction_state(Some("main"))? != TransactionState::Read {
        return Err(error("local_authority_archive_main_read_snapshot_required"));
    }
    Ok(())
}
fn size(db: &Connection) -> Result<(i64, i64, usize)> {
    let page_size = scalar(db, "page_size")?;
    let pages = scalar(db, "page_count")?;
    if !(512..=65_536).contains(&page_size) || !(page_size as u64).is_power_of_two() || pages <= 0 {
        return Err(error(INVALID));
    }
    let bytes = pages
        .checked_mul(page_size)
        .filter(|n| *n <= MAX_BYTES)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| error(LIMIT))?;
    Ok((page_size, pages, bytes))
}

pub(super) fn copy_snapshot(source: &Connection) -> Result<Connection> {
    require_read_snapshot(source)?;
    let changes = source.total_changes();
    let (page_size, pages, _) = size(source)?;
    let mut destination = Connection::open_in_memory()?;
    // The SQLite backup API requires equal page sizes for a memory destination.
    // Bounds include the full source page allocation, including its freelist.
    destination.pragma_update(None, "page_size", page_size)?;
    destination.pragma_update(None, "temp_store", "MEMORY")?;
    destination.pragma_update(None, "max_page_count", MAX_BYTES / page_size)?;
    if scalar(&destination, "page_size")? != page_size
        || scalar(&destination, "max_page_count")? != MAX_BYTES / page_size
    {
        return Err(error(INVALID));
    }
    {
        let backup = Backup::new(source, &mut destination)?;
        let mut remaining = pages;
        loop {
            let result = backup.step(STEP_PAGES)?;
            // Never spin or silently restart on busy, locked or unknown states.
            if !matches!(result, StepResult::More | StepResult::Done) {
                return Err(error("local_authority_archive_backup_incomplete"));
            }
            let progress = backup.progress();
            let next = i64::from(progress.remaining);
            if i64::from(progress.pagecount) != pages
                || next < 0
                || next >= remaining
                || (result == StepResult::Done) != (next == 0)
            {
                return Err(error("local_authority_archive_backup_progress_invalid"));
            }
            remaining = next;
            if result == StepResult::Done {
                break;
            }
        }
        // The safe rusqlite owner's Drop calls backup_finish exactly once.
        // Every step above must succeed and terminate at SQLITE_DONE. No
        // destination API is called while this Backup owner is alive.
    }
    require_read_snapshot(source)?;
    if source.total_changes() != changes || size(&destination)? != size(source)? {
        return Err(error("local_authority_archive_source_changed"));
    }
    Ok(destination)
}

pub(super) fn seal(
    destination: Connection,
    history: &Value,
) -> Result<OfflineLegacyAuthorityArchiveV1> {
    if destination.path() != Some("")
        || !destination.is_autocommit()
        || history["kind"] != "HeptaLocalStateAuthorityLegacyHistoryInspectionV1"
        || history["evidenceScope"] != "signed_history_observation_no_migration_authority"
    {
        return Err(error(INVALID));
    }
    let (page_size, pages, expected_bytes) = size(&destination)?;
    let serialized = destination.serialize(MAIN_DB)?;
    if serialized.len() != expected_bytes
        || serialized.len() < 100
        || &serialized[..16] != b"SQLite format 3\0"
        || !matches!(&serialized[18..20], [1, 1] | [2, 2])
    {
        return Err(error(INVALID));
    }
    let journal_header_mode = if serialized[18] == 2 {
        "wal"
    } else {
        "rollback"
    };
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(serialized.len())
        .map_err(|_| error(LIMIT))?;
    bytes.extend_from_slice(&serialized);
    let report = json!({
        "version":1,"kind":"HeptaLocalStateAuthorityOfflineLegacyArchiveV1",
        "evidenceScope":"offline_original_format_archive_no_publication_authority",
        "archiveFormat":"sqlite_backup_image","userVersion":0,
        "sourceLogicalHash":history["sourceLogicalHash"],
        "archiveLogicalHash":history["sourceLogicalHash"],
        "sourceSchemaHash":history["sourceSchemaHash"],
        "logicalHashProfile":"HeptaLocalStateAuthorityLegacySqlRowsV1",
        "rowCounts":history["rowCounts"],"sourceHistory":history,
        "pageSize":page_size,"pageCount":pages,"journalHeaderMode":journal_header_mode,
        "archiveSha256":hash_bytes(&bytes),"archiveByteLength":bytes.len(),
        "backupComplete":true,
    });
    Ok(OfflineLegacyAuthorityArchiveV1 { bytes, report })
}
