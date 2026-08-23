import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { verifyAgentExecutionReceipt } from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  verifyExternalResearchReplayReceipt,
  verifyExternalResearchReplayRequest,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import { reviewerReceiptSigningSubject } from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import { verifyDynamicFormalExecutionAuthority } from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import { readFormalSemanticReviewAgentDocument } from '../../paper-adapters/automation/campaign-formal-review-envelope.mjs';
import { inspectGpuScientificArtifactBodyArchiveSourceSync } from '../../paper-adapters/build-package/gpu-scientific-artifact-body-archive.mjs';
import { verifyCampaignResearchGpuScientificEvidence } from '../../paper-domain/automation/campaign-research-gpu-scientific-evidence-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  ASSURANCE_AUTHORITY_QUERY,
  blockGpuScientificInspection,
  blockGpuScientificInspectionSnapshot,
  gpuScientificCampaignSnapshotBlockers,
  gpuScientificInspectionMatchesResearchNode,
  inspectAutomationReadinessCanonicalAuthorityRows,
  parseAutomationReadinessJson as parseJson,
  sameAutomationReadinessJson as sameJson,
  sameGpuScientificInspectionSnapshot,
} from './automation-readiness-gpu-scientific-snapshot-binding.mjs';
import {
  automationReadinessExperimentInspectionMatchesRows,
  inspectAutomationReadinessCanonicalExperimentRows,
} from './automation-readiness-experiment-ir-authority-inspection.mjs';

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

