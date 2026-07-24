import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { verifyAgentExecutionReceipt } from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  verifyExternalResearchReplayReceipt,
  verifyExternalResearchReplayRequest,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import {
  reviewerReceiptSigningSubject,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import {
  verifyDynamicFormalExecutionAuthority,
} from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import {
  readFormalSemanticReviewAgentDocument,
} from '../../paper-adapters/automation/campaign-formal-review-envelope.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formalReceiptHashValid(receipt) {
  const {
    campaignFormalVerificationReceiptHash: claimedHash,
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...payload
  } = receipt || {};
  return receipt?.version === 1
    && receipt?.kind === 'CampaignFormalVerificationReceipt'
    && receipt?.status === 'campaign_formal_verification_completed'
    && hashRecord('CampaignFormalVerificationReceipt', payload) === claimedHash;
}

function formalReviewAuthorityValid({
  receipt,
  formalNode,
  plan,
  currentDynamicFormalExecutionAuthority,
  reviewerReceiptVerificationAuthority,
} = {}) {
  if (!formalReceiptHashValid(receipt)
    || formalNode?.node_status !== 'completed'
    || formalNode?.node_kind !== 'formal-verify'
    || receipt.campaignId !== formalNode.campaign_id
    || receipt.paperId !== formalNode.paper_id
    || receipt.formalNodeId !== formalNode.node_id
    || receipt.formalAttemptId !== formalNode.attempt_id
    || receipt.formalLeaseGeneration !== formalNode.lease_generation
    || receipt.campaignResearchVerificationInputHash
      !== plan?.researchVerificationInput?.campaignResearchVerificationInputHash
    || !verifyDynamicFormalExecutionAuthority(currentDynamicFormalExecutionAuthority)
    || !sameJson(
      receipt.dynamicFormalExecutionAuthority,
      currentDynamicFormalExecutionAuthority,
    )
    || receipt.formalReplayReceiptHashes?.length < 1
    || !receipt.formalReplayReceiptHashes.every((value) => (
      /^sha256:[0-9a-f]{64}$/.test(String(value || ''))
    ))) return false;

  const reviewReceipt = receipt.formalReviewAgentReceipt;
  const reviewEnvelope = receipt.formalReviewEnvelope;
  const signedReceipt = reviewReceipt?.signedReviewerReceipt;
  const authorReceipts = Array.isArray(receipt.formalAuthorAgentReceipts)
    ? receipt.formalAuthorAgentReceipts : [];
  const {
    formalSemanticReviewEnvelopeHash: envelopeHash,
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...envelopePayload
  } = reviewEnvelope || {};
  if (!verifyAgentExecutionReceipt(reviewReceipt)
    || !authorReceipts.length
    || authorReceipts.some((candidate) => !verifyAgentExecutionReceipt(candidate))
    || receipt.formalReviewAgentReceiptHash !== reviewReceipt.agentExecutionReceiptHash
    || receipt.formalAuthorAgentReceiptHash
      !== authorReceipts.at(-1)?.agentExecutionReceiptHash
    || reviewEnvelope?.status !== 'formal_semantic_review_envelope_verified'
    || hashPaperRecord('FormalClaimSemanticReviewEnvelope', envelopePayload) !== envelopeHash
    || receipt.formalReviewEnvelopeHash !== envelopeHash
    || reviewEnvelope.reviewAgentReceiptHash !== reviewReceipt.agentExecutionReceiptHash
    || reviewEnvelope.authorAgentReceiptHash
      !== authorReceipts.at(-1)?.agentExecutionReceiptHash
    || !reviewEnvelope.reviewerPrincipalId
    || !reviewEnvelope.authorPrincipalId
    || reviewEnvelope.reviewerPrincipalId === reviewEnvelope.authorPrincipalId
    || reviewEnvelope.reviewerIndependenceAssuranceScope
      !== 'signed_configured_identity_credential_root_and_signer_separation'
    || reviewEnvelope.providerAccountIndependenceVerified !== false
    || signedReceipt?.version !== 2
    || signedReceipt?.cryptographicAuthorityReady !== true
    || signedReceipt?.identityIndependenceReady !== true
    || reviewReceipt.reviewerCryptographicAuthorityReady !== true
    || reviewReceipt.reviewerIdentityIndependenceReady !== true
    || reviewReceipt.signedReviewerReceiptHash !== signedReceipt.signedReviewerReceiptHash
    || reviewEnvelope.signedReviewerReceiptHash !== signedReceipt.signedReviewerReceiptHash
    || reviewerReceiptVerificationAuthority?.version !== 2
    || reviewerReceiptVerificationAuthority?.cryptographicAuthorityReady !== true
    || reviewerReceiptVerificationAuthority?.identityIndependenceReady !== true
    || reviewerReceiptVerificationAuthority?.researchPrincipalPoolHash
      !== plan?.autonomousResearchPreparation?.researchPrincipalPoolHash
    || reviewReceipt.researchPrincipalPoolHash
      !== reviewerReceiptVerificationAuthority.researchPrincipalPoolHash
    || reviewReceipt.reviewerTrustSetHash
      !== reviewerReceiptVerificationAuthority.reviewerTrustSetHash
    || reviewReceipt.reviewerSignatureVerificationPolicyHash
      !== reviewerReceiptVerificationAuthority.reviewerSignatureVerificationPolicyHash
    || typeof reviewerReceiptVerificationAuthority.verifySignedReviewerReceipt !== 'function') {
    return false;
  }
  let subjectHash = null;
  try {
    subjectHash = reviewerReceiptSigningSubject({
      unsignedAgentExecutionReceiptHash: reviewReceipt.unsignedAgentExecutionReceiptHash,
      principalDescriptorHash: reviewReceipt.reviewPrincipalDescriptorHash,
      researchPrincipalPoolHash: reviewReceipt.researchPrincipalPoolHash,
    });
  } catch { return false; }
  const signedVerified = reviewerReceiptVerificationAuthority.verifySignedReviewerReceipt({
    receipt: signedReceipt,
    expected: {
      subjectHash,
      principalId: reviewReceipt.reviewPrincipalId,
      principalDescriptorHash: reviewReceipt.reviewPrincipalDescriptorHash,
      researchPrincipalPoolHash: reviewReceipt.researchPrincipalPoolHash,
      signerIdentityHash: reviewReceipt.reviewerSignerIdentityHash,
    },
  }) === true;
  const agentDocument = readFormalSemanticReviewAgentDocument(reviewReceipt, {
    proposalLineageRequired: Boolean(reviewEnvelope.proposalClaimToTheoremBindingHash),
  });
  const scientificClaimAuthority = plan?.scientificClaimAuthority || null;
  return signedVerified
    && agentDocument.blockers.length === 0
    && agentDocument.theoremSpecificationHash === receipt.theoremSpecificationHash
    && agentDocument.theoremSpecificationHash === reviewEnvelope.theoremSpecificationHash
    && sameJson(agentDocument.reviews, reviewEnvelope.reviews)
    && scientificClaimAuthority?.claimAuthorityType === reviewEnvelope.claimAuthorityType
    && scientificClaimAuthority?.autonomousResearchSeedBindingHash
      === reviewEnvelope.claimAuthorityBindingHash
    && scientificClaimAuthority?.seedBundleHash
      === reviewEnvelope.claimAuthorityBundleHash;
}

