import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyGpuScientificCampaignExecutionResult,
} from './gpu-scientific-campaign-execution-contract.mjs';
import {
  verifyGpuScientificArtifactBodyArchiveManifest,
} from './gpu-scientific-artifact-body-archive-contract.mjs';
import {
  verifyGpuScientificCampaignQualificationEvidence,
  verifyGpuScientificCampaignQualificationRequest,
} from './gpu-scientific-campaign-promotion-contract.mjs';

function recordHashValid(value, kind, hashField) {
  if (!value || typeof value !== 'object') return false;
  const { [hashField]: claimedHash, ...payload } = value;
  return claimedHash === hashRecord(kind, payload);
}

export function buildCampaignResearchGpuScientificEvidence({
  campaign,
  node,
  plan,
  artifactArchiveManifest,
  qualificationRequest,
  qualificationEvidence,
  authorityInspection,
} = {}) {
  const payload = Object.freeze({
    version: 1,
    kind: 'CampaignResearchGpuScientificEvidence',
    status: 'campaign_research_gpu_scientific_pre_release_qualified',
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
    attemptId: node?.attemptId,
    leaseGeneration: node?.leaseGeneration,
    nodeResultHash: node?.resultSha256,
    executionPlanHash: plan?.gpuScientificCampaignExecutionPlanHash,
    executionResultHash:
      node?.result?.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash:
      artifactArchiveManifest?.gpuScientificArtifactBodyArchiveManifestHash,
    artifactArchiveManifest,
    scientificOutputCommitmentHash:
      artifactArchiveManifest?.scientificOutputCommitmentHash,
    qualificationRequestHash:
      qualificationRequest?.gpuScientificCampaignQualificationRequestHash,
    qualificationRequest,
    qualificationEvidenceHash:
      qualificationEvidence?.gpuScientificCampaignQualificationEvidenceHash,
    qualificationEvidence,
    authorityInspection,
    externalActionPerformed: true,
  });
  const evidence = Object.freeze({
    ...payload,
    campaignResearchGpuScientificEvidenceHash: hashRecord(
      'CampaignResearchGpuScientificEvidence',
      payload,
    ),
  });
  if (!verifyCampaignResearchGpuScientificEvidence(evidence, {
    campaign,
    node,
    plan,
  })) throw new Error('campaign_research_gpu_scientific_projection_invalid');
  return evidence;
}

export function verifyCampaignResearchGpuScientificEvidence(value, {
  campaign,
  node,
  plan,
} = {}) {
  if (!value || value.version !== 1
    || value.kind !== 'CampaignResearchGpuScientificEvidence'
    || value.status !== 'campaign_research_gpu_scientific_pre_release_qualified'
    || value.campaignId !== campaign?.campaignId
    || value.paperId !== campaign?.paperId
    || value.nodeId !== node?.nodeId
    || value.attemptId !== node?.attemptId
    || value.leaseGeneration !== node?.leaseGeneration
    || value.nodeResultHash !== node?.resultSha256
    || value.executionPlanHash
      !== plan?.gpuScientificCampaignExecutionPlanHash
    || value.executionResultHash
      !== node?.result?.gpuScientificCampaignExecutionResultHash
    || value.artifactArchiveManifestHash
      !== value.artifactArchiveManifest
        ?.gpuScientificArtifactBodyArchiveManifestHash
    || value.scientificOutputCommitmentHash
      !== value.artifactArchiveManifest?.scientificOutputCommitmentHash
    || value.qualificationRequestHash
      !== value.qualificationRequest
        ?.gpuScientificCampaignQualificationRequestHash
    || value.qualificationEvidenceHash
      !== value.qualificationEvidence
        ?.gpuScientificCampaignQualificationEvidenceHash
    || value.authorityInspection?.valid !== true
    || value.authorityInspection?.cryptographicSignaturesVerified !== true
    || value.authorityInspection?.qualificationEvidenceHash
      !== value.qualificationEvidenceHash
    || !recordHashValid(
      value.authorityInspection,
      'GpuScientificCampaignQualificationAuthorityInspection',
      'gpuScientificCampaignQualificationAuthorityInspectionHash',
    )
    || !verifyGpuScientificCampaignExecutionResult(node?.result, {
      campaign,
      node,
      plan,
    })
    || !verifyGpuScientificArtifactBodyArchiveManifest(
      value.artifactArchiveManifest,
      {
        campaignId: campaign?.campaignId,
        paperId: campaign?.paperId,
        campaignPlanHash: campaign?.spec?.campaignPlanHash,
        nodeId: node?.nodeId,
        attemptId: node?.attemptId,
        leaseGeneration: node?.leaseGeneration,
        executionPlanHash: plan?.gpuScientificCampaignExecutionPlanHash,
        executionResultHash:
          node?.result?.gpuScientificCampaignExecutionResultHash,
      },
    ).valid
    || !verifyGpuScientificCampaignQualificationRequest(
      value.qualificationRequest,
      {
        campaignId: campaign?.campaignId,
        paperId: campaign?.paperId,
        campaignPlanHash: campaign?.spec?.campaignPlanHash,
        nodeId: node?.nodeId,
        attemptId: node?.attemptId,
        leaseGeneration: node?.leaseGeneration,
        executionPlanHash: plan?.gpuScientificCampaignExecutionPlanHash,
        gpuScientificCampaignExecutionResultHash:
          node?.result?.gpuScientificCampaignExecutionResultHash,
        artifactArchiveManifestHash: value.artifactArchiveManifestHash,
        scientificOutputCommitmentHash:
          value.scientificOutputCommitmentHash,
      },
    )
    || !verifyGpuScientificCampaignQualificationEvidence(
      value.qualificationEvidence,
      {
        campaignId: campaign?.campaignId,
        paperId: campaign?.paperId,
        gpuScientificCampaignExecutionResultHash:
          node?.result?.gpuScientificCampaignExecutionResultHash,
        artifactArchiveManifestHash: value.artifactArchiveManifestHash,
        scientificOutputCommitmentHash:
          value.scientificOutputCommitmentHash,
      },
    )) return false;
  return recordHashValid(
    value,
    'CampaignResearchGpuScientificEvidence',
    'campaignResearchGpuScientificEvidenceHash',
  );
}
