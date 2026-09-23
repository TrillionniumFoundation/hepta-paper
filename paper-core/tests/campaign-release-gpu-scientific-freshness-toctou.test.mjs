import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  gpuScientificReleaseCapsuleLineageValid,
  gpuScientificReleaseEvidenceValid,
} from '../../paper-domain/automation/campaign-release-contract-helpers.mjs';
import {
  buildGpuScientificCampaignPromotionEvidence,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import {
  GPU_AUTHORITY_EXPIRED_TIME,
  GPU_RELEASE_TIME,
  createGpuScientificCampaignReleaseFixture,
  revokedGpuAuthorityTrustStore,
  runPackageAdapter,
} from './support/gpu-scientific-campaign-release-fixture.mjs';

function assertFreshnessFailure(error, blocker) {
  assert.equal(
    error.code,
    'campaign_release_gpu_scientific_authority_freshness_blocked',
  );
  assert.equal(error.retryable, false);
  assert.match(error.message, new RegExp(blocker));
  return true;
}

test('complete GPU release freezes one provider snapshot across adapter drift and binds it into the bundle receipt', async (t) => {
  const fixture = await createGpuScientificCampaignReleaseFixture(t);
  const frozenTrustStore = structuredClone(fixture.qualification.trustStore);
  const revokedTrustStore = revokedGpuAuthorityTrustStore(
    frozenTrustStore,
    '2026-08-14T12:00:00.000Z',
  );
  let adapterTrustStore = null;
  const packager = fixture.createPackager({
    packageAdapter: async (input) => {
      adapterTrustStore = structuredClone(
        input.operatorDatasetAuthorityTrustStore,
      );
      fixture.setTrustStore(revokedTrustStore);
      const output = await runPackageAdapter(input);
      const capsule = output.researchEvidenceCapsule;
      const promotionEvidence = buildGpuScientificCampaignPromotionEvidence({
        qualificationEvidence: fixture.gpuResearchEvidence.qualificationEvidence,
        researchEvidenceCapsuleManifestHash:
          capsule.researchEvidenceCapsuleManifestHash,
        researchEvidenceCapsuleManifestFileHash: capsule.manifestFile.hash,
        researchExecutionReleaseAttestationHash:
          capsule.researchExecutionReleaseAttestationHash,
      });
      const releaseArguments = {
        campaignPlanHash: fixture.campaign.spec.campaignPlanHash,
        campaignId: fixture.campaign.campaignId,
        paperId: fixture.campaign.paperId,
        plan: fixture.gpu.executionPlan,
        evidence: fixture.gpu.executionResult,
        qualificationEvidence:
          fixture.gpuResearchEvidence.qualificationEvidence,
        promotionEvidence,
        researchEvidenceCapsuleManifestHash:
          capsule.researchEvidenceCapsuleManifestHash,
        researchEvidenceCapsuleManifestFileHash: capsule.manifestFile.hash,
        researchExecutionReleaseAttestationHash:
          capsule.researchExecutionReleaseAttestationHash,
      };
      const lineageRecord = {
        gpuScientificExecutionPlanHash:
          fixture.gpu.executionPlan.gpuScientificCampaignExecutionPlanHash,
        gpuScientificCampaignExecutionResultHash:
          fixture.gpu.executionResult.gpuScientificCampaignExecutionResultHash,
        gpuScientificArtifactBodyArchiveManifestHash:
          promotionEvidence.artifactArchiveManifestHash,
        gpuScientificCampaignQualificationEvidenceHash:
          promotionEvidence.gpuScientificCampaignQualificationEvidenceHash,
        gpuScientificCampaignPromotionEvidence: promotionEvidence,
      };
      assert.deepEqual({
        releaseEvidence: gpuScientificReleaseEvidenceValid(releaseArguments),
        capsuleLineage: gpuScientificReleaseCapsuleLineageValid(lineageRecord, {
          manifest: capsule.manifest,
          manifestFileHash: capsule.manifestFile.hash,
          attestationHash: capsule.researchExecutionReleaseAttestationHash,
        }),
      }, {
        releaseEvidence: true,
        capsuleLineage: true,
      });
      return output;
    },
  });

  const result = await packager.packageRelease(fixture.packageInput);
  assert.equal(result.status, 'campaign_release_prepared');
  assert.equal(fixture.trustStoreReads(), 1);
  assert.deepEqual(adapterTrustStore, frozenTrustStore);
  assert.equal(fixture.archive.bodyCount, 11);

  const bundle = result.releaseBundle;
  const candidate = bundle.promotionCandidate;
  const receipt = bundle.gpuScientificReleaseAuthorityFreshnessReceipt;
  assert.equal(
    bundle.researchEvidenceCapsuleManifest.gpuScientificEvidence.archiveBodyCount,
    11,
  );
  assert.equal(
    bundle.researchEvidenceCapsuleManifest.gpuScientificEvidence
      .archiveEntries.length,
    11,
  );
  assert.equal(
    bundle.gpuScientificReleaseAuthorityFreshnessReceiptHash,
    receipt.gpuScientificReleaseAuthorityFreshnessReceiptHash,
  );
  assert.equal(
    candidate.gpuScientificReleaseAuthorityFreshnessReceiptHash,
    receipt.gpuScientificReleaseAuthorityFreshnessReceiptHash,
  );
  assert.deepEqual(
    candidate.gpuScientificReleaseAuthorityFreshnessReceipt,
    receipt,
  );
  assert.equal(receipt.initialObservedAt, GPU_RELEASE_TIME);
  assert.equal(receipt.observedAt, GPU_RELEASE_TIME);
  assert.equal(
    receipt.initialAuthorityInspectionHash,
    receipt.freshAuthorityInspectionHash,
  );
  assert.equal(
    receipt.frozenAuthorityTrustStoreHash,
    hashRecord('CampaignReleaseFrozenAuthorityTrustStore', frozenTrustStore),
  );
  assert.equal(
    receipt.publicAuthorityTrustSnapshotHash,
    bundle.researchEvidenceCapsuleManifest.publicAuthorityTrustSnapshotHash,
  );
  assert.equal(
    receipt.researchEvidenceCapsuleManifestHash,
    bundle.researchEvidenceCapsuleManifestHash,
  );
  assert.equal(
    receipt.researchExecutionReleaseAttestationHash,
    bundle.researchExecutionReleaseAttestationHash,
  );
  assert.equal(receipt.publicAuthorityTrustSnapshot.keys.length, 2);
  assert.ok(receipt.publicAuthorityTrustSnapshot.keys.every(
    (key) => key.status === 'active' && key.revoked === false,
  ));
  assert.ok(bundle.packageOutput.files.some((file) => (
    file.packageRelativePath
      === 'evidence/gpu-scientific/ARTIFACT_BODY_ARCHIVE_MANIFEST.json'
  )));
  assert.equal(
    fs.existsSync(path.join(
      bundle.packageOutput.packageDir,
      'evidence/gpu-scientific/deep-learning/tensor-bundle.bin',
    )),
    true,
  );
});

test('GPU release performs the final authority check after adapter/KMS work and rejects a clock crossing expiry', async (t) => {
  const fixture = await createGpuScientificCampaignReleaseFixture(t);
  let adapterCompleted = false;
  const packager = fixture.createPackager({
    packageAdapter: async (input) => {
      const result = await runPackageAdapter(input);
      adapterCompleted = true;
      fixture.clock.set(GPU_AUTHORITY_EXPIRED_TIME);
      return result;
    },
  });

  await assert.rejects(
    packager.packageRelease(fixture.packageInput),
    (error) => assertFreshnessFailure(error, 'authority_expired'),
  );
  assert.equal(adapterCompleted, true);
  assert.equal(fixture.trustStoreReads(), 1);
  assert.equal(
    fs.existsSync(path.join(
      fixture.runtimeRoot,
      'campaign-releases',
    )),
    true,
  );
});

test('existing GPU materialization rejects later expiry and revocation without rewriting the bundle', async (t) => {
  const fixture = await createGpuScientificCampaignReleaseFixture(t);
  const packager = fixture.createPackager();
  const first = await packager.packageRelease(fixture.packageInput);
  const bundlePath = first.materializationReceipt.path;
  const originalBytes = fs.readFileSync(bundlePath);
  const originalStat = fs.statSync(bundlePath, { bigint: true });
  assert.equal(fixture.trustStoreReads(), 1);

  fixture.clock.set(GPU_AUTHORITY_EXPIRED_TIME);
  await assert.rejects(
    packager.packageRelease(fixture.packageInput),
    (error) => assertFreshnessFailure(error, 'authority_expired'),
  );
  assert.deepEqual(fs.readFileSync(bundlePath), originalBytes);

  fixture.clock.set(GPU_RELEASE_TIME);
  fixture.setTrustStore(revokedGpuAuthorityTrustStore(
    fixture.qualification.trustStore,
    '2026-08-14T12:00:00.000Z',
  ));
  await assert.rejects(
    packager.packageRelease(fixture.packageInput),
    (error) => assertFreshnessFailure(error, 'signature_key_not_active'),
  );
  const completedStat = fs.statSync(bundlePath, { bigint: true });
  assert.deepEqual(fs.readFileSync(bundlePath), originalBytes);
  assert.equal(completedStat.dev, originalStat.dev);
  assert.equal(completedStat.ino, originalStat.ino);
  assert.equal(completedStat.mtimeNs, originalStat.mtimeNs);
  assert.equal(fixture.trustStoreReads(), 3);
});

test('existing GPU materialization rejects writable package file mode drift', async (t) => {
  const fixture = await createGpuScientificCampaignReleaseFixture(t);
  const packager = fixture.createPackager();
  const first = await packager.packageRelease(fixture.packageInput);
  const sourceZip = first.releaseBundle.packageOutput.files.find(
    (file) => file.role === 'generated_source_zip',
  );
  assert.ok(sourceZip?.path);
  const originalBytes = fs.readFileSync(sourceZip.path);
  fs.chmodSync(sourceZip.path, 0o644);

  await assert.rejects(
    packager.packageRelease(fixture.packageInput),
    /campaign_release_materialization_immutable_collision/,
  );
  assert.deepEqual(fs.readFileSync(sourceZip.path), originalBytes);
  assert.notEqual(fs.statSync(sourceZip.path).mode & 0o222, 0);
});
