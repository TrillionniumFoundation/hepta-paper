import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { workspaceExecutionMerkleHash } from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';
import { hashPaperRecord, hashPaperSemanticIdentity } from '../contracts/primitives.mjs';
import { verifyExperimentRegistry } from '../research/experiment-registry-verifier.mjs';
import { verifyCampaignResearchSourceSnapshot } from './campaign-research-contract.mjs';
import {
  verifyAdvancedNumericalCampaignExecutionPlan,
  verifyCampaignAdvancedNumericalExecutionResult,
} from './advanced-numerical-campaign-execution-contract.mjs';
import {
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  verifyGpuScientificCampaignExecutionPlan,
  verifyGpuScientificCampaignExecutionResult,
} from './gpu-scientific-campaign-execution-contract.mjs';
import {
  verifyGpuScientificCampaignPromotionEvidence,
} from './gpu-scientific-campaign-promotion-contract.mjs';
import {
  verifyCampaignResearchGpuScientificEvidence,
} from './campaign-research-gpu-scientific-evidence-contract.mjs';
import {
  verifyCampaignReleaseGpuScientificEvidenceDescriptor,
} from './campaign-release-gpu-scientific-evidence-capsule-contract.mjs';

export const EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS = Object.freeze([
  'empiricalAssertionAuthorityHash',
  'empiricalAssertionUniverseHash',
  'empiricalAssertionUniverseBindingHash',
  'empiricalAssertionManuscriptCorpusHash',
]);

export function empiricalAssertionReleaseHashes(record) {
  return Object.fromEntries(
    EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS.map((field) => [field, record?.[field] || null]),
  );
}

export function empiricalAssertionReleaseHashesMatch(left, right) {
  return EMPIRICAL_ASSERTION_RELEASE_HASH_FIELDS.every(
    (field) => (left?.[field] || null) === (right?.[field] || null),
  );
}

export function advancedNumericalReleaseEvidenceValid({
  campaignPlanHash,
  campaignId,
  paperId,
  plan,
  evidence,
} = {}) {
  if (!plan && !evidence) return true;
  if (!plan || !evidence
    || !verifyAdvancedNumericalCampaignExecutionPlan(plan, {
      campaignId,
      paperId,
      nodeId: evidence.nodeId,
    })) return false;
  const node = {
    nodeId: evidence.nodeId,
    kind: 'advanced-numerical-analysis',
    attemptId: evidence.attemptId,
    leaseGeneration: evidence.leaseGeneration,
  };
  const campaign = {
    campaignId,
    paperId,
    spec: { campaignPlanHash },
  };
  const result = evidence.result;
  return verifyCampaignAdvancedNumericalExecutionResult(result, {
    campaign,
    node,
    plan,
    requirePromotionEligible: true,
  })
    && evidence.executionPlanHash
      === plan.advancedNumericalCampaignExecutionPlanHash
    && evidence.executionReceiptHash
      === result.advancedNumericalCampaignExecutionReceiptHash
    && evidence.evidenceHash === result.advancedNumericalCampaignEvidenceHash
    && evidence.evidenceDocumentHash === result.evidenceDocumentHash
    && evidence.productionQualified === true
    && evidence.promotionEligible === true;
}

