PRAGMA foreign_keys = ON;

-- Stable fencing identity for every campaign-node lease.  Existing rows remain
-- compatible: generation/revision start at zero and a fresh claim assigns the
-- first attempt id before work can start.
ALTER TABLE campaign_nodes ADD COLUMN attempt_id TEXT;
ALTER TABLE campaign_nodes ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_nodes ADD COLUMN node_revision INTEGER NOT NULL DEFAULT 0;

-- An executor result is persisted before it is integrated into the canonical
-- node result.  A recovered worker can integrate this immutable result without
-- re-running the external executor.
ALTER TABLE campaign_nodes ADD COLUMN prepared_result_json TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_result_sha256 TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_attempt_id TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_at TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_requires_integration INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_nodes ADD COLUMN prepared_integration_key TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_integration_status TEXT NOT NULL DEFAULT 'none'
  CHECK(prepared_integration_status IN ('none','pending','integrating','integrated'));
ALTER TABLE campaign_nodes ADD COLUMN prepared_integration_started_at TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_integration_receipt_json TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_integration_receipt_sha256 TEXT;
ALTER TABLE campaign_nodes ADD COLUMN prepared_integrated_at TEXT;
ALTER TABLE campaign_nodes ADD COLUMN integrated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_campaign_nodes_attempt_fence
  ON campaign_nodes(node_id,status,lease_owner,attempt_id,lease_generation);
CREATE INDEX IF NOT EXISTS idx_campaign_nodes_prepared_result
  ON campaign_nodes(campaign_id,status,prepared_result_sha256)
  WHERE prepared_result_sha256 IS NOT NULL;

-- A prepared package is deliberately not a submission authority.  This row is
-- materialized only after the package node's fenced attempt is integrated and
-- completed.  Submission readers still join it back to the live campaign/node
-- rows so manual or stale rows cannot become authority by themselves.
CREATE TABLE IF NOT EXISTS campaign_current_releases (
  campaign_id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  campaign_plan_hash TEXT NOT NULL,
  package_node_id TEXT NOT NULL UNIQUE,
  package_attempt_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK(lease_generation > 0),
  package_result_hash TEXT NOT NULL,
  integration_descriptor_hash TEXT NOT NULL,
  integration_receipt_hash TEXT NOT NULL,
  campaign_release_bundle_hash TEXT NOT NULL,
  materialization_receipt_hash TEXT NOT NULL,
  release_bundle_json TEXT NOT NULL,
  promotion_receipt_json TEXT NOT NULL,
  promotion_receipt_hash TEXT NOT NULL,
  package_node_status TEXT NOT NULL CHECK(package_node_status = 'completed'),
  campaign_status TEXT NOT NULL CHECK(campaign_status = 'completed'),
  package_completed_at TEXT NOT NULL,
  promoted_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status = 'current_completed_release'),
  FOREIGN KEY(campaign_id) REFERENCES paper_campaigns(campaign_id),
  FOREIGN KEY(package_node_id) REFERENCES campaign_nodes(node_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_current_releases_lookup
  ON campaign_current_releases(paper_id,campaign_plan_hash,status);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','22',datetime('now')),
  ('campaign_attempt_fencing','enabled',datetime('now')),
  ('campaign_prepared_results','enabled',datetime('now')),
  ('campaign_release_authority','current_completed_release',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
