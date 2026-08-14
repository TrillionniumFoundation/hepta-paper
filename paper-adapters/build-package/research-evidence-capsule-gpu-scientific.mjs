import {
  CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
  CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH,
  CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
  campaignReleaseGpuScientificEvidenceDocumentsValid,
} from '../../paper-domain/automation/campaign-release-gpu-scientific-evidence-capsule-contract.mjs';
import {
  GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  publicTrustStoreFromSnapshot,
} from '../../paper-domain/automation/public-authority-trust-snapshot-contract.mjs';
import {
  verifyGpuScientificCampaignQualificationEvidenceAuthority,
} from '../automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';
import {
  verifyOfflinePublicAuthorityTrustAnchors,
} from './offline-operator-dataset-authority-verifier.mjs';
import {
  materializeGpuScientificArtifactBodyArchiveSync,
  verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync,
} from './gpu-scientific-artifact-body-archive.mjs';

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function inputState({
  gpuScientificExecutionPlan,
  gpuScientificExecutionNode,
  gpuScientificExecutionResult,
  gpuScientificQualificationEvidence,
  gpuScientificArtifactBodyArchiveManifest,
} = {}) {
  const core = [
    gpuScientificExecutionPlan,
    gpuScientificExecutionNode,
    gpuScientificExecutionResult,
    gpuScientificQualificationEvidence,
  ];
  const count = core.filter(Boolean).length;
  if ((count !== 0 && count !== core.length)
    || (gpuScientificArtifactBodyArchiveManifest && count === 0)) {
    throw new Error('research_evidence_capsule_gpu_scientific_inputs_incomplete');
  }
  return count === core.length;
}

function capsuleFile({ role, path, hash, bytes, content = undefined }) {
  return Object.freeze({
    role,
    path,
    hash,
    bytes: Number(bytes),
    executionRole: 'base',
    experimentId: null,
    ...(content ? { content } : {}),
  });
}

function archiveCapsuleFiles(archive) {
  return [
    capsuleFile({
      role: CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
      path: archive.manifestFile.packageRelativePath,
      hash: archive.manifestFile.hash,
      bytes: archive.manifestFile.bytes,
    }),
    ...archive.bodyFiles.map((file) => capsuleFile({
      role: file.archiveRole,
      path: file.packageRelativePath,
      hash: file.hash,
      bytes: file.bytes,
    })),
  ];
}

export function prepareCampaignReleaseGpuScientificCapsuleEvidenceSync({
  runtimeRoot,
  packageDir,
  campaignId,
  paperId,
  gpuScientificExecutionPlan = null,
  gpuScientificExecutionNode = null,
  gpuScientificExecutionResult = null,
  gpuScientificQualificationEvidence = null,
  gpuScientificArtifactBodyArchiveManifest = null,
} = {}) {
  const included = inputState({
    gpuScientificExecutionPlan,
    gpuScientificExecutionNode,
    gpuScientificExecutionResult,
    gpuScientificQualificationEvidence,
    gpuScientificArtifactBodyArchiveManifest,
  });
  if (!included) return Object.freeze({
    included: false,
    files: Object.freeze([]),
    qualificationFile: null,
    authoritySummary: null,
    referencedAuthorityKeyIds: Object.freeze([]),
    artifactBodyArchive: null,
  });
  const artifactBodyArchive = materializeGpuScientificArtifactBodyArchiveSync({
    runtimeRoot,
    packageDir,
    campaign: {
      campaignId,
      paperId,
      spec: {
        campaignPlanHash: gpuScientificExecutionResult?.campaignPlanHash,
        gpuScientificExecutionPlan,
      },
    },
    node: gpuScientificExecutionNode,
    executionPlan: gpuScientificExecutionPlan,
    executionResult: gpuScientificExecutionResult,
  });
  if (gpuScientificArtifactBodyArchiveManifest
    && gpuScientificArtifactBodyArchiveManifest
      .gpuScientificArtifactBodyArchiveManifestHash
      !== artifactBodyArchive.manifest
        .gpuScientificArtifactBodyArchiveManifestHash) {
    throw new Error('research_evidence_capsule_gpu_scientific_archive_manifest_mismatch');
  }
  const qualificationContent = jsonBytes(gpuScientificQualificationEvidence);
  const qualificationFile = capsuleFile({
    role: CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
    path: CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH,
    hash: hashBytes(qualificationContent),
    bytes: qualificationContent.length,
    content: qualificationContent,
  });
  const replaySignature = gpuScientificQualificationEvidence
    .gpuScientificCampaignSameDeviceReplayReceipt.signatures[0];
  const productionSignature = gpuScientificQualificationEvidence
    .gpuScientificCampaignProductionQualificationAuthority.signatures[0];
  if (!replaySignature?.keyId || !productionSignature?.keyId
    || replaySignature.role !== GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE
    || productionSignature.role
      !== GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE
    || replaySignature.keyId === productionSignature.keyId) {
    throw new Error('research_evidence_capsule_gpu_scientific_authority_signatures_invalid');
  }
  const authoritySummary = Object.freeze({
    version: 1,
    kind: 'CampaignReleaseGpuScientificQualificationAuthoritySummary',
    qualificationEvidenceHash: gpuScientificQualificationEvidence
      .gpuScientificCampaignQualificationEvidenceHash,
    replayAuthorityKeyId: replaySignature.keyId,
    replayAuthorityRole: GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
    productionQualificationAuthorityKeyId: productionSignature.keyId,
    productionQualificationAuthorityRole:
      GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
    packageInternalSignatureVerificationRequired: true,
    externalTrustAnchorRequired: true,
  });
  return Object.freeze({
    included: true,
    files: Object.freeze([
      qualificationFile,
      ...archiveCapsuleFiles(artifactBodyArchive),
    ]),
    qualificationFile,
    qualificationEvidence: gpuScientificQualificationEvidence,
    authoritySummary,
    referencedAuthorityKeyIds: Object.freeze([
      replaySignature.keyId,
      productionSignature.keyId,
    ].sort()),
    artifactBodyArchive,
  });
}