export function gpuScientificReleaseEvidenceValid({
  campaignPlanHash,
  campaignId,
  paperId,
  plan,
  evidence,
  qualificationEvidence,
  promotionEvidence,
  researchEvidenceCapsuleManifestHash,
  researchEvidenceCapsuleManifestFileHash,
  researchExecutionReleaseAttestationHash,
} = {}) {
  if (!plan && !evidence && !qualificationEvidence && !promotionEvidence) {
    return true;
  }
  if (!plan || !evidence || !qualificationEvidence || !promotionEvidence
    || !verifyGpuScientificCampaignExecutionPlan(plan, {
      campaignId,
      paperId,
      nodeId: evidence.nodeId,
    })) return false;
  const rawResultValid = verifyGpuScientificCampaignExecutionResult(evidence, {
    campaign: { campaignId, paperId, spec: { campaignPlanHash } },
    node: {
      nodeId: evidence.nodeId,
      kind: 'gpu-scientific-execution',
      attemptId: evidence.attemptId,
      leaseGeneration: evidence.leaseGeneration,
      gpuScientificExecutionPlanHash:
        plan.gpuScientificCampaignExecutionPlanHash,
      gpuScientificResourceBudgetHash:
        GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
          .gpuScientificCampaignResourceBudgetHash,
    },
    plan,
    requirePromotionEligible: false,
  });
  const request = qualificationEvidence
    ?.gpuScientificCampaignQualificationRequest;
  return rawResultValid
    && evidence.promotionEligible === false
    && verifyGpuScientificCampaignPromotionEvidence(promotionEvidence, {
      campaignId,
      paperId,
      gpuScientificCampaignExecutionResultHash:
        evidence.gpuScientificCampaignExecutionResultHash,
      artifactArchiveManifestHash:
        qualificationEvidence.artifactArchiveManifestHash,
      scientificOutputCommitmentHash:
        qualificationEvidence.scientificOutputCommitmentHash,
      researchEvidenceCapsuleManifestHash,
      researchEvidenceCapsuleManifestFileHash,
      researchExecutionReleaseAttestationHash,
    })
    && promotionEvidence.gpuScientificCampaignQualificationEvidenceHash
      === qualificationEvidence.gpuScientificCampaignQualificationEvidenceHash
    && JSON.stringify(
      promotionEvidence.gpuScientificCampaignQualificationEvidence,
    ) === JSON.stringify(qualificationEvidence)
    && request?.campaignPlanHash === campaignPlanHash
    && request?.executionPlanHash
      === plan.gpuScientificCampaignExecutionPlanHash
    && request?.taskSetHash === plan.taskSetHash
    && request?.nodeId === evidence.nodeId
    && request?.attemptId === evidence.attemptId
    && request?.leaseGeneration === evidence.leaseGeneration;
}

export function gpuScientificReleaseFields(plan, evidence, promotionEvidence) {
  return plan ? {
    gpuScientificExecutionPlanHash:
      plan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificCampaignExecutionResultHash:
      evidence.gpuScientificCampaignExecutionResultHash,
    gpuScientificExecutionPlan: plan,
    gpuScientificExecutionEvidence: evidence,
    gpuScientificArtifactBodyArchiveManifestHash:
      promotionEvidence.artifactArchiveManifestHash,
    gpuScientificCampaignQualificationEvidenceHash:
      promotionEvidence.gpuScientificCampaignQualificationEvidenceHash,
    gpuScientificCampaignPromotionEvidenceHash:
      promotionEvidence.gpuScientificCampaignPromotionEvidenceHash,
    gpuScientificCampaignPromotionEvidence: promotionEvidence,
  } : {};
}

export function gpuScientificPromotionCandidateEvidenceValid({
  campaignPlanHash, campaignId, paperId, plan, evidence, researchEvidence,
  promotionEvidence, researchEvidenceCapsuleManifestHash,
  researchEvidenceCapsuleManifest,
  researchEvidenceCapsuleManifestFileHash,
  researchExecutionReleaseAttestationHash,
} = {}) {
  const node = evidence ? {
    nodeId: evidence.nodeId,
    kind: 'gpu-scientific-execution',
    attemptId: evidence.attemptId,
    leaseGeneration: evidence.leaseGeneration,
    gpuScientificExecutionPlanHash:
      plan?.gpuScientificCampaignExecutionPlanHash || null,
    gpuScientificResourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash,
    resultSha256: researchEvidence?.nodeResultHash,
    result: evidence,
  } : null;
  if ((plan && !verifyCampaignResearchGpuScientificEvidence(researchEvidence, {
    campaign: { campaignId, paperId, spec: { campaignPlanHash } }, node, plan,
  })) || (!plan && researchEvidence)) return false;
  return gpuScientificReleaseEvidenceValid({
    campaignPlanHash, campaignId, paperId, plan, evidence,
    qualificationEvidence: researchEvidence?.qualificationEvidence || null,
    promotionEvidence,
    researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash,
    researchExecutionReleaseAttestationHash,
  }) && gpuScientificReleaseCapsuleLineageValid({
    gpuScientificExecutionPlanHash:
      plan?.gpuScientificCampaignExecutionPlanHash,
    gpuScientificCampaignExecutionResultHash:
      evidence?.gpuScientificCampaignExecutionResultHash,
    gpuScientificArtifactBodyArchiveManifestHash:
      promotionEvidence?.artifactArchiveManifestHash,
    gpuScientificCampaignQualificationEvidenceHash:
      promotionEvidence?.gpuScientificCampaignQualificationEvidenceHash,
    gpuScientificCampaignPromotionEvidence: promotionEvidence,
  }, {
    manifest: researchEvidenceCapsuleManifest,
    manifestFileHash: researchEvidenceCapsuleManifestFileHash,
    attestationHash: researchExecutionReleaseAttestationHash,
  });
}

