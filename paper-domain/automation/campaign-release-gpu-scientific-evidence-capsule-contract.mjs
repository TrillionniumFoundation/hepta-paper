import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
  verifyGpuScientificArtifactBodyArchiveManifest,
} from './gpu-scientific-artifact-body-archive-contract.mjs';
import {
  verifyGpuScientificCampaignQualificationEvidence,
} from './gpu-scientific-campaign-promotion-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH =
  'evidence/GPU_SCIENTIFIC_CAMPAIGN_QUALIFICATION_EVIDENCE.json';
export const CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE =
  'gpu_scientific_campaign_qualification_evidence';
export const CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE =
  'gpu_scientific_artifact_body_archive_manifest';

const DESCRIPTOR_KEYS = Object.freeze([
  'archiveBodyCount', 'archiveEntries', 'archiveTotalBytes',
  'artifactArchiveManifestFileBytes', 'artifactArchiveManifestFileHash',
  'artifactArchiveManifestPath', 'artifactBodySetHash',
  'executionPlanHash', 'externalActionPerformed',
  'gpuScientificArtifactBodyArchiveManifestHash',
  'gpuScientificCampaignExecutionResultHash',
  'gpuScientificCampaignQualificationEvidenceHash',
  'gpuScientificEvidenceDescriptorHash', 'kind',
  'qualificationEvidenceFileBytes', 'qualificationEvidenceFileHash',
  'qualificationEvidencePath', 'scientificOutputCommitmentHash',
  'version',
]);

function recordPayload(record, hashField) {
  if (!record || typeof record !== 'object') return null;
  const { [hashField]: _claimedHash, ...payload } = record;
  return payload;
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...keys].sort()));
}

function lineageBlockers(archive, qualification) {
  const request = qualification?.gpuScientificCampaignQualificationRequest;
  return [
    archive?.campaignId === qualification?.campaignId ? null : 'campaign_id',
    archive?.paperId === qualification?.paperId ? null : 'paper_id',
    archive?.executionResultHash
      === qualification?.gpuScientificCampaignExecutionResultHash
      ? null : 'execution_result_hash',
    archive?.gpuScientificArtifactBodyArchiveManifestHash
      === qualification?.artifactArchiveManifestHash
      ? null : 'archive_manifest_hash',
    archive?.scientificOutputCommitmentHash
      === qualification?.scientificOutputCommitmentHash
      ? null : 'scientific_output_commitment_hash',
    request?.campaignPlanHash === archive?.campaignPlanHash
      ? null : 'campaign_plan_hash',
    request?.nodeId === archive?.nodeId ? null : 'node_id',
    request?.attemptId === archive?.attemptId ? null : 'attempt_id',
    Number(request?.leaseGeneration) === Number(archive?.leaseGeneration)
      ? null : 'lease_generation',
    request?.executionPlanHash === archive?.executionPlanHash
      ? null : 'execution_plan_hash',
    request?.taskSetHash === archive?.taskSetHash ? null : 'task_set_hash',
    request?.gpuDeviceSelector === archive?.gpuDeviceSelector
      ? null : 'gpu_device_selector',
    request?.gpuScientificCampaignAttemptAuthorityHash
      === archive?.gpuScientificCampaignAttemptAuthorityHash
      ? null : 'attempt_authority_hash',
    request?.pdeTaskReceiptHash === archive?.pdeScientificReceiptHash
      ? null : 'pde_task_receipt_hash',
    request?.deepLearningTaskReceiptHash
      === archive?.deepLearningTrainingReceiptHash
      ? null : 'deep_learning_task_receipt_hash',
    request?.runtimeImageDigest === archive?.runtimeImageDigest
      ? null : 'runtime_image_digest',
    request?.runtimePackageClosureHash === archive?.runtimePackageClosureHash
      ? null : 'runtime_package_closure_hash',
    request?.originalExecutionProcessIdentityHashes?.pde
      === archive?.originalExecutionProcessIdentityHashes?.pde
      && request?.originalExecutionProcessIdentityHashes?.deepLearning
        === archive?.originalExecutionProcessIdentityHashes?.deepLearning
      ? null : 'execution_process_identity_hashes',
  ].filter(Boolean);
}

