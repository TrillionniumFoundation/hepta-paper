#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { heptaStorePath, legacyStorePath } from '../src/hepta-store.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { resolveWorkspaceLayout } from '../src/workspace-layout.mjs';

const layout = resolveWorkspaceLayout();
const root = layout.assetRoot;
const dbPath = heptaStorePath(root, layout.runtimeRoot);
const legacyPath = legacyStorePath(layout.legacyRoot);
const store = createDefaultPaperStore({ root, runtimeRoot: layout.runtimeRoot, dbPath });
const clock = createSystemClock();
const receiptLedger = createSqliteReceiptLedger({ store, clock });

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSql(sql, { json = false } = {}) {
  const result = json ? store.query(sql) : store.execute(sql);
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || 'sqlite3 failed');
  return json ? JSON.stringify(result.rows) : result.stdout;
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function initialize() {
  return status();
}

function migrateLegacy() {
  initialize();
  if (!fs.existsSync(legacyPath)) throw new Error(`Legacy store missing: ${legacyPath}`);
  const sourceHash = `sha256:${fileSha256(legacyPath)}`;
  runSql(`
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
  ('legacy_imported_at',datetime('now'),datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
COMMIT;
DETACH DATABASE legacy;
PRAGMA foreign_keys=ON;
`);
}

function status() {
  const rows = JSON.parse(runSql(`
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
UNION ALL SELECT 'submission_inbox',count(*) FROM submission_inbox;
`, { json: true }) || '[]');
  const metadata = JSON.parse(runSql('SELECT key,value,updated_at FROM store_metadata ORDER BY key;', { json: true }) || '[]');
  const evidenceClassifications = JSON.parse(runSql('SELECT environment,evidence_class,count(*) AS count FROM receipt_ledger GROUP BY environment,evidence_class ORDER BY environment,evidence_class;', { json: true }) || '[]');
  const jobClassifications = JSON.parse(runSql('SELECT environment,evidence_class,status,count(*) AS count FROM jobs GROUP BY environment,evidence_class,status ORDER BY environment,evidence_class,status;', { json: true }) || '[]');
  const quickCheck = runSql('PRAGMA quick_check;').trim();
  const schemaVersion = Number(JSON.parse(runSql('SELECT coalesce(max(version),0) AS version FROM schema_migrations;', { json: true }) || '[]')[0]?.version || 0);
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
  const result = store.execute(`VACUUM INTO ${sqlQuote(backupPath)};`);
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
  const ledgerReceipt = receiptLedger.record(receipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'backup' });
  return { ...receipt, ledgerReceipt };
}

function restoreDrill() {
  const backupReceipt = backup();
  const drillPath = `${backupReceipt.backupPath}.restore-drill.sqlite`;
  fs.copyFileSync(backupReceipt.backupPath, drillPath);
  const drillStore = createSqliteStore({ dbPath: drillPath });
  const quick = drillStore.execute('PRAGMA quick_check; PRAGMA foreign_key_check;');
  const hashMatches = `sha256:${fileSha256(drillPath)}` === backupReceipt.backupSha256;
  fs.rmSync(drillPath, { force: true });
  const receipt = {
    version: 1,
    kind: 'HeptaStoreRestoreDrillReceipt',
    status: quick.ok && /ok/.test(quick.stdout || '') && hashMatches
      ? 'hepta_store_restore_drill_passed'
      : 'hepta_store_restore_drill_blocked',
    backupPath: backupReceipt.backupPath,
    backupSha256: backupReceipt.backupSha256,
    hashMatches,
    quickCheck: String(quick.stdout || '').trim(),
    performedAt: new Date().toISOString(),
    productionStoreMutated: false,
  };
  const ledgerReceipt = receiptLedger.record(receipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'restore_drill' });
  return { ...receipt, ledgerReceipt };
}

const command = process.argv[2] || 'status';
let output = null;
if (command === 'init' || command === 'migrate') output = initialize();
else if (command === 'migrate-legacy') migrateLegacy();
else if (command === 'backup') output = backup();
else if (command === 'restore-drill') output = restoreDrill();
else if (command === 'status') output = status();
else throw new Error(`Unknown hepta-store command: ${command}`);
process.stdout.write(`${JSON.stringify(output || status(), null, 2)}\n`);
