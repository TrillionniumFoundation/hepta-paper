import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { normalizeFormalProofObligationMappings } from './formal-proof-obligation-mapping.mjs';

function normalizedText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizedStrings(values) {
  return [...new Set(Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [])].sort();
}

export function manuscriptClaimHash({ claimId, text, sourceLocator } = {}) {
  return hashRecord('ManuscriptClaimIdentity', {
    version: 1,
    claimId: String(claimId || '').trim(),
    text: normalizedText(text),
    sourceLocator: sourceLocator ? String(sourceLocator).trim() : null,
  });
}

export function buildFormalClaimContract({
  claimId,
  claimText,
  sourceLocator = null,
  theoremName,
  theoremTypeHash,
  sourceStatementHash,
  proofObligations = [],
  proofObligationContracts = null,
  proofObligationMappings = null,
  manuscriptSourceIdentity = null,
  theoremSpecificationHash = null,
  theoremSpecificationClaimHash = null,
  semanticReview = null,
} = {}) {
  const normalizedClaimId = String(claimId || '').trim();
  const normalizedTheoremName = String(theoremName || '').trim();
  const obligations = normalizedStrings(proofObligations);
  const obligationMapping = normalizeFormalProofObligationMappings({
    proofObligationContracts,
    proofObligations,
    proofObligationMappings,
    theoremName: normalizedTheoremName,
  });
  const computedManuscriptClaimHash = manuscriptClaimHash({ claimId: normalizedClaimId, text: claimText, sourceLocator });
  const review = semanticReview && typeof semanticReview === 'object' ? Object.freeze({
    status: semanticReview.status || null,
    reviewerId: semanticReview.reviewerId || null,
    authorId: semanticReview.authorId || null,
    semanticEquivalenceVerified: semanticReview.semanticEquivalenceVerified === true,
    reviewReceiptHash: semanticReview.reviewReceiptHash || null,
    reviewEnvelopeHash: semanticReview.reviewEnvelopeHash || null,
    reviewNodeId: semanticReview.reviewNodeId || null,
    reviewAttemptId: semanticReview.reviewAttemptId || null,
    reviewAgentReceiptHash: semanticReview.reviewAgentReceiptHash || null,
    authorNodeId: semanticReview.authorNodeId || null,
    authorAgentReceiptHash: semanticReview.authorAgentReceiptHash || null,
    reviewedManuscriptHash: semanticReview.reviewedManuscriptHash || null,
    reviewedWorkerPlanHash: semanticReview.reviewedWorkerPlanHash || null,
    theoremSpecificationHash: semanticReview.theoremSpecificationHash || null,
    theoremSpecificationClaimHash: semanticReview.theoremSpecificationClaimHash || null,
    proposalClaimToTheoremBindingHash: semanticReview.proposalClaimToTheoremBindingHash || null,
    proposalClaimRecordHash: semanticReview.proposalClaimRecordHash || null,
  }) : null;
  const sourceIdentity = manuscriptSourceIdentity && typeof manuscriptSourceIdentity === 'object' ? Object.freeze({
    path: manuscriptSourceIdentity.path || null,
    byteStart: Number.isSafeInteger(manuscriptSourceIdentity.byteStart) ? manuscriptSourceIdentity.byteStart : null,
    byteEnd: Number.isSafeInteger(manuscriptSourceIdentity.byteEnd) ? manuscriptSourceIdentity.byteEnd : null,
    contentHash: manuscriptSourceIdentity.contentHash || null,
    fileHash: manuscriptSourceIdentity.fileHash || null,
  }) : null;
  const blockers = [
    ...(!normalizedClaimId ? ['formal_claim_id_missing'] : []),
    ...(!normalizedText(claimText) ? ['formal_claim_text_missing'] : []),
    ...(!normalizedTheoremName ? ['formal_theorem_name_missing'] : []),
    ...(!theoremTypeHash ? ['formal_theorem_type_hash_missing'] : []),
    ...(!sourceStatementHash ? ['formal_source_statement_hash_missing'] : []),
    ...(!obligations.length ? ['formal_proof_obligations_missing'] : []),
    ...obligationMapping.blockers,
    ...(!sourceIdentity || !sourceIdentity.path || sourceIdentity.byteStart === null || sourceIdentity.byteEnd === null
      || sourceIdentity.byteEnd <= sourceIdentity.byteStart || !sourceIdentity.contentHash || !sourceIdentity.fileHash
      ? ['formal_claim_canonical_manuscript_source_missing'] : []),
    ...(!review ? ['formal_semantic_review_missing'] : []),
    ...(review && review.status !== 'formal_semantic_review_verified' ? ['formal_semantic_review_not_verified'] : []),
    ...(review && review.semanticEquivalenceVerified !== true ? ['formal_semantic_equivalence_not_verified'] : []),
    ...(review && !review.reviewReceiptHash ? ['formal_semantic_review_receipt_missing'] : []),
    ...(review && (!review.reviewerId || !review.authorId || review.reviewerId === review.authorId) ? ['formal_semantic_review_independence_invalid'] : []),
    ...(review && (!review.reviewEnvelopeHash || !review.reviewNodeId || !review.reviewAttemptId
      || !review.reviewAgentReceiptHash || !review.authorNodeId || !review.authorAgentReceiptHash)
      ? ['formal_semantic_review_execution_authority_missing'] : []),
    ...(review && (!review.reviewedManuscriptHash || !review.reviewedWorkerPlanHash)
      ? ['formal_semantic_review_input_binding_missing'] : []),
    ...(review && Boolean(review.proposalClaimToTheoremBindingHash)
      !== Boolean(review.proposalClaimRecordHash)
      ? ['formal_proposal_claim_lineage_incomplete'] : []),
  ];
  const payload = {
    version: 1,
    kind: 'FormalClaimContract',
    status: blockers.length ? 'formal_claim_contract_blocked' : 'formal_claim_contract_verified',
    claimId: normalizedClaimId || null,
    claimText: normalizedText(claimText),
    sourceLocator: sourceLocator ? String(sourceLocator).trim() : null,
    manuscriptClaimHash: computedManuscriptClaimHash,
    manuscriptSourceIdentity: sourceIdentity,
    theoremName: normalizedTheoremName || null,
    theoremTypeHash: theoremTypeHash || null,
    sourceStatementHash: sourceStatementHash || null,
    proofObligations: obligations,
    proofObligationContracts: obligationMapping.contracts,
    proofObligationMappings: obligationMapping.mappings,
    theoremSpecificationHash: theoremSpecificationHash || null,
    theoremSpecificationClaimHash: theoremSpecificationClaimHash || null,
    semanticReview: review,
    blockers,
  };
  return Object.freeze({ ...payload, formalClaimContractHash: hashRecord('FormalClaimContract', payload) });
}

