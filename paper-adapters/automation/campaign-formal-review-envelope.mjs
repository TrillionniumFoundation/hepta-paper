import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as hasExactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { hashWorkspaceFile } from './campaign-node-workspace-support.mjs';
import { canonicalClaimsFromWorkerPlan } from '../research-verify/canonical-claim-registry-reader.mjs';
import { readFinalizedTheoremSpecification } from './theorem-specification-finalizer.mjs';
import {
  createProposalClaimToTheoremBinding,
  verifyProposalClaimToTheoremBinding,
} from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import {
  reviewerReceiptSigningSubject,
  verifySignedReviewerReceipt,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';

const REVIEW_DOCUMENT_KEYS = Object.freeze([
  'kind',
  'reviews',
  'theoremSpecificationHash',
  'version',
]);
const REVIEW_ENTRY_KEYS = Object.freeze([
  'claimId',
  'manuscriptClaimHash',
  'semanticEquivalenceVerified',
  'sourceStatementHash',
  'status',
  'theoremName',
  'theoremTypeHash',
  'verdict',
]);
const PROPOSAL_REVIEW_ENTRY_KEYS = Object.freeze([
  ...REVIEW_ENTRY_KEYS,
  'approvedNarrowingRationale',
  'proposalClaimId',
  'proposalClaimRecordHash',
  'proposalClaimTextHash',
  'proposalToTheoremSemanticVerified',
  'proposalToTheoremVerdict',
]);

function sortedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
}

function extractCampaignAgentJson(text) {
  const candidates = [...String(text || '').matchAll(/\{[\s\S]*?\}/g)].map((match) => match[0]).reverse();
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try an earlier JSON object */ }
  }
  return null;
}

function normalizeFormalReviewEntry(review) {
  return Object.freeze({
    claimId: String(review?.claimId || ''),
    theoremName: String(review?.theoremName || ''),
    manuscriptClaimHash: review?.manuscriptClaimHash || null,
    theoremTypeHash: review?.theoremTypeHash || null,
    sourceStatementHash: review?.sourceStatementHash || null,
    status: review?.status || null,
    semanticEquivalenceVerified: review?.semanticEquivalenceVerified === true,
    verdict: review?.verdict || null,
    proposalClaimId: review?.proposalClaimId || null,
    proposalClaimRecordHash: review?.proposalClaimRecordHash || null,
    proposalClaimTextHash: review?.proposalClaimTextHash || null,
    proposalToTheoremSemanticVerified: review?.proposalToTheoremSemanticVerified === true,
    proposalToTheoremVerdict: review?.proposalToTheoremVerdict || null,
    approvedNarrowingRationale: review?.approvedNarrowingRationale ?? null,
  });
}

export function readFormalSemanticReviewAgentDocument(receipt, { proposalLineageRequired = false } = {}) {
  const parsed = receipt?.structuredOutput || extractCampaignAgentJson(receipt?.finalOutput) || {};
  const reviews = Array.isArray(parsed.reviews)
    ? Object.freeze(parsed.reviews.map(normalizeFormalReviewEntry)) : Object.freeze([]);
  const expectedEntryKeys = proposalLineageRequired ? PROPOSAL_REVIEW_ENTRY_KEYS : REVIEW_ENTRY_KEYS;
  const blockers = [
    ...(!hasExactKeys(parsed, REVIEW_DOCUMENT_KEYS)
      || parsed.kind !== 'FormalClaimSemanticReview'
      || parsed.version !== (proposalLineageRequired ? 2 : 1)
      ? ['formal_semantic_review_schema_invalid'] : []),
    ...(!reviews.length ? ['formal_semantic_review_entries_missing'] : []),
    ...(Array.isArray(parsed.reviews) && parsed.reviews.some((review) => !hasExactKeys(review, expectedEntryKeys))
      ? ['formal_semantic_review_entry_schema_invalid'] : []),
  ];
  return Object.freeze({
    version: parsed?.version ?? null,
    kind: parsed?.kind || null,
    theoremSpecificationHash: parsed?.theoremSpecificationHash || null,
    reviews,
    blockers: Object.freeze(blockers),
  });
}