export function gpuScientificReleaseCapsuleLineageValid(record, {
  manifest, manifestFileHash, attestationHash,
} = {}) {
  const planHash = record?.gpuScientificExecutionPlanHash;
  if (!planHash) return manifest?.gpuScientificEvidenceIncluded !== true;
  const promotion = record?.gpuScientificCampaignPromotionEvidence;
  const descriptor = manifest?.gpuScientificEvidence;
  const qualification = promotion
    ?.gpuScientificCampaignQualificationEvidence;
  const replay = qualification
    ?.gpuScientificCampaignSameDeviceReplayReceipt;
  const production = qualification
    ?.gpuScientificCampaignProductionQualificationAuthority;
  const observedAt = Date.parse(String(manifest?.createdAt || ''));
  const authorityCurrent = [replay, production].every((authority) => (
    Number.isFinite(observedAt)
      && observedAt >= Date.parse(String(authority?.validFrom || ''))
      && observedAt < Date.parse(String(authority?.expiresAt || ''))
  ));
  return manifest?.version === 3
    && manifest?.gpuScientificEvidenceIncluded === true
    && verifyCampaignReleaseGpuScientificEvidenceDescriptor(manifest)
    && descriptor?.executionPlanHash === planHash
    && descriptor?.gpuScientificCampaignExecutionResultHash
      === record.gpuScientificCampaignExecutionResultHash
    && descriptor?.gpuScientificArtifactBodyArchiveManifestHash
      === record.gpuScientificArtifactBodyArchiveManifestHash
    && descriptor?.gpuScientificCampaignQualificationEvidenceHash
      === record.gpuScientificCampaignQualificationEvidenceHash
    && descriptor?.scientificOutputCommitmentHash
      === promotion?.scientificOutputCommitmentHash
    && authorityCurrent
    && promotion?.researchEvidenceCapsuleManifestHash
      === manifest?.researchEvidenceCapsuleManifestHash
    && promotion?.researchEvidenceCapsuleManifestFileHash === manifestFileHash
    && promotion?.researchExecutionReleaseAttestationHash === attestationHash;
}

export function gpuScientificReleaseLineageValid({
  campaignPlanHash,
  campaignId,
  paperId,
  plan,
  evidence,
  promotionEvidence,
  planHash,
  resultHash,
  candidate = null,
} = {}) {
  return gpuScientificReleaseEvidenceValid({
    campaignPlanHash, campaignId, paperId, plan, evidence,
    qualificationEvidence:
      promotionEvidence?.gpuScientificCampaignQualificationEvidence,
    promotionEvidence,
    researchEvidenceCapsuleManifestHash:
      promotionEvidence?.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash:
      promotionEvidence?.researchEvidenceCapsuleManifestFileHash,
    researchExecutionReleaseAttestationHash:
      promotionEvidence?.researchExecutionReleaseAttestationHash,
  })
    && planHash === plan?.gpuScientificCampaignExecutionPlanHash
    && resultHash === evidence?.gpuScientificCampaignExecutionResultHash
    && (!candidate || (
      planHash === candidate.gpuScientificExecutionPlanHash
      && resultHash === candidate.gpuScientificCampaignExecutionResultHash
      && JSON.stringify(plan || null)
        === JSON.stringify(candidate.gpuScientificExecutionPlan || null)
      && JSON.stringify(evidence || null)
        === JSON.stringify(candidate.gpuScientificExecutionEvidence || null)
      && JSON.stringify(promotionEvidence || null)
        === JSON.stringify(
          candidate.gpuScientificCampaignPromotionEvidence || null,
        )
    ));
}

export function gpuScientificReleaseRecordValid(record, candidate = null) {
  return gpuScientificReleaseLineageValid({
    campaignPlanHash: record?.campaignPlanHash,
    campaignId: record?.campaignId,
    paperId: record?.paperId,
    plan: record?.gpuScientificExecutionPlan || null,
    evidence: record?.gpuScientificExecutionEvidence || null,
    promotionEvidence:
      record?.gpuScientificCampaignPromotionEvidence || null,
    planHash: record?.gpuScientificExecutionPlanHash,
    resultHash: record?.gpuScientificCampaignExecutionResultHash,
    candidate,
  });
}