export function inspectCampaignResearchGpuScientificReleaseChain({
  campaign,
  formalNode,
  gpuNode,
  executionPlan,
  researchNode,
  researchResult,
  runtimeRoot,
  gpuScientificPromotionAuthorityVerifier = null,
  now = new Date(),
} = {}) {
  const blockers = [];
  const evidence = researchResult?.gpuScientificQualificationEvidence || null;
  const researchLeaseGeneration = Number(researchNode?.leaseGeneration);
  if (!executionPlan) blockers.push('gpu_scientific_execution_plan_required');
  if (!gpuNode) blockers.push('gpu_scientific_completed_node_required');
  if (!evidence) blockers.push('gpu_scientific_research_evidence_required');
  if (!runtimeRoot) blockers.push('gpu_scientific_archive_runtime_root_required');
  if (!researchNode?.nodeId || !researchNode?.attemptId
    || !Number.isSafeInteger(researchLeaseGeneration)
    || researchLeaseGeneration < 0
    || !researchNode?.resultSha256) {
    blockers.push('gpu_scientific_research_node_identity_required');
  }
  if (researchResult && (researchResult.researchNodeId !== researchNode?.nodeId
    || researchResult.researchAttemptId !== researchNode?.attemptId
    || Number(researchResult.researchLeaseGeneration)
      !== researchLeaseGeneration)) {
    blockers.push('gpu_scientific_research_generation_binding_invalid');
  }
  if (researchNode && (researchNode.resultSha256
      !== hashRecord('PaperCampaignNodeResult', researchResult)
    || researchNode.resultSha256
      !== hashRecord('PaperCampaignNodeResult', researchNode.result))) {
    blockers.push('gpu_scientific_research_result_identity_invalid');
  }
  if (gpuNode && hashRecord('PaperCampaignNodeResult', gpuNode.result)
    !== gpuNode.resultSha256) {
    blockers.push('gpu_scientific_node_result_hash_invalid');
  }
  if (evidence && researchResult?.gpuScientificCampaignExecutionResultHash
    !== evidence.executionResultHash) {
    blockers.push('gpu_scientific_research_execution_result_binding_invalid');
  }
  if (evidence && researchResult?.gpuScientificArtifactBodyArchiveManifestHash
    !== evidence.artifactArchiveManifestHash) {
    blockers.push('gpu_scientific_research_archive_binding_invalid');
  }
  if (evidence && researchResult?.gpuScientificCampaignQualificationEvidenceHash
    !== evidence.qualificationEvidenceHash) {
    blockers.push('gpu_scientific_research_qualification_binding_invalid');
  }
  if (evidence && !verifyCampaignResearchGpuScientificEvidence(evidence, {
    campaign,
    node: gpuNode,
    plan: executionPlan,
  })) blockers.push('gpu_scientific_research_evidence_invalid');
  let producerArchiveInspection = null;
  if (runtimeRoot && executionPlan && gpuNode?.result && evidence) {
    try {
      producerArchiveInspection = inspectGpuScientificArtifactBodyArchiveSourceSync({
        runtimeRoot,
        campaign,
        node: gpuNode,
        executionPlan,
        executionResult: gpuNode.result,
      });
    } catch {
      blockers.push('gpu_scientific_archive_producer_bodies_invalid');
    }
    if (producerArchiveInspection
      && !sameJson(
        producerArchiveInspection.manifest,
        evidence.artifactArchiveManifest,
      )) blockers.push('gpu_scientific_archive_producer_manifest_mismatch');
  }
  let currentAuthorityInspection = null;
  if (typeof gpuScientificPromotionAuthorityVerifier?.verify !== 'function') {
    blockers.push('gpu_scientific_current_authority_verifier_required');
  } else if (evidence) {
    try {
      currentAuthorityInspection =
        gpuScientificPromotionAuthorityVerifier.verify({
          qualificationEvidence: evidence.qualificationEvidence,
          observedAt: now,
        });
    } catch {
      blockers.push('gpu_scientific_current_authority_verification_failed');
    }
    if (currentAuthorityInspection?.valid !== true
      || currentAuthorityInspection?.cryptographicSignaturesVerified !== true
      || currentAuthorityInspection?.qualificationEvidenceHash
        !== evidence.qualificationEvidenceHash) {
      blockers.push('gpu_scientific_current_authority_invalid');
      blockers.push(...(currentAuthorityInspection?.blockers || []).map((blocker) => (
        `gpu_scientific_current_authority:${blocker}`
      )));
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    status: uniqueBlockers.length
      ? 'campaign_research_gpu_scientific_release_chain_blocked'
      : 'campaign_research_gpu_scientific_release_chain_verified',
    ready: uniqueBlockers.length === 0,
    campaignId: campaign?.campaignId || null,
    paperId: campaign?.paperId || null,
    campaignStatus: campaign?.status || null,
    campaignRevision: campaign?.revision ?? null,
    campaignPlanHash: campaign?.spec?.campaignPlanHash || null,
    researchNodeId: researchNode?.nodeId || null,
    researchAttemptId: researchNode?.attemptId || null,
    researchLeaseGeneration:
      Number.isSafeInteger(researchLeaseGeneration)
        ? researchLeaseGeneration : null,
    researchRoundIndex: researchNode?.roundIndex ?? null,
    researchNodeRevision: researchNode?.nodeRevision ?? null,
    researchNodeStatus: researchNode?.status || null,
    researchResultHash: researchNode?.resultSha256 || null,
    formalNodeId: formalNode?.nodeId || null,
    formalAttemptId: formalNode?.attemptId || null,
    formalLeaseGeneration: formalNode?.leaseGeneration ?? null,
    formalRoundIndex: formalNode?.roundIndex ?? null,
    formalNodeRevision: formalNode?.nodeRevision ?? null,
    formalNodeStatus: formalNode?.status || null,
    formalResultHash: formalNode?.resultSha256 || null,
    nodeId: gpuNode?.nodeId || null,
    nodeAttemptId: gpuNode?.attemptId || null,
    nodeLeaseGeneration: gpuNode?.leaseGeneration ?? null,
    nodeRoundIndex: gpuNode?.roundIndex ?? null,
    nodeRevision: gpuNode?.nodeRevision ?? null,
    nodeStatus: gpuNode?.status || null,
    executionResultHash: evidence?.executionResultHash || null,
    artifactArchiveManifestHash:
      evidence?.artifactArchiveManifestHash || null,
    qualificationEvidenceHash: evidence?.qualificationEvidenceHash || null,
    producerArchiveManifestHash: producerArchiveInspection?.manifest
      ?.gpuScientificArtifactBodyArchiveManifestHash || null,
    gpuScientificCampaignQualificationAuthorityInspectionHash:
      currentAuthorityInspection
        ?.gpuScientificCampaignQualificationAuthorityInspectionHash || null,
    currentAuthorityInspection,
    blockers: uniqueBlockers,
  });
}

