#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const execute = process.argv.includes('--execute');
const runtimeRoot = defaultPaperRuntimeRoot();
const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
const store = createDefaultPaperStore({ root: defaultPaperAssetRoot(), runtimeRoot, dbPath });
const clock = createSystemClock();
const ledger = createSqliteReceiptLedger({ store, clock });
const quarantineRoot = path.join(runtimeRoot, 'quarantine', 'pre-v0.5-runtime-evidence');
fs.mkdirSync(quarantineRoot, { recursive: true });
const candidates = store.query("SELECT * FROM jobs WHERE environment='legacy_unclassified' AND status='queued' AND attempt_count=0 ORDER BY created_at;").rows;
const contaminatedReceipts = store.query(`
  SELECT * FROM receipt_ledger
  WHERE (environment='verification' AND evidence_class='technical_conformance')
     OR (environment='production' AND evidence_class='runtime_unclassified')
  ORDER BY created_at, receipt_id;
`).rows;
const exportPayload = { version: 1, kind: 'LegacyUnclassifiedQueuedJobExport', rows: candidates };
const exportHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(exportPayload)).digest('hex')}`;
const exportPath = path.join(quarantineRoot, 'QUEUED_JOBS.json');
fs.writeFileSync(exportPath, `${JSON.stringify({ ...exportPayload, exportHash }, null, 2)}\n`);
const receiptExportPayload = {
  version: 1,
  kind: 'ContaminatedProductionReceiptExport',
  selection: [
    'verification/technical_conformance receipts do not belong in the production ledger',
    'production/runtime_unclassified receipts were created after schema-v3 isolation and cannot qualify as evidence',
  ],
  rows: contaminatedReceipts,
};
const receiptExportHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(receiptExportPayload)).digest('hex')}`;
const receiptExportPath = path.join(quarantineRoot, 'CONTAMINATED_RECEIPTS.json');
fs.writeFileSync(receiptExportPath, `${JSON.stringify({ ...receiptExportPayload, receiptExportHash }, null, 2)}\n`);
if (execute && candidates.length) {
  const ids = candidates.map((row) => `'${String(row.job_id).replace(/'/g, "''")}'`).join(',');
  const result = store.execute(`DELETE FROM jobs WHERE job_id IN (${ids}) AND status='queued' AND attempt_count=0;`);
  if (!result.ok) throw new Error(result.error || result.stderr || 'queued_job_quarantine_failed');
}
if (execute && contaminatedReceipts.length) {
  const result = store.execute(`
    DELETE FROM receipt_ledger
    WHERE (environment='verification' AND evidence_class='technical_conformance')
       OR (environment='production' AND evidence_class='runtime_unclassified');
  `);
  if (!result.ok) throw new Error(result.error || result.stderr || 'contaminated_receipt_quarantine_failed');
}
const contaminatedRuntimeRoots = [
  path.join(runtimeRoot, 'selftest'),
  path.join(runtimeRoot, 'packages', 'migration_plugin_fixture'),
];
const movedRuntimeRoots = [];
if (execute) {
  for (const source of contaminatedRuntimeRoots) {
    if (!fs.existsSync(source)) continue;
    const destination = path.join(quarantineRoot, `runtime-${path.basename(source)}-${Date.now()}`);
    fs.renameSync(source, destination);
    movedRuntimeRoots.push({ source, destination });
  }
}
const classifications = store.query('SELECT environment,evidence_class,count(*) AS count FROM receipt_ledger GROUP BY environment,evidence_class ORDER BY environment,evidence_class;').rows;
const payload = {
  version: 1,
  kind: 'RuntimeEvidenceHygieneReceipt',
  status: execute ? 'runtime_evidence_hygiene_executed' : 'runtime_evidence_hygiene_planned',
  schemaVersion: 3,
  quarantinedQueuedJobCount: execute ? candidates.length : 0,
  queuedJobExportPath: exportPath,
  queuedJobExportHash: exportHash,
  receiptClassifications: classifications,
  quarantinedReceiptCount: execute ? contaminatedReceipts.length : 0,
  contaminatedReceiptExportPath: receiptExportPath,
  contaminatedReceiptExportHash: receiptExportHash,
  movedRuntimeRoots,
  testReceiptsDeletedFromProductionLedger: execute && contaminatedReceipts.length > 0,
  quarantinedReceiptPayloadsPreserved: true,
  legacyReceiptsReclassifiedNotPromoted: true,
  createdAt: clock.nowIso(),
};
const receiptHash = hashRecord('RuntimeEvidenceHygieneReceipt', payload);
const ledgerReceipt = execute ? ledger.record({ ...payload, receiptHash }, {
  stream: 'runtime-hygiene',
  environment: 'administrative',
  evidenceClass: 'evidence_hygiene',
}) : null;
process.stdout.write(`${JSON.stringify({ ...payload, runtimeEvidenceHygieneReceiptHash: receiptHash, ledgerReceipt }, null, 2)}\n`);