export async function executeCampaignFormalVerification({ campaign, node, campaignNodes = [], formalReviewEnvelope = null, workspace, manuscript, researchVerifier, executionSignal = null } = {}) {
  if (!researchVerifier) {
    const error = new Error('campaign_research_verifier_required');
    error.retryable = false;
    throw error;
  }
  const result = await researchVerifier.verify({
    campaign,
    node,
    campaignNodes,
    workspace,
    manuscript,
    formalReviewEnvelope,
    executionSignal,
  });
  if (result?.status !== 'campaign_research_verification_completed'
    || !result?.researchReportHash
    || !result?.campaignResearchVerificationResultHash) {
    const error = new Error(`campaign_research_verification_blocked:${(result?.researchPromotionBlockers || []).join(',') || 'result_invalid'}`);
    error.retryable = false;
    error.receipt = result || null;
    throw error;
  }
  return result;
}

function signedPoolReviewerVerified(receipt, { signedReviewerReceiptVerifier = null } = {}) {
  if (receipt?.signedReviewerReceipt) {
    try {
      const subjectHash = reviewerReceiptSigningSubject({
        unsignedAgentExecutionReceiptHash: receipt.unsignedAgentExecutionReceiptHash,
        principalDescriptorHash: receipt.reviewPrincipalDescriptorHash,
        researchPrincipalPoolHash: receipt.researchPrincipalPoolHash,
      });
      const expected = {
        subjectHash,
        principalId: receipt.reviewPrincipalId,
        principalDescriptorHash: receipt.reviewPrincipalDescriptorHash,
        researchPrincipalPoolHash: receipt.researchPrincipalPoolHash,
        signerIdentityHash: receipt.reviewerSignerIdentityHash,
      };
      if (receipt.signedReviewerReceipt.version === 2
        && typeof signedReviewerReceiptVerifier === 'function') {
        return signedReviewerReceiptVerifier({
          receipt: receipt.signedReviewerReceipt,
          expected,
        }) === true;
      }
      return verifySignedReviewerReceipt(receipt.signedReviewerReceipt, expected);
    } catch { return false; }
  }
  return false;
}

