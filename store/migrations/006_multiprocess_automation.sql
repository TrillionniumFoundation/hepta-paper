PRAGMA foreign_keys = ON;

ALTER TABLE paper_campaigns ADD COLUMN parent_campaign_id TEXT;
ALTER TABLE paper_campaigns ADD COLUMN supersedes_campaign_id TEXT;
ALTER TABLE paper_campaigns ADD COLUMN recovery_of_campaign_id TEXT;
ALTER TABLE paper_campaigns ADD COLUMN current_phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE paper_campaigns ADD COLUMN current_review_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_campaigns ADD COLUMN priced_agent_call_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE campaign_nodes ADD COLUMN role TEXT;
ALTER TABLE campaign_nodes ADD COLUMN reviewer_id TEXT;
ALTER TABLE campaign_nodes ADD COLUMN child_session_id TEXT;
ALTER TABLE campaign_nodes ADD COLUMN review_hash TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prompt_hash TEXT;
ALTER TABLE campaign_nodes ADD COLUMN resolved_model TEXT;

UPDATE campaign_nodes
SET role=json_extract(spec_json,'$.role')
WHERE role IS NULL AND json_valid(spec_json);

UPDATE paper_campaigns
SET recovery_of_campaign_id=substr(campaign_id,1,instr(campaign_id,':recovery-')-1),
    supersedes_campaign_id=substr(campaign_id,1,instr(campaign_id,':recovery-')-1),
    parent_campaign_id=substr(campaign_id,1,instr(campaign_id,':recovery-')-1)
WHERE instr(campaign_id,':recovery-')>0;

UPDATE paper_campaigns SET cost_known=1 WHERE agent_call_count=0;

CREATE TABLE IF NOT EXISTS automation_resource_limits (
  scope TEXT PRIMARY KEY,
  agent_limit INTEGER NOT NULL CHECK(agent_limit >= 0),
  cpu_limit INTEGER NOT NULL CHECK(cpu_limit >= 0),
  gpu_limit INTEGER NOT NULL CHECK(gpu_limit >= 0),
  memory_mib_limit INTEGER NOT NULL CHECK(memory_mib_limit >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_resource_leases (
  lease_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES automation_resource_limits(scope) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  campaign_id TEXT,
  node_id TEXT,
  agent INTEGER NOT NULL DEFAULT 0 CHECK(agent >= 0),
  cpu INTEGER NOT NULL DEFAULT 0 CHECK(cpu >= 0),
  gpu INTEGER NOT NULL DEFAULT 0 CHECK(gpu >= 0),
  memory_mib INTEGER NOT NULL DEFAULT 0 CHECK(memory_mib >= 0),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_resource_leases_scope_expiry
  ON automation_resource_leases(scope,expires_at);
CREATE INDEX IF NOT EXISTS idx_automation_resource_leases_owner
  ON automation_resource_leases(owner_id,expires_at);

CREATE TABLE IF NOT EXISTS automation_resource_peaks (
  scope TEXT PRIMARY KEY REFERENCES automation_resource_limits(scope) ON DELETE CASCADE,
  agent_peak INTEGER NOT NULL DEFAULT 0,
  cpu_peak INTEGER NOT NULL DEFAULT 0,
  gpu_peak INTEGER NOT NULL DEFAULT 0,
  memory_mib_peak INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO automation_resource_limits(
  scope,agent_limit,cpu_limit,gpu_limit,memory_mib_limit,created_at,updated_at
) VALUES('global',4,4,1,8192,datetime('now'),datetime('now'));
INSERT OR IGNORE INTO automation_resource_peaks(scope,updated_at)
VALUES('global',datetime('now'));

CREATE INDEX IF NOT EXISTS idx_paper_campaigns_lineage
  ON paper_campaigns(paper_id,recovery_of_campaign_id,supersedes_campaign_id,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_review_identity_per_wave
  ON campaign_nodes(campaign_id,round_index,reviewer_id)
  WHERE reviewer_id IS NOT NULL AND kind LIKE 'revision-referee-%';
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_review_session_per_wave
  ON campaign_nodes(campaign_id,round_index,child_session_id)
  WHERE child_session_id IS NOT NULL AND kind LIKE 'revision-referee-%';
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_review_hash_per_wave
  ON campaign_nodes(campaign_id,round_index,review_hash)
  WHERE review_hash IS NOT NULL AND kind LIKE 'revision-referee-%';

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','6',datetime('now')),
  ('multiprocess_automation','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
