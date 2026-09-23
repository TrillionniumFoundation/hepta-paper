PRAGMA foreign_keys = ON;

-- Export alone is not proof that a workspace can be deleted.  Keep the
-- restore verification and the qualification instant beside the immutable
-- snapshot record so retention can fail closed after a crash.
ALTER TABLE workspace_snapshots ADD COLUMN export_receipt_sha256 TEXT;
ALTER TABLE workspace_snapshots ADD COLUMN restore_receipt_sha256 TEXT;
ALTER TABLE workspace_snapshots ADD COLUMN restore_receipt_json TEXT;
ALTER TABLE workspace_snapshots ADD COLUMN restore_ledger_receipt_id TEXT REFERENCES receipt_ledger(receipt_id);
ALTER TABLE workspace_snapshots ADD COLUMN restore_verified_at TEXT;
ALTER TABLE workspace_snapshots ADD COLUMN retention_qualified_at TEXT;
ALTER TABLE workspace_snapshots ADD COLUMN manifest_path TEXT;
ALTER TABLE workspace_snapshots ADD COLUMN external_content_sha256 TEXT;

CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_retention_qualification
  ON workspace_snapshots(workspace_id,status,retention_qualified_at);

-- A workflow projection is only usable when the matching immutable ledger
-- receipt committed in the same SQLite transaction is still effective.
ALTER TABLE workflow_states ADD COLUMN ledger_receipt_id TEXT REFERENCES receipt_ledger(receipt_id);
ALTER TABLE workflow_states ADD COLUMN projection_receipt_sha256 TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_states_ledger_receipt
  ON workflow_states(ledger_receipt_id);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','23',datetime('now')),
  ('workspace_retention_qualification','restore_receipt_required',datetime('now')),
  ('workflow_state_projection_atomicity','projection_and_ledger_same_transaction',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
