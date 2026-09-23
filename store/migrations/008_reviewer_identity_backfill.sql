PRAGMA foreign_keys = ON;

UPDATE campaign_nodes
SET reviewer_id=role
WHERE reviewer_id IS NULL
  AND role IS NOT NULL
  AND (kind LIKE 'referee-%' OR kind LIKE 'revision-referee-%');

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','8',datetime('now')),
  ('reviewer_identity_backfill','completed',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
