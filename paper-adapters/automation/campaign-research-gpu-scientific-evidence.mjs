import {
  verifyGpuScientificCampaignExecutionResult,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  buildGpuScientificCampaignQualificationRequest,
  verifyGpuScientificCampaignQualificationEvidence,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import {
  buildCampaignResearchGpuScientificEvidence,
  verifyCampaignResearchGpuScientificEvidence,
} from '../../paper-domain/automation/campaign-research-gpu-scientific-evidence-contract.mjs';
import {
  inspectGpuScientificArtifactBodyArchiveSourceSync,
} from '../build-package/gpu-scientific-artifact-body-archive.mjs';
import { assertCompletedNodeResult } from './campaign-research-verifier-evidence-helpers.mjs';

export { verifyCampaignResearchGpuScientificEvidence };

export function requireCampaignResearchGpuScientificEvidence({
  campaign,
  authoritativeNodes,
  directDependencies,
  runtimeRoot,
  qualificationIntakeRepository = null,
  promotionAuthorityVerifier = null,
} = {}) {
  const plan = campaign.spec.gpuScientificExecutionPlan || null;
  const dependencyNodes = authoritativeNodes.filter((candidate) => (
    directDependencies.has(candidate.nodeId)
      && candidate.kind === 'gpu-scientific-execution'
  ));
  if (!plan) {
    if (dependencyNodes.length) {
      throw new Error('campaign_research_unplanned_gpu_scientific_dependency');
    }
    return null;
  }
  if (dependencyNodes.length !== 1) {
    throw new Error('campaign_research_gpu_scientific_dependency_required');
  }
  const node = assertCompletedNodeResult(
    dependencyNodes[0],
    'gpu_scientific_node',
  );
  if (!verifyGpuScientificCampaignExecutionResult(node.result, {
    campaign,
    node,
    plan,
  })) throw new Error('campaign_research_gpu_scientific_evidence_invalid');
  let sourceInspection;
  try {
    sourceInspection = inspectGpuScientificArtifactBodyArchiveSourceSync({
      runtimeRoot,
      campaign,
      node,
      executionPlan: plan,
      executionResult: node.result,
    });
  } catch (cause) {
    const error = new Error(
      `campaign_research_gpu_scientific_artifact_archive_invalid:${cause.message}`,
    );
    error.retryable = false;
    error.cause = cause;
    throw error;
  }
  const archive = sourceInspection.manifest;
  const request = buildGpuScientificCampaignQualificationRequest({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: node.nodeId,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    executionPlanHash: plan.gpuScientificCampaignExecutionPlanHash,
    taskSetHash: plan.taskSetHash,
    gpuDeviceSelector: archive.gpuDeviceSelector,
    gpuScientificCampaignAttemptAuthorityHash:
      archive.gpuScientificCampaignAttemptAuthorityHash,
    gpuScientificCampaignExecutionResultHash:
      node.result.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash:
      archive.gpuScientificArtifactBodyArchiveManifestHash,
    scientificOutputCommitmentHash: archive.scientificOutputCommitmentHash,
    pdeTaskReceiptHash: archive.pdeScientificReceiptHash,
    deepLearningTaskReceiptHash: archive.deepLearningTrainingReceiptHash,
    runtimeImageDigest: archive.runtimeImageDigest,
    runtimePackageClosureHash: archive.runtimePackageClosureHash,
    originalExecutionProcessIdentityHashes:
      archive.originalExecutionProcessIdentityHashes,
  });
  const intake = qualificationIntakeRepository?.resolve?.({ request }) || null;
  if (!intake?.evidence) {
    const error = new Error(
      'campaign_research_gpu_scientific_external_authorities_required',
    );
    error.retryable = true;
    error.receipt = request;
    throw error;
  }
  const qualificationEvidence = intake.evidence;
  const authorityInspection = promotionAuthorityVerifier?.verify?.({
    qualificationEvidence,
  }) || null;
  if (!authorityInspection?.valid
    || !verifyGpuScientificCampaignQualificationEvidence(
      qualificationEvidence,
      {
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        gpuScientificCampaignExecutionResultHash:
          node.result.gpuScientificCampaignExecutionResultHash,
        artifactArchiveManifestHash:
          archive.gpuScientificArtifactBodyArchiveManifestHash,
        scientificOutputCommitmentHash:
          archive.scientificOutputCommitmentHash,
      },
    )
    || JSON.stringify(
      qualificationEvidence.gpuScientificCampaignQualificationRequest,
    ) !== JSON.stringify(request)) {
    const error = new Error(
      'campaign_research_gpu_scientific_external_authorities_invalid',
    );
    error.retryable = false;
    error.receipt = authorityInspection || qualificationEvidence;
    throw error;
  }
  return buildCampaignResearchGpuScientificEvidence({
    campaign,
    node,
    plan,
    artifactArchiveManifest: archive,
    qualificationRequest: request,
    qualificationEvidence,
    authorityInspection,
  });
}
