import { verifyCampaignResearchSourceSnapshot } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { verifyAgentExecutionReceipt } from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyNativeResearchWorkerExecutionReport } from '../research-verify/worker-runtime.mjs';
import { verifyProposalClaimToTheoremBinding } from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import { readFormalSemanticReviewAgentDocument } from './campaign-formal-review-envelope.mjs';

export function validCampaignFormalAgentReceipt(receipt) {
  return verifyAgentExecutionReceipt(receipt);
}

export function verifyFormalReviewAgentReceiptBinding({ receipt, reviewEnvelope, theoremSpecification } = {}) {
  const blockers = [];
  if (!validCampaignFormalAgentReceipt(receipt)) {
    blockers.push('formal_review_agent_receipt_invalid');
    return Object.freeze({ valid: false, authoritativeReviews: Object.freeze([]), blockers: Object.freeze(blockers) });
  }
  const agentDocument = readFormalSemanticReviewAgentDocument(receipt, {
    proposalLineageRequired: theoremSpecification?.proposalClaimLineageRequired === true,
  });
  blockers.push(...agentDocument.blockers.map((blocker) => `formal_review_agent_document:${blocker}`));
  if (agentDocument.theoremSpecificationHash !== theoremSpecification?.theoremSpecificationHash) {
    blockers.push('formal_review_agent_theorem_specification_mismatch');
  }
  if (JSON.stringify(agentDocument.reviews) !== JSON.stringify(reviewEnvelope?.reviews || [])) {
    blockers.push('formal_review_agent_envelope_reviews_mismatch');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    authoritativeReviews: agentDocument.reviews,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function verifyTheoremSpecificationNodeResult(node, theoremSpecification) {
  const blockers = [];
  if (!node || node.kind !== 'theorem-spec' || node.status !== 'completed' || !node.result
    || hashRecord('PaperCampaignNodeResult', node.result) !== node.resultSha256) {
    blockers.push('campaign_theorem_specification_store_evidence_invalid');
    return blockers;
  }
  const {
    campaignTheoremSpecificationResultHash: claimedHash,
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...payload
  } = node.result;
  if (node.result.kind !== 'CampaignTheoremSpecificationResult'
    || node.result.status !== 'campaign_theorem_specification_completed'
    || !claimedHash
    || hashRecord('CampaignTheoremSpecificationResult', payload) !== claimedHash) {
    blockers.push('campaign_theorem_specification_result_invalid');
  }
  const finalization = node.result.theoremSpecificationFinalizationReceipt;
  const {
    theoremSpecificationFinalizationReceiptHash: finalizationHash,
    ...finalizationPayload
  } = finalization || {};
  if (!finalizationHash
    || hashRecord('TheoremSpecificationFinalizationReceipt', finalizationPayload) !== finalizationHash
    || finalizationHash !== node.result.theoremSpecificationFinalizationReceiptHash) {
    blockers.push('campaign_theorem_specification_finalization_receipt_invalid');
  }
  if (!validCampaignFormalAgentReceipt(node.result.theoremSpecificationAgentReceipt)
    || node.result.agentExecutionReceiptHash !== node.result.theoremSpecificationAgentReceipt?.agentExecutionReceiptHash) {
    blockers.push('campaign_theorem_specification_agent_receipt_invalid');
  }
  if (node.result.theoremSpecificationHash !== theoremSpecification?.theoremSpecificationHash
    || node.result.sourceManuscriptHash !== theoremSpecification?.sourceManuscriptHash
    || node.result.formalClaimUniverseHash !== theoremSpecification?.formalClaimUniverseHash
    || Number(node.result.claimCount) !== Number(theoremSpecification?.claimCount)) {
    blockers.push('campaign_theorem_specification_result_binding_invalid');
  }
  const expectedProposalClaimRecordHashes = (theoremSpecification?.claims || [])
    .map((claim) => claim.proposalClaimSource?.proposalClaimRecordHash).filter(Boolean);
  if (node.result.claimAuthorityType !== theoremSpecification?.claimAuthorityType
    || node.result.claimAuthorityBindingHash !== theoremSpecification?.claimAuthorityBindingHash
    || node.result.claimAuthorityBundleHash !== theoremSpecification?.claimAuthorityBundleHash
    || node.result.approvedProposalSeedBindingHash !== theoremSpecification?.approvedProposalSeedBindingHash
    || node.result.proposalSeedContractBundleHash !== theoremSpecification?.proposalSeedContractBundleHash
    || JSON.stringify(node.result.proposalClaimRecordHashes || [])
      !== JSON.stringify(expectedProposalClaimRecordHashes)) {
    blockers.push('campaign_theorem_specification_proposal_lineage_invalid');
  }
  return blockers;
}

export function proposalLineageReviewBlockers(theoremSpecification, reviewEnvelope) {
  if (theoremSpecification?.proposalClaimLineageRequired !== true) return [];
  return reviewEnvelope?.proposalClaimToTheoremBindingHash
    && reviewEnvelope?.claimAuthorityType === theoremSpecification.claimAuthorityType
    && reviewEnvelope?.claimAuthorityBindingHash === theoremSpecification.claimAuthorityBindingHash
    && reviewEnvelope?.claimAuthorityBundleHash === theoremSpecification.claimAuthorityBundleHash
    && reviewEnvelope?.approvedProposalSeedBindingHash === theoremSpecification.approvedProposalSeedBindingHash
    && reviewEnvelope?.proposalSeedContractBundleHash === theoremSpecification.proposalSeedContractBundleHash
    ? [] : ['campaign_formal_candidate_proposal_lineage_invalid'];
}

export function assertCompletedCampaignFormalNode(node) {
  if (!node || node.kind !== 'formal-verify' || node.status !== 'completed' || !node.attemptId
    || !Number.isInteger(node.leaseGeneration) || node.leaseGeneration < 1 || !node.result || !node.resultSha256
    || hashRecord('PaperCampaignNodeResult', node.result) !== node.resultSha256) {
    throw new Error('campaign_formal_verification_store_evidence_invalid');
  }
  return node;
}

export function verifyCampaignFormalReceipt(receipt, {
  campaign,
  formalNode,
  sourceSnapshot,
  paperTask,
  theoremSpecification,
} = {}) {
  const blockers = [];
  const {
    campaignFormalVerificationReceiptHash: claimedHash,
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...payload
  } = receipt || {};
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'CampaignFormalVerificationReceipt') {
    blockers.push('campaign_formal_verification_receipt_shape_invalid');
  }
  if (!claimedHash || hashRecord('CampaignFormalVerificationReceipt', payload) !== claimedHash) {
    blockers.push('campaign_formal_verification_receipt_hash_invalid');
  }
  if (receipt?.status !== 'campaign_formal_verification_completed') {
    blockers.push('campaign_formal_verification_receipt_not_completed');
  }
  for (const [field, expected, blocker] of [
    ['campaignId', campaign?.campaignId, 'campaign_formal_verification_campaign_mismatch'],
    ['paperId', campaign?.paperId, 'campaign_formal_verification_paper_mismatch'],
    ['formalNodeId', formalNode?.nodeId, 'campaign_formal_verification_node_mismatch'],
    ['formalAttemptId', formalNode?.attemptId, 'campaign_formal_verification_attempt_mismatch'],
    ['formalLeaseGeneration', formalNode?.leaseGeneration, 'campaign_formal_verification_lease_mismatch'],
    ['campaignResearchVerificationInputHash', campaign?.spec?.researchVerificationInput?.campaignResearchVerificationInputHash, 'campaign_formal_verification_input_mismatch'],
    ['theoremSpecificationHash', theoremSpecification?.theoremSpecificationHash, 'campaign_formal_verification_theorem_specification_mismatch'],
    ['formalClaimUniverseHash', theoremSpecification?.formalClaimUniverseHash, 'campaign_formal_verification_claim_universe_mismatch'],
    ['verifiedSourceMerkleHash', sourceSnapshot?.verifiedSourceMerkleHash, 'campaign_formal_verification_source_merkle_mismatch'],
    ['verifiedSourceWorkspaceManifestHash', sourceSnapshot?.verifiedSourceWorkspaceManifestHash, 'campaign_formal_verification_source_manifest_mismatch'],
  ]) if (expected && receipt?.[field] !== expected) blockers.push(blocker);
  const snapshotVerification = verifyCampaignResearchSourceSnapshot(receipt?.campaignFormalSourceSnapshot, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    researchNodeId: formalNode?.nodeId,
    researchAttemptId: formalNode?.attemptId,
    researchLeaseGeneration: formalNode?.leaseGeneration,
    verifiedSourceMerkleHash: sourceSnapshot?.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: sourceSnapshot?.verifiedSourceWorkspaceManifestHash,
  });
  blockers.push(...snapshotVerification.blockers.map((blocker) => `formal_source_snapshot:${blocker}`));
  if (receipt?.campaignFormalSourceSnapshotHash !== receipt?.campaignFormalSourceSnapshot?.campaignResearchSourceSnapshotHash) {
    blockers.push('campaign_formal_verification_source_snapshot_hash_mismatch');
  }
  const workerVerification = verifyNativeResearchWorkerExecutionReport(receipt?.nativeResearchWorkerExecution, {
    paperId: paperTask?.paperId,
    taskKey: paperTask?.taskKey,
    requireFormalWorkers: true,
    theoremSpecificationHash: theoremSpecification?.theoremSpecificationHash || null,
  });
  blockers.push(...workerVerification.blockers.map((blocker) => `formal_worker:${blocker}`));
  if (receipt?.nativeResearchWorkerExecutionReportHash
    !== receipt?.nativeResearchWorkerExecution?.nativeResearchWorkerExecutionReportHash) {
    blockers.push('campaign_formal_verification_worker_report_hash_mismatch');
  }
  const expectedSpecificationClaimHashes = (theoremSpecification?.claims || [])
    .map((claim) => claim.theoremSpecificationClaimHash);
  if (JSON.stringify(receipt?.theoremSpecificationClaimHashes || [])
    !== JSON.stringify(expectedSpecificationClaimHashes)) {
    blockers.push('campaign_formal_verification_theorem_specification_claims_mismatch');
  }
  const authorReceipts = Array.isArray(receipt?.formalAuthorAgentReceipts)
    ? receipt.formalAuthorAgentReceipts
    : [];
  const authorReceiptHashes = authorReceipts.map((item) => item?.agentExecutionReceiptHash || null);
  if (!authorReceipts.length || authorReceipts.some((item) => !validCampaignFormalAgentReceipt(item))
    || JSON.stringify(receipt?.formalAuthorAgentReceiptHashes || []) !== JSON.stringify(authorReceiptHashes)
    || receipt?.formalAuthorAgentReceiptHash !== authorReceiptHashes.at(-1)) {
    blockers.push('campaign_formal_verification_author_receipts_invalid');
  }
  if (!validCampaignFormalAgentReceipt(receipt?.formalReviewAgentReceipt)
    || receipt?.formalReviewAgentReceiptHash !== receipt?.formalReviewAgentReceipt?.agentExecutionReceiptHash) {
    blockers.push('campaign_formal_verification_review_agent_receipt_invalid');
  }
  const reviewEnvelope = receipt?.formalReviewEnvelope;
  const {
    formalSemanticReviewEnvelopeHash: reviewEnvelopeHash,
    workspaceAttemptIntegration: _reviewWorkspaceAttemptIntegration,
    ...reviewEnvelopePayload
  } = reviewEnvelope || {};
  if (!reviewEnvelopeHash
    || hashPaperRecord('FormalClaimSemanticReviewEnvelope', reviewEnvelopePayload) !== reviewEnvelopeHash
    || reviewEnvelopeHash !== receipt?.formalReviewEnvelopeHash
    || reviewEnvelope?.theoremSpecificationHash !== theoremSpecification?.theoremSpecificationHash
    || reviewEnvelope?.authorAgentReceiptHash !== receipt?.formalAuthorAgentReceiptHash
    || reviewEnvelope?.reviewAgentReceiptHash !== receipt?.formalReviewAgentReceiptHash) {
    blockers.push('campaign_formal_verification_review_envelope_invalid');
  }
  const reviewAgentBinding = verifyFormalReviewAgentReceiptBinding({
    receipt: receipt?.formalReviewAgentReceipt,
    reviewEnvelope,
    theoremSpecification,
  });
  blockers.push(...reviewAgentBinding.blockers.map((blocker) => `campaign_formal_review_authority:${blocker}`));
  if (theoremSpecification?.proposalClaimLineageRequired === true) {
    const proposalVerification = verifyProposalClaimToTheoremBinding(
      receipt?.proposalClaimToTheoremBinding,
      {
        paperId: campaign?.paperId,
        campaignId: campaign?.campaignId,
        theoremSpecificationHash: theoremSpecification?.theoremSpecificationHash,
        approvedProposalSeedBindingHash: theoremSpecification?.approvedProposalSeedBindingHash,
        proposalSeedContractBundleHash: theoremSpecification?.proposalSeedContractBundleHash,
        claimAuthorityType: theoremSpecification?.claimAuthorityType,
        claimAuthorityBindingHash: theoremSpecification?.claimAuthorityBindingHash,
        claimAuthorityBundleHash: theoremSpecification?.claimAuthorityBundleHash,
        reviewAgentReceiptHash: receipt?.formalReviewAgentReceiptHash,
        reviewerPrincipalId: reviewEnvelope?.reviewerPrincipalId,
        theoremSpecification,
        reviews: reviewAgentBinding.authoritativeReviews,
      },
    );
    blockers.push(...proposalVerification.blockers.map((blocker) => `campaign_formal_proposal_lineage:${blocker}`));
    if (receipt?.proposalClaimToTheoremBindingHash
      !== proposalVerification.proposalClaimToTheoremBindingHash
      || receipt?.proposalClaimToTheoremBindingHash
      !== reviewEnvelope?.proposalClaimToTheoremBindingHash
      || JSON.stringify(receipt?.proposalClaimToTheoremBinding)
        !== JSON.stringify(reviewEnvelope?.proposalClaimToTheoremBinding)) {
      blockers.push('campaign_formal_verification_proposal_lineage_binding_invalid');
    }
  } else if (receipt?.proposalClaimToTheoremBindingHash || receipt?.proposalClaimToTheoremBinding) {
    blockers.push('campaign_formal_verification_unexpected_proposal_lineage');
  }
  const verificationIteration = Number(receipt?.formalVerificationIteration);
  const repairHistory = Array.isArray(receipt?.formalRepairHistory) ? receipt.formalRepairHistory : [];
  if (!Number.isSafeInteger(verificationIteration) || verificationIteration < 0 || verificationIteration > 2
    || Number(receipt?.formalRepairCount) !== verificationIteration
    || authorReceipts.length !== verificationIteration + 1
    || repairHistory.length !== verificationIteration
    || repairHistory.some((entry, index) => entry?.iteration !== index
      || entry?.authorAgentReceiptHash !== authorReceiptHashes[index]
      || !entry?.reviewAgentReceiptHash || !entry?.formalReviewEnvelopeHash)) {
    blockers.push('campaign_formal_verification_repair_history_invalid');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}