export function verifyFormalClaimContract(contract, expected = {}) {
  const blockers = [];
  const { formalClaimContractHash, ...payload } = contract || {};
  if (!contract || contract.kind !== 'FormalClaimContract' || hashRecord('FormalClaimContract', payload) !== formalClaimContractHash) {
    blockers.push('formal_claim_contract_hash_invalid');
  }
  if (contract?.status !== 'formal_claim_contract_verified' || contract?.blockers?.length) blockers.push('formal_claim_contract_not_verified');
  const expectedValues = {
    claimId: expected.claimId,
    manuscriptClaimHash: expected.manuscriptClaimHash,
    theoremName: expected.theoremName,
    theoremTypeHash: expected.theoremTypeHash,
    sourceStatementHash: expected.sourceStatementHash,
    theoremSpecificationHash: expected.theoremSpecificationHash,
    theoremSpecificationClaimHash: expected.theoremSpecificationClaimHash,
  };
  for (const [field, value] of Object.entries(expectedValues)) {
    if (value && contract?.[field] !== value) blockers.push(`formal_claim_contract_${field}_mismatch`);
  }
  const expectedObligations = normalizedStrings(expected.proofObligations);
  if (expectedObligations.length && JSON.stringify(contract?.proofObligations || []) !== JSON.stringify(expectedObligations)) {
    blockers.push('formal_claim_contract_proof_obligations_mismatch');
  }
  const expectedMapping = normalizeFormalProofObligationMappings({
    proofObligationContracts: expected.proofObligationContracts,
    proofObligations: expected.proofObligations,
    proofObligationMappings: expected.proofObligationMappings,
    theoremName: expected.theoremName,
  });
  if (expectedObligations.length && (!expectedMapping.valid
    || JSON.stringify(contract?.proofObligationContracts || []) !== JSON.stringify(expectedMapping.contracts)
    || JSON.stringify(contract?.proofObligationMappings || []) !== JSON.stringify(expectedMapping.mappings))) {
    blockers.push('formal_claim_contract_proof_obligation_mapping_mismatch');
  }
  const review = contract?.semanticReview;
  if (!review || review.status !== 'formal_semantic_review_verified' || review.semanticEquivalenceVerified !== true
    || !review.reviewReceiptHash || !review.reviewerId || !review.authorId || review.reviewerId === review.authorId) {
    blockers.push('formal_claim_contract_semantic_review_invalid');
  }
  if (!contract?.manuscriptSourceIdentity?.path
    || !Number.isSafeInteger(contract.manuscriptSourceIdentity.byteStart)
    || !Number.isSafeInteger(contract.manuscriptSourceIdentity.byteEnd)
    || contract.manuscriptSourceIdentity.byteEnd <= contract.manuscriptSourceIdentity.byteStart
    || !contract.manuscriptSourceIdentity.contentHash
    || !contract.manuscriptSourceIdentity.fileHash) {
    blockers.push('formal_claim_contract_canonical_manuscript_source_invalid');
  }
  if (!review?.reviewEnvelopeHash || !review?.reviewNodeId || !review?.reviewAttemptId
    || !review?.reviewAgentReceiptHash || !review?.authorNodeId || !review?.authorAgentReceiptHash
    || !review?.reviewedManuscriptHash || !review?.reviewedWorkerPlanHash) {
    blockers.push('formal_claim_contract_semantic_review_authority_invalid');
  }
  if (expected.proposalClaimToTheoremBindingHash
    && review?.proposalClaimToTheoremBindingHash !== expected.proposalClaimToTheoremBindingHash) {
    blockers.push('formal_claim_contract_proposal_binding_mismatch');
  }
  if (expected.proposalClaimRecordHash
    && review?.proposalClaimRecordHash !== expected.proposalClaimRecordHash) {
    blockers.push('formal_claim_contract_proposal_claim_mismatch');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length ? 'formal_claim_contract_verification_blocked' : 'formal_claim_contract_verification_verified',
    formalClaimContractHash: formalClaimContractHash || null,
    blockers: [...new Set(blockers)],
  });
}
