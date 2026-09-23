import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildGpuScientificReleaseAuthorityFreshnessReceipt,
} from '../../paper-domain/automation/gpu-scientific-release-authority-freshness-receipt-contract.mjs';
import {
  buildPublicAuthorityTrustSnapshot,
  publicTrustStoreFromSnapshot,
} from '../../paper-domain/automation/public-authority-trust-snapshot-contract.mjs';
import {
  parseResearchEvidenceCapsuleJson,
  readResearchEvidenceCapsuleFile,
} from '../build-package/research-evidence-capsule-directory-reader.mjs';

function freshnessError(reason, receipt = null, cause = null) {
  const error = new Error(
    `campaign_release_gpu_scientific_authority_freshness_blocked:${reason}`,
    cause ? { cause } : undefined,
  );
  error.code = 'campaign_release_gpu_scientific_authority_freshness_blocked';
  error.retryable = false;
  error.receipt = receipt;
  return error;
}

export function campaignReleaseGpuScientificAuthorityObservedAt(clock) {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  const milliseconds = value instanceof Date
    ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) throw freshnessError('current_clock_invalid');
  return new Date(milliseconds).toISOString();
}

export function freezeCampaignReleaseGpuScientificAuthorityTrustStore({
  trustStoreProvider,
  runtimeRoot,
} = {}) {
  if (typeof trustStoreProvider !== 'function') {
    throw freshnessError('trust_store_provider_required');
  }
  try {
    return deepFreezeJsonValue(structuredClone(
      trustStoreProvider({ runtimeRoot }),
    ));
  } catch (cause) {
    throw freshnessError('trust_store_snapshot_failed', null, cause);
  }
}

export function assertCurrentGpuScientificQualificationAuthority({
  gpuScientificExecutionPlan,
  gpuScientificResearchEvidence,
  gpuScientificPromotionAuthorityVerifier,
  trustStore = null,
  observedAt = null,
} = {}) {
  if (!gpuScientificExecutionPlan) return null;
  if (typeof gpuScientificPromotionAuthorityVerifier?.verify !== 'function') {
    const error = new Error(
      'campaign_release_gpu_scientific_authority_verifier_required',
    );
    error.code = 'campaign_release_gpu_scientific_authority_verifier_required';
    error.retryable = false;
    throw error;
  }
  const qualificationEvidence =
    gpuScientificResearchEvidence?.qualificationEvidence || null;
  let inspection;
  try {
    inspection = gpuScientificPromotionAuthorityVerifier.verify({
      qualificationEvidence,
      trustStore,
      observedAt,
    });
  } catch (cause) {
    throw freshnessError('verification_failed', qualificationEvidence, cause);
  }
  const {
    gpuScientificCampaignQualificationAuthorityInspectionHash: claimedHash,
    ...inspectionPayload
  } = inspection || {};
  const blockers = Array.isArray(inspection?.blockers)
    ? inspection.blockers.filter(Boolean) : [];
  if (!qualificationEvidence
    || gpuScientificResearchEvidence?.qualificationEvidenceHash
      !== qualificationEvidence.gpuScientificCampaignQualificationEvidenceHash
    || inspection?.version !== 1
    || inspection?.kind
      !== 'GpuScientificCampaignQualificationAuthorityInspection'
    || inspection?.status
      !== 'gpu_scientific_campaign_qualification_authority_verified'
    || inspection?.valid !== true
    || blockers.length !== 0
    || inspection?.structureVerified !== true
    || inspection?.cryptographicSignaturesVerified !== true
    || inspection?.authorityIdentityIndependenceVerified !== true
    || inspection?.qualificationEvidenceHash
      !== qualificationEvidence.gpuScientificCampaignQualificationEvidenceHash
    || claimedHash !== hashRecord(
      'GpuScientificCampaignQualificationAuthorityInspection',
      inspectionPayload,
    )) {
    throw freshnessError(
      blockers.join(',') || 'inspection_invalid',
      inspection || qualificationEvidence,
    );
  }
  return inspection;
}

