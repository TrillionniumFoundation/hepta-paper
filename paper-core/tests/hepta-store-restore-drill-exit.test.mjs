import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { copySqliteDatabase } from '../../paper-adapters/persistence/sqlite-consistent-copy.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createReadOnlySqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { verifyHeptaStoreRestoreDrillReceipt } from '../../paper-domain/evidence/hepta-store-restore-drill-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function consistentDatabaseSha256(dbPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-test-live-hash-'));
  const snapshotPath = path.join(root, 'snapshot.sqlite');
  try {
    await copySqliteDatabase({ sourcePath: dbPath, destinationPath: snapshotPath });
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex')}`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function nativeState(dbPath) {
  const store = createReadOnlySqliteStore({ dbPath });
  try {
    const rows = store.query(`
SELECT 'papers' AS name,count(*) AS count FROM papers
UNION ALL SELECT 'venues',count(*) FROM venues
UNION ALL SELECT 'submission_ledger',count(*) FROM submission_ledger
UNION ALL SELECT 'submissions',count(*) FROM submissions
UNION ALL SELECT 'artifacts',count(*) FROM artifacts
UNION ALL SELECT 'referee_revision_requests',count(*) FROM referee_revision_requests
UNION ALL SELECT 'patch_queue',count(*) FROM patch_queue
UNION ALL SELECT 'jobs',count(*) FROM jobs
UNION ALL SELECT 'job_attempts',count(*) FROM job_attempts
UNION ALL SELECT 'submission_outbox',count(*) FROM submission_outbox
UNION ALL SELECT 'submission_inbox',count(*) FROM submission_inbox
UNION ALL SELECT 'paper_campaigns',count(*) FROM paper_campaigns
UNION ALL SELECT 'campaign_nodes',count(*) FROM campaign_nodes
UNION ALL SELECT 'campaign_events',count(*) FROM campaign_events;
`).rows;
    const ledgerCount = Number(store.query('SELECT count(*) AS count FROM receipt_ledger;')
      .rows[0].count);
    return Object.freeze({
      business: Object.freeze(Object.fromEntries(rows.map((row) => [row.name, Number(row.count)]))),
      ledgerCount,
    });
  } finally {
    store.close();
  }
}

function receiptLedgerRow(dbPath, receiptId) {
  const store = createReadOnlySqliteStore({ dbPath });
  try {
    return store.query('SELECT * FROM receipt_ledger WHERE receipt_id=?;', [receiptId]).rows[0];
  } finally {
    store.close();
  }
}

function createCliFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-restore-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const runtimeRoot = path.join(root, 'runtime');
  const env = {
    ...process.env,
    HEPTA_PAPER_ASSET_ROOT: assetRoot,
    HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
  };
  const run = (...args) => spawnSync(
    process.execPath,
    ['paper-core/bin/hepta-store.mjs', ...args],
    { cwd: workspaceRoot, env, encoding: 'utf8' },
  );
  const migrated = run('migrate');
  assert.equal(migrated.status, 0, migrated.stderr);
  return { assetRoot, runtimeRoot, run };
}

