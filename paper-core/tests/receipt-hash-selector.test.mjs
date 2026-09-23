import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECEIPT_HASH_SELECTOR_POLICY,
  selectReceiptHash,
  selectReceiptHashWithPolicy,
} from '../../paper-domain/evidence/receipt-hash-selector.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const table = [
  {
    name: 'receiptHash wins over every other candidate',
    receipt: { receiptHash: 'receipt', writeReceiptHash: 'write', jobReceiptHash: 'job', alphaReceiptHash: 'alpha' },
    hash: 'receipt',
    source: 'receiptHash',
  },
  {
    name: 'writeReceiptHash wins when receiptHash is empty',
    receipt: { receiptHash: '', writeReceiptHash: 'write', jobReceiptHash: 'job', alphaReceiptHash: 'alpha' },
    hash: 'write',
    source: 'writeReceiptHash',
  },
  {
    name: 'jobReceiptHash wins over reverse candidates',
    receipt: { jobReceiptHash: 'job', alphaReceiptHash: 'alpha', omegaReceiptHash: 'omega' },
    hash: 'job',
    source: 'jobReceiptHash',
  },
  {
    name: 'last inserted custom ReceiptHash wins in reverse order',
    receipt: { alphaReceiptHash: 'alpha', value: 1, omegaReceiptHash: 'omega' },
    hash: 'omega',
    source: 'reverse:omegaReceiptHash',
  },
];

for (const row of table) {
  test(row.name, () => {
    assert.equal(selectReceiptHash(row.receipt), row.hash);
    assert.deepEqual(selectReceiptHashWithPolicy(row.receipt), {
      ...RECEIPT_HASH_SELECTOR_POLICY,
      source: row.source,
      hash: row.hash,
    });
  });
}

test('selector fallback is the version-1 record hash', () => {
  const receipt = { kind: 'FallbackReceipt', value: 1 };
  assert.deepEqual(selectReceiptHashWithPolicy(receipt), {
    ...RECEIPT_HASH_SELECTOR_POLICY,
    source: 'fallback:hashRecord',
    hash: hashRecord('FallbackReceipt', receipt),
  });
});
