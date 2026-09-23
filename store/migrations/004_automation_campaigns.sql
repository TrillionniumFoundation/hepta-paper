PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paper_campaigns (
  campaign_id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  current_round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_campaigns_status ON paper_campaigns(status,updated_at);

CREATE TABLE IF NOT EXISTS campaign_nodes (
  node_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES paper_campaigns(campaign_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  round_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  dependencies_json TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result_json TEXT,
  result_sha256 TEXT,
  failure_class TEXT,
  failure_json TEXT,
  failure_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id,node_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_nodes_ready ON campaign_nodes(campaign_id,status,priority,created_at);

CREATE TABLE IF NOT EXISTS campaign_events (
  event_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES paper_campaigns(campaign_id) ON DELETE CASCADE,
  node_id TEXT,
  kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_events_time ON campaign_events(campaign_id,created_at,event_id);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','4',datetime('now')),
  ('automation_plane','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
