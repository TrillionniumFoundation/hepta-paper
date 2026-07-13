import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  issueLedgerAdministratorWriter,
  issueTestArtifactRepositoryWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteReceiptLedgerQualificationStore } from '../../paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { verifyTrustedLedgerReceipt } from '../../paper-domain/evidence/trusted-ledger-receipt.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-issuer-policy-'));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'test.sqlite') });
  const clock = { nowIso: () => '2026-07-13T00:00:00.000Z' };
  return { root, store, clock };
}

test('trusted writer cannot be self-declared and registered issuer is least-privilege', () => {
  const { root, store, clock } = fixture();
  try {
    assert.throws(() => createSqliteReceiptLedger({
      store,
      clock,
      writerIdentity: { writerId: 'self-declared', trusted: true },
    }), /raw_trusted_writer_identity_forbidden/);
    const ledger = createSqliteReceiptLedger({
      store,
      clock,
      issuerCapability: issueTestArtifactRepositoryWriter(),
    });
    const payload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written' };
    const recorded = ledger.record({ ...payload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload) }, { stream: 'artifact-writes' });
    assert.equal(recorded.writerTrusted, true);
    assert.equal(recorded.issuerPolicyId, 'test-artifact-repository');
    assert.equal(recorded.issuerAssurance, 'test_only');
    assert.throws(() => ledger.record({ kind: 'ForgedReceipt' }, { stream: 'artifact-writes' }), /issuer kind forbidden/);
    assert.throws(() => ledger.record({ ...payload, writeReceiptHash: hashRecord('Other', payload) }, { stream: 'jobs' }), /issuer stream forbidden/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt ledger rows cannot be updated or deleted after schema 19', () => {
  const { root, store, clock } = fixture();
  try {
    const ledger = createSqliteReceiptLedger({ store, clock });
    const receipt = ledger.record({ kind: 'UntrustedDiagnosticReceipt', status: 'recorded' }, { stream: 'diagnostic' });
    assert.equal(store.execute(`UPDATE receipt_ledger SET status='changed' WHERE receipt_id='${receipt.receiptId}'`).ok, false);
    assert.equal(store.execute(`DELETE FROM receipt_ledger WHERE receipt_id='${receipt.receiptId}'`).ok, false);
    assert.equal(ledger.get(receipt.receiptId).status, 'recorded');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('qualified trusted receipts fail closed while raw rows remain audit-readable', () => {
  const { root, store, clock } = fixture();
  try {
    const ledger = createSqliteReceiptLedger({
      store,
      clock,
      issuerCapability: issueTestArtifactRepositoryWriter(),
    });
    const payload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written' };
    const receipt = { ...payload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload) };
    const recorded = ledger.record(receipt, { stream: 'artifact-writes' });
    const qualifications = createSqliteReceiptLedgerQualificationStore({
      store,
      clock,
      issuerCapability: issueLedgerAdministratorWriter(),
    });
    const qualification = qualifications.qualify({
      receiptId: recorded.receiptId,
      disposition: 'invalid',
      reason: 'adversarial effective-ledger test',
    });
    const verification = verifyTrustedLedgerReceipt({
      receipt,
      ledgerReceiptId: recorded.receiptId,
      receiptLedger: ledger,
      expectedKinds: ['ArtifactWriteReceipt'],
      expectedStreams: ['artifact-writes'],
    });
    assert.equal(verification.status, 'trusted_ledger_receipt_blocked');
    assert.deepEqual(verification.blockers, ['trusted_receipt_qualified_invalid']);
    assert.equal(verification.qualificationHash, qualification.qualificationHash);
    assert.equal(ledger.list({ stream: 'artifact-writes' }).length, 0);
    assert.equal(ledger.list({ stream: 'artifact-writes', includeQualified: true }).length, 1);
    assert.equal(ledger.getRawForAudit(recorded.receiptId).receipt_id, recorded.receiptId);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('superseded receipts resolve only through a hash-bound replacement lineage', () => {
  const { root, store, clock } = fixture();
  try {
    const ledger = createSqliteReceiptLedger({ store, clock, issuerCapability: issueTestArtifactRepositoryWriter() });
    const oldPayload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'old' };
    const oldReceipt = { ...oldPayload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', oldPayload) };
    const oldRecorded = ledger.record(oldReceipt, { stream: 'artifact-writes' });
    const replacementPayload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'replacement' };
    const replacementReceipt = { ...replacementPayload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', replacementPayload) };
    const replacementRecorded = ledger.record(replacementReceipt, { stream: 'artifact-writes' });
    const qualifications = createSqliteReceiptLedgerQualificationStore({ store, clock, issuerCapability: issueLedgerAdministratorWriter() });
    qualifications.qualify({ receiptId: oldRecorded.receiptId, disposition: 'superseded', reason: 'replacement lineage test', replacementReceiptId: replacementRecorded.receiptId });
    const replacementVerification = verifyTrustedLedgerReceipt({ receipt: replacementReceipt, ledgerReceiptId: oldRecorded.receiptId, receiptLedger: ledger, expectedKinds: ['ArtifactWriteReceipt'], expectedStreams: ['artifact-writes'] });
    assert.equal(replacementVerification.status, 'trusted_ledger_receipt_verified');
    assert.equal(replacementVerification.effectiveLineage.length, 1);
    assert.equal(replacementVerification.effectiveLineage[0].replacementReceiptId, replacementRecorded.receiptId);
    const staleVerification = verifyTrustedLedgerReceipt({ receipt: oldReceipt, ledgerReceiptId: oldRecorded.receiptId, receiptLedger: ledger });
    assert.equal(staleVerification.status, 'trusted_ledger_receipt_blocked');
    assert.equal(staleVerification.blockers.includes('trusted_receipt_ledger_payload_mismatch'), true);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
