import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runPaperBatch } from '../../paper-composition/batch/paper-batch-application.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createFilesystemReportReceiptLedger } from '../../paper-adapters/artifacts/filesystem-report-receipt-ledger.mjs';

function fileHash(candidate) {
  return crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
}

function reportReceipt(hash = 'sha256:report-write') {
  return Object.freeze({ version: 2, kind: 'ArtifactWriteReceipt', writeReceiptHash: hash });
}

function reportReceiptPath(receiptRoot, receipt) {
  const receiptId = `report-artifact:${receipt.writeReceiptHash}`;
  return path.join(receiptRoot, `${crypto.createHash('sha256').update(receiptId).digest('hex')}.json`);
}

test('batch dry-run uses a missing read-only store without creating or migrating a database', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-batch-dry-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const runtimeRoot = path.join(root, 'runtime-that-does-not-exist');
  fs.mkdirSync(assetRoot, { recursive: true });
  const report = await runPaperBatch({ root: assetRoot, runtimeRoot, mode: 'inventory', execute: false, writeReport: false });
  assert.equal(report.execute, false);
  assert.equal(Object.hasOwn(report, 'coreIntegrity'), false);
  assert.equal(Object.hasOwn(report, 'compatibilityStageSummary'), false);
  assert.equal(report.safety.vendoredReferenceRuntimeScanPerformed, false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'hepta-paper.sqlite')), false);
  assert.equal(fs.existsSync(runtimeRoot), false);
  const persistedReport = await runPaperBatch({ root: assetRoot, runtimeRoot, mode: 'inventory', execute: false, writeReport: true });
  assert.equal(persistedReport.execute, false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'hepta-paper.sqlite')), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'hepta-paper.sqlite-wal')), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'hepta-paper.sqlite-shm')), false);
  const reportRoot = path.join(runtimeRoot, 'reports');
  const persistedName = fs.readdirSync(reportRoot)
    .find((name) => /^paper-batch-inventory-\d+T\d+Z\.json$/.test(name));
  assert.ok(persistedName);
  const persisted = JSON.parse(fs.readFileSync(path.join(reportRoot, persistedName), 'utf8'));
  assert.equal(Object.hasOwn(persisted, 'coreIntegrity'), false);
  assert.equal(Object.hasOwn(persisted, 'compatibilityStageSummary'), false);
  const detail = JSON.parse(fs.readFileSync(path.join(reportRoot, persisted.resultDetail.path), 'utf8'));
  assert.equal(Object.hasOwn(detail, 'coreIntegrity'), false);
  assert.equal(detail.version, 2);
  assert.equal(fs.readdirSync(path.join(runtimeRoot, 'report-receipts')).filter((name) => name.endsWith('.json')).length > 0, true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'report-artifact-cas')), true);
  await assert.rejects(() => runPaperBatch({
    root: assetRoot,
    runtimeRoot,
    mode: 'inventory',
    execute: true,
    writeReport: false,
  }), /batch_inventory_execute_forbidden_use_read_only_preview/);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'hepta-paper.sqlite')), false);
});

test('batch inventory rejects retired and unknown inventory sources instead of returning an empty scan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-batch-retired-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(assetRoot, { recursive: true });
  await assert.rejects(() => runPaperBatch({
    root: assetRoot,
    runtimeRoot,
    mode: 'inventory',
    inventorySource: 'legacy-sqlite',
  }), /legacy_inventory_runtime_disabled_use_explicit_compatibility_boundary/);
  await assert.rejects(() => runPaperBatch({
    root: assetRoot,
    runtimeRoot,
    mode: 'inventory',
    inventorySource: 'invented',
  }), /inventory_source_unsupported:invented/);
  assert.equal(fs.existsSync(runtimeRoot), false);
});

test('batch dataset composition never manufactures operator authorization', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-batch-dataset-authorization-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const runtimeRoot = path.join(root, 'runtime');
  const datasetRoot = path.join(assetRoot, 'dataset');
  fs.mkdirSync(datasetRoot, { recursive: true });
  fs.writeFileSync(path.join(datasetRoot, 'records.csv'), 'value\n1\n');
  const options = { root: assetRoot, runtimeRoot, mode: 'local-dry-run', execute: false, datasetRoot, benchmarkId: 'dataset' };
  await assert.rejects(() => runPaperBatch(options), /batch_campaign_dataset_license_required/);
  await assert.rejects(() => runPaperBatch({ ...options, datasetLicenseId: 'LicenseRef-OperatorApproved' }), /batch_campaign_dataset_operator_authorization_required/);
  await runPaperBatch({ ...options, datasetLicenseId: 'MIT' });
  await runPaperBatch({ ...options, datasetLicenseId: 'LicenseRef-OperatorApproved', datasetAuthorizationHash: `sha256:${'a'.repeat(64)}` });
});

