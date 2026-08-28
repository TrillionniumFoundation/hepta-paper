pub(super) const SCHEMA_VERSION: &str = "1";
pub(super) const APPLICATION_ID: i64 = 1_213_224_001; // ASCII "HPTA"
pub(super) const USER_VERSION: i64 = 1;

pub(super) const EXPECTED_SCHEMA_OBJECTS: &[(&str, &str)] = &[
    ("table", "broker_metadata"),
    ("table", "capability_nonces"),
    ("table", "operation_transitions"),
    ("table", "operations"),
    ("trigger", "broker_metadata_no_delete"),
    ("trigger", "broker_metadata_no_insert"),
    ("trigger", "broker_metadata_no_update"),
    ("trigger", "capability_nonces_no_delete"),
    ("trigger", "capability_nonces_no_update"),
    ("trigger", "operation_transition_projection_guard"),
    ("trigger", "operation_transitions_no_delete"),
    ("trigger", "operation_transitions_no_update"),
    ("trigger", "operations_immutable_fields"),
    ("trigger", "operations_no_delete"),
    ("trigger", "operations_projection_guard"),
];

pub(super) const SCHEMA_SQL: &str = r#"
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 256;
PRAGMA journal_size_limit = 67108864;
PRAGMA application_id = 1213224001;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS broker_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO broker_metadata(key, value)
VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_payload BLOB NOT NULL,
    peer_pid INTEGER NOT NULL CHECK (peer_pid > 0),
    peer_uid INTEGER NOT NULL CHECK (peer_uid >= 0),
    peer_gid INTEGER NOT NULL CHECK (peer_gid >= 0),
    signer_key_id TEXT NOT NULL,
    capability_nonce TEXT NOT NULL UNIQUE,
    capability_message_hash TEXT NOT NULL,
    current_state TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms > 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
    provider_action_may_have_started INTEGER NOT NULL DEFAULT 0
        CHECK (provider_action_may_have_started IN (0, 1)),
    prepared_receipt_hash TEXT,
    CHECK (length(operation_id) BETWEEN 1 AND 128),
    CHECK (length(signer_key_id) BETWEEN 1 AND 128),
    CHECK (length(capability_nonce) BETWEEN 1 AND 128),
    CHECK (length(request_payload) BETWEEN 1 AND 1048576),
    CHECK (
        length(request_hash) = 71
        AND substr(request_hash, 1, 7) = 'sha256:'
        AND substr(request_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
        length(idempotency_key) = 71
        AND substr(idempotency_key, 1, 7) = 'sha256:'
        AND substr(idempotency_key, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
        length(capability_message_hash) = 71
        AND substr(capability_message_hash, 1, 7) = 'sha256:'
        AND substr(capability_message_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
        prepared_receipt_hash IS NULL OR (
            length(prepared_receipt_hash) = 71
            AND substr(prepared_receipt_hash, 1, 7) = 'sha256:'
            AND substr(prepared_receipt_hash, 8) NOT GLOB '*[^0-9a-f]*'
        )
    ),
    CHECK (current_state IN (
        'reserved', 'request_bound', 'process_spawned', 'event_stream_started',
        'terminal_event_observed', 'final_output_captured', 'schema_validated',
        'workspace_snapshotted', 'mutation_validated', 'result_prepared',
        'acknowledged', 'rejected_preflight', 'failed_before_spawn',
        'cancelled_before_spawn', 'failed_after_spawn', 'timed_out_after_spawn',
        'terminal_failure', 'event_stream_invalid', 'output_schema_invalid',
        'mutation_policy_violated', 'result_ambiguous'
    )),
    FOREIGN KEY (
        capability_nonce, signer_key_id, operation_id, created_at_unix_ms
    ) REFERENCES capability_nonces (
        nonce, signer_key_id, operation_id, consumed_at_unix_ms
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE IF NOT EXISTS capability_nonces (
    nonce TEXT PRIMARY KEY CHECK (length(nonce) BETWEEN 1 AND 128),
    signer_key_id TEXT NOT NULL CHECK (length(signer_key_id) BETWEEN 1 AND 128),
    operation_id TEXT NOT NULL UNIQUE,
    consumed_at_unix_ms INTEGER NOT NULL CHECK (consumed_at_unix_ms > 0),
    UNIQUE (nonce, signer_key_id, operation_id, consumed_at_unix_ms),
    FOREIGN KEY(operation_id) REFERENCES operations(operation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS operation_transitions (
    operation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    from_state TEXT NOT NULL CHECK (from_state IN (
        'reserved', 'request_bound', 'process_spawned', 'event_stream_started',
        'terminal_event_observed', 'final_output_captured', 'schema_validated',
        'workspace_snapshotted', 'mutation_validated', 'result_prepared'
    )),
    to_state TEXT NOT NULL CHECK (to_state IN (
        'request_bound', 'process_spawned', 'event_stream_started',
        'terminal_event_observed', 'final_output_captured', 'schema_validated',
        'workspace_snapshotted', 'mutation_validated', 'result_prepared',
        'acknowledged', 'rejected_preflight', 'failed_before_spawn',
        'cancelled_before_spawn', 'failed_after_spawn', 'timed_out_after_spawn',
        'terminal_failure', 'event_stream_invalid', 'output_schema_invalid',
        'mutation_policy_violated', 'result_ambiguous'
    )),
    recorded_at_unix_ms INTEGER NOT NULL CHECK (recorded_at_unix_ms > 0),
    evidence_hash TEXT,
    reason_code TEXT,
    PRIMARY KEY(operation_id, sequence),
    FOREIGN KEY(operation_id) REFERENCES operations(operation_id),
    CHECK (
        evidence_hash IS NULL OR (
            length(evidence_hash) = 71
            AND substr(evidence_hash, 1, 7) = 'sha256:'
            AND substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
        )
    ),
    CHECK (
        (to_state IN (
            'process_spawned', 'terminal_event_observed', 'final_output_captured',
            'schema_validated', 'workspace_snapshotted', 'mutation_validated',
            'result_prepared', 'acknowledged'
        )) = (evidence_hash IS NOT NULL)
    ),
    CHECK (
        (to_state IN (
            'rejected_preflight', 'failed_before_spawn', 'cancelled_before_spawn',
            'failed_after_spawn', 'timed_out_after_spawn', 'terminal_failure',
            'event_stream_invalid', 'output_schema_invalid',
            'mutation_policy_violated', 'result_ambiguous'
        )) = (reason_code IS NOT NULL)
    ),
    CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128)
) STRICT;

CREATE TRIGGER IF NOT EXISTS broker_metadata_no_insert
BEFORE INSERT ON broker_metadata
WHEN NOT (
    NEW.key = 'schema_version'
    AND NEW.value = '1'
    AND EXISTS (
        SELECT 1 FROM broker_metadata
        WHERE key = 'schema_version' AND value = '1'
    )
)
BEGIN
    SELECT RAISE(ABORT, 'broker metadata manifest is closed');
END;

CREATE TRIGGER IF NOT EXISTS broker_metadata_no_update
BEFORE UPDATE ON broker_metadata
BEGIN
    SELECT RAISE(ABORT, 'broker metadata is immutable');
END;

CREATE TRIGGER IF NOT EXISTS broker_metadata_no_delete
BEFORE DELETE ON broker_metadata
BEGIN
    SELECT RAISE(ABORT, 'broker metadata is immutable');
END;

CREATE TRIGGER IF NOT EXISTS operation_transitions_no_update
BEFORE UPDATE ON operation_transitions
BEGIN
    SELECT RAISE(ABORT, 'operation transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS operation_transitions_no_delete
BEFORE DELETE ON operation_transitions
BEGIN
    SELECT RAISE(ABORT, 'operation transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS capability_nonces_no_update
BEFORE UPDATE ON capability_nonces
BEGIN
    SELECT RAISE(ABORT, 'capability nonces are immutable');
END;

CREATE TRIGGER IF NOT EXISTS capability_nonces_no_delete
BEFORE DELETE ON capability_nonces
BEGIN
    SELECT RAISE(ABORT, 'capability nonces are immutable');
END;

CREATE TRIGGER IF NOT EXISTS operations_no_delete
BEFORE DELETE ON operations
BEGIN
    SELECT RAISE(ABORT, 'broker operations are immutable records');
END;

CREATE TRIGGER IF NOT EXISTS operations_immutable_fields
BEFORE UPDATE ON operations
WHEN NEW.operation_id != OLD.operation_id
  OR NEW.request_hash != OLD.request_hash
  OR NEW.idempotency_key != OLD.idempotency_key
  OR NEW.request_payload != OLD.request_payload
  OR NEW.peer_pid != OLD.peer_pid
  OR NEW.peer_uid != OLD.peer_uid
  OR NEW.peer_gid != OLD.peer_gid
  OR NEW.signer_key_id != OLD.signer_key_id
  OR NEW.capability_nonce != OLD.capability_nonce
  OR NEW.capability_message_hash != OLD.capability_message_hash
  OR NEW.created_at_unix_ms != OLD.created_at_unix_ms
BEGIN
    SELECT RAISE(ABORT, 'broker operation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS operation_transition_projection_guard
BEFORE INSERT ON operation_transitions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM operations
        WHERE operation_id = NEW.operation_id AND current_state = NEW.from_state
    ) THEN RAISE(ABORT, 'transition source does not match operation projection') END;
    SELECT CASE WHEN NEW.sequence != COALESCE((
        SELECT MAX(sequence) + 1 FROM operation_transitions
        WHERE operation_id = NEW.operation_id
    ), 1) THEN RAISE(ABORT, 'transition sequence is not contiguous') END;
    SELECT CASE WHEN NEW.recorded_at_unix_ms < (
        SELECT updated_at_unix_ms FROM operations WHERE operation_id = NEW.operation_id
    ) THEN RAISE(ABORT, 'transition time predates operation projection') END;
END;

CREATE TRIGGER IF NOT EXISTS operations_projection_guard
BEFORE UPDATE ON operations
WHEN NEW.current_state != OLD.current_state
  OR NEW.updated_at_unix_ms != OLD.updated_at_unix_ms
  OR NEW.provider_action_may_have_started != OLD.provider_action_may_have_started
  OR NEW.prepared_receipt_hash IS NOT OLD.prepared_receipt_hash
BEGIN
    SELECT CASE WHEN NEW.updated_at_unix_ms < OLD.updated_at_unix_ms
        THEN RAISE(ABORT, 'operation update time is not monotonic') END;
    SELECT CASE WHEN NEW.provider_action_may_have_started < OLD.provider_action_may_have_started
        THEN RAISE(ABORT, 'provider-action projection cannot regress') END;
    SELECT CASE WHEN OLD.prepared_receipt_hash IS NOT NULL
        AND NEW.prepared_receipt_hash IS NOT OLD.prepared_receipt_hash
        THEN RAISE(ABORT, 'prepared receipt projection is immutable') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM operation_transitions
        WHERE operation_id = NEW.operation_id
          AND sequence = (SELECT MAX(sequence) FROM operation_transitions
                          WHERE operation_id = NEW.operation_id)
          AND to_state = NEW.current_state
          AND recorded_at_unix_ms = NEW.updated_at_unix_ms
    ) THEN RAISE(ABORT, 'operation projection lacks matching append-only transition') END;
END;
"#;
