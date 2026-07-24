import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const BOUNDED_ASSURANCE_SCOPES = new Set([
  'filesystem_credential_root_and_principal_separation',
  'configured_principal_and_process_separation',
]);
const SIGNED_CONFIGURED_IDENTITY_ASSURANCE_SCOPE =
  'signed_configured_identity_credential_root_and_signer_separation';
const SIGNED_IDENTITY_FIELDS = Object.freeze([
  'reviewPrincipalDescriptorHash',
  'reviewerProviderAccountIdentityHash',
  'reviewerCredentialRootIdentityHash',
  'reviewerTrustDomainIdentityHash',
  'researchPrincipalPoolHash',
  'signedReviewerReceiptHash',
]);

function assuranceScopeValid(envelope) {
  const scope = envelope?.reviewerIndependenceAssuranceScope;
  if (BOUNDED_ASSURANCE_SCOPES.has(scope)) {
    return envelope?.providerAccountIndependenceVerified === false;
  }
  return scope === SIGNED_CONFIGURED_IDENTITY_ASSURANCE_SCOPE
    && envelope?.providerAccountIndependenceVerified === false
    && SIGNED_IDENTITY_FIELDS.every((field) => SHA256.test(String(envelope?.[field] || '')));
}

export function formalReviewEnvelopeBlockers(envelope, {
  paperId,
  manuscriptHash,
  workerPlanHash,
  formalClaimUniverseHash,
  canonicalClaimRegistryHash,
  theoremSpecificationHash,
} = {}) {
  const blockers = [];
  const {
    formalSemanticReviewEnvelopeHash,
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...payload
  } = envelope || {};
  if (!envelope || envelope.kind !== 'FormalClaimSemanticReviewEnvelope'
    || hashPaperRecord('FormalClaimSemanticReviewEnvelope', payload)
      !== formalSemanticReviewEnvelopeHash) {
    blockers.push('formal_semantic_review_envelope_hash_invalid');
  }
  if (envelope?.status !== 'formal_semantic_review_envelope_verified') {
    blockers.push('formal_semantic_review_envelope_not_verified');
  }
  if (envelope?.paperId !== paperId) blockers.push('formal_semantic_review_envelope_paper_mismatch');
  if (envelope?.manuscriptHash !== manuscriptHash) {
    blockers.push('formal_semantic_review_envelope_manuscript_mismatch');
  }
  if (envelope?.workerPlanHash !== workerPlanHash) {
    blockers.push('formal_semantic_review_envelope_plan_mismatch');
  }
  if (!formalClaimUniverseHash || envelope?.formalClaimUniverseHash !== formalClaimUniverseHash) {
    blockers.push('formal_semantic_review_envelope_claim_universe_mismatch');
  }
  if (!canonicalClaimRegistryHash
    || envelope?.canonicalClaimRegistryHash !== canonicalClaimRegistryHash) {
    blockers.push('formal_semantic_review_envelope_claim_registry_mismatch');
  }
  if (theoremSpecificationHash !== undefined
    && (!theoremSpecificationHash
      || envelope?.theoremSpecificationHash !== theoremSpecificationHash)) {
    blockers.push('formal_semantic_review_envelope_theorem_specification_mismatch');
  }
  for (const field of [
    'reviewNodeId',
    'reviewAttemptId',
    'reviewAgentReceiptHash',
    'authorNodeId',
    'authorAgentReceiptHash',
    'reviewerPrincipalId',
    'authorPrincipalId',
  ]) {
    if (!envelope?.[field]) blockers.push(`formal_semantic_review_envelope_${field}_missing`);
  }
  if (envelope?.reviewNodeId === envelope?.authorNodeId
    || envelope?.reviewAgentReceiptHash === envelope?.authorAgentReceiptHash
    || envelope?.reviewerPrincipalId === envelope?.authorPrincipalId) {
    blockers.push('formal_semantic_review_envelope_independence_invalid');
  }
  if (!assuranceScopeValid(envelope)) {
    blockers.push('formal_semantic_review_envelope_assurance_scope_invalid');
  }
  return [...new Set(blockers)];
}
