import { digest, hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const RECEIPT_HASH_POLICIES = Object.freeze({
  CURRENT: 'hepta-receipt-v2',
  LEGACY_RECORD_V1: 'legacy-record-v1',
  LEGACY_PAPER_RECORD_V1: 'legacy-paper-record-v1',
});

export function receiptSelfHashField(receipt = {}) {
  if (receipt.kind === 'ArtifactWriteReceipt') return 'writeReceiptHash';
  if (receipt.kind === 'NativeResearchWorkerExecutionReceipt') return 'nativeResearchWorkerExecutionReceiptHash';
  if (receipt.receiptHash) return 'receiptHash';
  if (receipt.jobReceiptHash) return 'jobReceiptHash';
  return null;
}

export function receiptHashPayload(receipt = {}, hashField = receiptSelfHashField(receipt)) {
  const payload = { ...receipt };
  if (hashField) delete payload[hashField];
  delete payload.ledgerReceiptId;
  return payload;
}

export function resolveReceiptHashPolicy(receipt = {}) {
  if (receipt.receiptHashPolicy) return receipt.receiptHashPolicy;
  if (receipt.kind === 'NativeResearchWorkerExecutionReceipt') {
    return RECEIPT_HASH_POLICIES.LEGACY_PAPER_RECORD_V1;
  }
  return RECEIPT_HASH_POLICIES.LEGACY_RECORD_V1;
}

export function computeReceiptHash(receipt = {}, {
  hashField = receiptSelfHashField(receipt),
  policy = resolveReceiptHashPolicy(receipt),
} = {}) {
  if (!receipt?.kind || !hashField) return null;
  const payload = receiptHashPayload(receipt, hashField);
  if (policy === RECEIPT_HASH_POLICIES.CURRENT) {
    return digest({ version: 2, kind: receipt.kind, payload });
  }
  if (policy === RECEIPT_HASH_POLICIES.LEGACY_PAPER_RECORD_V1) {
    return digest({ version: 1, kind: receipt.kind, payload });
  }
  if (policy === RECEIPT_HASH_POLICIES.LEGACY_RECORD_V1) {
    return hashRecord(receipt.kind, payload);
  }
  return null;
}

export function sealReceiptHash(receipt = {}, {
  hashField = receiptSelfHashField(receipt),
  policy = RECEIPT_HASH_POLICIES.CURRENT,
} = {}) {
  if (!receipt?.kind) throw new Error('receipt kind is required');
  if (!hashField) throw new Error('receipt self hash field is required');
  if (policy !== RECEIPT_HASH_POLICIES.CURRENT) throw new Error(`receipt hash policy not writable:${policy}`);
  const versioned = { ...receipt, receiptHashPolicy: policy };
  return Object.freeze({ ...versioned, [hashField]: computeReceiptHash(versioned, { hashField, policy }) });
}
