export function assertReviewerReceiptSignerPort(value) {
  if (!value || value.kind !== 'ReviewerReceiptSignerPort'
    || typeof value.sign !== 'function'
    || ![1, 2].includes(value.version)
    || ![true, false].includes(value.crashRecoveryReady ?? false)
    || ![true, false].includes(value.cryptographicAuthorityReady)
    || ![true, false].includes(value.identityIndependenceReady)
    || (value.identityIndependenceReady === true
      && value.cryptographicAuthorityReady !== true)
    || (value.cryptographicAuthorityReady === true
      && (!/^sha256:[0-9a-f]{64}$/.test(String(value.trustSetHash || ''))
        || !/^sha256:[0-9a-f]{64}$/.test(
          String(value.signatureVerificationPolicyHash || ''),
        )))
    || (value.version === 2 && typeof value.verifySignedReceipt !== 'function')) {
    throw new Error('reviewer_receipt_signer_port_invalid');
  }
  if (value.crashRecoveryReady === true
    && (!/^sha256:[0-9a-f]{64}$/.test(
      String(value.recoveryConfigurationIdentityHash || ''),
    )
      || value.recoveryOutcomeCryptographicAuthorityReady !== true
      || !/^sha256:[0-9a-f]{64}$/.test(
        String(value.recoveryOutcomeVerificationPolicyHash || ''),
      )
      || typeof value.lookup !== 'function'
      || typeof value.resume !== 'function')) {
    throw new Error('reviewer_receipt_signer_recovery_port_invalid');
  }
  return value;
}
