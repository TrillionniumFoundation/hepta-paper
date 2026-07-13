PRAGMA foreign_keys = ON;

ALTER TABLE submission_outbox ADD COLUMN claimed_by TEXT;
ALTER TABLE submission_outbox ADD COLUMN lease_token TEXT;
ALTER TABLE submission_outbox ADD COLUMN lease_expires_at TEXT;
ALTER TABLE submission_outbox ADD COLUMN heartbeat_at TEXT;
ALTER TABLE submission_outbox ADD COLUMN executor_capabilities_hash TEXT;

DROP INDEX IF EXISTS idx_submission_outbox_active_action_scope;
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_outbox_active_action_scope
  ON submission_outbox(action_scope_key)
  WHERE action_scope_key IS NOT NULL
    AND status IN ('pending','in_flight','retryable_failure','waiting_for_response','reauthorization_required','responded');
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_outbox_lease_token
  ON submission_outbox(lease_token) WHERE lease_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submission_outbox_claimable
  ON submission_outbox(provider,account_id,status,next_attempt_at,lease_expires_at,created_at);

CREATE TABLE IF NOT EXISTS submission_provider_capabilities (
  capability_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  portal_route TEXT NOT NULL,
  executor_descriptor_hash TEXT NOT NULL,
  capabilities_hash TEXT NOT NULL,
  attestation_hash TEXT NOT NULL UNIQUE,
  verification_receipt_hash TEXT NOT NULL UNIQUE,
  verified_subject_ids_json TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider,account_id,executor_descriptor_hash)
);

CREATE TABLE IF NOT EXISTS submission_delivery_cursors (
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  cursor_response_id TEXT,
  cursor_received_at TEXT,
  cursor_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider,account_id)
);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','16',datetime('now')),
  ('submission_delivery_leases','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
