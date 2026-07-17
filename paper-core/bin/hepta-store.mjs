#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heptaStorePath } from '../src/hepta-store.mjs';
import {
  createDefaultPaperStore,
  createReadOnlyPaperStore,
  createReadOnlySqliteStore,
  openExistingWritablePaperStore,
} from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import {
  createSystemClock,
  fileSha256HashSync,
  readRegularJsonFileSync,
  writeDurableJsonSync,
} from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { composeStoreAdministratorReceiptLedger } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, resolveWorkspaceLayout } from '../src/workspace-layout.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';

const layout = resolveWorkspaceLayout();
const root = layout.assetRoot;
const dbPath = heptaStorePath(root, layout.runtimeRoot);
const clock = createSystemClock();
let mutableStore = null;
let mutableReceiptLedger = null;

function writableStore({ migrate = false } = {}) {
  assertWorkspaceLayoutPhysicallyDecoupled({
    assetRoot: layout.assetRoot,
    runtimeRoot: layout.runtimeRoot,
    legacyRoot: layout.legacyRoot,
  });
  if (!mutableStore) mutableStore = migrate
    ? createDefaultPaperStore({ root, runtimeRoot: layout.runtimeRoot, dbPath })
    : openExistingWritablePaperStore({ root, runtimeRoot: layout.runtimeRoot, dbPath });
  return mutableStore;
}

function receiptLedger() {
  if (!mutableReceiptLedger) mutableReceiptLedger = composeStoreAdministratorReceiptLedger({ store: writableStore(), clock });
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

const fileSha256 = (file) => fileSha256HashSync(file, { prefix: false });
const within = pathWithin;
const writeDurableJson = writeDurableJsonSync;
const jsonFile = readRegularJsonFileSync;

function ledgerIdentity(receipt, evidenceClass) {
  return receiptLedger().prepare(receipt, {
    stream: 'store-admin',
    environment: 'administrative',
    evidenceClass,
  });
}

function assertTrustedStoreReceipt(identity, expectedKind) {
  const row = receiptLedger().get(identity.receiptId);
  if (!row
    || row.receipt_id !== identity.receiptId
    || row.receipt_sha256 !== identity.receiptHash
    || row.kind !== expectedKind
    || Number(row.effective_receipt_usable) !== 1
    || Number(row.writer_trusted) !== 1
    || row.issuer_policy_id !== 'store-administrator'
    || row.environment !== 'administrative') {
    throw new Error('hepta_store_backup_receipt_not_trusted');
  }
  return row;
}

function resolveBackupReceipt(requestedPath = null) {
  const backupRoot = path.resolve(layout.runtimeRoot, 'backups');
  const candidates = requestedPath ? [path.resolve(requestedPath)] : (fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot)
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => path.join(backupRoot, name))
      .filter((candidate) => {
        try { const stat = fs.lstatSync(candidate); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
      })
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs || right.localeCompare(left))
    : []);
  if (!candidates.length) return null;
  const backupPath = candidates[0];
  const stat = fs.lstatSync(backupPath);
  if (!within(backupRoot, backupPath) || stat.isSymbolicLink() || !stat.isFile() || !within(backupRoot, fs.realpathSync(backupPath))) {
    throw new Error('hepta_store_backup_path_unsafe');
  }
  const receipt = jsonFile(`${backupPath}.receipt.json`);
  if (receipt?.version !== 1
    || receipt.kind !== 'HeptaStoreBackupReceipt'
    || receipt.status !== 'hepta_store_backup_recorded'
    || path.resolve(String(receipt.sourcePath || '')) !== path.resolve(dbPath)
    || path.resolve(String(receipt.backupPath || '')) !== backupPath
    || receipt.backupSha256 !== `sha256:${fileSha256(backupPath)}`
    || Number(receipt.bytes) !== stat.size) {
    throw new Error('hepta_store_backup_receipt_invalid');
  }
  const identity = ledgerIdentity(receipt, 'backup');
  assertTrustedStoreReceipt(identity, 'HeptaStoreBackupReceipt');
  return Object.freeze({ receipt, identity });
}

