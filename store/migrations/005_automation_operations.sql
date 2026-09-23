PRAGMA foreign_keys = ON;

ALTER TABLE paper_campaigns ADD COLUMN last_resumed_at TEXT;
ALTER TABLE paper_campaigns ADD COLUMN accumulated_run_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN agent_call_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN cpu_job_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN gpu_job_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN stop_reason TEXT;

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','5',datetime('now')),
  ('automation_operations','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
