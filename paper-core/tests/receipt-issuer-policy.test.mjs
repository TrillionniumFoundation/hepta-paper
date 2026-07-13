import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { issueReceiptWriterCapability } from '../../paper-adapters/persistence/receipt-issuer-policy.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
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
      issuerCapability: issueReceiptWriterCapability('test-artifact-repository'),
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

test('receipt ledger rows cannot be updated or deleted after schema 18', () => {
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