function archiveDescriptorEntries(archive, byRole) {
  return archive.entries.map((archiveEntry) => {
    const entry = byRole.get(archiveEntry.role);
    if (entry?.path !== archiveEntry.packageRelativePath
      || entry?.hash !== archiveEntry.sha256
      || Number(entry?.bytes) !== Number(archiveEntry.bytes)
      || entry?.executionRole !== 'base' || entry?.experimentId !== null) {
      throw new Error('campaign_release_gpu_scientific_archive_entry_invalid');
    }
    return Object.freeze({
      role: archiveEntry.role,
      path: archiveEntry.packageRelativePath,
      hash: archiveEntry.sha256,
      bytes: Number(archiveEntry.bytes),
    });
  });
}

export function buildCampaignReleaseGpuScientificEvidenceDescriptor({
  entries,
  artifactArchiveManifest,
  qualificationEvidence,
} = {}) {
  const archiveInspection = verifyGpuScientificArtifactBodyArchiveManifest(
    artifactArchiveManifest,
  );
  const qualificationValid = verifyGpuScientificCampaignQualificationEvidence(
    qualificationEvidence,
  );
  const lineage = lineageBlockers(
    artifactArchiveManifest,
    qualificationEvidence,
  );
  if (!archiveInspection.valid || !qualificationValid || lineage.length) {
    const reason = !archiveInspection.valid
      ? `archive:${archiveInspection.blockers.join(',')}`
      : !qualificationValid ? 'qualification' : `lineage:${lineage.join(',')}`;
    throw new Error(`campaign_release_gpu_scientific_evidence_invalid:${reason}`);
  }
  const byRole = new Map(entries.map((entry) => [entry.role, entry]));
  const qualificationFile = byRole.get(
    CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
  );
  const archiveManifestFile = byRole.get(
    CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
  );
  const archiveEntries = archiveDescriptorEntries(
    artifactArchiveManifest,
    byRole,
  );
  if (qualificationFile?.path
      !== CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH
    || qualificationFile?.executionRole !== 'base'
    || qualificationFile?.experimentId !== null
    || archiveManifestFile?.path
      !== GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH
    || archiveManifestFile?.executionRole !== 'base'
    || archiveManifestFile?.experimentId !== null) {
    throw new Error('campaign_release_gpu_scientific_evidence_file_invalid');
  }
  const payload = {
    version: 1,
    kind: 'CampaignReleaseGpuScientificEvidenceDescriptor',
    gpuScientificCampaignExecutionResultHash:
      qualificationEvidence.gpuScientificCampaignExecutionResultHash,
    executionPlanHash: artifactArchiveManifest.executionPlanHash,
    gpuScientificCampaignQualificationEvidenceHash:
      qualificationEvidence.gpuScientificCampaignQualificationEvidenceHash,
    qualificationEvidencePath: qualificationFile.path,
    qualificationEvidenceFileHash: qualificationFile.hash,
    qualificationEvidenceFileBytes: Number(qualificationFile.bytes),
    gpuScientificArtifactBodyArchiveManifestHash:
      artifactArchiveManifest.gpuScientificArtifactBodyArchiveManifestHash,
    artifactArchiveManifestPath: archiveManifestFile.path,
    artifactArchiveManifestFileHash: archiveManifestFile.hash,
    artifactArchiveManifestFileBytes: Number(archiveManifestFile.bytes),
    artifactBodySetHash: artifactArchiveManifest.artifactBodySetHash,
    scientificOutputCommitmentHash:
      artifactArchiveManifest.scientificOutputCommitmentHash,
    archiveBodyCount: artifactArchiveManifest.bodyCount,
    archiveTotalBytes: artifactArchiveManifest.totalBytes,
    archiveEntries: Object.freeze(archiveEntries),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    gpuScientificEvidenceDescriptorHash: hashRecord(
      'CampaignReleaseGpuScientificEvidenceDescriptor',
      payload,
    ),
  });
}

export function campaignReleaseGpuScientificExpectedEntryRoles(manifest) {
  if (manifest?.gpuScientificEvidenceIncluded !== true) return Object.freeze([]);
  return Object.freeze([
    CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
    CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
    ...(manifest?.gpuScientificEvidence?.archiveEntries || [])
      .map((entry) => entry.role),
  ]);
}