function persistedGpuScientificReleaseChainInspection({
  rows,
  campaignId,
  paperId,
  expectedAgendaAuthorityInspection = null,
  gpuScientificPromotionAuthorityVerifier,
  runtimeRoot,
  now,
} = {}) {
  const plan = parseJson(rows?.[0]?.spec_json);
  const { campaignPlanHash: planHash, ...planPayload } = plan || {};
  if (plan?.kind !== 'PaperCampaignPlan'
    || plan?.autonomousResearchPreparation?.launchMode !== 'production-run'
    || plan.campaignId !== campaignId
    || plan.paperId !== paperId
    || hashRecord('PaperCampaignPlan', planPayload) !== planHash) {
    return Object.freeze({
      status: 'campaign_research_gpu_scientific_release_chain_blocked',
      ready: false,
      campaignId: campaignId || null,
      paperId: paperId || null,
      researchNodeId: null,
      researchAttemptId: null,
      researchLeaseGeneration: null,
      researchResultHash: null,
      nodeId: null,
      executionResultHash: null,
      artifactArchiveManifestHash: null,
      qualificationEvidenceHash: null,
      producerArchiveManifestHash: null,
      currentAuthorityInspection: null,
      blockers: Object.freeze([
        'gpu_scientific_production_campaign_plan_invalid',
      ]),
    });
  }
  const authorityRows = inspectAutomationReadinessCanonicalAuthorityRows(
    plan, rows,
  );
  const persistedNode = (selection) => selection.row ? Object.freeze({
    ...selection.planNode,
    nodeId: selection.row.node_id,
    kind: selection.row.node_kind,
    status: selection.row.node_status,
    attemptId: selection.row.attempt_id,
    leaseGeneration: Number(selection.row.lease_generation),
    roundIndex: Number(selection.row.round_index),
    nodeRevision: Number(selection.row.node_revision),
    result: parseJson(selection.row.result_json),
    resultSha256: selection.row.result_sha256,
  }) : null;
  const formalNode = persistedNode(authorityRows.formal);
  const gpuNode = persistedNode(authorityRows.gpu);
  const researchNode = persistedNode(authorityRows.research);
  const researchResult = researchNode?.result || null;
  const evidence = researchResult?.gpuScientificQualificationEvidence || null;
  const inspected = inspectCampaignResearchGpuScientificReleaseChain({
    campaign: Object.freeze({
      campaignId,
      paperId,
      status: rows[0]?.campaign_status || null,
      revision: Number.isSafeInteger(Number(rows[0]?.campaign_revision))
        ? Number(rows[0].campaign_revision) : null,
      spec: plan,
    }),
    formalNode,
    gpuNode,
    executionPlan: plan.gpuScientificExecutionPlan || null,
    researchNode,
    researchResult,
    runtimeRoot,
    gpuScientificPromotionAuthorityVerifier,
    now,
  });
  const blockers = [
    ...authorityRows.blockers,
    ...gpuScientificCampaignSnapshotBlockers({
      row: rows[0],
      planHash,
      campaignId,
      paperId,
      expectedAgendaAuthorityInspection,
    }),
    ...(researchResult?.campaignId === campaignId
      && researchResult?.paperId === paperId
      ? [] : ['gpu_scientific_research_campaign_identity_invalid']),
    ...(evidence && evidence.nodeId !== gpuNode?.nodeId
      ? ['gpu_scientific_research_canonical_gpu_binding_invalid'] : []),
  ];
  return blockers.length
    ? blockGpuScientificInspection(inspected, blockers) : inspected;
}

