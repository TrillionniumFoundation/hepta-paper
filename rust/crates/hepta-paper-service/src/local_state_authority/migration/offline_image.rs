//! Construction of a detached native SQLite image from the owner's already
//! verified legacy SQL snapshot. The only database opened here is :memory:.
//! No path, source connection, filesystem publication or maintenance capability
//! is accepted or produced. The public pinned owner is the sole entry point.
use super::source_rows::{JournalRows, read_source_rows};
use crate::{
    local_state_authority::storage,
    sqlite_mutation_coordinator::{Result, error, hash_bytes},
};
use ed25519_dalek::VerifyingKey;
use rusqlite::{Connection, MAIN_DB, TransactionBehavior};
use serde_json::{Value, json};

const INVALID: &str = "local_authority_offline_native_image_invalid";
const LIMIT: &str = "local_authority_offline_native_image_limit_exceeded";
const PAGE_SIZE: i64 = 4096;
const MAX_PAGES: i64 = 49_152;
const MAX_IMAGE_BYTES: usize = 192 * 1024 * 1024;

/// An offline artifact, not a migration or publication capability. The image
/// preserves historical configuration paths but does not open any of them.
/// There is no public constructor, deserializer, writable view or publisher.
pub struct OfflineNativeAuthorityImageV1 {
    bytes: Vec<u8>,
    report: Value,
}
impl OfflineNativeAuthorityImageV1 {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn report(&self) -> &Value {
        &self.report
    }
}

fn integer(db: &Connection, pragma: &str) -> Result<i64> {
    Ok(db.pragma_query_value(None, pragma, |row| row.get(0))?)
}
fn assert_native_image(db: &Connection, public_key_hash: &str) -> Result<()> {
    storage::assert_schema(db)?;
    if integer(db, "user_version")? != 1 {
        return Err(error(INVALID));
    }
    let mut identity =
        db.prepare("SELECT singleton,key_hash FROM main.authority_native_identity")?;
    let mut identity_rows = identity.query([])?;
    let row = identity_rows.next()?.ok_or_else(|| error(INVALID))?;
    if row.get::<_, i64>(0)? != 1
        || row.get::<_, String>(1)? != public_key_hash
        || identity_rows.next()?.is_some()
    {
        return Err(error(INVALID));
    }
    let mut check = db.prepare("PRAGMA main.quick_check")?;
    let mut checks = check.query([])?;
    if checks
        .next()?
        .ok_or_else(|| error(INVALID))?
        .get::<_, String>(0)?
        != "ok"
        || checks.next()?.is_some()
    {
        return Err(error(INVALID));
    }
    Ok(())
}

/// `rows` and `source_report` are produced together by the pinned owner's
/// private full-history observation. They are never accepted from a public
/// JSON request; the consistency checks below catch internal misbinding too.
pub(super) fn build_image(
    rows: &JournalRows,
    public_key: &VerifyingKey,
    source_report: &Value,
) -> Result<OfflineNativeAuthorityImageV1> {
    let key_hash = hash_bytes(public_key.as_bytes());
    if source_report["version"] != 1
        || source_report["kind"] != "HeptaLocalStateAuthorityLegacyHistoryInspectionV1"
        || source_report["evidenceScope"] != "signed_history_observation_no_migration_authority"
        || source_report["sourceLogicalHash"] != rows.logical_hash()
        || source_report["publicKeySha256"] != key_hash
        || source_report["rowCounts"] != rows.counts()
    {
        return Err(error(INVALID));
    }
    let mut destination = Connection::open_in_memory()?;
    // These settings apply only to our fresh, unshared memory database. The
    // hard page limit bounds native allocation before serialization allocates
    // an image; it never authorizes dropping/truncating historical rows.
    destination.pragma_update(None, "page_size", PAGE_SIZE)?;
    destination.pragma_update(None, "temp_store", "MEMORY")?;
    destination.pragma_update(None, "max_page_count", MAX_PAGES)?;
    if integer(&destination, "page_size")? != PAGE_SIZE
        || integer(&destination, "max_page_count")? != MAX_PAGES
        || integer(&destination, "temp_store")? != 2
    {
        return Err(error(INVALID));
    }
    let post_hash;
    {
        let tx = destination.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("../schema.sql"))?;
        rows.copy_into(&tx)?;
        tx.execute(
            "INSERT INTO main.authority_native_identity(singleton,key_hash) VALUES(1,?1)",
            [&key_hash],
        )?;
        tx.pragma_update(None, "user_version", 1)?;
        assert_native_image(&tx, &key_hash)?;
        let observed = read_source_rows(&tx)?;
        post_hash = observed.logical_hash().to_owned();
        if post_hash != rows.logical_hash() || observed.counts() != rows.counts() {
            return Err(error("local_authority_offline_native_image_rows_changed"));
        }
        tx.commit()?;
    }
    assert_native_image(&destination, &key_hash)?;
    let page_count = integer(&destination, "page_count")?;
    let expected_bytes = page_count
        .checked_mul(integer(&destination, "page_size")?)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0 && *n <= MAX_IMAGE_BYTES)
        .ok_or_else(|| error(LIMIT))?;
    if page_count > MAX_PAGES || integer(&destination, "page_size")? != PAGE_SIZE {
        return Err(error(LIMIT));
    }
    // Use the dependency's safe SQLite serialization API. Do not write a
    // temporary file, reopen the source, or construct a raw SQLite allocation.
    let serialized = destination.serialize(MAIN_DB)?;
    if serialized.len() != expected_bytes || serialized.len() > MAX_IMAGE_BYTES {
        return Err(error(LIMIT));
    }
    // A standalone image must not advertise a WAL whose bytes are absent.
    if serialized.len() < 100
        || &serialized[..16] != b"SQLite format 3\0"
        || serialized[18..20] != [1, 1]
    {
        return Err(error(INVALID));
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(serialized.len())
        .map_err(|_| error(LIMIT))?;
    bytes.extend_from_slice(&serialized);
    let report = json!({
        "version":1,"kind":"HeptaLocalStateAuthorityOfflineNativeImageV1",
        "evidenceScope":"offline_native_image_no_publication_authority",
        "sourceLogicalHash":rows.logical_hash(),"nativeLogicalHash":post_hash,
        "logicalHashProfile":"HeptaLocalStateAuthorityLegacySqlRowsV1",
        "nativeLogicalHashScope":"preserved_six_legacy_tables_including_rowids_and_raw_text",
        "publicKeySha256":key_hash,"userVersion":1,"rowCounts":rows.counts(),
        "imageSha256":hash_bytes(&bytes),"imageByteLength":bytes.len(),
        "sourceHistory":source_report,
    });
    Ok(OfflineNativeAuthorityImageV1 { bytes, report })
}

#[cfg(test)]
mod tests;