export function verifyCampaignReleaseGpuScientificEvidenceDescriptor(manifest) {
  const descriptor = manifest?.gpuScientificEvidence;
  if (!exactKeys(descriptor, DESCRIPTOR_KEYS)
    || descriptor?.version !== 1
    || descriptor?.kind !== 'CampaignReleaseGpuScientificEvidenceDescriptor'
    || descriptor?.externalActionPerformed !== false) return false;
  const payload = recordPayload(
    descriptor,
    'gpuScientificEvidenceDescriptorHash',
  );
  if (!payload || hashRecord(
    'CampaignReleaseGpuScientificEvidenceDescriptor',
    payload,
  ) !== descriptor.gpuScientificEvidenceDescriptorHash) return false;
  const archiveEntries = Array.isArray(descriptor.archiveEntries)
    ? descriptor.archiveEntries : [];
  const byRole = new Map((manifest.entries || []).map((entry) => [entry.role, entry]));
  const qualificationFile = byRole.get(
    CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
  );
  const archiveManifestFile = byRole.get(
    CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
  );
  return SHA256.test(String(descriptor.gpuScientificCampaignExecutionResultHash || ''))
    && SHA256.test(String(descriptor.executionPlanHash || ''))
    && SHA256.test(String(descriptor.gpuScientificCampaignQualificationEvidenceHash || ''))
    && SHA256.test(String(descriptor.gpuScientificArtifactBodyArchiveManifestHash || ''))
    && SHA256.test(String(descriptor.artifactBodySetHash || ''))
    && SHA256.test(String(descriptor.scientificOutputCommitmentHash || ''))
    && archiveEntries.length === 9
    && Number(descriptor.archiveBodyCount) === archiveEntries.length
    && Number(descriptor.archiveTotalBytes)
      === archiveEntries.reduce((total, entry) => total + Number(entry?.bytes || 0), 0)
    && new Set(archiveEntries.map((entry) => entry?.role)).size === archiveEntries.length
    && new Set(archiveEntries.map((entry) => entry?.path)).size === archiveEntries.length
    && archiveEntries.every((archiveEntry) => {
      const entry = byRole.get(archiveEntry?.role);
      return String(archiveEntry?.path || '').startsWith('evidence/gpu-scientific/')
        && SHA256.test(String(archiveEntry?.hash || ''))
        && Number.isSafeInteger(Number(archiveEntry?.bytes))
        && Number(archiveEntry.bytes) > 0
        && entry?.path === archiveEntry.path
        && entry?.hash === archiveEntry.hash
        && Number(entry?.bytes) === Number(archiveEntry.bytes);
    })
    && qualificationFile?.path === descriptor.qualificationEvidencePath
    && qualificationFile?.hash === descriptor.qualificationEvidenceFileHash
    && Number(qualificationFile?.bytes)
      === Number(descriptor.qualificationEvidenceFileBytes)
    && archiveManifestFile?.path === descriptor.artifactArchiveManifestPath
    && archiveManifestFile?.hash === descriptor.artifactArchiveManifestFileHash
    && Number(archiveManifestFile?.bytes)
      === Number(descriptor.artifactArchiveManifestFileBytes);
}

export function campaignReleaseGpuScientificEvidenceDocumentsValid({
  manifest,
  artifactArchiveManifest,
  qualificationEvidence,
} = {}) {
  const descriptor = manifest?.gpuScientificEvidence;
  return verifyCampaignReleaseGpuScientificEvidenceDescriptor(manifest)
    && verifyGpuScientificArtifactBodyArchiveManifest(
      artifactArchiveManifest,
      {
        campaignId: manifest?.campaignId,
        paperId: manifest?.paperId,
        executionPlanHash: descriptor?.executionPlanHash,
        executionResultHash:
          descriptor?.gpuScientificCampaignExecutionResultHash,
        gpuScientificArtifactBodyArchiveManifestHash:
          descriptor?.gpuScientificArtifactBodyArchiveManifestHash,
        artifactBodySetHash: descriptor?.artifactBodySetHash,
        scientificOutputCommitmentHash:
          descriptor?.scientificOutputCommitmentHash,
      },
    ).valid
    && verifyGpuScientificCampaignQualificationEvidence(
      qualificationEvidence,
      {
        campaignId: manifest?.campaignId,
        paperId: manifest?.paperId,
        gpuScientificCampaignExecutionResultHash:
          descriptor?.gpuScientificCampaignExecutionResultHash,
        artifactArchiveManifestHash:
          descriptor?.gpuScientificArtifactBodyArchiveManifestHash,
        scientificOutputCommitmentHash:
          descriptor?.scientificOutputCommitmentHash,
      },
    )
    && qualificationEvidence?.gpuScientificCampaignQualificationEvidenceHash
      === descriptor?.gpuScientificCampaignQualificationEvidenceHash
    && lineageBlockers(
      artifactArchiveManifest,
      qualificationEvidence,
    ).length === 0;
}
