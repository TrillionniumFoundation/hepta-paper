import { requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import { evaluateManuscriptPromotion } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';

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

function promotionInput({ campaign, paperQualityProfiles, theoremReadiness: readiness, researchReport = null, boundary, requireResearchQuality = false, experimentRegistryAuthorityVerifier = null }) {
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
  const receipt = primitives.quality.manuscriptQuality({
    workspacePath: workspace,
    manuscriptPath: manuscript,
    mode: node.kind === 'revalidate-citations' ? 'citations' : 'artifacts',
    requiresEmpiricalArtifacts: (campaign.spec.languages || []).some((language) => String(language).toLowerCase() !== 'latex'),
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
  experimentRegistryAuthorityVerifier = null,
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
  const promotionGate = evaluateManuscriptPromotion(promotionInput({
    campaign,
    paperQualityProfiles,
    theoremReadiness: readiness,
    researchReport,
    requireResearchQuality: true,
    boundary: 'automation_package_candidate',
    experimentRegistryAuthorityVerifier,
  }));
  if (!promotionGate.passed) {
    primitives.quality.recordRevision({ paperId: campaign.paperId, report: readiness, sourceWorkspace: workspace });
    const error = new Error(promotionGate.blockers.join(',') || 'manuscript_promotion_blocked');
    error.retryable = false;
    error.receipt = promotionGate;
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
  return primitives.release.packageRelease({
    campaign,
    packageNode: node,
    finalCompileNode: context.finalCompileNode,
    researchVerifyNode: researchNode,
    researchReport,
    sourceWorkspace: workspace,
    createdAt,
    executionSignal,
  });
}
