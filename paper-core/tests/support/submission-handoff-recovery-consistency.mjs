import assert from 'node:assert/strict';

const DETACHED_PROOF_FIELDS = Object.freeze([
  'detachedRecordWriteReceiptHashes',
  'submissionHandoffDetachedRecordSetHash',
  'detachedSubmissionHandoffBundleVerificationReceiptHash',
  'stagedDetachedSubmissionHandoffBundleVerificationReceiptHash',
]);

export function assertSubmissionHandoffDetachedRecoveryConsistency(
  freshExport,
  recoveredExport,
) {
  assert.equal(
    recoveredExport.status,
    'submission_handoff_export_completed',
    JSON.stringify(recoveredExport.blockers),
  );
  const fresh = freshExport.bundleExportReceipt;
  const recovered = recoveredExport.bundleExportReceipt;
  assert.ok(fresh.detachedRecordWriteReceiptHashes.length > 0);
  assert.equal(recovered.recoveredExistingPublication, true);
  for (const field of DETACHED_PROOF_FIELDS) {
    assert.deepEqual(recovered[field], fresh[field], field);
  }
}
