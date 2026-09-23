INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','12',datetime('now')),
  ('workspace_lineage_registry','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
