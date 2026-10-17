CREATE TABLE IF NOT EXISTS authority_metadata(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  configuration_hash TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  database_scope_hash TEXT NOT NULL,
  writer_manifest_hash TEXT NOT NULL,
  global_sequence INTEGER NOT NULL CHECK(global_sequence>=0),
  global_hash TEXT NOT NULL,
  schema_transition_state TEXT NOT NULL
    CHECK(schema_transition_state IN('uninitialized','reserved','finalized'))
) STRICT;
CREATE TABLE IF NOT EXISTS authority_database_head(
  database_instance_id TEXT PRIMARY KEY,
  database_role TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS authority_schema_transition(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  reserve_request_json TEXT NOT NULL,
  reservation_receipt_json TEXT NOT NULL,
  finalize_request_json TEXT,
  finalization_receipt_json TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS authority_schema_rebind(
  transition_id TEXT PRIMARY KEY,
  reserve_request_json TEXT NOT NULL,
  reservation_receipt_json TEXT NOT NULL,
  finalize_request_json TEXT,
  finalization_receipt_json TEXT,
  target_configuration_hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS authority_mutation(
  mutation_attempt_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN('reserved','finalized','aborted')),
  global_sequence INTEGER NOT NULL UNIQUE,
  database_instance_id TEXT NOT NULL,
  reserve_request_json TEXT NOT NULL,
  reservation_receipt_json TEXT NOT NULL,
  finalize_request_json TEXT,
  finalization_receipt_json TEXT,
  abort_request_json TEXT,
  abort_receipt_json TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS authority_backup_reservation(
  reservation_id TEXT PRIMARY KEY,
  reserve_request_json TEXT NOT NULL,
  reservation_receipt_json TEXT NOT NULL,
  finalize_request_json TEXT,
  finalization_receipt_json TEXT
) STRICT;
