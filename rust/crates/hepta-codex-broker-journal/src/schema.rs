use std::time::Duration;

use rusqlite::Connection;

use super::{store::JournalStoreError, types::BrokerJournalPolicyV1};

const APPLICATION_ID: i64 = 1_213_219_658;
const SCHEMA_VERSION: i64 = 1;
const JOURNAL_KIND: &str = "hepta-codex-broker-operation-journal-v1";

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS broker_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  capability_nonce TEXT NOT NULL UNIQUE,
  peer_process_id INTEGER NOT NULL CHECK (peer_process_id > 0),
  peer_user_id INTEGER NOT NULL CHECK (peer_user_id BETWEEN 0 AND 4294967295),
  peer_group_id INTEGER NOT NULL CHECK (peer_group_id BETWEEN 0 AND 4294967295),
  current_state TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms > 0),
  updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  provider_action_may_have_started INTEGER NOT NULL DEFAULT 0
    CHECK (provider_action_may_have_started IN (0, 1)),
  prepared_receipt_hash TEXT,
  CHECK (length(operation_id) BETWEEN 1 AND 128),
  CHECK (length(capability_nonce) BETWEEN 1 AND 128),
  CHECK (current_state IN (
    'reserved',
    'request_bound',
    'process_spawned',
    'event_stream_started',
    'terminal_event_observed',
    'final_output_captured',
    'schema_validated',
    'workspace_snapshotted',
    'mutation_validated',
    'result_prepared',
    'acknowledged',
    'rejected_preflight',
    'failed_before_spawn',
    'cancelled_before_spawn',
    'failed_after_spawn',
    'timed_out_after_spawn',
    'terminal_failure',
    'event_stream_invalid',
    'output_schema_invalid',
    'mutation_policy_violated',
    'result_ambiguous'
  ))
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS operation_transitions (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  recorded_at_unix_ms INTEGER NOT NULL CHECK (recorded_at_unix_ms > 0),
  evidence_hash TEXT,
  reason_code TEXT,
  transition_hash TEXT NOT NULL,
  PRIMARY KEY (operation_id, sequence),
  FOREIGN KEY (operation_id) REFERENCES operations(operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS operation_transitions_hash_unique
  ON operation_transitions(transition_hash);

CREATE TRIGGER IF NOT EXISTS broker_metadata_no_update
BEFORE UPDATE ON broker_metadata
BEGIN
  SELECT RAISE(ABORT, 'broker_metadata_append_only');
END;

CREATE TRIGGER IF NOT EXISTS broker_metadata_no_delete
BEFORE DELETE ON broker_metadata
BEGIN
  SELECT RAISE(ABORT, 'broker_metadata_append_only');
END;

CREATE TRIGGER IF NOT EXISTS operation_transitions_no_update
BEFORE UPDATE ON operation_transitions
BEGIN
  SELECT RAISE(ABORT, 'operation_transitions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS operation_transitions_no_delete
BEFORE DELETE ON operation_transitions
BEGIN
  SELECT RAISE(ABORT, 'operation_transitions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS operations_no_delete
BEFORE DELETE ON operations
BEGIN
  SELECT RAISE(ABORT, 'operations_not_deletable');
END;

CREATE TRIGGER IF NOT EXISTS operations_identity_immutable
BEFORE UPDATE OF
  operation_id,
  request_hash,
  idempotency_key,
  capability_nonce,
  peer_process_id,
  peer_user_id,
  peer_group_id,
  created_at_unix_ms
ON operations
BEGIN
  SELECT RAISE(ABORT, 'operation_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS operations_revision_monotonic
BEFORE UPDATE ON operations
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'operation_revision_not_incremented');
END;

CREATE TRIGGER IF NOT EXISTS operations_time_monotonic
BEFORE UPDATE ON operations
WHEN NEW.updated_at_unix_ms < OLD.updated_at_unix_ms
BEGIN
  SELECT RAISE(ABORT, 'operation_time_regressed');
END;

CREATE TRIGGER IF NOT EXISTS operations_provider_action_monotonic
BEFORE UPDATE ON operations
WHEN OLD.provider_action_may_have_started = 1
 AND NEW.provider_action_may_have_started != 1
BEGIN
  SELECT RAISE(ABORT, 'provider_action_flag_regressed');
END;

CREATE TRIGGER IF NOT EXISTS operations_prepared_receipt_immutable
BEFORE UPDATE ON operations
WHEN OLD.prepared_receipt_hash IS NOT NULL
 AND NEW.prepared_receipt_hash IS NOT OLD.prepared_receipt_hash
BEGIN
  SELECT RAISE(ABORT, 'prepared_receipt_hash_immutable');
END;
"#;

pub(super) fn initialize_connection(
    connection: &Connection,
    policy: BrokerJournalPolicyV1,
) -> Result<(), JournalStoreError> {
    connection
        .busy_timeout(Duration::from_millis(policy.busy_timeout_ms))
        .map_err(JournalStoreError::Sqlite)?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;\n\
             PRAGMA synchronous = FULL;\n\
             PRAGMA temp_store = MEMORY;\n\
             PRAGMA trusted_schema = OFF;\n\
             PRAGMA wal_autocheckpoint = 256;",
        )
        .map_err(JournalStoreError::Sqlite)?;
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(JournalStoreError::Sqlite)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(JournalStoreError::JournalModeNotWal(journal_mode));
    }
    connection
        .execute_batch(SCHEMA_SQL)
        .map_err(JournalStoreError::Sqlite)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO broker_metadata(key, value) VALUES ('journal_kind', ?1)",
            [JOURNAL_KIND],
        )
        .map_err(JournalStoreError::Sqlite)?;
    connection
        .execute_batch(&format!(
            "PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {SCHEMA_VERSION};"
        ))
        .map_err(JournalStoreError::Sqlite)?;
    verify_connection_contract(connection)
}

pub(super) fn verify_connection_contract(
    connection: &Connection,
) -> Result<(), JournalStoreError> {
    let foreign_keys: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(JournalStoreError::Sqlite)?;
    if foreign_keys != 1 {
        return Err(JournalStoreError::ForeignKeysDisabled);
    }
    let application_id: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(JournalStoreError::Sqlite)?;
    if application_id != APPLICATION_ID {
        return Err(JournalStoreError::ApplicationIdMismatch(application_id));
    }
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(JournalStoreError::Sqlite)?;
    if user_version != SCHEMA_VERSION {
        return Err(JournalStoreError::SchemaVersionMismatch(user_version));
    }
    let journal_kind: String = connection
        .query_row(
            "SELECT value FROM broker_metadata WHERE key = 'journal_kind'",
            [],
            |row| row.get(0),
        )
        .map_err(JournalStoreError::Sqlite)?;
    if journal_kind != JOURNAL_KIND {
        return Err(JournalStoreError::JournalKindMismatch(journal_kind));
    }
    Ok(())
}
