CREATE TABLE IF NOT EXISTS legacy_receipt_lineage (
  translation_hash TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_row_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT, payload_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  authority_imported INTEGER NOT NULL DEFAULT 0 CHECK(authority_imported=0),
  active_control_plane_row_created INTEGER NOT NULL DEFAULT 0 CHECK(active_control_plane_row_created=0)
);
CREATE TABLE IF NOT EXISTS legacy_artifact_version_lineage (
  translation_hash TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_row_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT, payload_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  authority_imported INTEGER NOT NULL DEFAULT 0 CHECK(authority_imported=0),
  active_control_plane_row_created INTEGER NOT NULL DEFAULT 0 CHECK(active_control_plane_row_created=0)
);
CREATE TABLE IF NOT EXISTS legacy_campaign_node_lineage (
  translation_hash TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_row_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT, payload_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  authority_imported INTEGER NOT NULL DEFAULT 0 CHECK(authority_imported=0),
  active_control_plane_row_created INTEGER NOT NULL DEFAULT 0 CHECK(active_control_plane_row_created=0)
);
CREATE TABLE IF NOT EXISTS legacy_campaign_edge_lineage (
  translation_hash TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_row_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT, payload_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  authority_imported INTEGER NOT NULL DEFAULT 0 CHECK(authority_imported=0),
  active_control_plane_row_created INTEGER NOT NULL DEFAULT 0 CHECK(active_control_plane_row_created=0)
);
CREATE TABLE IF NOT EXISTS legacy_workspace_lineage (
  translation_hash TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_row_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT, payload_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  authority_imported INTEGER NOT NULL DEFAULT 0 CHECK(authority_imported=0),
  active_control_plane_row_created INTEGER NOT NULL DEFAULT 0 CHECK(active_control_plane_row_created=0)
);
CREATE TABLE IF NOT EXISTS legacy_submission_portal_lineage (
  translation_hash TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_row_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT, payload_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  authority_imported INTEGER NOT NULL DEFAULT 0 CHECK(authority_imported=0),
  active_control_plane_row_created INTEGER NOT NULL DEFAULT 0 CHECK(active_control_plane_row_created=0)
);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','14',datetime('now')),
  ('legacy_native_lineage','archive_only',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
