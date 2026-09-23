PRAGMA foreign_keys = ON;

-- Monotonic fencing generation for job leases. Existing jobs start at zero;
-- the first successful acquisition advances them to generation one.
ALTER TABLE jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_attempts ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_job_attempts_active_lease
  ON job_attempts(job_id, status, lease_generation, worker_id);

UPDATE store_metadata SET value='21', updated_at=datetime('now') WHERE key='schema_version';
INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('job_lease_fencing','generation_v1',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
