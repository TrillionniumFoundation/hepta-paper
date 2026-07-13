CREATE TABLE IF NOT EXISTS campaign_telemetry_samples (
  telemetry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES paper_campaigns(campaign_id) ON DELETE CASCADE,
  node_id TEXT,
  sample_kind TEXT NOT NULL,
  phases_json TEXT NOT NULL DEFAULT '{}',
  lock_wait_ms INTEGER NOT NULL DEFAULT 0,
  queue_contention_count INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT,
  acquired_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaign_telemetry_campaign
  ON campaign_telemetry_samples(campaign_id, telemetry_id);
