import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { exportLegacyHistorySnapshot, verifyLegacyHistorySnapshot } from '../../paper-adapters/persistence/legacy-history-snapshot-repository.mjs';
import { persistLegacyNativeTranslations, translateLegacyHistorySnapshot, verifyLegacyNativeTranslation } from '../../paper-adapters/persistence/legacy-history-translator-repository.mjs';

test('legacy history snapshot preserves every omitted table with stable hashes and row counts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-legacy-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyDbPath = path.join(root, 'legacy.sqlite');
  const store = createSqliteStore({ dbPath: legacyDbPath });
  t.after(() => store.close());
  const statements = [
    'CREATE TABLE gate_runs(gate_run_id INTEGER PRIMARY KEY,slug TEXT,status TEXT,created_at TEXT);',
    'CREATE TABLE referee_rounds(round_id INTEGER PRIMARY KEY,status TEXT);',
    'CREATE TABLE events(event_id INTEGER PRIMARY KEY,event_type TEXT);',
    'CREATE TABLE todos(todo_id INTEGER PRIMARY KEY,status TEXT);',
    'CREATE TABLE paper_versions(version_id INTEGER PRIMARY KEY,slug TEXT,label TEXT,version_type TEXT,path TEXT,manifest_path TEXT,manifest_sha256 TEXT,created_at TEXT,metadata_json TEXT);',
    'CREATE TABLE archive_events(archive_event_id INTEGER PRIMARY KEY,status TEXT);',
    'CREATE TABLE submission_portal_events(portal_event_id INTEGER PRIMARY KEY,slug TEXT,portal_system TEXT,portal_id TEXT,portal_url TEXT,submission_state TEXT,deadline TEXT,decision TEXT,next_action TEXT,created_at TEXT);',
    'CREATE TABLE plugins(plugin_id TEXT PRIMARY KEY,name TEXT);',
    'CREATE TABLE jobs(job_id INTEGER PRIMARY KEY,slug TEXT,goal TEXT,task_name TEXT,task_type TEXT,plugin_id TEXT,status TEXT,input_hash TEXT,output_hash TEXT,created_at TEXT,started_at TEXT,finished_at TEXT);',
    'CREATE TABLE job_edges(edge_id INTEGER PRIMARY KEY,slug TEXT,from_task TEXT,to_task TEXT,edge_type TEXT);',
    'CREATE TABLE source_workspaces(workspace_id INTEGER PRIMARY KEY,slug TEXT,workspace_dir TEXT,main_tex_path TEXT,status TEXT);',
    "INSERT INTO events VALUES(2,'factory_dashboard'),(1,'release_status');",
    "INSERT INTO gate_runs VALUES(1,'paper','PASS','2026-01-01');",
    "INSERT INTO paper_versions VALUES(1,'paper','v1','snapshot','versions/v1','versions/v1/manifest.json','sha256:manifest','2026-01-01','{}');",
    "INSERT INTO submission_portal_events VALUES(1,'paper','OpenReview','portal-1','https://example.invalid','submitted','2026-02-01','','await_review','2026-01-01');",
    "INSERT INTO jobs VALUES(1,'paper','prove claim','formal_verify','proof','lean','completed','sha256:input','sha256:output','2026-01-01','2026-01-01','2026-01-01');",
    "INSERT INTO job_edges VALUES(1,'paper','formal_verify','package','requires');",
    "INSERT INTO source_workspaces VALUES(1,'paper','papers/paper','main.tex','active');",
  ];
  for (const sql of statements) assert.equal(store.execute(sql).ok, true, sql);
  store.close();

  const first = exportLegacyHistorySnapshot({ legacyDbPath, outputRoot: path.join(root, 'snapshots'), clock: { nowIso: () => '2026-01-01T00:00:00.000Z' } });
  const second = exportLegacyHistorySnapshot({ legacyDbPath, outputRoot: path.join(root, 'snapshots'), clock: { nowIso: () => '2026-01-01T00:00:01.000Z' } });
  assert.equal(first.status, 'legacy_history_snapshot_verified');
  assert.equal(first.manifestHash, second.manifestHash);
  assert.equal(first.tableCounts.events, 2);
  assert.equal(first.tableCounts.jobs, 1);
  assert.equal(first.rowCount, 8);
  assert.equal(first.lineage.find((item) => item.sourceTable === 'jobs').translationTarget, 'campaign_lineage_reference');
  assert.equal(first.lineage.every((item) => item.activeControlPlaneRowsCreated === false), true);
  assert.equal(first.lineage.find((item) => item.sourceTable === 'events').sourceRowLineageCount, 2);
  const eventLineage = fs.readFileSync(first.lineage.find((item) => item.sourceTable === 'events').sourceRowLineagePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(eventLineage.map((item) => item.sourcePrimaryKey.event_id), [1, 2]);
  assert.equal(eventLineage.every((item) => /^sha256:/.test(item.sourceRowHash) && item.authorityImported === false && item.activeControlPlaneRowCreated === false), true);
  assert.match(first.lineageReceiptHash, /^sha256:/);
  assert.equal(verifyLegacyHistorySnapshot({ manifestPath: first.manifestPath }).status, 'legacy_history_snapshot_verified');
  const translated = translateLegacyHistorySnapshot({ manifestPath: first.manifestPath, clock: { nowIso: () => '2026-01-01T00:00:02.000Z' } });
  assert.equal(translated.status, 'legacy_native_translations_verified');
  assert.equal(translated.translationCount, 7);
  assert.equal(translated.byKind.LegacyNativeReceiptReference, 2);
  assert.deepEqual(translated.eventClassificationCounts, { native_lineage_candidate: 1, generated_control_plane_archive_only: 1 });
  assert.equal(translated.byKind.LegacyCampaignNodeLineage, 1);
  assert.equal(translated.byKind.LegacyCampaignEdgeLineage, 1);
  assert.equal(translated.byKind.LegacyArtifactVersionLineage, 1);
  assert.equal(translated.byKind.LegacyWorkspaceLineage, 1);
  assert.equal(translated.byKind.LegacySubmissionPortalLineage, 1);
  assert.equal(translated.records.find((item) => item.kind === 'LegacyArtifactVersionLineage').artifactHash, 'sha256:manifest');
  assert.equal(translated.records.find((item) => item.kind === 'LegacyCampaignNodeLineage').nodeKind, 'formal_verify');
  assert.equal(translated.records.find((item) => item.kind === 'LegacyCampaignNodeLineage').nodeType, 'proof');
  assert.equal(translated.records.find((item) => item.kind === 'LegacySubmissionPortalLineage').provider, 'OpenReview');
  assert.equal(translated.records.every((item) => item.sourceRowHash && item.translationHash && item.authorityImported === false), true);
  assert.equal(verifyLegacyNativeTranslation({ bundle: translated }).status, 'legacy_native_translation_verified');
  const nativeDbPath = path.join(root, 'native.sqlite');
  const nativeStore = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: nativeDbPath });
  t.after(() => nativeStore.close());
  const persisted = persistLegacyNativeTranslations({ store: nativeStore, bundle: translated, clock: { nowIso: () => '2026-01-01T00:00:03.000Z' } });
  assert.equal(persisted.status, 'legacy_native_lineage_persisted');
  assert.equal(persisted.attemptedCount, 7);
  assert.equal(persisted.insertedCount, 7);
  assert.equal(persisted.existingCount, 0);
  const repeated = persistLegacyNativeTranslations({ store: nativeStore, bundle: translated, clock: { nowIso: () => '2026-01-01T00:00:04.000Z' } });
  assert.equal(repeated.insertedCount, 0);
  assert.equal(repeated.existingCount, 7);
  for (const table of ['legacy_receipt_lineage', 'legacy_artifact_version_lineage', 'legacy_campaign_node_lineage', 'legacy_campaign_edge_lineage', 'legacy_workspace_lineage', 'legacy_submission_portal_lineage']) {
    const row = nativeStore.query(`SELECT COUNT(*) AS count, SUM(authority_imported) AS authority_count, SUM(active_control_plane_row_created) AS control_count FROM ${table};`).rows[0];
    assert.ok(Number(row.count) > 0, table);
    assert.equal(Number(row.authority_count), 0, table);
    assert.equal(Number(row.control_count), 0, table);
  }
  assert.equal(nativeStore.query('SELECT COUNT(*) AS count FROM jobs;').rows[0].count, 0);
  const transactionalDbPath = path.join(root, 'transactional.sqlite');
  const transactionalStore = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: transactionalDbPath });
  t.after(() => transactionalStore.close());
  assert.equal(transactionalStore.execute('BEGIN IMMEDIATE;').ok, true);
  const staged = persistLegacyNativeTranslations({ store: transactionalStore, bundle: translated, withinTransaction: true, clock: { nowIso: () => '2026-01-01T00:00:05.000Z' } });
  assert.equal(staged.insertedCount, 7);
  assert.equal(transactionalStore.execute('ROLLBACK;').ok, true);
  assert.equal(Number(transactionalStore.query('SELECT COUNT(*) AS count FROM legacy_receipt_lineage;').rows[0].count), 0);
  const eventsPath = path.join(path.dirname(first.manifestPath), 'events.ndjson');
  fs.chmodSync(eventsPath, 0o644);
  fs.appendFileSync(eventsPath, '{"tampered":true}\n');
  assert.ok(verifyLegacyHistorySnapshot({ manifestPath: first.manifestPath }).blockers.includes('legacy_history_table_hash_mismatch:events'));
});
