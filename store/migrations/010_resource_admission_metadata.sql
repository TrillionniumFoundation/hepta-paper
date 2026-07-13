INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','10',datetime('now')),
  ('resource_admission_queue','enabled',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