function researchReplayAuthorityValid({
  result,
  researchNode,
  formalReceipt,
  expectedExperimentIrExecutionAuthorityInspection,
  externalResearchReplayReceiptVerifier,
} = {}) {
  const report = result?.report;
  const request = report?.capabilities?.externalReplayRequest || null;
  const receipt = report?.capabilities?.externalReplayReceipt || null;
  const experimentAuthority = expectedExperimentIrExecutionAuthorityInspection?.receipt;
  const experimentReplay = expectedExperimentIrExecutionAuthorityInspection
    ?.experimentReplayReceipt;
  const expectedExperimentPair = Object.freeze({
    originalExperimentRunReceiptHash:
      experimentAuthority?.originalExperimentRunReceiptHash || null,
    localReplayExperimentRunReceiptHash:
      experimentAuthority?.replayExperimentRunReceiptHash || null,
    localReplayObservationManifestHash:
      experimentReplay?.replayRunReceipt?.observationManifestHash || null,
  });
  const { researchReportHash: reportHash, ...reportPayload } = report || {};
  return result?.version === 1
    && result?.kind === 'CampaignResearchVerificationResult'
    && result?.status === 'campaign_research_verification_completed'
    && researchNode?.node_status === 'completed'
    && researchNode?.node_kind === 'research-verify'
    && result.campaignId === researchNode.campaign_id
    && result.paperId === researchNode.paper_id
    && result.formalVerificationReceiptHash
      === formalReceipt?.campaignFormalVerificationReceiptHash
    && result.researchReportHash === reportHash
    && hashPaperRecord('PaperResearchVerifyReport', reportPayload) === reportHash
    && report?.externalReplayVerified === true
    && report?.promotionEligibility?.status === 'research_promotion_ready'
    && report?.externalReplayRequestHash === request?.requestHash
    && report?.externalResearchReplayReceiptHash
      === receipt?.externalResearchReplayReceiptHash
    && result.externalReplayRequestHash === request?.requestHash
    && result.externalResearchReplayReceiptHash
      === receipt?.externalResearchReplayReceiptHash
    && verifyExternalResearchReplayRequest(request)
    && request.paperId === researchNode.paper_id
    && request.campaignId === researchNode.campaign_id
    && request.experimentPairs?.length === 1
    && sameJson(request.experimentPairs[0], expectedExperimentPair)
    && sameJson(
      request.formalReplayReceiptHashes,
      [...formalReceipt.formalReplayReceiptHashes].sort(),
    )
    && externalResearchReplayReceiptVerifier?.kind
      === 'ExternalResearchReplayReceiptVerifier'
    && externalResearchReplayReceiptVerifier?.cryptographicAuthorityReady === true
    && externalResearchReplayReceiptVerifier?.identityIndependenceReady === true
    && receipt?.version === 3
    && receipt?.cryptographicAuthorityReady === true
    && receipt?.identityIndependenceReady === true
    && receipt?.configurationHash
      === externalResearchReplayReceiptVerifier.configurationHash
    && receipt?.trustSetHash === externalResearchReplayReceiptVerifier.trustSetHash
    && receipt?.signatureVerificationPolicyHash
      === externalResearchReplayReceiptVerifier.signatureVerificationPolicyHash
    && verifyExternalResearchReplayReceipt(receipt, {
      request,
      cryptographicVerifier: externalResearchReplayReceiptVerifier,
    });
}

