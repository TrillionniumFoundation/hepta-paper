import { verifyAuthoritySignatures } from '../../paper-core/src/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function verifySignedExecutorResponse({ dispatchAuthorization, response, trustStore } = {}) {
  const blockers = [];
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (!response) blockers.push('signed_executor_response_missing');
  if (response?.executorId !== dispatchAuthorization?.executorId) blockers.push('signed_response_executor_id_mismatch');
  if (response?.executorDescriptorHash !== dispatchAuthorization?.executorDescriptorHash) blockers.push('signed_response_executor_descriptor_mismatch');
  if (response?.capabilitiesHash !== dispatchAuthorization?.executorCapabilitiesHash) blockers.push('signed_response_capabilities_mismatch');
  if (response?.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) blockers.push('signed_response_dispatch_mismatch');
  const signatureVerification = verifyAuthoritySignatures({ document: response, trustStore, requiredRoles: ['submission_executor'], minSignatures: 1 });
  blockers.push(...signatureVerification.blockers);
  const payload = {
    version: 1,
    kind: 'ExecutorResponseVerificationReceipt',
    status: blockers.length ? 'executor_response_signature_blocked' : 'executor_response_signature_verified',
    responseId: response?.responseId || null,
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    executorId: response?.executorId || null,
    executorDescriptorHash: response?.executorDescriptorHash || null,
    capabilitiesHash: response?.capabilitiesHash || null,
    verifiedSubjectIds: signatureVerification.verifiedSubjectIds,
    cryptographicSignaturesVerified: signatureVerification.cryptographicSignaturesVerified,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, executorResponseVerificationReceiptHash: hashRecord('ExecutorResponseVerificationReceipt', payload) });
}