export function verifyCampaignReleaseGpuScientificCapsuleDirectorySync({
  packageDir,
  manifest,
  documents,
  publicAuthorityTrustSnapshot = null,
  trustedAuthorityRoots = null,
  verificationTime = null,
} = {}) {
  if (manifest?.gpuScientificEvidenceIncluded !== true) return Object.freeze({
    valid: true,
    blockers: Object.freeze([]),
    qualificationEvidence: null,
    artifactArchiveManifest: null,
    artifactBodyArchiveVerification: null,
    qualificationAuthorityInspection: null,
    externalAuthorityTrustVerification: null,
  });
  const descriptor = manifest.gpuScientificEvidence;
  const qualificationEvidence = documents.get(
    CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH,
  ) || null;
  const artifactArchiveManifest = documents.get(
    descriptor.artifactArchiveManifestPath,
  ) || null;
  const blockers = [];
  if (!campaignReleaseGpuScientificEvidenceDocumentsValid({
    manifest,
    artifactArchiveManifest,
    qualificationEvidence,
  })) blockers.push('research_evidence_capsule_gpu_scientific_document_binding_invalid');
  const artifactBodyArchiveVerification =
    verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync({
      packageDir,
      expected: {
        campaignId: manifest.campaignId,
        paperId: manifest.paperId,
        executionPlanHash: descriptor.executionPlanHash,
        executionResultHash:
          descriptor.gpuScientificCampaignExecutionResultHash,
        gpuScientificArtifactBodyArchiveManifestHash:
          descriptor.gpuScientificArtifactBodyArchiveManifestHash,
        artifactBodySetHash: descriptor.artifactBodySetHash,
        scientificOutputCommitmentHash:
          descriptor.scientificOutputCommitmentHash,
      },
    });
  if (!artifactBodyArchiveVerification.valid
    || artifactBodyArchiveVerification.manifestFileHash
      !== descriptor.artifactArchiveManifestFileHash
    || Number(artifactBodyArchiveVerification.manifestFileBytes)
      !== Number(descriptor.artifactArchiveManifestFileBytes)) {
    blockers.push(...artifactBodyArchiveVerification.blockers.map((blocker) => (
      `research_evidence_capsule_gpu_scientific_archive_invalid:${blocker}`
    )), 'research_evidence_capsule_gpu_scientific_archive_binding_invalid');
  }
  const replayKeyId = qualificationEvidence
    ?.gpuScientificCampaignSameDeviceReplayReceipt?.signatures?.[0]?.keyId;
  const productionKeyId = qualificationEvidence
    ?.gpuScientificCampaignProductionQualificationAuthority
    ?.signatures?.[0]?.keyId;
  const authoritySummary = documents.get(
    'evidence/PUBLIC_AUTHORITY_EVIDENCE.json',
  )?.gpuScientificQualificationAuthority;
  if (authoritySummary?.qualificationEvidenceHash
      !== qualificationEvidence?.gpuScientificCampaignQualificationEvidenceHash
    || authoritySummary?.replayAuthorityKeyId !== replayKeyId
    || authoritySummary?.productionQualificationAuthorityKeyId
      !== productionKeyId
    || authoritySummary?.packageInternalSignatureVerificationRequired !== true
    || authoritySummary?.externalTrustAnchorRequired !== true) {
    blockers.push('research_evidence_capsule_gpu_scientific_authority_summary_invalid');
  }
  const authorityVerificationTime = new Date(
    verificationTime || manifest?.createdAt,
  );
  const qualificationAuthorityInspection =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence,
      trustStore: publicTrustStoreFromSnapshot(
        publicAuthorityTrustSnapshot,
      ),
      now: authorityVerificationTime,
    });
  if (!qualificationAuthorityInspection.valid) {
    blockers.push(...qualificationAuthorityInspection.blockers.map((blocker) => (
      `research_evidence_capsule_gpu_scientific_authority_invalid:${blocker}`
    )));
  }
  const externalAuthorityTrustVerification =
    verifyOfflinePublicAuthorityTrustAnchors({
      trustSnapshot: publicAuthorityTrustSnapshot,
      keyIds: [replayKeyId, productionKeyId],
      trustedAuthorityRoots,
      verificationTime: authorityVerificationTime,
    });
  if (!externalAuthorityTrustVerification.valid) {
    blockers.push(...externalAuthorityTrustVerification.blockers.map((blocker) => (
      `research_evidence_capsule_gpu_scientific_trust_invalid:${blocker}`
    )));
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    qualificationEvidence,
    artifactArchiveManifest,
    artifactBodyArchiveVerification,
    qualificationAuthorityInspection,
    externalAuthorityTrustVerification,
  });
}