function formalAgentPrincipal(receipt, {
  independentReviewer = false,
  signedReviewerReceiptVerifier = null,
} = {}) {
  if (!receipt?.providerMode || !receipt?.executorId) return null;
  const openClaw = receipt.providerMode === 'openclaw:detached-child-session';
  if (openClaw && (!receipt.agentId || !receipt.agentCapabilityProfileHash
    || !receipt.openClawAgentConfigurationHash || !receipt.openClawGatewayConfigurationHash)) return null;
  const codexReviewer = independentReviewer && receipt.providerMode === 'openai';
  const signedPoolReviewer = independentReviewer && signedPoolReviewerVerified(receipt, {
    signedReviewerReceiptVerifier,
  });
  if (codexReviewer && (!receipt.agentId
    || !receipt.codexFormalReviewerCapabilityReceiptHash
    || !receipt.codexCredentialRootIdentityHash
    || !receipt.codexCredentialConfigIdentityHash
    || !receipt.codexBinaryIdentityHash
    || receipt.codexProviderCredentialSharingPermitted !== true
    || receipt.codexFreshEphemeralSessionRequired !== true
    || receipt.codexAuthorContextInheritanceForbidden !== true
    || receipt.codexFrozenArtifactReviewRequired !== true
    || receipt.sessionIsolation !== 'fresh_ephemeral_no_resume'
    || receipt.contextInheritance !== 'forbidden'
    || receipt.codexReviewerAssuranceScope
      !== 'ephemeral_session_frozen_artifact_and_role_separation'
    || receipt.codexProviderAccountIndependenceVerified !== false
    || receipt.codexAuthenticationStatus !== 'codex_authentication_verified')) return null;
  const payload = {
    version: 1,
    kind: 'FormalAgentPrincipal',
    providerMode: receipt.providerMode,
    executorId: receipt.executorId,
    agentId: receipt.agentId || null,
    model: receipt.resolvedModel || receipt.model || null,
    capabilityProfileHash: receipt.agentCapabilityProfileHash || null,
    configurationHash: receipt.openClawAgentConfigurationHash || null,
    gatewayConfigurationHash: receipt.openClawGatewayConfigurationHash || null,
    codexFormalReviewerCapabilityReceiptHash: receipt.codexFormalReviewerCapabilityReceiptHash || null,
    codexCredentialRootIdentityHash: receipt.codexCredentialRootIdentityHash || null,
    codexCredentialConfigIdentityHash: receipt.codexCredentialConfigIdentityHash || null,
    codexAuthorCredentialRootIdentityHash: receipt.codexAuthorCredentialRootIdentityHash || null,
    codexCredentialIndependenceVerified: receipt.codexCredentialIndependenceVerified === true,
    providerCredentialSharingPermitted:
      receipt.codexProviderCredentialSharingPermitted === true,
    freshSessionIsolationVerified:
      receipt.codexFreshEphemeralSessionRequired === true
        && receipt.sessionIsolation === 'fresh_ephemeral_no_resume',
    authorContextInheritanceForbidden:
      receipt.codexAuthorContextInheritanceForbidden === true
        && receipt.contextInheritance === 'forbidden',
    frozenArtifactReviewRequired: receipt.codexFrozenArtifactReviewRequired === true,
    reviewerAssuranceScope: receipt.providerMode === 'openai'
      ? signedPoolReviewer
        ? 'signed_configured_identity_credential_root_and_signer_separation'
        : receipt.codexReviewerAssuranceScope || null
      : 'configured_principal_and_process_separation',
    // Even a signed reviewer-pool identity does not prove separation from the
    // author account unless an author identity attestation is compared here.
    providerAccountIndependenceVerified: false,
    reviewPrincipalId: receipt.reviewPrincipalId || null,
    reviewPrincipalDescriptorHash: receipt.reviewPrincipalDescriptorHash || null,
    reviewerProviderAccountIdentityHash:
      receipt.reviewerProviderAccountIdentityHash || null,
    reviewerCredentialRootIdentityHash:
      receipt.reviewerCredentialRootIdentityHash || null,
    reviewerTrustDomainIdentityHash: receipt.reviewerTrustDomainIdentityHash || null,
    reviewerSignerIdentityHash: receipt.reviewerSignerIdentityHash || null,
    researchPrincipalPoolHash: receipt.researchPrincipalPoolHash || null,
    signedReviewerReceiptHash: receipt.signedReviewerReceiptHash || null,
    signatureVerificationReceiptHash:
      receipt.signatureVerificationReceiptHash || null,
    codexBinaryIdentityHash: receipt.codexBinaryIdentityHash || null,
    codexVersion: receipt.codexVersion || null,
  };
  return hashRecord('FormalAgentPrincipal', payload);
}

