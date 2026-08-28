pub(crate) const SCHEMA_VERSION: i64 = 1;

pub(crate) const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS broker_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE
    CHECK (length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'
      AND substr(request_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) = 71 AND substr(idempotency_key, 1, 7) = 'sha256:'
      AND substr(idempotency_key, 8) NOT GLOB '*[^0-9a-f]*'),
  signer_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  peer_pid INTEGER NOT NULL CHECK (peer_pid > 0),
  peer_uid INTEGER NOT NULL CHECK (peer_uid >= 0),
  peer_gid INTEGER NOT NULL CHECK (peer_gid >= 0),
  role TEXT NOT NULL CHECK (role IN ('author', 'reviewer', 'formal_reviewer', 'repairer')),
  current_state TEXT NOT NULL CHECK (current_state IN (
    'reserved', 'request_bound', 'process_spawned', 'event_stream_started',
    'terminal_event_observed', 'final_output_captured', 'schema_validated',
    'workspace_snapshotted', 'mutation_validated', 'result_prepared', 'acknowledged',
    'rejected_preflight', 'failed_before_spawn', 'cancelled_before_spawn',
    'failed_after_spawn', 'timed_out_after_spawn', 'terminal_failure',
    'event_stream_invalid', 'output_schema_invalid', 'mutation_policy_violated',
    'result_ambiguous'
  )),
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms > 0),
  updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
  provider_action_may_have_started INTEGER NOT NULL DEFAULT 0
    CHECK (provider_action_may_have_started IN (0, 1)),
  prepared_receipt_hash TEXT
    CHECK (prepared_receipt_hash IS NULL OR (
      length(prepared_receipt_hash) = 71
      AND substr(prepared_receipt_hash, 1, 7) = 'sha256:'
      AND substr(prepared_receipt_hash, 8) NOT GLOB '*[^0-9a-f]*'
    )),
  request_payload BLOB NOT NULL CHECK (length(request_payload) > 0),
  UNIQUE (signer_key_id, nonce)
) STRICT;

CREATE TABLE IF NOT EXISTS operation_transitions (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT NOT NULL CHECK (from_state IN (
    'reserved', 'request_bound', 'process_spawned', 'event_stream_started',
    'terminal_event_observed', 'final_output_captured', 'schema_validated',
    'workspace_snapshotted', 'mutation_validated', 'result_prepared', 'acknowledged',
    'rejected_preflight', 'failed_before_spawn', 'cancelled_before_spawn',
    'failed_after_spawn', 'timed_out_after_spawn', 'terminal_failure',
    'event_stream_invalid', 'output_schema_invalid', 'mutation_policy_violated',
    'result_ambiguous'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'reserved', 'request_bound', 'process_spawned', 'event_stream_started',
    'terminal_event_observed', 'final_output_captured', 'schema_validated',
    'workspace_snapshotted', 'mutation_validated', 'result_prepared', 'acknowledged',
    'rejected_preflight', 'failed_before_spawn', 'cancelled_before_spawn',
    'failed_after_spawn', 'timed_out_after_spawn', 'terminal_failure',
    'event_stream_invalid', 'output_schema_invalid', 'mutation_policy_violated',
    'result_ambiguous'
  )),
  recorded_at_unix_ms INTEGER NOT NULL CHECK (recorded_at_unix_ms > 0),
  evidence_hash TEXT
    CHECK (evidence_hash IS NULL OR (
      length(evidence_hash) = 71
      AND substr(evidence_hash, 1, 7) = 'sha256:'
      AND substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
    )),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  PRIMARY KEY (operation_id, sequence),
  FOREIGN KEY (operation_id) REFERENCES operations(operation_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS operations_no_delete
BEFORE DELETE ON operations
BEGIN
  SELECT RAISE(ABORT, 'broker operations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS operations_identity_immutable
BEFORE UPDATE OF operation_id, request_hash, idempotency_key, signer_key_id, nonce,
  peer_pid, peer_uid, peer_gid, role, created_at_unix_ms, request_payload
ON operations
BEGIN
  SELECT RAISE(ABORT, 'broker operation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS operations_provider_marker_monotonic
BEFORE UPDATE OF provider_action_may_have_started ON operations
WHEN OLD.provider_action_may_have_started = 1
  AND NEW.provider_action_may_have_started = 0
BEGIN
  SELECT RAISE(ABORT, 'provider action marker cannot be cleared');
END;

CREATE TRIGGER IF NOT EXISTS operations_prepared_receipt_immutable
BEFORE UPDATE OF prepared_receipt_hash ON operations
WHEN OLD.prepared_receipt_hash IS NOT NULL
  AND NEW.prepared_receipt_hash IS NOT OLD.prepared_receipt_hash
BEGIN
  SELECT RAISE(ABORT, 'prepared receipt identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS transitions_no_update
BEFORE UPDATE ON operation_transitions
BEGIN
  SELECT RAISE(ABORT, 'broker transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS transitions_no_delete
BEFORE DELETE ON operation_transitions
BEGIN
  SELECT RAISE(ABORT, 'broker transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS transition_insert_guard
BEFORE INSERT ON operation_transitions
BEGIN
  SELECT CASE
    WHEN (SELECT current_state FROM operations WHERE operation_id = NEW.operation_id)
      IN ('acknowledged', 'rejected_preflight', 'failed_before_spawn',
          'cancelled_before_spawn', 'failed_after_spawn', 'timed_out_after_spawn',
          'terminal_failure', 'event_stream_invalid', 'output_schema_invalid',
          'mutation_policy_violated', 'result_ambiguous')
    THEN RAISE(ABORT, 'terminal operation cannot transition')
  END;
  SELECT CASE
    WHEN NEW.from_state != (
      SELECT current_state FROM operations WHERE operation_id = NEW.operation_id
    )
    THEN RAISE(ABORT, 'transition source does not match operation state')
  END;
  SELECT CASE
    WHEN NEW.sequence != (
      SELECT COALESCE(MAX(sequence), 0) + 1
      FROM operation_transitions
      WHERE operation_id = NEW.operation_id
    )
    THEN RAISE(ABORT, 'transition sequence is not contiguous')
  END;
END;

INSERT OR IGNORE INTO broker_meta(key, value) VALUES ('schema_version', '1');
"#;