export function inspectPersistedCampaignResearchGpuScientificReleaseChain({
  store,
  campaignId,
  paperId,
  expectedAgendaAuthorityInspection = null,
  gpuScientificPromotionAuthorityVerifier = null,
  runtimeRoot = null,
  now = new Date(),
} = {}) {
  if (!campaignId || !paperId) return Object.freeze({
    status: 'campaign_research_gpu_scientific_release_chain_blocked',
    ready: false,
    campaignId: campaignId || null,
    paperId: paperId || null,
    researchNodeId: null,
    researchAttemptId: null,
    researchLeaseGeneration: null,
    researchResultHash: null,
    nodeId: null,
    executionResultHash: null,
    artifactArchiveManifestHash: null,
    qualificationEvidenceHash: null,
    producerArchiveManifestHash: null,
    currentAuthorityInspection: null,
    blockers: Object.freeze(['gpu_scientific_persisted_lineage_required']),
  });
  const query = store?.query?.(ASSURANCE_AUTHORITY_QUERY, [campaignId]);
  if (!query?.ok) return Object.freeze({
    status: 'campaign_research_gpu_scientific_release_chain_blocked',
    ready: false,
    campaignId: campaignId || null,
    paperId: paperId || null,
    researchNodeId: null,
    researchAttemptId: null,
    researchLeaseGeneration: null,
    researchResultHash: null,
    nodeId: null,
    executionResultHash: null,
    artifactArchiveManifestHash: null,
    qualificationEvidenceHash: null,
    producerArchiveManifestHash: null,
    currentAuthorityInspection: null,
    blockers: Object.freeze(['gpu_scientific_persisted_authority_query_failed']),
  });
  return persistedGpuScientificReleaseChainInspection({
    rows: query.rows || [],
    campaignId,
    paperId,
    expectedAgendaAuthorityInspection,
    gpuScientificPromotionAuthorityVerifier,
    runtimeRoot,
    now,
  });
}

function inspectedCandidate({
  planRow,
  formalNode,
  researchNode,
  gpuScientificReleaseChainInspection,
  expectedAgendaAuthorityInspection,
  expectedExperimentIrExecutionAuthorityInspection,
  currentDynamicFormalExecutionAuthority,
  externalResearchReplayReceiptVerifier,
  reviewerReceiptVerificationAuthority,
  currentExperimentAuthorityRows,
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
    || !['running', 'completed'].includes(planRow.campaign_status)
    || planRow.campaign_status
      !== expectedAgendaAuthorityInspection?.campaignStatus
    || Number(planRow.campaign_revision)
      !== Number(expectedAgendaAuthorityInspection?.campaignRevision)
    || planHash !== expectedAgendaAuthorityInspection?.campaignPlanHash
    || expectedExperimentIrExecutionAuthorityInspection?.ready !== true
    || expectedExperimentIrExecutionAuthorityInspection.campaignId !== planRow.campaign_id
    || expectedExperimentIrExecutionAuthorityInspection.paperId !== planRow.paper_id
    || expectedExperimentIrExecutionAuthorityInspection.campaignPlanHash !== planHash
    || !automationReadinessExperimentInspectionMatchesRows(
      expectedExperimentIrExecutionAuthorityInspection,
      currentExperimentAuthorityRows,
    )
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
  if (!gpuScientificInspectionMatchesResearchNode(
    gpuScientificReleaseChainInspection,
    researchNode,
    researchResult,
  )) return null;
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
    gpuScientificReleaseChainInspection,
  });
}

