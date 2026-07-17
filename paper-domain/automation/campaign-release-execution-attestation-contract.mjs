import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 ._():-]{0,159}$/;

export const RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE = 'research_execution_release_attestor';
export const RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH = 'evidence/CAPSULE_MANIFEST.external-attestation.json';
export const RESEARCH_EXECUTION_RELEASE_ATTESTATION_MAXIMUM_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function payloadWithoutHash(record) {
  if (!record || typeof record !== 'object') return null;
  const { campaignReleaseExecutionAttestationHash: _hash, ...payload } = record;
  return payload;
}

function signingPayloadWithoutHash(record) {
  if (!record || typeof record !== 'object') return null;
  const { signature: _signature, campaignReleaseExecutionAttestationHash: _hash, ...payload } = record;
  return payload;
}

export function campaignReleaseExecutionAttestationSigningPayloadHash(record) {
  const payload = signingPayloadWithoutHash(record);
  return payload ? hashRecord('CampaignReleaseExecutionAttestationSigningPayload', payload) : null;
}

export function campaignReleaseExecutionAttestationDocumentFileHash(attestation) {
  return hashBytes(Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8'));
}

export function buildCampaignReleaseExecutionAttestationUnsignedPayload({
  manifest,
  manifestFileHash,
  signer,
  signedAt,
  validFrom = signedAt,
  expiresAt,
} = {}) {
  return Object.freeze({
    version: 1,
    kind: 'CampaignReleaseExecutionAttestation',
    status: 'campaign_release_execution_attested',
    assurance: 'external-release-root-manifest-and-recorded-execution-lineage-attestation-v1',
    keyId: String(signer?.keyId || ''),
    keyVersion: String(signer?.keyVersion || ''),
    subjectId: String(signer?.subjectId || ''),
    organization: signer?.organization ? String(signer.organization) : null,
    role: RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    researchEvidenceCapsuleManifestHash: String(manifest?.researchEvidenceCapsuleManifestHash || ''),
    researchEvidenceCapsuleManifestFileHash: String(manifestFileHash || ''),
    campaignId: String(manifest?.campaignId || ''),
    paperId: String(manifest?.paperId || ''),
    researchReportHash: String(manifest?.researchReportHash || ''),
    experimentRegistryHash: String(manifest?.experimentRegistryHash || ''),
    campaignResearchSourceSnapshotHash: manifest?.campaignResearchSourceSnapshotHash || null,
    verifiedSourceMerkleHash: String(manifest?.verifiedSourceMerkleHash || ''),
    verifiedSourceWorkspaceManifestHash: String(manifest?.verifiedSourceWorkspaceManifestHash || ''),
    researchVerifyNodeId: String(manifest?.researchVerifyNodeId || ''),
    researchVerifyAttemptId: String(manifest?.researchVerifyAttemptId || ''),
    researchVerifyLeaseGeneration: Number(manifest?.researchVerifyLeaseGeneration),
    academicExperimentCount: Number(manifest?.academicExperimentCount),
    experimentCount: Number(manifest?.experimentCount),
    signedAt: new Date(signedAt).toISOString(),
    validFrom: new Date(validFrom).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    privateKeyIncluded: false,
    publicKeyIncluded: false,
    trustAnchorIncluded: false,
    recordedExecutionLineageAttested: true,
    executionAuthenticityAttested: false,
    externalActionPerformed: false,
  });
}

export function finalizeCampaignReleaseExecutionAttestation({ unsignedPayload, signature } = {}) {
  const signed = Object.freeze({ ...unsignedPayload, signature: String(signature || '') });
  const attestation = Object.freeze({
    ...signed,
    campaignReleaseExecutionAttestationHash: hashRecord('CampaignReleaseExecutionAttestation', signed),
  });
  const verification = verifyCampaignReleaseExecutionAttestationStructure(attestation);
  if (!verification.valid) throw new Error(`campaign_release_execution_attestation_invalid:${verification.blockers.join(',')}`);
  return attestation;
}

export function verifyCampaignReleaseExecutionAttestationStructure(attestation, expected = {}) {
  const blockers = [];
  const payload = payloadWithoutHash(attestation);
  if (attestation?.version !== 1 || attestation?.kind !== 'CampaignReleaseExecutionAttestation'
    || attestation?.status !== 'campaign_release_execution_attested'
    || attestation?.assurance !== 'external-release-root-manifest-and-recorded-execution-lineage-attestation-v1'
    || attestation?.role !== RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE
    || attestation?.algorithm !== 'ed25519'
    || attestation?.privateKeyIncluded !== false || attestation?.publicKeyIncluded !== false
    || attestation?.trustAnchorIncluded !== false
    || attestation?.recordedExecutionLineageAttested !== true
    || attestation?.executionAuthenticityAttested !== false
    || attestation?.externalActionPerformed !== false) {
    blockers.push('campaign_release_execution_attestation_shape_invalid');
  }
  if (!payload || !SHA256.test(String(attestation?.campaignReleaseExecutionAttestationHash || ''))
    || hashRecord('CampaignReleaseExecutionAttestation', payload)
      !== attestation?.campaignReleaseExecutionAttestationHash) {
    blockers.push('campaign_release_execution_attestation_hash_invalid');
  }
  if (![attestation?.keyId, attestation?.keyVersion, attestation?.subjectId, attestation?.role]
    .every((value) => ID.test(String(value || '')))
    || !ORGANIZATION.test(String(attestation?.organization || ''))
    || typeof attestation?.signature !== 'string' || !/^[A-Za-z0-9+/]{80,120}={0,2}$/.test(attestation.signature)) {
    blockers.push('campaign_release_execution_attestation_signer_invalid');
  }
  for (const field of ['researchEvidenceCapsuleManifestHash', 'researchEvidenceCapsuleManifestFileHash',
    'researchReportHash', 'experimentRegistryHash', 'verifiedSourceMerkleHash',
    'verifiedSourceWorkspaceManifestHash']) {
    if (!SHA256.test(String(attestation?.[field] || ''))) blockers.push(`campaign_release_execution_attestation_${field}_invalid`);
    if (expected[field] && attestation?.[field] !== expected[field]) blockers.push(`campaign_release_execution_attestation_${field}_mismatch`);
  }
  for (const field of ['campaignId', 'paperId', 'researchVerifyNodeId', 'researchVerifyAttemptId']) {
    if (!String(attestation?.[field] || '')) blockers.push(`campaign_release_execution_attestation_${field}_required`);
    if (expected[field] && attestation?.[field] !== expected[field]) blockers.push(`campaign_release_execution_attestation_${field}_mismatch`);
  }
  if (expected.campaignResearchSourceSnapshotHash
    && attestation?.campaignResearchSourceSnapshotHash !== expected.campaignResearchSourceSnapshotHash) {
    blockers.push('campaign_release_execution_attestation_campaign_source_snapshot_mismatch');
  }
  if (!Number.isSafeInteger(Number(attestation?.researchVerifyLeaseGeneration))
    || Number(attestation.researchVerifyLeaseGeneration) < 1
    || !Number.isSafeInteger(Number(attestation?.experimentCount)) || Number(attestation.experimentCount) < 1
    || !Number.isSafeInteger(Number(attestation?.academicExperimentCount))
    || Number(attestation.academicExperimentCount) < 1
    || Number(attestation.academicExperimentCount) > Number(attestation.experimentCount)) {
    blockers.push('campaign_release_execution_attestation_counts_invalid');
  }
  const signedAt = Date.parse(String(attestation?.signedAt || ''));
  const validFrom = Date.parse(String(attestation?.validFrom || ''));
  const expiresAt = Date.parse(String(attestation?.expiresAt || ''));
  if (![signedAt, validFrom, expiresAt].every(Number.isFinite)
    || validFrom < signedAt || expiresAt <= validFrom
    || expiresAt - signedAt > RESEARCH_EXECUTION_RELEASE_ATTESTATION_MAXIMUM_LIFETIME_MS) {
    blockers.push('campaign_release_execution_attestation_time_window_invalid');
  }
  if (expected.manifest) {
    const manifest = expected.manifest;
    for (const field of ['campaignId', 'paperId', 'researchReportHash', 'experimentRegistryHash',
      'campaignResearchSourceSnapshotHash', 'verifiedSourceMerkleHash', 'verifiedSourceWorkspaceManifestHash',
      'researchVerifyNodeId', 'researchVerifyAttemptId', 'researchVerifyLeaseGeneration',
      'academicExperimentCount', 'experimentCount']) {
      if ((attestation?.[field] ?? null) !== (manifest?.[field] ?? null)) {
        blockers.push(`campaign_release_execution_attestation_manifest_lineage_mismatch:${field}`);
      }
    }
    if (attestation?.signedAt !== manifest?.createdAt) {
      blockers.push('campaign_release_execution_attestation_manifest_lineage_mismatch:signedAt');
    }
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(unique(blockers)) });
}

export function verifyCampaignReleaseExecutionAttestationManifestBinding({
  manifest,
  attestation = null,
  manifestFileHash = null,
} = {}) {
  if (!manifest?.externalExecutionAttestationRequired) {
    return Object.freeze({
      valid: attestation === null,
      blockers: Object.freeze(attestation === null ? [] : ['unexpected_execution_attestation']),
    });
  }
  return verifyCampaignReleaseExecutionAttestationStructure(attestation, {
    manifest,
    researchEvidenceCapsuleManifestHash: manifest.researchEvidenceCapsuleManifestHash,
    ...(manifestFileHash ? { researchEvidenceCapsuleManifestFileHash: manifestFileHash } : {}),
  });
}