export function autonomousManuscriptSourceRowsMatch(binding, sourceTreeManifest) {
  if (!binding) return true;
  const rows = new Map((sourceTreeManifest?.rows || []).map((row) => [row.path, row]));
  const expected = [
    [binding.manuscriptPath, binding.renderedManuscriptHash],
    ['AUTONOMOUS_MANUSCRIPT_IR.json', binding.manuscriptIrFileHash],
    ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json', binding.agentAuthoredSourceDraftFileHash],
  ].filter(([, hash]) => hash);
  return expected.every(([path, hash]) => rows.get(path)?.hash === hash);
}

export function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}

export function explicitTimestamp(value) {
  const normalized = required(value, 'campaign_release_created_at');
  if (!Number.isFinite(Date.parse(normalized))) throw new Error('campaign_release_created_at_invalid');
  return normalized;
}

function recordPayload(record, hashField) {
  if (!record || typeof record !== 'object') return null;
  const { [hashField]: _claimedHash, ...payload } = record;
  return payload;
}

export function matchesRecordHash(record, kind, hashField, hasher = hashRecord) {
  const payload = recordPayload(record, hashField);
  return Boolean(payload && record?.[hashField] && hasher(kind, payload) === record[hashField]);
}

export function artifactPackageHashesValid(record) {
  if (!record || typeof record !== 'object') return false;
  const {
    artifactPackageHash,
    semanticIdentityVersion: _semanticIdentityVersion,
    semanticIdentityHash,
    ...payload
  } = record;
  return Boolean(artifactPackageHash
    && hashPaperRecord('PaperArtifactPackage', payload) === artifactPackageHash
    && (!semanticIdentityHash || hashPaperSemanticIdentity('PaperArtifactPackage', payload) === semanticIdentityHash));
}

export function researchReportValid(report, experimentRegistryAuthorityVerifier = null) {
  if (!report || report.kind !== 'PaperResearchVerifyReport' || report.promotionEligibility?.status !== 'research_promotion_ready') return false;
  const { researchReportHash, ...payload } = report;
  const registry = report?.capabilities?.experimentRegistry || null;
  const registryVerification = verifyExperimentRegistry(registry, {
    expectedPaperId: report.paperId || null,
    expectedCampaignId: report?.campaignResearchSourceSnapshot?.campaignId || null,
    authorityVerifier: experimentRegistryAuthorityVerifier,
  });
  return Boolean(registryVerification.valid
    && report.experimentRegistryHash === registry?.experimentRegistryHash
    && researchReportHash && hashPaperRecord('PaperResearchVerifyReport', payload) === researchReportHash);
}

export function sourceRowsMerkleHash(sourceTreeManifest) {
  const rows = Array.isArray(sourceTreeManifest?.rows) ? sourceTreeManifest.rows : [];
  return workspaceExecutionMerkleHash(rows);
}

export function researchSourceLineageValid({
  researchReport,
  campaignResearchSourceSnapshot,
  campaignId,
  paperId,
  researchVerifyNodeId,
  researchVerifyAttemptId,
  researchVerifyLeaseGeneration,
  verifiedSourceMerkleHash,
  verifiedSourceWorkspaceManifestHash,
} = {}) {
  if (!researchReport) return campaignResearchSourceSnapshot === null || campaignResearchSourceSnapshot === undefined;
  const verification = verifyCampaignResearchSourceSnapshot(campaignResearchSourceSnapshot, {
    campaignId,
    paperId,
    researchNodeId: researchVerifyNodeId,
    researchAttemptId: researchVerifyAttemptId,
    researchLeaseGeneration: researchVerifyLeaseGeneration,
    verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash,
  });
  return verification.valid
    && researchReport.paperId === paperId
    && researchReport.researchNodeId === researchVerifyNodeId
    && researchReport.researchAttemptId === researchVerifyAttemptId
    && researchReport.researchLeaseGeneration === researchVerifyLeaseGeneration
    && researchReport.campaignResearchSourceSnapshotHash === campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash
    && researchReport.verifiedSourceMerkleHash === verifiedSourceMerkleHash
    && researchReport.verifiedSourceWorkspaceManifestHash === verifiedSourceWorkspaceManifestHash;
}
