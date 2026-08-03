import { requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import { evaluateManuscriptPromotion } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';
import {
  campaignTrustedAutonomousManuscriptAuthorshipReceipt,
  inspectAutonomousManuscriptReleaseProof,
} from '../../paper-domain/automation/autonomous-manuscript-release-proof-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectAutonomousResearchProductionProfilePreparation,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  buildIndependentEvidenceEntailmentReviewReceipt,
} from '../../paper-domain/research/evidence-entailment-review-receipt-contract.mjs';
import {
  verifyExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';

function profiles(campaign) {
  return campaign.spec.paperQualityProfiles || [campaign.spec.paperQualityProfile].filter(Boolean);
}

function theoremReadiness(primitives, campaign, workspace, manuscript) {
  return primitives.quality.theoremReadiness({
    workspacePath: workspace,
    manuscriptPath: manuscript,
    paperId: campaign.paperId,
    profile: campaign.spec.paperQualityProfile || null,
  });
}

function authoritativeManuscriptResult({ primitives, campaign, context, workspace, manuscript }) {
  const currentManuscriptHash = primitives.workspace.hashFile({
    workspace,
    relative: manuscript,
  });
  const candidates = (context.campaignNodes || []).filter((candidate) => (
    candidate?.status === 'completed'
      && ['manuscript-integrate', 'revise'].includes(candidate?.kind)
  )).filter((candidate) => {
    const result = candidate?.result;
    const receipt = result?.trustedAutonomousManuscriptRenderReceipt;
    const proof = inspectAutonomousManuscriptReleaseProof({
      nodeId: candidate?.nodeId || null,
      attemptId: candidate?.attemptId || null,
      leaseGeneration: candidate?.leaseGeneration || null,
      resultHash: candidate?.resultSha256 || null,
      result,
    }, {
      paperId: campaign.paperId,
      campaignId: campaign.campaignId,
      manuscriptPath: manuscript,
      renderedManuscriptHash: currentManuscriptHash,
    }, {
      requireAgentAuthored: receipt?.requireAgentAuthoredProse === true,
      requireReadableProof: receipt?.formalSupportTemplateId === null
        && receipt?.formalSupportRegistryHash === null,
    });
    return proof.valid;
  }).sort((left, right) => (
    Number(Boolean(right.sourceClosureTerminal || right.spec?.sourceClosureTerminal))
      - Number(Boolean(left.sourceClosureTerminal || left.spec?.sourceClosureTerminal))
    || Number(right.roundIndex || 0) - Number(left.roundIndex || 0)
    || String(right.nodeId || '').localeCompare(String(left.nodeId || ''))
  ));
  const selected = candidates[0] || null;
  return selected ? Object.freeze({
    nodeId: selected.nodeId,
    attemptId: selected.attemptId || null,
    leaseGeneration: selected.leaseGeneration || null,
    resultHash: selected.resultSha256,
    result: selected.result,
  }) : null;
}

function authoritativeRefereeConvergence({ campaign, context, manuscriptHash }) {
  const finalDependencies = new Set(context.finalCompileNode?.dependencies || []);
  const candidates = (context.campaignNodes || []).filter((candidate) => {
    const decision = candidate?.result || null;
    const { refereeConvergenceDecisionHash: claimedHash, ...payload } = decision || {};
    return candidate?.kind === 'convergence'
      && candidate?.status === 'completed'
      && finalDependencies.has(candidate.nodeId)
      && decision?.kind === 'RefereeConvergenceDecision'
      && decision?.paperId === campaign.paperId
      && decision?.status === 'referee_convergence_reached'
      && decision?.accepted === true
      && decision?.expectedManuscriptHash === manuscriptHash
      && hashRecord('RefereeConvergenceDecision', payload) === claimedHash
      && hashRecord('PaperCampaignNodeResult', decision) === candidate?.resultSha256;
  });
  return candidates.length === 1 ? candidates[0].result : null;
}

function authoritativeExperimentExecution({ campaign, context, researchReport }) {
  const preparation = campaign?.spec?.autonomousResearchPreparation || null;
  const registry = researchReport?.capabilities?.experimentRegistry || null;
  const reportReplayHashes = new Set((registry?.experiments || []).map((experiment) => (
    experiment?.evidenceBinding?.authorityEvidence?.experimentReplayReceipt
      ?.experimentReplayReceiptHash || null
  )).filter(Boolean));
  const candidates = (context?.campaignNodes || []).filter((candidate) => {
    const authority = candidate?.result?.experimentIrExecutionAuthorityReceipt || null;
    const replay = candidate?.result?.experimentReplayReceipt || null;
    return candidate?.status === 'completed'
      && authority
      && replay
      && candidate?.nodeId === authority.nodeId
      && candidate?.kind === authority.nodeKind
      && candidate?.result?.experimentIrExecutionAuthorityReceiptHash
        === authority.experimentIrExecutionAuthorityReceiptHash
      && reportReplayHashes.has(replay.experimentReplayReceiptHash)
      && verifyExperimentIrExecutionAuthorityReceipt(authority, {
        campaignId: campaign?.campaignId,
        paperId: campaign?.paperId,
        campaignPlanHash: campaign?.spec?.campaignPlanHash,
        nodeId: candidate.nodeId,
        nodeKind: candidate.kind,
        researchAgendaIr: preparation?.researchAgendaIr,
        researchAgendaProducerReceipt: preparation?.researchAgendaProducerReceipt,
        proposal: preparation?.proposal,
        researchAgendaClaimBindingReceipt: preparation?.agendaClaimBindingReceipt,
        experimentReplayReceipt: replay,
      });
  }).sort((left, right) => (
    Number(Boolean(right.sourceClosureTerminal || right.spec?.sourceClosureTerminal))
      - Number(Boolean(left.sourceClosureTerminal || left.spec?.sourceClosureTerminal))
    || Number(right.roundIndex || 0) - Number(left.roundIndex || 0)
    || String(right.nodeId || '').localeCompare(String(left.nodeId || ''))
  ));
  if (!candidates.length) return null;
  const selected = candidates[0];
  const selectedHash = selected.result.experimentIrExecutionAuthorityReceiptHash;
  if (candidates.some((candidate) => (
    candidate.result.experimentIrExecutionAuthorityReceiptHash !== selectedHash
  ))) return null;
  return Object.freeze({
    experimentIrExecutionAuthorityReceipt:
      selected.result.experimentIrExecutionAuthorityReceipt,
    experimentReplayReceipt: selected.result.experimentReplayReceipt,
  });
}

function promotionInput({
  campaign,
  paperQualityProfiles,
  theoremReadiness: readiness,
  researchReport = null,
  boundary,
  requireResearchQuality = false,
  experimentRegistryAuthorityVerifier = null,
  evidenceEntailmentReviewReceipt = null,
  requireEvidenceEntailmentReview = false,
  expectedManuscriptHash = null,
  expectedEvidenceEntailmentContractHash = null,
  expectedEvidenceBoundManuscriptIrHash = null,
  expectedManuscriptAuthorPrincipalId = null,
}) {
  return {
    paperTask: {
      paperId: campaign.paperId,
      taskKey: `${campaign.paperId}:campaign`,
      paperQualityProfile: campaign.spec.paperQualityProfile || null,
      paperQualityProfiles,
    },
    profile: campaign.spec.paperQualityProfile || null,
    profiles: paperQualityProfiles,
    theoremReadiness: readiness,
    researchReport,
    requireResearchQuality,
    requirePaperQuality: boundary === 'automation_package_candidate' && paperQualityProfiles.length > 0,
    boundary,
    evidenceEntailmentReviewReceipt,
    requireEvidenceEntailmentReview,
    expectedManuscriptHash,
    expectedEvidenceEntailmentContractHash,
    expectedEvidenceBoundManuscriptIrHash,
    expectedManuscriptAuthorPrincipalId,
    ...(boundary === 'automation_package_candidate' ? {
      experimentRegistryAuthorityVerifier,
      expectedCampaignId: campaign.campaignId,
    } : {}),
  };
}

export function executeCampaignConvergenceNode({ primitives, campaign, workspace, manuscript } = {}) {
  const paperQualityProfiles = profiles(campaign);
  const readiness = theoremReadiness(primitives, campaign, workspace, manuscript);
  const promotionGate = evaluateManuscriptPromotion(promotionInput({
    campaign,
    paperQualityProfiles,
    theoremReadiness: readiness,
    boundary: 'automation_convergence',
  }));
  const revisionMaterialization = readiness.passed ? null : primitives.quality.recordRevision({
    paperId: campaign.paperId,
    report: readiness,
    sourceWorkspace: workspace,
  });
  return {
    thresholds: campaign.spec.convergenceThresholds || {},
    qualityGates: [readiness, promotionGate],
    revisionMaterialization,
  };
}

export function executeCampaignQualityRevalidationNode({ primitives, campaign, node, context, workspace, manuscript } = {}) {
  const changedPaths = context.revisionNode?.result?.changedPaths || [];
  const impact = requiredRevalidationForChanges(changedPaths);
  if (!impact.required.includes(node.kind)) {
    return { status: 'impact_revalidation_not_required', nodeKind: node.kind, changedPaths };
  }
  const artifactMode = node.kind === 'revalidate-artifacts';
  const empiricalProfile = profiles(campaign).includes('empirical_or_experiment');
  const trustedAutonomousManuscriptAuthorityRequired = artifactMode && empiricalProfile
    && Boolean(campaign.spec.autonomousResearchPreparation)
    && campaign.spec.scientificClaimAuthority?.claimAuthorityType
      === 'machine-policy-authorized';
  const trustedAutonomousManuscriptResult = trustedAutonomousManuscriptAuthorityRequired
    ? authoritativeManuscriptResult({
      primitives,
      campaign,
      context,
      workspace,
      manuscript,
    }) : null;
  if (trustedAutonomousManuscriptAuthorityRequired && !trustedAutonomousManuscriptResult) {
    const error = new Error(
      'campaign_revalidation_trusted_autonomous_manuscript_authority_required',
    );
    error.retryable = false;
    throw error;
  }
  const receipt = primitives.quality.manuscriptQuality({
    workspacePath: workspace,
    manuscriptPath: manuscript,
    mode: artifactMode ? 'artifacts' : 'citations',
    requiresEmpiricalArtifacts: empiricalProfile
      || (campaign.spec.languages || []).some((language) => (
        String(language).toLowerCase() !== 'latex'
      )),
    expectedPaperId: campaign.paperId,
    expectedCampaignId: campaign.campaignId,
    trustedAutonomousManuscriptRenderReceipt:
      trustedAutonomousManuscriptResult
        ?.result?.trustedAutonomousManuscriptRenderReceipt || null,
    trustedAutonomousManuscriptAgentExecutionReceipt:
      campaignTrustedAutonomousManuscriptAuthorshipReceipt(
        trustedAutonomousManuscriptResult?.result,
      ),
    trustedAutonomousManuscriptCampaignNodes: context.campaignNodes || [],
  });
  if (!receipt.passed) {
    const error = new Error(receipt.blockers.join(',') || 'manuscript_quality_check_failed');
    error.retryable = false;
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

export async function executeCampaignPackageNode({
  primitives,
  campaign,
  node,
  context,
  workspace,
  manuscript,
  executionSignal,
  executionResources = null,
  experimentRegistryAuthorityVerifier = null,
  reviewerEvidenceAuthority = null,
} = {}) {
  const paperQualityProfiles = profiles(campaign);
  const readiness = theoremReadiness(primitives, campaign, workspace, manuscript);
  const researchReport = context.researchVerifyNode?.result?.report || null;
  const experimentRegistry = researchReport?.capabilities?.experimentRegistry || null;
  const empiricalProfile = paperQualityProfiles.includes('empirical_or_experiment');
  const manuscriptArtifactAuthority = primitives.quality.manuscriptQuality({
    workspacePath: workspace,
    manuscriptPath: manuscript,
    mode: 'artifacts',
    requiresEmpiricalArtifacts: empiricalProfile,
    requiresTrustedEmpiricalAuthority: empiricalProfile || Number(experimentRegistry?.experiments?.length || 0) > 0,
    experimentRegistry,
    experimentRegistryAuthorityVerifier,
    expectedPaperId: campaign.paperId,
    expectedCampaignId: campaign.campaignId,
    expectedEmpiricalAssertionAuthority:
      researchReport?.capabilities?.empiricalAssertionAuthority || null,
    expectedEmpiricalAssertionUniverse:
      researchReport?.capabilities?.empiricalAssertionUniverse || null,
    expectedEmpiricalAssertionUniverseBinding:
      researchReport?.capabilities?.empiricalAssertionUniverseBinding || null,
  });
  if (!manuscriptArtifactAuthority.passed) {
    const error = new Error(manuscriptArtifactAuthority.blockers.join(',') || 'manuscript_empirical_artifact_authority_blocked');
    error.retryable = false;
    error.receipt = manuscriptArtifactAuthority;
    throw error;
  }
  if (!readiness.passed) {
    primitives.quality.recordRevision({
      paperId: campaign.paperId,
      report: readiness,
      sourceWorkspace: workspace,
    });
    const error = new Error(readiness.blockers.join(',') || 'theorem_manuscript_readiness_blocked');
    error.retryable = false;
    error.receipt = readiness;
    throw error;
  }
  if (!context.finalCompileNode) {
    const error = new Error('campaign_release_final_compile_dependency_required');
    error.retryable = false;
    throw error;
  }
  const researchNode = context.researchVerifyNode;
  if (researchNode?.status !== 'completed'
    || researchNode.result?.researchPromotionStatus !== 'research_promotion_ready'
    || !researchReport?.researchReportHash
    || !(researchNode.dependencies || []).includes(context.finalCompileNode.nodeId)) {
    const error = new Error('campaign_release_research_promotion_dependency_required');
    error.retryable = false;
    throw error;
  }
  const createdAt = node.updatedAt || null;
  if (!createdAt) {
    const error = new Error('campaign_release_created_at_required');
    error.retryable = false;
    throw error;
  }
  const trustedAutonomousManuscriptResult = authoritativeManuscriptResult({
    primitives,
    campaign,
    context,
    workspace,
    manuscript,
  });
  const preparation = campaign.spec.autonomousResearchPreparation || null;
  const productionProfileInspection =
    inspectAutonomousResearchProductionProfilePreparation(preparation);
  if (!productionProfileInspection.ready) {
    const error = new Error(
      `campaign_release_production_profile_blocked:${productionProfileInspection.blockers.join(',')}`,
    );
    error.retryable = false;
    throw error;
  }
  if (preparation?.launchMode === 'production-run' && !trustedAutonomousManuscriptResult) {
    const error = new Error('campaign_release_agent_authored_manuscript_proof_required');
    error.retryable = false;
    throw error;
  }
  const currentManuscriptHash = primitives.workspace.hashFile({
    workspace,
    relative: manuscript,
  });
  const refereeConvergenceDecision = authoritativeRefereeConvergence({
    campaign,
    context,
    manuscriptHash: currentManuscriptHash,
  });
  if (preparation?.launchMode === 'production-run' && !refereeConvergenceDecision) {
    const error = new Error('campaign_release_final_accepted_referee_convergence_required');
    error.retryable = false;
    throw error;
  }
  const experimentExecutionClosure = authoritativeExperimentExecution({
    campaign,
    context,
    researchReport,
  });
  const recursiveResearchClosureRequested = preparation?.launchMode === 'production-run'
    && preparation?.venueProfileSelection?.profile?.externalSubmissionEnabled === true
    && preparation?.researchAgendaIr
    && preparation?.agendaClaimBindingReceipt
    && preparation?.priorArtClaimAlignmentReceipt
    && preparation?.venueRequirementIr;
  if (recursiveResearchClosureRequested && !experimentExecutionClosure) {
    const error = new Error(
      'campaign_release_experiment_ir_execution_authority_required',
    );
    error.retryable = false;
    throw error;
  }
  const renderReceipt = trustedAutonomousManuscriptResult
    ?.result?.trustedAutonomousManuscriptRenderReceipt || null;
  const authorReceipt = campaignTrustedAutonomousManuscriptAuthorshipReceipt(
    trustedAutonomousManuscriptResult?.result,
  );
  const authorPrincipalId = authorReceipt?.principalId || authorReceipt?.agentId || null;
  const requireEvidenceEntailmentReview = preparation?.launchMode === 'production-run';
  const evidenceEntailmentReviewReceipt = requireEvidenceEntailmentReview
    ? buildIndependentEvidenceEntailmentReviewReceipt({
      evidenceEntailmentContract: renderReceipt?.evidenceEntailmentContract,
      refereeConvergenceDecision,
      authorPrincipalId,
      requireSignedReviewerEvidence: true,
    }) : null;
  const promotionGate = evaluateManuscriptPromotion(promotionInput({
    campaign,
    paperQualityProfiles,
    theoremReadiness: readiness,
    researchReport,
    requireResearchQuality: true,
    boundary: 'automation_package_candidate',
    experimentRegistryAuthorityVerifier,
    evidenceEntailmentReviewReceipt,
    requireEvidenceEntailmentReview,
    expectedManuscriptHash: currentManuscriptHash,
    expectedEvidenceEntailmentContractHash:
      renderReceipt?.evidenceEntailmentContractHash || null,
    expectedEvidenceBoundManuscriptIrHash:
      renderReceipt?.evidenceBoundManuscriptIrHash || null,
    expectedManuscriptAuthorPrincipalId: authorPrincipalId,
  }));
  if (!promotionGate.passed) {
    primitives.quality.recordRevision({
      paperId: campaign.paperId,
      report: readiness,
      sourceWorkspace: workspace,
    });
    const error = new Error(
      promotionGate.blockers.join(',') || 'manuscript_promotion_blocked',
    );
    error.retryable = false;
    error.receipt = promotionGate;
    throw error;
  }
  return primitives.release.packageRelease({
    campaign,
    packageNode: node,
    finalCompileNode: context.finalCompileNode,
    researchVerifyNode: researchNode,
    researchReport,
    sourceWorkspace: workspace,
    manuscriptPath: manuscript,
    trustedAutonomousManuscriptResult,
    refereeConvergenceDecision,
    evidenceEntailmentReviewReceipt,
    reviewerEvidenceAuthority,
    experimentExecutionClosure,
    createdAt,
    executionSignal,
    assertExternalSideEffectReady:
      executionResources?.assertExternalSideEffectReady || null,
  });
}
