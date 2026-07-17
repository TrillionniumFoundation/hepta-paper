import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { workspaceExecutionMerkleHash } from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';
import { hashPaperRecord, hashPaperSemanticIdentity } from '../contracts/primitives.mjs';
import { verifyExperimentRegistry } from '../research/experiment-registry-verifier.mjs';
import { verifyCampaignResearchSourceSnapshot } from './campaign-research-contract.mjs';

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
