import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const KEYS = Object.freeze([
  'authorCapabilityReceiptHash', 'authorCredentialRootIdentityHash',
  'authorIdentityConfigurationHash', 'authorIdentitySubjectHash',
  'authorPrincipalId', 'kind', 'researchPrincipalPoolHash',
  'reviewerSignatureVerificationPolicyHash', 'reviewerTrustSetHash',
  'runtimePrincipalBindingHash', 'version',
]);

function canonicalHash(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

export function buildAutonomousResearchRuntimePrincipalBinding({
  authorPrincipalId,
  authorIdentityConfigurationHash,
  authorIdentitySubjectHash,
  authorCapabilityReceiptHash,
  authorCredentialRootIdentityHash,
  researchPrincipalPoolHash,
  reviewerTrustSetHash,
  reviewerSignatureVerificationPolicyHash,
} = {}) {
  const principalId = String(authorPrincipalId || '').trim();
  const payload = {
    version: 1,
    kind: 'AutonomousResearchRuntimePrincipalBinding',
    authorPrincipalId: SAFE_ID.test(principalId) ? principalId : null,
    authorIdentityConfigurationHash: canonicalHash(authorIdentityConfigurationHash),
    authorIdentitySubjectHash: canonicalHash(authorIdentitySubjectHash),
    authorCapabilityReceiptHash: canonicalHash(authorCapabilityReceiptHash),
    authorCredentialRootIdentityHash: canonicalHash(authorCredentialRootIdentityHash),
    researchPrincipalPoolHash: canonicalHash(researchPrincipalPoolHash),
    reviewerTrustSetHash: canonicalHash(reviewerTrustSetHash),
    reviewerSignatureVerificationPolicyHash:
      canonicalHash(reviewerSignatureVerificationPolicyHash),
  };
  if (Object.values(payload).some((value) => value === null)) {
    throw new Error('autonomous_research_runtime_principal_binding_invalid');
  }
  return Object.freeze({
    ...payload,
    runtimePrincipalBindingHash:
      hashRecord('AutonomousResearchRuntimePrincipalBinding', payload),
  });
}

export function verifyAutonomousResearchRuntimePrincipalBinding(binding) {
  if (!hasExactObjectKeys(binding, KEYS)) return false;
  try {
    return JSON.stringify(buildAutonomousResearchRuntimePrincipalBinding(binding))
      === JSON.stringify(binding);
  } catch { return false; }
}
