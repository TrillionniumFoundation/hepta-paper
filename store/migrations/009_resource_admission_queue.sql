CREATE TABLE IF NOT EXISTS automation_resource_waiters (
  waiter_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  campaign_id TEXT,
  node_id TEXT,
  agent INTEGER NOT NULL DEFAULT 0 CHECK(agent >= 0),
  cpu INTEGER NOT NULL DEFAULT 0 CHECK(cpu >= 0),
  gpu INTEGER NOT NULL DEFAULT 0 CHECK(gpu >= 0),
  memory_mib INTEGER NOT NULL DEFAULT 0 CHECK(memory_mib >= 0),
  requested_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_resource_waiters_admission
  ON automation_resource_waiters(scope, requested_at, waiter_id);

CREATE INDEX IF NOT EXISTS idx_automation_resource_waiters_owner
  ON automation_resource_waiters(owner_id, expires_at);
