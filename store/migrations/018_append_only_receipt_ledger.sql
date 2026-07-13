PRAGMA foreign_keys = ON;

ALTER TABLE receipt_ledger ADD COLUMN issuer_policy_id TEXT;
ALTER TABLE receipt_ledger ADD COLUMN issuer_policy_hash TEXT;
ALTER TABLE receipt_ledger ADD COLUMN issuer_assurance TEXT NOT NULL DEFAULT 'legacy_unclassified';

CREATE TABLE IF NOT EXISTS receipt_ledger_qualifications (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  qualification_id TEXT NOT NULL UNIQUE,
  receipt_id TEXT NOT NULL REFERENCES receipt_ledger(receipt_id),
  disposition TEXT NOT NULL CHECK(disposition IN ('superseded','invalid','administrative_exported','retention_tombstone')),
  reason TEXT NOT NULL,
  replacement_receipt_id TEXT REFERENCES receipt_ledger(receipt_id),
  qualification_json TEXT NOT NULL,
  qualification_sha256 TEXT NOT NULL,
  issuer_policy_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_ledger_qualifications_receipt
  ON receipt_ledger_qualifications(receipt_id,sequence);

CREATE TRIGGER IF NOT EXISTS receipt_ledger_forbid_update
BEFORE UPDATE ON receipt_ledger
BEGIN
  SELECT RAISE(ABORT, 'receipt_ledger_is_append_only');
END;

CREATE TRIGGER IF NOT EXISTS receipt_ledger_forbid_delete
BEFORE DELETE ON receipt_ledger
BEGIN
  SELECT RAISE(ABORT, 'receipt_ledger_is_append_only');
END;

CREATE TRIGGER IF NOT EXISTS receipt_ledger_qualifications_forbid_update
BEFORE UPDATE ON receipt_ledger_qualifications
BEGIN
  SELECT RAISE(ABORT, 'receipt_ledger_qualifications_are_append_only');
END;

CREATE TRIGGER IF NOT EXISTS receipt_ledger_qualifications_forbid_delete
BEFORE DELETE ON receipt_ledger_qualifications
BEGIN
  SELECT RAISE(ABORT, 'receipt_ledger_qualifications_are_append_only');
END;

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','18',datetime('now')),
  ('receipt_issuer_policy','registered_capability_required',datetime('now')),
  ('receipt_ledger_append_only','enabled',datetime('now')),
  ('receipt_ledger_qualification_projection','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