test('hepta-store restore drill preserves a zero exit for a passing receipt', async (t) => {
  const { runtimeRoot, run } = createCliFixture(t);
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  const previousUmask = process.umask(0o000);
  let backupRun;
  try {
    backupRun = run('backup');
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(backupRun.status, 0, backupRun.stderr);
  const backup = JSON.parse(backupRun.stdout);
  assert.equal(fs.statSync(backup.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${backup.backupPath}.receipt.json`).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(runtimeRoot, 'backups'))
    .filter((name) => name.startsWith('.sqlite-copy-')), []);

  const stateBefore = nativeState(dbPath);
  const liveDatabaseSha256Before = await consistentDatabaseSha256(dbPath);
  const restoreRun = run('restore-drill', '--backup', backup.backupPath);
  assert.equal(restoreRun.status, 0, restoreRun.stderr);
  const restore = JSON.parse(restoreRun.stdout);
  const verification = verifyHeptaStoreRestoreDrillReceipt(restore);
  assert.equal(restore.version, 3);
  assert.equal(restore.receiptRole, 'completion');
  assert.equal(restore.status, 'hepta_store_restore_drill_passed');
  assert.equal(restore.restoreDrillBusinessWritePerformed, false);
  assert.equal(restore.restoreDrillAdministrativeWritePerformed, true);
  assert.equal(restore.concurrentBusinessStateChangesAttested, false);
  assert.equal(restore.writerQuiescenceAttested, false);
  assert.equal(restore.businessProjectionComparisonPerformed, false);
  assert.equal(Object.hasOwn(restore, 'productionStoreMutated'), false);
  assert.equal(Object.hasOwn(restore, 'productionBusinessStateMutated'), false);
  assert.equal(Object.hasOwn(restore, 'productionAdministrativeStateMutated'), false);
  assert.equal(restore.liveDatabaseHashMethod, 'sqlite_online_backup_sha256_v1');
  assert.match(restore.liveDatabaseSha256Before, /^sha256:[0-9a-f]{64}$/);
  assert.match(restore.diagnosticLiveDatabaseSha256After, /^sha256:[0-9a-f]{64}$/);
  assert.equal(restore.liveDatabaseSha256Before, liveDatabaseSha256Before);
  assert.equal(
    restore.diagnosticLiveDatabaseSha256After,
    await consistentDatabaseSha256(dbPath),
  );
  assert.notEqual(
    restore.liveDatabaseSha256Before,
    restore.diagnosticLiveDatabaseSha256After,
  );
  assert.equal(restore.diagnosticAfterHashAssurance, 'completion_self_hash_only');
  assert.equal(restore.diagnosticAfterHashLedgerAuthenticated, false);
  assert.match(restore.completionReceiptSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verification.valid, true, verification.blockers.join(','));
  assert.equal(verification.completionSelfHashValid, true);
  assert.equal(verification.diagnosticAfterHashLedgerAuthenticated, false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${backup.backupPath}.restore-drill.receipt.json`, 'utf8')),
    restore,
  );
  assert.equal(fs.statSync(`${backup.backupPath}.restore-drill.receipt.json`).mode & 0o777, 0o600);

  const stateAfter = nativeState(dbPath);
  assert.deepEqual(stateAfter.business, stateBefore.business);
  assert.equal(stateAfter.ledgerCount, stateBefore.ledgerCount + 1);
  const ledgerRow = receiptLedgerRow(dbPath, restore.administrativeLedgerReceipt.receiptId);
  assert.equal(ledgerRow.receipt_sha256, restore.administrativeLedgerReceipt.receiptSha256);
  assert.equal(ledgerRow.environment, 'administrative');
  assert.equal(ledgerRow.evidence_class, 'restore_drill');
  assert.deepEqual(JSON.parse(ledgerRow.receipt_json), verification.ledgerSubject);
  assert.equal(
    Object.hasOwn(JSON.parse(ledgerRow.receipt_json), 'diagnosticLiveDatabaseSha256After'),
    false,
  );

  assert.equal(verifyHeptaStoreRestoreDrillReceipt({
    ...restore,
    productionStoreMutated: false,
  }).valid, false);
  assert.equal(verifyHeptaStoreRestoreDrillReceipt({
    ...restore,
    diagnosticLiveDatabaseSha256After: restore.liveDatabaseSha256Before,
  }).valid, false);

  const resealedDiagnosticPayload = {
    ...restore,
    diagnosticLiveDatabaseSha256After: `sha256:${'f'.repeat(64)}`,
  };
  delete resealedDiagnosticPayload.completionReceiptSha256;
  const resealedDiagnostic = {
    ...resealedDiagnosticPayload,
    completionReceiptSha256: hashRecord(
      'HeptaStoreRestoreDrillCompletionReceiptV3',
      resealedDiagnosticPayload,
    ),
  };
  const resealedVerification = verifyHeptaStoreRestoreDrillReceipt(resealedDiagnostic);
  assert.equal(resealedVerification.valid, true);
  assert.equal(resealedVerification.diagnosticAfterHashLedgerAuthenticated, false);
  assert.deepEqual(resealedVerification.ledgerSubject, verification.ledgerSubject);
});

test('restore-drill receipt contract accepts only the exact legacy v2 schema', () => {
  const backupSha256 = `sha256:${'1'.repeat(64)}`;
  const backupLedgerReceiptSha256 = `sha256:${'2'.repeat(64)}`;
  const legacy = {
    version: 2,
    kind: 'HeptaStoreRestoreDrillReceipt',
    status: 'hepta_store_restore_drill_passed',
    backupPath: '/tmp/legacy-backup.sqlite',
    backupSha256,
    backupLedgerReceiptSha256,
    backupLedgerReceiptId: `store-admin:${backupLedgerReceiptSha256}`,
    hashMatches: true,
    quickCheck: 'ok',
    foreignKeyViolationCount: 0,
    performedAt: '2026-08-09T00:00:00.000Z',
    productionStoreMutated: false,
  };
  const verified = verifyHeptaStoreRestoreDrillReceipt(legacy);
  assert.equal(verified.valid, true);
  assert.equal(verified.legacy, true);
  assert.deepEqual(verified.ledgerSubject, legacy);
  assert.equal(verifyHeptaStoreRestoreDrillReceipt({
    ...legacy,
    productionBusinessStateMutated: false,
  }).valid, false);
});

test('hepta-store backup blocks foreign-key-damaged state before publication', (t) => {
  const { assetRoot, runtimeRoot, run } = createCliFixture(t);
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  const store = createDefaultPaperStore({ root: assetRoot, runtimeRoot, dbPath });
  const injected = store.execute(`
PRAGMA foreign_keys=OFF;
INSERT INTO submission_ledger(slug) VALUES('missing-parent-paper');
PRAGMA foreign_keys=ON;
`);
  store.close();
  assert.equal(injected.ok, true, injected.error);

  const backupRun = run('backup');
  assert.equal(backupRun.status, 1, backupRun.stderr);
  assert.match(backupRun.stderr, /sqlite_copy_restore_verification_failed/);
  const backupRoot = path.join(runtimeRoot, 'backups');
  assert.deepEqual(fs.readdirSync(backupRoot)
    .filter((name) => name.endsWith('.sqlite') || name.startsWith('.sqlite-copy-')), []);
});
