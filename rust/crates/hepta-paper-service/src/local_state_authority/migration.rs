//! Read-only schema and independently pinned signed-history observations for
//! explicit legacy journal migration. Neither observation proves a stopped
//! process or permission to rewrite a live journal. The detached memory-image
//! builder has no filesystem publisher or live migration executor.
use super::{Result, json};
use rusqlite::Connection;
use serde_json::Value;

mod archive;
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
    }))
}