test('batch report output leaves an existing business store byte-identical', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-batch-report-readonly-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(assetRoot, { recursive: true });
  const store = createDefaultPaperStore({ root: assetRoot, runtimeRoot });
  assert.equal(store.execute("INSERT INTO papers(slug,title,canonical_dir,status) VALUES('paper','Paper','paper','draft');").ok, true);
  store.close();
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  const beforeHash = fileHash(dbPath);
  const beforeBytes = fs.statSync(dbPath).size;
  await runPaperBatch({ root: assetRoot, runtimeRoot, mode: 'inventory', execute: false, writeReport: true });
  assert.equal(fileHash(dbPath), beforeHash);
  assert.equal(fs.statSync(dbPath).size, beforeBytes);
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}-shm`), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'reports')), true);
  fs.writeFileSync(`${dbPath}-wal`, 'active-wal-sentinel');
  await assert.rejects(() => runPaperBatch({ root: assetRoot, runtimeRoot, mode: 'inventory', execute: false, writeReport: false }), /immutable_readonly_store_active_wal_present/);
  assert.equal(fileHash(dbPath), beforeHash);
});

test('filesystem report receipt ledger is immutable and idempotent under a scoped CAS', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-report-receipt-cas-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const receiptRoot = path.join(runtimeRoot, 'report-receipts');
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const ledger = createFilesystemReportReceiptLedger({ scopeRoot: runtimeRoot, receiptRoot, clock });
  const receipt = reportReceipt();
  const first = ledger.record(receipt, { stream: 'artifact-writes', paperId: 'paper' });
  const candidate = reportReceiptPath(receiptRoot, receipt);
  const before = fs.readFileSync(candidate);
  const replay = ledger.record(receipt, { stream: 'artifact-writes', paperId: 'paper' });
  assert.equal(replay.receiptId, first.receiptId);
  assert.deepEqual(fs.readFileSync(candidate), before);

  const conflicting = reportReceipt('sha256:conflicting-write');
  const conflictingPath = reportReceiptPath(receiptRoot, conflicting);
  fs.writeFileSync(conflictingPath, 'attacker-controlled-preimage\n');
  assert.throws(
    () => ledger.record(conflicting, { stream: 'artifact-writes', paperId: 'paper' }),
    /report_receipt_immutable_collision/,
  );
  assert.equal(fs.readFileSync(conflictingPath, 'utf8'), 'attacker-controlled-preimage\n');
});

test('filesystem report receipt ledger rejects symlinked roots and entries without touching external files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-report-receipt-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const external = path.join(root, 'external');
  fs.mkdirSync(external);
  const victim = path.join(external, 'victim.json');
  fs.writeFileSync(victim, 'external-victim\n');

  const runtimeWithRootLink = path.join(root, 'runtime-root-link');
  fs.mkdirSync(runtimeWithRootLink);
  const linkedReceiptRoot = path.join(runtimeWithRootLink, 'report-receipts');
  fs.symlinkSync(external, linkedReceiptRoot, 'dir');
  const rootLinkedLedger = createFilesystemReportReceiptLedger({
    scopeRoot: runtimeWithRootLink,
    receiptRoot: linkedReceiptRoot,
    clock,
  });
  assert.throws(
    () => rootLinkedLedger.record(reportReceipt('sha256:root-link'), { stream: 'artifact-writes' }),
    /scoped_materialization/,
  );

  const runtimeWithEntryLink = path.join(root, 'runtime-entry-link');
  const receiptRoot = path.join(runtimeWithEntryLink, 'report-receipts');
  fs.mkdirSync(receiptRoot, { recursive: true });
  const receipt = reportReceipt('sha256:entry-link');
  fs.symlinkSync(victim, reportReceiptPath(receiptRoot, receipt));
  const entryLinkedLedger = createFilesystemReportReceiptLedger({ scopeRoot: runtimeWithEntryLink, receiptRoot, clock });
  assert.throws(
    () => entryLinkedLedger.record(receipt, { stream: 'artifact-writes' }),
    /scoped_materialization/,
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'external-victim\n');
});
