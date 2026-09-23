PRAGMA foreign_keys = ON;

ALTER TABLE receipt_ledger ADD COLUMN writer_id TEXT;
ALTER TABLE receipt_ledger ADD COLUMN writer_kind TEXT;
ALTER TABLE receipt_ledger ADD COLUMN writer_trusted INTEGER NOT NULL DEFAULT 0;

ALTER TABLE submission_outbox ADD COLUMN provider_capability_verification_receipt_hash TEXT;
ALTER TABLE submission_outbox ADD COLUMN portal_route TEXT;

ALTER TABLE submission_inbox ADD COLUMN persisted_receipt_id TEXT REFERENCES receipt_ledger(receipt_id);

ALTER TABLE submission_delivery_cursors ADD COLUMN cursor_sequence INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS submission_response_consumption (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id TEXT NOT NULL UNIQUE REFERENCES submission_inbox(response_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES submission_outbox(message_id),
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  anchor_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('UNCONSUMED','IN_PROGRESS','CONSUMED','REJECTED')),
  claimed_by TEXT,
  lease_token TEXT UNIQUE,
  lease_expires_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_response_consumption_scope
  ON submission_response_consumption(provider,account_id,state,sequence);

INSERT OR IGNORE INTO submission_response_consumption(
  response_id,message_id,provider,account_id,anchor_hash,state,created_at,updated_at
)
SELECT i.response_id,i.message_id,o.provider,o.account_id,
       'legacy:' || i.response_id,
       'UNCONSUMED',i.received_at,i.received_at
FROM submission_inbox i
JOIN submission_outbox o ON o.message_id=i.message_id
ORDER BY i.received_at,i.response_id;

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','17',datetime('now')),
  ('trusted_evidence_writer_policy','enabled',datetime('now')),
  ('submission_response_consumption','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
