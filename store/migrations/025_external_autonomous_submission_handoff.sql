PRAGMA foreign_keys = ON;

-- The autonomous submission state machine moves to its own trust database.
-- Merely applying this migration does not activate the cutover: an offline
-- coordinator must first provision and bind the dedicated handoff store, then
-- insert the single immutable cutover row below.  This keeps upgrades
-- recoverable while making every post-cutover native autonomous write fail.
CREATE TABLE IF NOT EXISTS autonomous_submission_handoff_cutover (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  cutover_id TEXT NOT NULL UNIQUE,
  handoff_database_identity_hash TEXT NOT NULL,
  legacy_autonomous_row_count INTEGER NOT NULL CHECK(legacy_autonomous_row_count >= 0),
  legacy_quarantined_row_count INTEGER NOT NULL CHECK(legacy_quarantined_row_count >= 0),
  activated_at TEXT NOT NULL
);

CREATE TRIGGER autonomous_submission_handoff_cutover_require_drained
BEFORE INSERT ON autonomous_submission_handoff_cutover
WHEN EXISTS (
  SELECT 1 FROM submission_outbox
  WHERE delivery_kind='autonomous'
    AND status NOT IN ('responded','dead_letter')
)
BEGIN
  SELECT RAISE(ABORT, 'autonomous_submission_handoff_cutover_drain_required');
END;

CREATE TRIGGER autonomous_submission_handoff_cutover_immutable_update
BEFORE UPDATE ON autonomous_submission_handoff_cutover
BEGIN
  SELECT RAISE(ABORT, 'autonomous_submission_handoff_cutover_immutable');
END;

CREATE TRIGGER autonomous_submission_handoff_cutover_immutable_delete
BEFORE DELETE ON autonomous_submission_handoff_cutover
BEGIN
  SELECT RAISE(ABORT, 'autonomous_submission_handoff_cutover_immutable');
END;

CREATE TRIGGER submission_outbox_autonomous_externalized_insert
BEFORE INSERT ON submission_outbox
WHEN NEW.delivery_kind='autonomous'
  AND EXISTS (SELECT 1 FROM autonomous_submission_handoff_cutover WHERE singleton=1)
BEGIN
  SELECT RAISE(ABORT, 'autonomous_submission_outbox_externalized');
END;

CREATE TRIGGER submission_outbox_autonomous_externalized_update
BEFORE UPDATE ON submission_outbox
WHEN OLD.delivery_kind='autonomous'
  AND EXISTS (SELECT 1 FROM autonomous_submission_handoff_cutover WHERE singleton=1)
BEGIN
  SELECT RAISE(ABORT, 'autonomous_submission_outbox_externalized');
END;

CREATE TRIGGER submission_outbox_autonomous_externalized_delete
BEFORE DELETE ON submission_outbox
WHEN OLD.delivery_kind='autonomous'
  AND EXISTS (SELECT 1 FROM autonomous_submission_handoff_cutover WHERE singleton=1)
BEGIN
  SELECT RAISE(ABORT, 'autonomous_submission_outbox_externalized');
END;

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','25',datetime('now')),
  ('autonomous_submission_handoff_cutover','available_inactive',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
