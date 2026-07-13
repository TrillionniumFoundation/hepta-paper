CREATE TABLE IF NOT EXISTS campaign_workspaces (
  workspace_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES paper_campaigns(campaign_id) ON DELETE CASCADE,
  node_id TEXT REFERENCES campaign_nodes(node_id) ON DELETE SET NULL,
  parent_workspace_id TEXT REFERENCES campaign_workspaces(workspace_id) ON DELETE SET NULL,
  source_path TEXT NOT NULL,
  workspace_path TEXT NOT NULL UNIQUE,
  source_sha256 TEXT,
  workspace_manifest_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  failure_class TEXT,
  retention_state TEXT NOT NULL DEFAULT 'protected',
  retention_reason TEXT NOT NULL DEFAULT 'active_or_unresolved_lineage',
  export_receipt_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  exported_at TEXT
);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES campaign_workspaces(workspace_id) ON DELETE CASCADE,
  manifest_sha256 TEXT NOT NULL,
  archive_path TEXT,
  archive_sha256 TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'recorded',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_workspaces_campaign ON campaign_workspaces(campaign_id,status);
CREATE INDEX IF NOT EXISTS idx_campaign_workspaces_retention ON campaign_workspaces(retention_state,status);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_workspace ON workspace_snapshots(workspace_id,created_at DESC);
