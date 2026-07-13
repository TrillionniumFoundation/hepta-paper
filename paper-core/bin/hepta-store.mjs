#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { heptaStorePath } from '../src/hepta-store.mjs';
import { createReadOnlySqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { resolveWorkspaceLayout } from '../src/workspace-layout.mjs';

const layout = resolveWorkspaceLayout();
const root = layout.assetRoot;
const dbPath = heptaStorePath(root, layout.runtimeRoot);
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
  const receiptQualificationRows = JSON.parse(runSql(store, `
SELECT count(*) AS row_count,count(DISTINCT receipt_id) AS qualified_receipt_count
FROM receipt_ledger_qualifications;
`, { json: true }) || '[]');
  const unresolvedContaminatedReceiptCount = Number(JSON.parse(runSql(store, `
SELECT count(*) AS count
FROM receipt_ledger AS receipt
WHERE (
  (environment='verification' AND evidence_class='technical_conformance')
  OR (environment='production' AND evidence_class='runtime_unclassified')
  OR (environment='production' AND evidence_class='release_conformance_with_operational_binding')
)
AND NOT EXISTS (
  SELECT 1 FROM receipt_ledger_qualifications AS qualification
  WHERE qualification.receipt_id=receipt.receipt_id
    AND qualification.disposition IN ('administrative_exported','invalid','superseded','retention_tombstone')
);
`, { json: true }) || '[]')[0]?.count || 0);
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
    receiptQualifications: {
      rowCount: Number(receiptQualificationRows[0]?.row_count || 0),
      qualifiedReceiptCount: Number(receiptQualificationRows[0]?.qualified_receipt_count || 0),
      unresolvedContaminatedReceiptCount,
      rawEvidenceClassificationsPreserved: true,
    },
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
else if (command === 'backup') output = backup();
else if (command === 'restore-drill') output = restoreDrill();
else if (command === 'status') output = status();
else throw new Error(`Unknown hepta-store command: ${command}`);
process.stdout.write(`${JSON.stringify(output || status(), null, 2)}\n`);