export function inspectPersistedAutonomousResearchAssuranceAuthority({
  store,
  expectedAgendaAuthorityInspection = null,
  expectedExperimentIrExecutionAuthorityInspection = null,
  currentDynamicFormalExecutionAuthority = null,
  externalResearchReplayReceiptVerifier = null,
  reviewerReceiptVerificationAuthority = null,
  gpuScientificPromotionAuthorityVerifier = null,
  gpuScientificReleaseChainInspection: suppliedGpuScientificInspection = null,
  runtimeRoot = null,
  now = new Date(),
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
    gpuScientificReleaseChainInspection: suppliedGpuScientificInspection,
    blockers: Object.freeze([
      blocker,
      ...(suppliedGpuScientificInspection?.blockers || []),
    ]),
  });
  if (!configured) {
    return unavailable('autonomous_research_assurance_current_authorities_required');
  }
  const campaignId = expectedAgendaAuthorityInspection.campaignId;
  const query = store?.query?.(ASSURANCE_AUTHORITY_QUERY, [campaignId]);
  if (!query?.ok) {
    return unavailable('autonomous_research_assurance_authority_query_failed');
  }
  const rows = query.rows.filter((row) => row.campaign_id === campaignId);
  const planRow = rows[0] || null;
  const authorityRows = inspectAutomationReadinessCanonicalAuthorityRows(
    parseJson(planRow?.spec_json), rows, { requireFormal: true },
  );
  const currentExperimentAuthorityRows =
    inspectAutomationReadinessCanonicalExperimentRows(
      parseJson(planRow?.spec_json),
      rows,
    );
  let authority = null;
  const currentGpuScientificReleaseChainInspection =
    persistedGpuScientificReleaseChainInspection({
      rows,
      campaignId,
      paperId: expectedAgendaAuthorityInspection.paperId,
      expectedAgendaAuthorityInspection,
      gpuScientificPromotionAuthorityVerifier,
      runtimeRoot,
      now,
    });
  const gpuScientificReleaseChainInspection = suppliedGpuScientificInspection
    && !sameGpuScientificInspectionSnapshot(
      suppliedGpuScientificInspection,
      currentGpuScientificReleaseChainInspection,
    )
    ? blockGpuScientificInspectionSnapshot(
      currentGpuScientificReleaseChainInspection,
    )
    : currentGpuScientificReleaseChainInspection;
  const researchNode = authorityRows.research.row;
  const formalNode = authorityRows.formal.row;
  if (authorityRows.ready && researchNode && formalNode) {
    const researchResult = parseJson(researchNode.result_json);
    const formalHash = researchResult?.formalVerificationReceiptHash || null;
    if (parseJson(formalNode.result_json)
      ?.campaignFormalVerificationReceiptHash === formalHash) {
      try {
        authority = inspectedCandidate({
          planRow,
          formalNode,
          researchNode,
          gpuScientificReleaseChainInspection,
          expectedAgendaAuthorityInspection,
          expectedExperimentIrExecutionAuthorityInspection,
          currentDynamicFormalExecutionAuthority,
          externalResearchReplayReceiptVerifier,
          reviewerReceiptVerificationAuthority,
          currentExperimentAuthorityRows,
        });
      } catch {
        authority = null;
      }
    }
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
    gpuScientificReleaseChainInspection:
      authority?.gpuScientificReleaseChainInspection
      || gpuScientificReleaseChainInspection,
    blockers: Object.freeze(authority ? [] : [...new Set([
        'autonomous_research_assurance_authority_not_persisted',
        ...authorityRows.blockers,
        ...(currentExperimentAuthorityRows.ready ? [] : [
          ...currentExperimentAuthorityRows.blockers,
          'experiment_ir_execution_authority_snapshot_mismatch',
        ]),
        ...(currentExperimentAuthorityRows.ready
          && !automationReadinessExperimentInspectionMatchesRows(
            expectedExperimentIrExecutionAuthorityInspection,
            currentExperimentAuthorityRows,
          ) ? ['experiment_ir_execution_authority_snapshot_mismatch'] : []),
        ...(gpuScientificReleaseChainInspection?.blockers || []),
      ])]),
  });
}
