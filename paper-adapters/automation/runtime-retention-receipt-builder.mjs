import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildRuntimeRetentionReceipt(intent, removed, { intentPath, createdAt }) {
  const payload = {
    version: 2,
    kind: 'RuntimeRetentionReceipt',
    status: removed.some((entry) => entry.blockers.length)
      ? 'runtime_retention_partially_blocked'
      : 'runtime_retention_applied',
    planHash: intent.planHash,
    intentHash: intent.runtimeRetentionIntentReceiptHash,
    intentReceiptId: `runtime-retention:${intent.runtimeRetentionIntentReceiptHash}`,
    removed,
    bytesEligible: removed.reduce((total, entry) => total + entry.bytes, 0),
    bytesRemoved: removed.filter((entry) => entry.removed)
      .reduce((total, entry) => total + entry.bytes, 0),
    applied: true,
    externalActionPerformed: false,
    intentPath,
    createdAt,
  };
  return Object.freeze({
    ...payload,
    runtimeRetentionReceiptHash: hashRecord('RuntimeRetentionReceipt', payload),
  });
}
