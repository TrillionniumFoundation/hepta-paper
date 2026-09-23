export function assertAutonomousSubmissionCompletedReceiptVerifierPort(value) {
  if (value?.version !== 1
    || value?.kind !== 'AutonomousSubmissionCompletedReceiptVerifier'
    || typeof value.verify !== 'function'
    || typeof value.wrapVerifiedReceipt !== 'function'
    || ![true, false].includes(value.cryptographicAuthorityReady)) {
    throw new Error('autonomous_submission_completed_receipt_verifier_port_invalid');
  }
  return value;
}
