PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS receipt_ledger (
  receipt_id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  paper_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_ledger_stream_time ON receipt_ledger(stream, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipt_ledger_paper_time ON receipt_ledger(paper_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  paper_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  spec_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_receipt_id TEXT REFERENCES receipt_ledger(receipt_id),
  failure_class TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_priority ON jobs(status, priority, created_at);

CREATE TABLE IF NOT EXISTS job_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_id TEXT REFERENCES receipt_ledger(receipt_id),
  failure_class TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS submission_outbox (
  message_id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  dispatch_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_outbox_status_time ON submission_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS submission_inbox (
  response_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES submission_outbox(message_id),
  dispatch_hash TEXT NOT NULL,
  provider_receipt_hash TEXT,
  outcome TEXT NOT NULL,
  response_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_dead_letters (
  dead_letter_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES submission_outbox(message_id),
  failure_class TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_release_locks (
  paper_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  lock_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  reconciliation_hash TEXT
);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','2',datetime('now')),
  ('runtime_ledger','enabled',datetime('now')),
  ('legacy_catalog_runtime_scan','disabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
