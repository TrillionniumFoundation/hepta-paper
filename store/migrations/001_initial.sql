PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  migration_sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS papers (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  venue_target TEXT NOT NULL DEFAULT '',
  paper_type TEXT NOT NULL DEFAULT '',
  canonical_dir TEXT NOT NULL,
  source_dir TEXT NOT NULL DEFAULT '',
  submission_dir TEXT NOT NULL DEFAULT 'submission',
  current_pdf TEXT NOT NULL DEFAULT '',
  current_source_zip TEXT NOT NULL DEFAULT '',
  current_verdict TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(status);

CREATE TABLE IF NOT EXISTS venues (
  venue_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  cycle TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS submission_ledger (
  slug TEXT PRIMARY KEY REFERENCES papers(slug) ON DELETE CASCADE,
  venue_target TEXT NOT NULL DEFAULT '',
  venue_family TEXT NOT NULL DEFAULT '',
  lifecycle_stage TEXT NOT NULL DEFAULT '',
  submission_state TEXT NOT NULL DEFAULT '',
  portal_id TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT '',
  decision_at TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '',
  round_label TEXT NOT NULL DEFAULT '',
  package_label TEXT NOT NULL DEFAULT '',
  package_dir TEXT NOT NULL DEFAULT '',
  review_path TEXT NOT NULL DEFAULT '',
  response_path TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  portal_system TEXT NOT NULL DEFAULT '',
  portal_url TEXT NOT NULL DEFAULT '',
  last_portal_sync_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_submission_ledger_stage ON submission_ledger(lifecycle_stage, submission_state);

CREATE TABLE IF NOT EXISTS submissions (
  submission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES papers(slug) ON DELETE CASCADE,
  venue_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'local_package',
  package_dir TEXT NOT NULL DEFAULT '',
  pdf_path TEXT NOT NULL DEFAULT '',
  source_zip_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_submissions_slug_time ON submissions(slug, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES papers(slug) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_artifacts_slug_kind ON artifacts(slug, kind);

CREATE TABLE IF NOT EXISTS referee_revision_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES papers(slug) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  matrix_rank INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'requested',
  risk_class TEXT NOT NULL DEFAULT '',
  objection TEXT NOT NULL DEFAULT '',
  source_locator TEXT NOT NULL DEFAULT '',
  evidence_locator TEXT NOT NULL DEFAULT '',
  proposed_fix TEXT NOT NULL DEFAULT '',
  evidence_needed TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL DEFAULT '',
  patch_scope TEXT NOT NULL DEFAULT '',
  source_batch_id TEXT NOT NULL DEFAULT '',
  source_patch_id INTEGER,
  source_report_path TEXT NOT NULL DEFAULT '',
  source_request_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  evidence_status TEXT NOT NULL DEFAULT '',
  evidence_relevance_status TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  state_reason TEXT NOT NULL DEFAULT '',
  last_transition_at TEXT NOT NULL DEFAULT '',
  worker_patch_id INTEGER,
  verification_log_path TEXT NOT NULL DEFAULT '',
  cluster_key TEXT NOT NULL DEFAULT '',
  cluster_label TEXT NOT NULL DEFAULT '',
  cluster_rank INTEGER NOT NULL DEFAULT 0,
  UNIQUE(slug, request_key)
);
CREATE INDEX IF NOT EXISTS idx_referee_revision_requests_slug_status ON referee_revision_requests(slug, status);

CREATE TABLE IF NOT EXISTS patch_queue (
  patch_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES papers(slug) ON DELETE CASCADE,
  source_job_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  patch_path TEXT NOT NULL,
  patch_sha256 TEXT NOT NULL DEFAULT '',
  target_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  batch_id TEXT NOT NULL DEFAULT '',
  superseded_by_patch_id INTEGER,
  superseded_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_patch_queue_slug_status ON patch_queue(slug, status);

CREATE TABLE IF NOT EXISTS workflow_states (
  paper_id TEXT PRIMARY KEY REFERENCES papers(slug) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  state_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_receipts (
  receipt_id TEXT PRIMARY KEY,
  paper_id TEXT REFERENCES papers(slug) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