function initialize() {
  writableStore({ migrate: true });
  return status();
}

function status({ allowIsolatedVerificationEvidence = false } = {}) {
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
  ${allowIsolatedVerificationEvidence ? '' : "(environment='verification' AND evidence_class='technical_conformance') OR"}
  (environment='production' AND evidence_class='runtime_unclassified')
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
    status: quickCheck === 'ok' && unresolvedContaminatedReceiptCount === 0 ? 'hepta_native_store_ready' : 'hepta_native_store_blocked',
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
  writeDurableJson(`${backupPath}.receipt.json`, receipt);
  const ledgerReceipt = receiptLedger().record(receipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'backup' });
  return { ...receipt, ledgerReceipt };
}

function restoreDrill({ backupPath = null } = {}) {
  let selected = resolveBackupReceipt(backupPath);
  if (!selected) {
    const created = backup();
    selected = Object.freeze({
      receipt: Object.freeze(Object.fromEntries(Object.entries(created).filter(([key]) => key !== 'ledgerReceipt'))),
      identity: created.ledgerReceipt,
    });
  }
  const backupReceipt = selected.receipt;
  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-restore-drill-'));
  const drillPath = path.join(drillRoot, 'restore-drill.sqlite');
  let quick = { ok: false, rows: [] };
  let foreignKeys = { ok: false, rows: [] };
  let hashMatches = false;
  try {
    fs.copyFileSync(backupReceipt.backupPath, drillPath, fs.constants.COPYFILE_FICLONE);
    const drillStore = createReadOnlySqliteStore({ dbPath: drillPath });
    try {
      quick = drillStore.query('PRAGMA quick_check;');
      foreignKeys = drillStore.query('PRAGMA foreign_key_check;');
      hashMatches = `sha256:${fileSha256(drillPath)}` === backupReceipt.backupSha256;
    } finally { drillStore.close(); }
  } finally { fs.rmSync(drillRoot, { recursive: true, force: true }); }
  const receipt = {
    version: 2,
    kind: 'HeptaStoreRestoreDrillReceipt',
    status: quick.ok && quick.rows?.[0]?.quick_check === 'ok' && foreignKeys.ok && foreignKeys.rows.length === 0 && hashMatches
      ? 'hepta_store_restore_drill_passed'
      : 'hepta_store_restore_drill_blocked',
    backupPath: backupReceipt.backupPath,
    backupSha256: backupReceipt.backupSha256,
    backupLedgerReceiptSha256: selected.identity.receiptHash,
    backupLedgerReceiptId: selected.identity.receiptId,
    hashMatches,
    quickCheck: quick.rows?.[0]?.quick_check || 'unknown',
    foreignKeyViolationCount: foreignKeys.rows?.length ?? null,
    performedAt: new Date().toISOString(),
    productionStoreMutated: false,
  };
  writeDurableJson(`${backupReceipt.backupPath}.restore-drill.receipt.json`, receipt);
  const ledgerReceipt = receiptLedger().record(receipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'restore_drill' });
  return { ...receipt, ledgerReceipt };
}

const command = process.argv[2] || 'status';
const backupOptionIndex = process.argv.indexOf('--backup');
const selectedBackupPath = backupOptionIndex >= 0 ? process.argv[backupOptionIndex + 1] : null;
if (backupOptionIndex >= 0 && !selectedBackupPath) throw new Error('--backup requires a path');
let output = null;
if (command === 'init' || command === 'migrate') output = initialize();
else if (command === 'backup') output = backup();
else if (command === 'restore-drill') output = restoreDrill({ backupPath: selectedBackupPath });
else if (command === 'status') output = status({ allowIsolatedVerificationEvidence: process.argv.includes('--allow-isolated-verification-evidence') });
else throw new Error(`Unknown hepta-store command: ${command}`);
process.stdout.write(`${JSON.stringify(output || status(), null, 2)}\n`);
const blocked = (command === 'status'
    && process.argv.includes('--require-trust-clean')
    && output?.status !== 'hepta_native_store_ready')
  || (command === 'restore-drill' && output?.status !== 'hepta_store_restore_drill_passed');
if (blocked) process.exitCode = 1;