function inspectedCandidate({
  planRow,
  formalNode,
  researchNode,
  expectedAgendaAuthorityInspection,
  expectedExperimentIrExecutionAuthorityInspection,
  currentDynamicFormalExecutionAuthority,
  externalResearchReplayReceiptVerifier,
  reviewerReceiptVerificationAuthority,
} = {}) {
  const plan = parseJson(planRow?.spec_json);
  const formalReceipt = parseJson(formalNode?.result_json);
  const researchResult = parseJson(researchNode?.result_json);
  const { campaignPlanHash: planHash, ...planPayload } = plan || {};
  if (plan?.kind !== 'PaperCampaignPlan'
    || plan?.autonomousResearchPreparation?.launchMode !== 'production-run'
    || hashRecord('PaperCampaignPlan', planPayload) !== planHash
    || planRow.campaign_id !== expectedAgendaAuthorityInspection?.campaignId
    || planRow.paper_id !== expectedAgendaAuthorityInspection?.paperId
    || planHash !== expectedAgendaAuthorityInspection?.campaignPlanHash
    || expectedExperimentIrExecutionAuthorityInspection?.ready !== true
    || expectedExperimentIrExecutionAuthorityInspection.campaignId !== planRow.campaign_id
    || expectedExperimentIrExecutionAuthorityInspection.paperId !== planRow.paper_id
    || expectedExperimentIrExecutionAuthorityInspection.campaignPlanHash !== planHash
    || plan.autonomousResearchPreparation?.researchAgendaIr?.researchAgendaIrHash
      !== expectedAgendaAuthorityInspection?.researchAgendaIr?.researchAgendaIrHash
    || hashRecord('PaperCampaignNodeResult', formalReceipt)
      !== formalNode?.result_sha256
    || hashRecord('PaperCampaignNodeResult', researchResult)
      !== researchNode?.result_sha256
    || !formalReviewAuthorityValid({
      receipt: formalReceipt,
      formalNode,
      plan,
      currentDynamicFormalExecutionAuthority,
      reviewerReceiptVerificationAuthority,
    })
    || !researchReplayAuthorityValid({
      result: researchResult,
      researchNode,
      formalReceipt,
      expectedExperimentIrExecutionAuthorityInspection,
      externalResearchReplayReceiptVerifier,
    })) return null;
  return Object.freeze({
    campaignId: planRow.campaign_id,
    paperId: planRow.paper_id,
    campaignPlanHash: planHash,
    researchAgendaIrHash:
      expectedAgendaAuthorityInspection.researchAgendaIr.researchAgendaIrHash,
    dynamicFormalExecutionAuthorityHash:
      currentDynamicFormalExecutionAuthority.dynamicFormalExecutionAuthorityHash,
    formalNodeId: formalNode.node_id,
    researchNodeId: researchNode.node_id,
    externalResearchReplayRequest:
      researchResult.report.capabilities.externalReplayRequest,
    externalResearchReplayReceipt:
      researchResult.report.capabilities.externalReplayReceipt,
    independentFormalReviewReceipt: formalReceipt,
  });
}