export function verifyPackagedGpuScientificAuthorityFreshness({
  packageResult,
  qualificationEvidence,
  initialAuthorityInspection,
  initialObservedAt,
  frozenAuthorityTrustStore,
  gpuScientificPromotionAuthorityVerifier,
  clock,
} = {}) {
  const manifest = packageResult?.researchEvidenceCapsule?.manifest || null;
  const snapshotEntries = (manifest?.entries || []).filter(
    (entry) => entry?.role === 'public_authority_trust_snapshot',
  );
  const snapshotEntry = snapshotEntries.length === 1
    ? snapshotEntries[0] : null;
  const packageDir = packageResult?.packageDirAbsolute || null;
  const snapshotRead = packageDir && snapshotEntry?.path
    ? readResearchEvidenceCapsuleFile(
      packageDir,
      snapshotEntry.path,
      16 * 1024 * 1024,
    ) : null;
  const publicAuthorityTrustSnapshot = snapshotRead?.content
    ? parseResearchEvidenceCapsuleJson(snapshotRead.content) : null;
  if (!snapshotEntry || !snapshotRead?.content
    || snapshotRead.hash !== snapshotEntry.hash
    || Number(snapshotRead.bytes) !== Number(snapshotEntry.bytes)
    || publicAuthorityTrustSnapshot?.publicAuthorityTrustSnapshotHash
      !== manifest?.publicAuthorityTrustSnapshotHash) {
    throw freshnessError(
      'package_trust_snapshot_invalid',
      publicAuthorityTrustSnapshot || snapshotRead,
    );
  }
  let expectedSnapshot;
  try {
    expectedSnapshot = buildPublicAuthorityTrustSnapshot({
      trustStore: frozenAuthorityTrustStore,
      referencedKeyIds:
        publicAuthorityTrustSnapshot.referencedKeyIds || [],
      capturedAt: manifest.createdAt,
    });
  } catch (cause) {
    throw freshnessError(
      'package_trust_snapshot_rebuild_failed',
      publicAuthorityTrustSnapshot,
      cause,
    );
  }
  if (JSON.stringify(expectedSnapshot)
      !== JSON.stringify(publicAuthorityTrustSnapshot)) {
    throw freshnessError(
      'package_trust_snapshot_does_not_match_frozen_store',
      publicAuthorityTrustSnapshot,
    );
  }
  const packagedTrustStore = publicTrustStoreFromSnapshot(
    publicAuthorityTrustSnapshot,
  );
  if (!packagedTrustStore) {
    throw freshnessError(
      'package_trust_snapshot_invalid',
      publicAuthorityTrustSnapshot,
    );
  }
  const observedAt = campaignReleaseGpuScientificAuthorityObservedAt(clock);
  const freshAuthorityInspection =
    assertCurrentGpuScientificQualificationAuthority({
      gpuScientificExecutionPlan: { present: true },
      gpuScientificResearchEvidence: {
        qualificationEvidenceHash:
          qualificationEvidence
            ?.gpuScientificCampaignQualificationEvidenceHash,
        qualificationEvidence,
      },
      gpuScientificPromotionAuthorityVerifier,
      trustStore: packagedTrustStore,
      observedAt,
    });
  if (freshAuthorityInspection
      ?.gpuScientificCampaignQualificationAuthorityInspectionHash
    !== initialAuthorityInspection
      ?.gpuScientificCampaignQualificationAuthorityInspectionHash) {
    throw freshnessError(
      'authority_inspection_changed_during_packaging',
      freshAuthorityInspection,
    );
  }
  return buildGpuScientificReleaseAuthorityFreshnessReceipt({
    qualificationEvidence,
    initialAuthorityInspection,
    freshAuthorityInspection,
    initialObservedAt,
    observedAt,
    frozenAuthorityTrustStoreHash: hashRecord(
      'CampaignReleaseFrozenAuthorityTrustStore',
      frozenAuthorityTrustStore,
    ),
    publicAuthorityTrustSnapshot,
    researchEvidenceCapsuleManifest: manifest,
    researchEvidenceCapsuleManifestFileHash:
      packageResult.researchEvidenceCapsule?.manifestFile?.hash || null,
    researchExecutionReleaseAttestationHash:
      packageResult.researchEvidenceCapsule
        ?.researchExecutionReleaseAttestationHash || null,
    authorityInspectionVerifier: (input) => (
      gpuScientificPromotionAuthorityVerifier.verify(input)
    ),
  });
}
