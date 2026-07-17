import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const RECEIPT_HASH_SELECTOR_POLICY = Object.freeze({
  version: 1,
  policyId: 'receipt-hash-selector-v1',
  priority: Object.freeze([
    'receiptHash',
    'writeReceiptHash',
    'jobReceiptHash',
    'reverse:*ReceiptHash',
    'hashRecord(kind||Receipt,receipt)',
  ]),
});

export function selectReceiptHashWithPolicy(receipt = {}) {
  const explicit = [
    ['receiptHash', receipt.receiptHash],
    ['writeReceiptHash', receipt.writeReceiptHash],
    ['jobReceiptHash', receipt.jobReceiptHash],
  ].find(([, value]) => Boolean(value));
  if (explicit) {
    return Object.freeze({
      ...RECEIPT_HASH_SELECTOR_POLICY,
      source: explicit[0],
      hash: explicit[1],
    });
  }
  const reverse = Object.entries(receipt).reverse()
    .find(([key]) => key.endsWith('ReceiptHash'));
  if (reverse?.[1]) {
    return Object.freeze({
      ...RECEIPT_HASH_SELECTOR_POLICY,
      source: `reverse:${reverse[0]}`,
      hash: reverse[1],
    });
  }
  return Object.freeze({
    ...RECEIPT_HASH_SELECTOR_POLICY,
    source: 'fallback:hashRecord',
    hash: hashRecord(receipt.kind || 'Receipt', receipt),
  });
}

export function selectReceiptHash(receipt = {}) {
  return selectReceiptHashWithPolicy(receipt).hash;
}
