//! Read-only schema and independently pinned signed-history observations for
//! explicit legacy journal migration. Neither observation proves a stopped
//! process or permission to rewrite a live journal. The detached memory-image
//! builder has no filesystem publisher or live migration executor.
use super::{Result, json};
use rusqlite::Connection;
use serde_json::Value;

mod archive;
mod backup_history;
mod cli;
mod history;
mod mutation_history;
mod offline_image;
mod schema_history;
mod source_profile;
mod source_rows;
pub use archive::OfflineLegacyAuthorityArchiveV1;
pub use cli::run_authority_journal_cli_v1;
pub use history::LegacyAuthorityJournalVerifierV1;
pub use offline_image::OfflineNativeAuthorityImageV1;

/// Internal historical composition for the existing native reserve owner. It
/// uses its held transaction/key, opens only memory references, checks the full
/// retained chain and actual heads, and returns no current protocol capability.
pub(super) fn verify_native_settled_history_in_held_transaction(
    database: &Connection,
    configuration: &Value,
    public_key: &ed25519_dalek::VerifyingKey,
) -> Result<()> {
    use crate::sqlite_mutation_coordinator::{error, hash, hash_bytes};
    source_profile::inspect_native_schema(database, &hash_bytes(public_key.as_bytes()))?;
    let rows = source_rows::read_source_rows(database)?;
    let schema = schema_history::verify_schema_history_v1(&rows, configuration, public_key)?;
    if !schema.initialized() {
        return Err(error("local_authority_history_uninitialized_rows_invalid"));
    }
    let observed = mutation_history::verify_mutation_history_v1(
        &rows,
        schema.genesis(),
        schema.trust(),
        public_key,
    )?;
    let [metadata] = rows.metadata() else {
        return Err(error("local_authority_history_terminal_state_mismatch"));
    };
    if metadata[0] != 1
        || metadata[2]
            != hash(
                "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
                configuration,
            )?
    {
        return Err(error("local_authority_history_terminal_state_mismatch"));
    }
    backup_history::verify_backup_history_v1(&rows, observed.head(), configuration, public_key)?;
    Ok(())
}

/// Inspect the exact incumbent Node authority schema using an already held
/// SQLite READ or WRITE transaction. The caller retains its connection and
/// transaction; this function never opens a source file, changes PRAGMAs,
/// writes rows, signs, commits, or acquires a service-maintenance capability.
///
/// The JSON report describes schema only. It is not a source-file identity,
/// logical-history digest, stop certificate, or migration authorization.
pub fn inspect_legacy_authority_journal_schema_v1(database: &Connection) -> Result<Value> {
    let profile = source_profile::inspect_source_schema(database)?;
    Ok(json!({
        "version": 1,
        "kind": "HeptaLocalStateAuthorityLegacySchemaInspectionV1",
        "evidenceScope": "schema_only_no_migration_authority",
        "sourceSchema": profile.schema(),
        "sourceSchemaHash": profile.schema_hash(),
        "sourceSchemaProfile": profile.profile_id(),
    }))
}
