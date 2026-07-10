PRAGMA foreign_keys = ON;

ALTER TABLE receipt_ledger ADD COLUMN environment TEXT NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE receipt_ledger ADD COLUMN evidence_class TEXT NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE receipt_ledger ADD COLUMN release_commit TEXT;
CREATE INDEX IF NOT EXISTS idx_receipt_ledger_environment_class
  ON receipt_ledger(environment, evidence_class, created_at DESC);

ALTER TABLE jobs ADD COLUMN environment TEXT NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE jobs ADD COLUMN evidence_class TEXT NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE job_attempts ADD COLUMN environment TEXT NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE job_attempts ADD COLUMN evidence_class TEXT NOT NULL DEFAULT 'legacy_unclassified';

UPDATE receipt_ledger
SET environment='verification', evidence_class='technical_conformance'
WHERE stream='capability-verification';

UPDATE receipt_ledger
SET environment='administrative', evidence_class='backup_or_restore_drill'
WHERE stream='store-admin';

UPDATE receipt_ledger
SET environment='production', evidence_class='non_authoritative_pilot'
WHERE stream='real-paper-pilots';

UPDATE receipt_ledger
SET environment='production', evidence_class='operational_candidate'
WHERE stream='jobs' AND receipt_json LIKE '%A_Theory_of__Expectations%';

UPDATE jobs
SET environment='production', evidence_class='non_authoritative_pilot'
WHERE job_id LIKE 'research-worker:A_Theory_of__Expectations:%';

UPDATE job_attempts
SET environment='production', evidence_class='non_authoritative_pilot'
WHERE job_id LIKE 'research-worker:A_Theory_of__Expectations:%';

UPDATE store_metadata SET value='3', updated_at=datetime('now') WHERE key='schema_version';
INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('evidence_isolation','enabled',datetime('now')),
  ('verification_runtime_policy','isolated',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
