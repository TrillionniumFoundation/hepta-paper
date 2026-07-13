#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { heptaStorePath, legacyStorePath } from '../src/hepta-store.mjs';
import { createReadOnlySqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { exportLegacyHistorySnapshot, verifyLegacyHistorySnapshot } from '../../paper-adapters/persistence/legacy-history-snapshot-repository.mjs';
import { persistLegacyNativeTranslations, translateLegacyHistorySnapshot, verifyLegacyNativeTranslation } from '../../paper-adapters/persistence/legacy-history-translator-repository.mjs';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { resolveWorkspaceLayout } from '../src/workspace-layout.mjs';

const layout = resolveWorkspaceLayout();
const root = layout.assetRoot;
const dbPath = heptaStorePath(root, layout.runtimeRoot);
const legacyPath = legacyStorePath(layout.legacyRoot);
const clock = createSystemClock();
let mutableStore = null;
let mutableReceiptLedger = null;

function writableStore() {
  if (!mutableStore) mutableStore = createDefaultPaperStore({ root, runtimeRoot: layout.runtimeRoot, dbPath });
  return mutableStore;
}

function receiptLedger() {
  if (!mutableReceiptLedger) mutableReceiptLedger = createSqliteReceiptLedger({ store: writableStore(), clock });
  return mutableReceiptLedger;
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSql(store, sql, { json = false } = {}) {
  const result = json ? store.query(sql) : store.execute(sql);
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || 'sqlite3 failed');
  return json ? JSON.stringify(result.rows) : result.stdout;
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function initialize() {
  writableStore();
  return status();
}

function snapshotLegacyHistory({ ledger = null } = {}) {
  if (!fs.existsSync(legacyPath)) throw new Error(`Legacy store missing: ${legacyPath}`);
  const snapshot = exportLegacyHistorySnapshot({
    legacyDbPath: legacyPath,
    outputRoot: path.join(layout.runtimeRoot, 'legacy-history'),
    receiptLedger: ledger,
    clock,
  });
  const verification = verifyLegacyHistorySnapshot({ manifestPath: snapshot.manifestPath });
  if (snapshot.status !== 'legacy_history_snapshot_verified' || verification.status !== 'legacy_history_snapshot_verified') {
    throw new Error(`legacy_history_snapshot_blocked:${[...snapshot.blockers, ...verification.blockers].join(',')}`);
  }
  const nativeTranslations = translateLegacyHistorySnapshot({ manifestPath: snapshot.manifestPath, receiptLedger: ledger, clock });
  const nativeTranslationVerification = verifyLegacyNativeTranslation({ bundle: nativeTranslations });
  if (nativeTranslationVerification.status !== 'legacy_native_translation_verified') {
    throw new Error(`legacy_native_translation_blocked:${nativeTranslationVerification.blockers.join(',')}`);
  }
  return { ...snapshot, verification, nativeTranslations, nativeTranslationVerification };
}

function migrateLegacy() {
  initialize();
  if (!fs.existsSync(legacyPath)) throw new Error(`Legacy store missing: ${legacyPath}`);
  const sourceHash = `sha256:${fileSha256(legacyPath)}`;
  const historySnapshot = snapshotLegacyHistory();
  const store = writableStore();
  runSql(store, `
PRAGMA foreign_keys=OFF;
ATTACH DATABASE ${sqlQuote(legacyPath)} AS legacy;
BEGIN IMMEDIATE;
DELETE FROM audit_receipts;
DELETE FROM workflow_states;
DELETE FROM patch_queue;
DELETE FROM referee_revision_requests;
DELETE FROM artifacts;
DELETE FROM submissions;
DELETE FROM submission_ledger;
DELETE FROM venues;
DELETE FROM papers;
INSERT INTO papers SELECT * FROM legacy.papers;
INSERT INTO venues SELECT * FROM legacy.venues;
INSERT INTO submission_ledger SELECT l.* FROM legacy.submission_ledger l JOIN papers p ON p.slug=l.slug;
INSERT INTO submissions SELECT s.* FROM legacy.submissions s JOIN papers p ON p.slug=s.slug;
INSERT INTO artifacts SELECT a.* FROM legacy.artifacts a JOIN papers p ON p.slug=a.slug;
INSERT INTO referee_revision_requests SELECT r.* FROM legacy.referee_revision_requests r JOIN papers p ON p.slug=r.slug;
INSERT INTO patch_queue SELECT q.* FROM legacy.patch_queue q JOIN papers p ON p.slug=q.slug;
INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('store_role','hepta-paper-native',datetime('now')),
  ('legacy_import_source',${sqlQuote(legacyPath)},datetime('now')),
  ('legacy_import_sha256',${sqlQuote(sourceHash)},datetime('now')),
  ('legacy_history_manifest_hash',${sqlQuote(historySnapshot.manifestHash)},datetime('now')),
  ('legacy_history_manifest_path',${sqlQuote(historySnapshot.manifestPath)},datetime('now')),
  ('legacy_history_row_count',${sqlQuote(historySnapshot.rowCount)},datetime('now')),
  ('legacy_history_lineage_receipt_hash',${sqlQuote(historySnapshot.lineageReceiptHash)},datetime('now')),
  ('legacy_native_translation_bundle_hash',${sqlQuote(historySnapshot.nativeTranslations.legacyNativeTranslationBundleHash)},datetime('now')),
  ('legacy_native_translation_file_hash',${sqlQuote(historySnapshot.nativeTranslations.translationsHash)},datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
`);
  let nativeLineagePersistence = null;
  try {
    nativeLineagePersistence = persistLegacyNativeTranslations({
      store,
      bundle: historySnapshot.nativeTranslations,
      receiptLedger: receiptLedger(),
      clock,
      withinTransaction: true,
    });
    runSql(store, `INSERT INTO store_metadata(key,value,updated_at) VALUES
      ('legacy_native_lineage_persistence_receipt_hash',${sqlQuote(nativeLineagePersistence.receiptHash)},datetime('now')),
      ('legacy_native_lineage_inserted_count',${sqlQuote(nativeLineagePersistence.insertedCount)},datetime('now')),
      ('legacy_native_lineage_existing_count',${sqlQuote(nativeLineagePersistence.existingCount)},datetime('now')),
      ('legacy_imported_at',datetime('now'),datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
      COMMIT;
      DETACH DATABASE legacy;
      PRAGMA foreign_keys=ON;`);
  } catch (error) {
    store.execute('ROLLBACK;');
    store.execute('DETACH DATABASE legacy;PRAGMA foreign_keys=ON;');
    throw error;
  }
  return {
    version: 1,
    kind: 'HeptaLegacyMigrationResult',
    status: 'legacy_current_state_imported_with_verified_history_snapshot',
    sourceHash,
    historySnapshot,
    nativeLineagePersistence,
    store: status(),
  };
}

function status() {
  const store = createReadOnlyPaperStore({ root, runtimeRoot: layout.runtimeRoot, dbPath });
  const rows = JSON.parse(runSql(store, `
SELECT 'papers' AS name,count(*) AS count FROM papers
UNION ALL SELECT 'venues',count(*) FROM venues
UNION ALL SELECT 'submission_ledger',count(*) FROM submission_ledger
UNION ALL SELECT 'submissions',count(*) FROM submissions
UNION ALL SELECT 'artifacts',count(*) FROM artifacts
UNION ALL SELECT 'referee_revision_requests',count(*) FROM referee_revision_requests
UNION ALL SELECT 'patch_queue',count(*) FROM patch_queue
UNION ALL SELECT 'receipt_ledger',count(*) FROM receipt_ledger
UNION ALL SELECT 'jobs',count(*) FROM jobs
UNION ALL SELECT 'job_attempts',count(*) FROM job_attempts
UNION ALL SELECT 'submission_outbox',count(*) FROM submission_outbox
UNION ALL SELECT 'submission_inbox',count(*) FROM submission_inbox
UNION ALL SELECT 'paper_campaigns',count(*) FROM paper_campaigns
UNION ALL SELECT 'campaign_nodes',count(*) FROM campaign_nodes
UNION ALL SELECT 'campaign_events',count(*) FROM campaign_events;
`, { json: true }) || '[]');
  const metadata = JSON.parse(runSql(store, 'SELECT key,value,updated_at FROM store_metadata ORDER BY key;', { json: true }) || '[]');
  const evidenceClassifications = JSON.parse(runSql(store, 'SELECT environment,evidence_class,count(*) AS count FROM receipt_ledger GROUP BY environment,evidence_class ORDER BY environment,evidence_class;', { json: true }) || '[]');
  const jobClassifications = JSON.parse(runSql(store, 'SELECT environment,evidence_class,status,count(*) AS count FROM jobs GROUP BY environment,evidence_class,status ORDER BY environment,evidence_class,status;', { json: true }) || '[]');
  const quickRows = JSON.parse(runSql(store, 'PRAGMA quick_check;', { json: true }) || '[]');
  const quickCheck = String(quickRows[0]?.quick_check || quickRows[0]?.integrity_check || 'unknown');
  const schemaVersion = Number(JSON.parse(runSql(store, 'SELECT coalesce(max(version),0) AS version FROM schema_migrations;', { json: true }) || '[]')[0]?.version || 0);
  return {
    version: 3,
    kind: 'HeptaNativeStoreStatus',
    status: quickCheck === 'ok' ? 'hepta_native_store_ready' : 'hepta_native_store_blocked',
    dbPath,
    schemaVersion,
    quickCheck,
    tables: Object.fromEntries(rows.map((row) => [row.name, Number(row.count)])),
    metadata,
    evidenceClassifications,
    jobClassifications,
    legacyDefaultDependency: false,
  };
}

function backup() {
  const backupRoot = path.join(layout.runtimeRoot, 'backups');
  fs.mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const backupPath = path.join(backupRoot, `hepta-paper-${stamp}-${process.pid}.sqlite`);
  const result = writableStore().execute(`VACUUM INTO ${sqlQuote(backupPath)};`);
  if (!result.ok) throw new Error(result.error || result.stderr || 'backup_failed');
  const receipt = {
    version: 1,
    kind: 'HeptaStoreBackupReceipt',
    status: 'hepta_store_backup_recorded',
    sourcePath: dbPath,
    backupPath,
    backupSha256: `sha256:${fileSha256(backupPath)}`,
    bytes: fs.statSync(backupPath).size,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${backupPath}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  const ledgerReceipt = receiptLedger().record(receipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'backup' });
  return { ...receipt, ledgerReceipt };
}

function restoreDrill() {
  const backupReceipt = backup();
  const drillPath = `${backupReceipt.backupPath}.restore-drill.sqlite`;
  fs.copyFileSync(backupReceipt.backupPath, drillPath);
  const drillStore = createReadOnlySqliteStore({ dbPath: drillPath });
  const quick = drillStore.query('PRAGMA quick_check;');
  const foreignKeys = drillStore.query('PRAGMA foreign_key_check;');
  const hashMatches = `sha256:${fileSha256(drillPath)}` === backupReceipt.backupSha256;
  drillStore.close();
  fs.rmSync(drillPath, { force: true });
  const receipt = {
    version: 1,
    kind: 'HeptaStoreRestoreDrillReceipt',
    status: quick.ok && quick.rows?.[0]?.quick_check === 'ok' && foreignKeys.ok && foreignKeys.rows.length === 0 && hashMatches
      ? 'hepta_store_restore_drill_passed'
      : 'hepta_store_restore_drill_blocked',
    backupPath: backupReceipt.backupPath,
    backupSha256: backupReceipt.backupSha256,
    hashMatches,
    quickCheck: quick.rows?.[0]?.quick_check || 'unknown',
    foreignKeyViolationCount: foreignKeys.rows?.length ?? null,
    performedAt: new Date().toISOString(),
    productionStoreMutated: false,
  };
  const ledgerReceipt = receiptLedger().record(receipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'restore_drill' });
  return { ...receipt, ledgerReceipt };
}

const command = process.argv[2] || 'status';
let output = null;
if (command === 'init' || command === 'migrate') output = initialize();
else if (command === 'snapshot-legacy-history') output = snapshotLegacyHistory();
else if (command === 'migrate-legacy') output = migrateLegacy();
else if (command === 'backup') output = backup();
else if (command === 'restore-drill') output = restoreDrill();
else if (command === 'status') output = status();
else throw new Error(`Unknown hepta-store command: ${command}`);
process.stdout.write(`${JSON.stringify(output || status(), null, 2)}\n`);
