import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  publicTrustStoreFromSnapshot,
  verifyPublicAuthorityTrustSnapshot,
} from './public-authority-trust-snapshot-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  'authorityInspectionStableAcrossPackaging', 'currentClockVerified',
  'externalActionPerformed', 'freshAuthorityInspection',
  'freshAuthorityInspectionHash', 'frozenAuthorityTrustStoreHash',
  'gpuScientificCampaignQualificationEvidenceHash',
  'gpuScientificReleaseAuthorityFreshnessReceiptHash',
  'initialAuthorityInspection', 'initialAuthorityInspectionHash',
  'initialObservedAt', 'kind', 'observedAt',
  'packageSnapshotMatchesFrozenTrustStore',
  'publicAuthorityTrustSnapshot', 'publicAuthorityTrustSnapshotHash',
  'researchEvidenceCapsuleManifestFileHash',
  'researchEvidenceCapsuleManifestHash',
  'researchExecutionReleaseAttestationHash', 'status', 'version',
]);

function recordHashValid(record, kind, hashField) {
  if (!record || typeof record !== 'object') return false;
  const { [hashField]: claimedHash, ...payload } = record;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord(kind, payload) === claimedHash;
}

function canonicalTimestamp(value) {
  const milliseconds = value instanceof Date
    ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function authorityInspectionValid(inspection, qualificationEvidenceHash) {
  return inspection?.version === 1
    && inspection?.kind
      === 'GpuScientificCampaignQualificationAuthorityInspection'
    && inspection?.status
      === 'gpu_scientific_campaign_qualification_authority_verified'
    && inspection?.valid === true
    && inspection?.structureVerified === true
    && inspection?.cryptographicSignaturesVerified === true
    && inspection?.authorityIdentityIndependenceVerified === true
    && Array.isArray(inspection?.blockers)
    && inspection.blockers.length === 0
    && inspection?.qualificationEvidenceHash === qualificationEvidenceHash
    && recordHashValid(
      inspection,
      'GpuScientificCampaignQualificationAuthorityInspection',
      'gpuScientificCampaignQualificationAuthorityInspectionHash',
    );
}

function qualificationAuthorityKeyIds(qualificationEvidence) {
  return [...new Set([
    ...(qualificationEvidence
      ?.gpuScientificCampaignSameDeviceReplayReceipt?.signatures || []),
    ...(qualificationEvidence
      ?.gpuScientificCampaignProductionQualificationAuthority?.signatures
      || []),
  ].map((signature) => String(signature?.keyId || '')).filter(Boolean))].sort();
}

export function verifyGpuScientificReleaseAuthorityFreshnessReceipt(
  receipt,
  {
    qualificationEvidence = null,
    researchEvidenceCapsuleManifest = null,
    researchEvidenceCapsuleManifestFileHash = null,
    researchExecutionReleaseAttestationHash = null,
    authorityInspectionVerifier = null,
    verificationTime = null,
  } = {},
) {
  const blockers = [];
  const qualificationEvidenceHash = qualificationEvidence
    ?.gpuScientificCampaignQualificationEvidenceHash || null;
  const initialObservedAt = canonicalTimestamp(receipt?.initialObservedAt);
  const observedAt = canonicalTimestamp(receipt?.observedAt);
  const authorityVerificationTime = canonicalTimestamp(
    verificationTime ?? receipt?.observedAt,
  );
  const snapshot = receipt?.publicAuthorityTrustSnapshot || null;
  const requiredKeyIds = qualificationAuthorityKeyIds(qualificationEvidence);
  const snapshotVerification = verifyPublicAuthorityTrustSnapshot(snapshot, {
    requiredKeyIds,
    allowAdditionalReferencedKeys: true,
  });
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)
    || receipt?.version !== 1
    || receipt?.kind !== 'GpuScientificReleaseAuthorityFreshnessReceipt'
    || receipt?.status
      !== 'gpu_scientific_release_authority_freshness_verified'
    || receipt?.authorityInspectionStableAcrossPackaging !== true
    || receipt?.packageSnapshotMatchesFrozenTrustStore !== true
    || receipt?.currentClockVerified !== true
    || receipt?.externalActionPerformed !== false) {
    blockers.push('gpu_scientific_release_authority_freshness_shape_invalid');
  }
  if (!recordHashValid(
    receipt,
    'GpuScientificReleaseAuthorityFreshnessReceipt',
    'gpuScientificReleaseAuthorityFreshnessReceiptHash',
  )) {
    blockers.push('gpu_scientific_release_authority_freshness_hash_invalid');
  }
  if (!SHA256.test(String(receipt?.frozenAuthorityTrustStoreHash || ''))
    || !SHA256.test(String(qualificationEvidenceHash || ''))
    || receipt?.gpuScientificCampaignQualificationEvidenceHash
      !== qualificationEvidenceHash) {
    blockers.push(
      'gpu_scientific_release_authority_freshness_qualification_binding_invalid',
    );
  }
  if (!authorityInspectionValid(
    receipt?.initialAuthorityInspection,
    qualificationEvidenceHash,
  ) || !authorityInspectionValid(
    receipt?.freshAuthorityInspection,
    qualificationEvidenceHash,
  ) || receipt?.initialAuthorityInspectionHash
      !== receipt?.initialAuthorityInspection
        ?.gpuScientificCampaignQualificationAuthorityInspectionHash
    || receipt?.freshAuthorityInspectionHash
      !== receipt?.freshAuthorityInspection
        ?.gpuScientificCampaignQualificationAuthorityInspectionHash
    || receipt?.initialAuthorityInspectionHash
      !== receipt?.freshAuthorityInspectionHash) {
    blockers.push(
      'gpu_scientific_release_authority_freshness_inspection_invalid',
    );
  }
  if (!initialObservedAt || !observedAt
    || receipt?.initialObservedAt !== initialObservedAt
    || receipt?.observedAt !== observedAt
    || Date.parse(initialObservedAt) > Date.parse(observedAt)
    || !canonicalTimestamp(snapshot?.capturedAt)
    || Date.parse(snapshot.capturedAt) > Date.parse(observedAt)) {
    blockers.push('gpu_scientific_release_authority_freshness_time_invalid');
  }
  if (!authorityVerificationTime) {
    blockers.push(
      'gpu_scientific_release_authority_freshness_verification_time_invalid',
    );
  }
  if (!snapshotVerification.valid
    || receipt?.publicAuthorityTrustSnapshotHash
      !== snapshot?.publicAuthorityTrustSnapshotHash
    || receipt?.publicAuthorityTrustSnapshotHash
      !== researchEvidenceCapsuleManifest
        ?.publicAuthorityTrustSnapshotHash) {
    blockers.push(
      'gpu_scientific_release_authority_freshness_snapshot_invalid',
      ...snapshotVerification.blockers,
    );
  }
  let cryptographicInspection = null;
  if (typeof authorityInspectionVerifier !== 'function') {
    blockers.push(
      'gpu_scientific_release_authority_freshness_cryptographic_verifier_required',
    );
  } else {
    try {
      cryptographicInspection = authorityInspectionVerifier({
        qualificationEvidence,
        trustStore: publicTrustStoreFromSnapshot(snapshot),
        observedAt: authorityVerificationTime,
      });
    } catch {
      cryptographicInspection = null;
    }
    if (!authorityInspectionValid(
      cryptographicInspection,
      qualificationEvidenceHash,
    ) || JSON.stringify(cryptographicInspection)
        !== JSON.stringify(receipt?.freshAuthorityInspection)) {
      blockers.push(
        'gpu_scientific_release_authority_freshness_cryptographic_verification_invalid',
      );
    }
  }
  if (receipt?.researchEvidenceCapsuleManifestHash
      !== researchEvidenceCapsuleManifest
        ?.researchEvidenceCapsuleManifestHash
    || receipt?.researchEvidenceCapsuleManifestFileHash
      !== researchEvidenceCapsuleManifestFileHash
    || receipt?.researchExecutionReleaseAttestationHash
      !== researchExecutionReleaseAttestationHash
    || ![
      receipt?.researchEvidenceCapsuleManifestHash,
      receipt?.researchEvidenceCapsuleManifestFileHash,
      receipt?.researchExecutionReleaseAttestationHash,
    ].every((value) => SHA256.test(String(value || '')))) {
    blockers.push(
      'gpu_scientific_release_authority_freshness_release_binding_invalid',
    );
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function buildGpuScientificReleaseAuthorityFreshnessReceipt({
  qualificationEvidence,
  initialAuthorityInspection,
  freshAuthorityInspection,
  initialObservedAt,
  observedAt,
  frozenAuthorityTrustStoreHash,
  publicAuthorityTrustSnapshot,
  researchEvidenceCapsuleManifest,
  researchEvidenceCapsuleManifestFileHash,
  researchExecutionReleaseAttestationHash,
  authorityInspectionVerifier = null,
} = {}) {
  const payload = {
    version: 1,
    kind: 'GpuScientificReleaseAuthorityFreshnessReceipt',
    status: 'gpu_scientific_release_authority_freshness_verified',
    gpuScientificCampaignQualificationEvidenceHash:
      qualificationEvidence
        ?.gpuScientificCampaignQualificationEvidenceHash || null,
    frozenAuthorityTrustStoreHash,
    initialAuthorityInspectionHash:
      initialAuthorityInspection
        ?.gpuScientificCampaignQualificationAuthorityInspectionHash || null,
    initialAuthorityInspection: structuredClone(initialAuthorityInspection),
    initialObservedAt: canonicalTimestamp(initialObservedAt),
    freshAuthorityInspectionHash:
      freshAuthorityInspection
        ?.gpuScientificCampaignQualificationAuthorityInspectionHash || null,
    freshAuthorityInspection: structuredClone(freshAuthorityInspection),
    observedAt: canonicalTimestamp(observedAt),
    publicAuthorityTrustSnapshotHash:
      publicAuthorityTrustSnapshot?.publicAuthorityTrustSnapshotHash || null,
    publicAuthorityTrustSnapshot:
      structuredClone(publicAuthorityTrustSnapshot),
    researchEvidenceCapsuleManifestHash:
      researchEvidenceCapsuleManifest
        ?.researchEvidenceCapsuleManifestHash || null,
    researchEvidenceCapsuleManifestFileHash,
    researchExecutionReleaseAttestationHash,
    authorityInspectionStableAcrossPackaging:
      initialAuthorityInspection
        ?.gpuScientificCampaignQualificationAuthorityInspectionHash
        === freshAuthorityInspection
          ?.gpuScientificCampaignQualificationAuthorityInspectionHash,
    packageSnapshotMatchesFrozenTrustStore: true,
    currentClockVerified: true,
    externalActionPerformed: false,
  };
  const receipt = deepFreezeJsonValue({
    ...payload,
    gpuScientificReleaseAuthorityFreshnessReceiptHash: hashRecord(
      'GpuScientificReleaseAuthorityFreshnessReceipt',
      payload,
    ),
  });
  const verification = verifyGpuScientificReleaseAuthorityFreshnessReceipt(
    receipt,
    {
      qualificationEvidence,
      researchEvidenceCapsuleManifest,
      researchEvidenceCapsuleManifestFileHash,
      researchExecutionReleaseAttestationHash,
      authorityInspectionVerifier,
    },
  );
  if (!verification.valid) {
    throw new Error(
      `gpu_scientific_release_authority_freshness_receipt_invalid:${verification.blockers.join(',')}`,
    );
  }
  return receipt;
}