export function buildCampaignFormalReviewEnvelope({
  campaign,
  node,
  authorNode = null,
  receipt,
  workspace,
  manuscript,
  signedReviewerReceiptVerifier = null,
} = {}) {
  const reviewerPrincipalId = formalAgentPrincipal(receipt, {
    independentReviewer: true,
    signedReviewerReceiptVerifier,
  });
  const authorPrincipalId = formalAgentPrincipal(authorNode?.result);
  const signedPoolReviewer = signedPoolReviewerVerified(receipt, {
    signedReviewerReceiptVerifier,
  });
  const expectedResearchPrincipalPoolHash = campaign?.spec?.autonomousResearchPreparation
    ?.researchPrincipalPoolHash || null;
  let workerPlanHash = null;
  try { workerPlanHash = hashWorkspaceFile(workspace, 'RESEARCH_WORKER_PLAN.json'); } catch { workerPlanHash = null; }
  let canonicalClaimRegistry = null;
  let theoremSpecification = null;
  try {
    theoremSpecification = readFinalizedTheoremSpecification({
      workspace,
      manuscriptPath: manuscript,
      paperId: campaign?.paperId,
      campaignId: campaign?.campaignId,
      scientificClaimAuthority: campaign?.spec?.scientificClaimAuthority || null,
      approvedProposalSeed: campaign?.spec?.approvedProposalSeed || null,
    });
  } catch { theoremSpecification = null; }
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json'), 'utf8'));
    canonicalClaimRegistry = canonicalClaimsFromWorkerPlan({
      sourceRoot: workspace,
      paperTask: { sourceWorkspace: workspace, mainTex: path.join(workspace, manuscript) },
      plan,
    });
  } catch { canonicalClaimRegistry = null; }
  const manuscriptHash = canonicalClaimRegistry?.manuscriptHash || null;
  const proposalLineageRequired = theoremSpecification?.proposalClaimLineageRequired === true;
  const agentDocument = readFormalSemanticReviewAgentDocument(receipt, { proposalLineageRequired });
  const reviews = agentDocument.reviews;
  const reviewClaimIds = reviews.map((review) => review.claimId).filter(Boolean);
  const duplicateReviewClaimIds = [...new Set(reviewClaimIds.filter((claimId, index) => reviewClaimIds.indexOf(claimId) !== index))];
  const canonicalClaimIds = new Set((canonicalClaimRegistry?.claims || []).map((claim) => claim.claimId));
  const specificationClaimIds = new Set((theoremSpecification?.claims || []).map((claim) => claim.claimId));
  const reviewClaimIdSet = new Set(reviewClaimIds);
  const blockers = [
    ...agentDocument.blockers,
    ...(!authorNode?.result?.agentExecutionReceiptHash ? ['formal_author_execution_receipt_missing'] : []),
    ...(!receipt?.agentExecutionReceiptHash ? ['formal_review_execution_receipt_missing'] : []),
    ...(!reviewerPrincipalId || !authorPrincipalId || reviewerPrincipalId === authorPrincipalId ? ['formal_review_principal_independence_invalid'] : []),
    ...(expectedResearchPrincipalPoolHash && (!signedPoolReviewer
      || receipt?.researchPrincipalPoolHash !== expectedResearchPrincipalPoolHash)
      ? ['formal_review_signed_principal_pool_binding_invalid'] : []),
    ...(!workerPlanHash || !manuscriptHash ? ['formal_review_input_hash_missing'] : []),
    ...(!theoremSpecification ? ['formal_review_theorem_specification_invalid'] : []),
    ...(theoremSpecification && agentDocument.theoremSpecificationHash !== theoremSpecification.theoremSpecificationHash
      ? ['formal_review_theorem_specification_hash_mismatch'] : []),
    ...(canonicalClaimRegistry?.status === 'canonical_claim_registry_verified'
      ? []
      : ['formal_review_canonical_claim_registry_invalid', ...(canonicalClaimRegistry?.blockers || [])]),
    ...duplicateReviewClaimIds.map((claimId) => `formal_semantic_review_duplicate:${claimId}`),
    ...[...canonicalClaimIds].filter((claimId) => !reviewClaimIdSet.has(claimId)).map((claimId) => `formal_semantic_review_missing:${claimId}`),
    ...[...reviewClaimIdSet].filter((claimId) => !canonicalClaimIds.has(claimId)).map((claimId) => `formal_semantic_review_unregistered:${claimId}`),
    ...[...canonicalClaimIds].filter((claimId) => !specificationClaimIds.has(claimId)).map((claimId) => `formal_review_specification_claim_missing:${claimId}`),
    ...[...specificationClaimIds].filter((claimId) => !canonicalClaimIds.has(claimId)).map((claimId) => `formal_review_canonical_claim_missing:${claimId}`),
  ];
  for (const claim of canonicalClaimRegistry?.claims || []) {
    const specificationClaim = theoremSpecification?.claims?.find((candidate) => candidate.claimId === claim.claimId) || null;
    if (!specificationClaim || specificationClaim.statement !== claim.text
      || specificationClaim.manuscriptSource?.path !== claim.manuscriptPath
      || specificationClaim.manuscriptSource?.byteStart !== claim.manuscriptByteStart
      || specificationClaim.manuscriptSource?.byteEnd !== claim.manuscriptByteEnd
      || specificationClaim.manuscriptSource?.contentHash !== claim.manuscriptContentHash
      || specificationClaim.manuscriptSource?.formalClaimUniverseEntryHash !== claim.formalClaimUniverseEntryHash
      || JSON.stringify(sortedStrings(specificationClaim.proofObligations))
        !== JSON.stringify(sortedStrings(claim.proofObligations))) {
      blockers.push(`formal_review_specification_claim_binding_mismatch:${claim.claimId}`);
    }
  }
  let proposalClaimToTheoremBinding = null;
  if (proposalLineageRequired) {
    try {
      proposalClaimToTheoremBinding = createProposalClaimToTheoremBinding({
        paperId: campaign?.paperId,
        campaignId: campaign?.campaignId,
        theoremSpecification,
        reviews,
        reviewAuthority: {
          reviewAgentReceiptHash: receipt?.agentExecutionReceiptHash,
          reviewerPrincipalId,
        },
      });
      const verification = verifyProposalClaimToTheoremBinding(proposalClaimToTheoremBinding, {
        paperId: campaign?.paperId,
        campaignId: campaign?.campaignId,
        approvedProposalSeedBindingHash: theoremSpecification.approvedProposalSeedBindingHash,
        proposalSeedContractBundleHash: theoremSpecification.proposalSeedContractBundleHash,
        claimAuthorityType: theoremSpecification.claimAuthorityType,
        claimAuthorityBindingHash: theoremSpecification.claimAuthorityBindingHash,
        claimAuthorityBundleHash: theoremSpecification.claimAuthorityBundleHash,
        theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
        reviewAgentReceiptHash: receipt?.agentExecutionReceiptHash,
        reviewerPrincipalId,
        theoremSpecification,
        reviews,
      });
      if (!verification.valid) blockers.push(...verification.blockers);
    } catch (error) {
      blockers.push(error?.message || 'proposal_claim_to_theorem_binding_invalid');
    }
  }
  const payload = {
    version: 1,
    kind: 'FormalClaimSemanticReviewEnvelope',
    status: blockers.length ? 'formal_semantic_review_envelope_blocked' : 'formal_semantic_review_envelope_verified',
    paperId: campaign?.paperId || null,
    campaignId: campaign?.campaignId || null,
    reviewNodeId: node?.nodeId || null,
    reviewAttemptId: node?.attemptId || null,
    reviewAgentReceiptHash: receipt?.agentExecutionReceiptHash || null,
    reviewerPrincipalId,
    reviewerIndependenceAssuranceScope: receipt?.providerMode === 'openai'
      ? receipt.signedReviewerReceiptHash
        ? 'signed_configured_identity_credential_root_and_signer_separation'
        : receipt.codexReviewerAssuranceScope || null
      : 'configured_principal_and_process_separation',
    providerAccountIndependenceVerified: false,
    reviewPrincipalDescriptorHash: receipt?.reviewPrincipalDescriptorHash || null,
    reviewerProviderAccountIdentityHash:
      receipt?.reviewerProviderAccountIdentityHash || null,
    reviewerCredentialRootIdentityHash:
      receipt?.reviewerCredentialRootIdentityHash || null,
    reviewerTrustDomainIdentityHash:
      receipt?.reviewerTrustDomainIdentityHash || null,
    researchPrincipalPoolHash: receipt?.researchPrincipalPoolHash || null,
    signedReviewerReceiptHash: receipt?.signedReviewerReceiptHash || null,
    authorNodeId: authorNode?.nodeId || null,
    authorAgentReceiptHash: authorNode?.result?.agentExecutionReceiptHash || null,
    authorPrincipalId,
    manuscriptHash,
    workerPlanHash,
    theoremSpecificationHash: theoremSpecification?.theoremSpecificationHash || null,
    claimAuthorityType: theoremSpecification?.claimAuthorityType || null,
    claimAuthorityBindingHash: theoremSpecification?.claimAuthorityBindingHash || null,
    claimAuthorityBundleHash: theoremSpecification?.claimAuthorityBundleHash || null,
    approvedProposalSeedBindingHash: theoremSpecification?.approvedProposalSeedBindingHash || null,
    proposalSeedContractBundleHash: theoremSpecification?.proposalSeedContractBundleHash || null,
    proposalClaimToTheoremBindingHash:
      proposalClaimToTheoremBinding?.proposalClaimToTheoremBindingHash || null,
    proposalClaimToTheoremBinding,
    formalClaimUniverseHash: canonicalClaimRegistry?.formalClaimUniverseHash || null,
    canonicalClaimRegistryHash: canonicalClaimRegistry?.canonicalClaimRegistryHash || null,
    reviews,
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    formalSemanticReviewEnvelopeHash: hashPaperRecord('FormalClaimSemanticReviewEnvelope', payload),
  });
}
