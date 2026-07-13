PRAGMA foreign_keys = ON;

ALTER TABLE submission_outbox ADD COLUMN replay_key TEXT;
ALTER TABLE submission_outbox ADD COLUMN action_scope_key TEXT;
ALTER TABLE submission_outbox ADD COLUMN dispatch_cycle_hash TEXT;
ALTER TABLE submission_outbox ADD COLUMN authorization_receipt_hash TEXT;
ALTER TABLE submission_outbox ADD COLUMN executor_descriptor_hash TEXT;
ALTER TABLE submission_outbox ADD COLUMN response_due_at TEXT;
ALTER TABLE submission_inbox ADD COLUMN verification_receipt_hash TEXT;
ALTER TABLE submission_inbox ADD COLUMN verification_receipt_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_outbox_replay_key
  ON submission_outbox(replay_key) WHERE replay_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_outbox_active_action_scope
  ON submission_outbox(action_scope_key)
  WHERE action_scope_key IS NOT NULL
    AND status IN ('pending','retryable_failure','waiting_for_response','reauthorization_required','responded');
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_outbox_dispatch_cycle
  ON submission_outbox(dispatch_cycle_hash) WHERE dispatch_cycle_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS submission_authorization_consumptions (
  nonce TEXT PRIMARY KEY,
  authorization_receipt_hash TEXT NOT NULL UNIQUE,
  replay_key TEXT NOT NULL UNIQUE,
  dispatch_cycle_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE REFERENCES submission_outbox(message_id),
  consumed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_intake_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  message_id TEXT,
  paper_id TEXT,
  payload_hash TEXT NOT NULL,
  failure_codes_json TEXT NOT NULL,
  boundary_kind TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_quarantine_message_time
  ON submission_intake_quarantine(message_id, received_at DESC);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','15',datetime('now')),
  ('submission_boundary_hardening','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
