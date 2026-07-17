#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createReadOnlyPaperStore, openExistingWritablePaperStore, composeLedgerAdministratorServices } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { createSystemClock } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { selectReceiptHash } from '../../paper-domain/evidence/receipt-hash-selector.mjs';
import { sqlText } from '../../paper-ports/store-port.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const execute = process.argv.includes('--execute');
const runtimeRoot = defaultPaperRuntimeRoot();
const root = defaultPaperAssetRoot();
if (execute) assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
const readStore = createReadOnlyPaperStore({ root, runtimeRoot });
const rows = readStore.query('SELECT receipt_id,stream,receipt_json,receipt_sha256 FROM receipt_ledger ORDER BY receipt_id;').rows;
const invalid = rows.flatMap((row) => {
  try {
    const receipt = JSON.parse(row.receipt_json);
    const expected = selectReceiptHash(receipt);
    const expectedId = `${row.stream}:${expected}`;
    return expected === row.receipt_sha256 && expectedId === row.receipt_id
      ? []
      : [{ ...row, receipt, expected, expectedId }];
  } catch (error) {
    return [{ ...row, error: error.name, expected: null, expectedId: null }];
  }
});
const blockers = [
  ...invalid.filter((row) => !row.expected || !row.expectedId).map((row) => `unrepairable_receipt:${row.receipt_id}`),
];
const repaired = [];
readStore.close?.();
if (execute && !blockers.length) {
  const store = openExistingWritablePaperStore({ root, runtimeRoot });
  const clock = createSystemClock();
  const administratorServices = composeLedgerAdministratorServices({ store, clock });
  const qualifications = administratorServices.qualifications;
  const replacementLedger = administratorServices.replacementLedger;
  for (const row of invalid) {
    const conflict = store.query(`SELECT receipt_id,receipt_sha256 FROM receipt_ledger WHERE receipt_id=${sqlText(row.expectedId)} AND receipt_id<>${sqlText(row.receipt_id)} LIMIT 1;`).rows[0];
    if (conflict) {
      if (conflict.receipt_sha256 !== row.expected) {
        blockers.push(`receipt_id_conflict:${row.expectedId}`);
        continue;
      }
      const qualification = qualifications.qualify({
        receiptId: row.receipt_id,
        disposition: 'superseded',
        reason: 'invalid historical ledger row superseded by an existing valid receipt',
        replacementReceiptId: row.expectedId,
      });
      repaired.push({ priorReceiptId: row.receipt_id, receiptId: row.expectedId, receiptHash: row.expected, disposition: 'qualified_duplicate_invalid_historical_row', qualificationHash: qualification.qualificationHash });
      continue;
    }
    const canReissueOriginal = row.expectedId !== row.receipt_id;
    const replacement = canReissueOriginal
      ? replacementLedger.record({ ...row.receipt, receiptHash: row.expected }, { stream: row.stream, strictInsert: true, environment: 'administrative', evidenceClass: 'integrity_repair_replacement' })
      : replacementLedger.record({
          version: 1,
          kind: 'ReceiptLedgerRepairReplacementReceipt',
          status: 'invalid_historical_receipt_payload_preserved',
          priorReceiptId: row.receipt_id,
          expectedReceiptHash: row.expected,
          preservedReceipt: row.receipt,
        }, { stream: 'store-integrity-replacements', strictInsert: true, environment: 'administrative', evidenceClass: 'integrity_repair_replacement' });
    const qualification = qualifications.qualify({
      receiptId: row.receipt_id,
      disposition: 'superseded',
      reason: 'invalid historical ledger row superseded by an append-only replacement',
      replacementReceiptId: replacement.receiptId,
    });
    repaired.push({ priorReceiptId: row.receipt_id, receiptId: replacement.receiptId, receiptHash: replacement.receiptHash, qualificationHash: qualification.qualificationHash });
  }
  const ledger = administratorServices.ledger;
  const payload = {
    version: 1,
    kind: 'ReceiptLedgerIntegrityRepairReceipt',
    status: blockers.length ? 'receipt_ledger_integrity_repair_blocked' : 'receipt_ledger_integrity_repaired',
    codeProvenance: currentCodeProvenance(),
    invalidReceiptCount: invalid.length,
    repairedReceiptCount: repaired.length,
    repaired,
    blockers,
    executedAt: clock.nowIso(),
  };
  const receiptHash = hashRecord('ReceiptLedgerIntegrityRepairReceipt', payload);
  const receipt = { ...payload, receiptHash };
  ledger.record(receipt, {
    stream: 'store-integrity',
    environment: 'administrative',
    evidenceClass: 'integrity_repair',
    releaseCommit: currentCodeProvenance().commit,
  });
  const outputRoot = path.join(runtimeRoot, 'store-integrity');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, `RECEIPT_LEDGER_INTEGRITY_REPAIR_${Date.now()}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
}
const report = {
  version: 1,
  kind: 'ReceiptLedgerIntegrityRepairPlan',
  status: execute
    ? (blockers.length ? 'receipt_ledger_integrity_repair_blocked' : 'receipt_ledger_integrity_repaired')
    : (invalid.length ? 'receipt_ledger_integrity_repair_required' : 'receipt_ledger_integrity_clean'),
  execute,
  scannedReceiptCount: rows.length,
  invalidReceiptCount: invalid.length,
  repairedReceiptCount: repaired.length,
  invalid: invalid.map((row) => ({ receiptId: row.receipt_id, expectedReceiptId: row.expectedId, expectedReceiptHash: row.expected, error: row.error || null })),
  blockers,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (execute && blockers.length) process.exitCode = 1;
