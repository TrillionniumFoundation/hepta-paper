import {
  agentExecutionReceiptPayload,
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  selectResearchPrincipal,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function selectionKey(request) {
  return request?.context?.nodeId || request?.context?.attemptId
    || request?.context?.campaignId || request?.role;
}

export function selectedReviewerPrincipal(pool, request) {
  const role = request?.role === 'formal-review'
    ? 'formal-review' : 'independent-review';
  return selectResearchPrincipal({
    pool,
    role,
    selectionKey: selectionKey(request),
  });
}

function reviewerTrustFields({ principal, pool, trustInspection }) {
  return Object.freeze({
    reviewPrincipalId: principal.principalId,
    reviewPrincipalDescriptorHash: principal.principalDescriptorHash,
    reviewerProviderAccountIdentityHash: principal.providerAccountIdentityHash,
    reviewerCredentialRootIdentityHash: principal.credentialRootIdentityHash,
    reviewerTrustDomainIdentityHash: principal.trustDomainIdentityHash,
    reviewerSignerIdentityHash: principal.signerIdentityHash,
    researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
    reviewerCryptographicAuthorityReady: true,
    reviewerIdentityIndependenceReady: true,
    reviewerTrustSetHash: trustInspection.trustSetHash,
    reviewerSignatureVerificationPolicyHash:
      trustInspection.signatureVerificationPolicyHash,
  });
}

export function buildUnsignedReviewerRecoveryReceipt({
  rawReceipt,
  principal,
  pool,
  trustInspection,
}) {
  if (!verifyAgentExecutionReceipt(rawReceipt)) {
    throw new Error('reviewer_recovery_agent_receipt_invalid');
  }
  const payload = {
    ...agentExecutionReceiptPayload(rawReceipt),
    ...reviewerTrustFields({ principal, pool, trustInspection }),
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

export function verifyUnsignedReviewerRecoveryReceipt({
  receipt,
  request,
  pool,
  trustInspection,
}) {
  if (!verifyAgentExecutionReceipt(receipt)) return false;
  const principal = selectedReviewerPrincipal(pool, request);
  const expected = reviewerTrustFields({ principal, pool, trustInspection });
  return Object.entries(expected).every(([field, value]) => (
    receipt[field] === value
  )) && !Object.hasOwn(receipt, 'signedReviewerReceipt');
}

export function normalizeReviewerRecoveryResolution(
  resolution,
  buildReceipt,
) {
  if (!resolution || !['completed', 'in_progress', 'not_found']
    .includes(resolution.status)) {
    throw new Error('reviewer_recovery_resolution_invalid');
  }
  if (resolution.status !== 'completed') {
    if (resolution.receipt !== null && resolution.receipt !== undefined) {
      throw new Error('reviewer_recovery_resolution_invalid');
    }
    return Object.freeze({ status: resolution.status, receipt: null });
  }
  return Object.freeze({
    status: 'completed',
    receipt: buildReceipt(resolution.receipt),
  });
}

export function recoveryCapable(value) {
  return value?.crashRecoveryReady === true
    && SHA256.test(String(value.recoveryConfigurationIdentityHash || ''))
    && value.recoveryOutcomeCryptographicAuthorityReady === true
    && SHA256.test(String(
      value.recoveryOutcomeVerificationPolicyHash || '',
    ))
    && typeof value.lookup === 'function'
    && typeof value.resume === 'function';
}

export function buildPrincipalRecoveryBindings(
  relevantPrincipals,
  implementations,
) {
  return Object.freeze(relevantPrincipals.map((principal) => {
    const implementation = implementations.get(principal.principalId);
    return Object.freeze({
      principalId: principal.principalId,
      recoveryConfigurationIdentityHash:
        implementation?.recoveryConfigurationIdentityHash || null,
      recoveryOutcomeVerificationPolicyHash:
        implementation?.recoveryOutcomeVerificationPolicyHash || null,
    });
  }));
}