export function inspectPersistedAutonomousResearchAssuranceAuthority({
  store,
  expectedAgendaAuthorityInspection = null,
  expectedExperimentIrExecutionAuthorityInspection = null,
  currentDynamicFormalExecutionAuthority = null,
  externalResearchReplayReceiptVerifier = null,
  reviewerReceiptVerificationAuthority = null,
} = {}) {
  const configured = expectedAgendaAuthorityInspection?.ready === true
    && expectedExperimentIrExecutionAuthorityInspection?.ready === true
    && expectedExperimentIrExecutionAuthorityInspection.campaignId
      === expectedAgendaAuthorityInspection.campaignId
    && expectedExperimentIrExecutionAuthorityInspection.paperId
      === expectedAgendaAuthorityInspection.paperId
    && expectedExperimentIrExecutionAuthorityInspection.campaignPlanHash
      === expectedAgendaAuthorityInspection.campaignPlanHash
    && verifyDynamicFormalExecutionAuthority(currentDynamicFormalExecutionAuthority)
    && externalResearchReplayReceiptVerifier?.kind
      === 'ExternalResearchReplayReceiptVerifier'
    && reviewerReceiptVerificationAuthority?.version === 2
    && reviewerReceiptVerificationAuthority?.cryptographicAuthorityReady === true
    && reviewerReceiptVerificationAuthority?.identityIndependenceReady === true;
  const unavailable = (blocker) => Object.freeze({
    status: 'autonomous_research_assurance_authority_unavailable',
    ready: false,
    statusReadOnly: true,
    campaignId: null,
    paperId: null,
    campaignPlanHash: null,
    researchAgendaIrHash: null,
    dynamicFormalExecutionAuthorityHash: null,
    formalNodeId: null,
    researchNodeId: null,
    externalResearchReplayRequest: null,
    externalResearchReplayReceipt: null,
    independentFormalReviewReceipt: null,
    blockers: Object.freeze([blocker]),
  });
  if (!configured) {
    return unavailable('autonomous_research_assurance_current_authorities_required');
  }
  const campaignId = expectedAgendaAuthorityInspection.campaignId;
  const query = store?.query?.(`SELECT
      c.campaign_id,c.paper_id,c.spec_json,
      n.node_id,n.kind AS node_kind,n.status AS node_status,n.attempt_id,
      n.lease_generation,n.result_json,n.result_sha256,n.updated_at
    FROM campaign_nodes n
    JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    WHERE n.status='completed' AND n.kind IN ('formal-verify','research-verify')
    ORDER BY n.updated_at DESC,n.node_id ASC LIMIT 512;`);
  if (!query?.ok) {
    return unavailable('autonomous_research_assurance_authority_query_failed');
  }
  const rows = query.rows.filter((row) => row.campaign_id === campaignId);
  const planRow = rows[0] || null;
  let authority = null;
  for (const researchNode of rows.filter((row) => row.node_kind === 'research-verify')) {
    const researchResult = parseJson(researchNode.result_json);
    const formalHash = researchResult?.formalVerificationReceiptHash || null;
    const formalNode = rows.find((row) => {
      if (row.node_kind !== 'formal-verify') return false;
      return parseJson(row.result_json)?.campaignFormalVerificationReceiptHash === formalHash;
    });
    if (!formalNode) continue;
    try {
      authority = inspectedCandidate({
        planRow,
        formalNode,
        researchNode,
        expectedAgendaAuthorityInspection,
        expectedExperimentIrExecutionAuthorityInspection,
        currentDynamicFormalExecutionAuthority,
        externalResearchReplayReceiptVerifier,
        reviewerReceiptVerificationAuthority,
      });
    } catch { authority = null; }
    if (authority) break;
  }
  return Object.freeze({
    status: authority
      ? 'autonomous_research_assurance_authority_verified'
      : 'autonomous_research_assurance_authority_not_persisted',
    ready: Boolean(authority),
    statusReadOnly: true,
    campaignId: authority?.campaignId || null,
    paperId: authority?.paperId || null,
    campaignPlanHash: authority?.campaignPlanHash || null,
    researchAgendaIrHash: authority?.researchAgendaIrHash || null,
    dynamicFormalExecutionAuthorityHash:
      authority?.dynamicFormalExecutionAuthorityHash || null,
    formalNodeId: authority?.formalNodeId || null,
    researchNodeId: authority?.researchNodeId || null,
    externalResearchReplayRequest:
      authority?.externalResearchReplayRequest || null,
    externalResearchReplayReceipt:
      authority?.externalResearchReplayReceipt || null,
    independentFormalReviewReceipt:
      authority?.independentFormalReviewReceipt || null,
    blockers: Object.freeze(authority
      ? [] : ['autonomous_research_assurance_authority_not_persisted']),
  });
}
