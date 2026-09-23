import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSubmissionHandoffDetachedRecordsCapsule,
  hashSubmissionHandoffDetachedRecordSet,
  sealAndVerifySubmissionHandoffBundleSync,
} from '../../paper-adapters/submission/handoff-bundle-integrity.mjs';
import {
  verifyDetachedSubmissionHandoffBundle,
} from '../../paper-adapters/submission/handoff-bundle-detached-verifier.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import {
  verifySubmissionHandoffExportRequest,
} from '../../paper-domain/submission/submission-handoff-export-request.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildSubmissionHandoffExportLifecycleFixture,
} from './support/submission-handoff-export-lifecycle-fixture.mjs';

const OBSERVED_AT = '2026-08-18T00:00:00.000Z';

function H(label) {
  return hashRecord('SubmissionHandoffDetachedFixtureHash', { label });
}

function restoreOwnerWrite(candidate) {
  let entry;
  try {
    entry = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink()) return;
  fs.chmodSync(candidate, entry.isDirectory() ? 0o700 : 0o600);
  if (entry.isDirectory()) {
    for (const name of fs.readdirSync(candidate)) {
      restoreOwnerWrite(path.join(candidate, name));
    }
  }
}

function packageRecords() {
  const packageVerificationPayload = {
    version: 1,
    kind: 'PackageVerificationReceipt',
    status: 'package_verification_passed',
    paperId: 'paper-detached',
    verifiedArtifactPackageHash: H('candidate-artifact-package'),
    blockers: [],
    externalActionPerformed: false,
  };
  const packageVerificationReceipt = Object.freeze({
    ...packageVerificationPayload,
    packageVerificationReceiptHash: hashRecord(
      'PackageVerificationReceipt',
      packageVerificationPayload,
    ),
  });
  const promotionGatePayload = {
    version: 1,
    kind: 'ManuscriptPromotionGate',
    status: 'manuscript_promotion_ready',
    paperId: 'paper-detached',
    blockers: [],
    externalActionPerformed: false,
  };
  const manuscriptPromotionGate = Object.freeze({
    ...promotionGatePayload,
    manuscriptPromotionGateHash: hashRecord(
      'ManuscriptPromotionGate',
      promotionGatePayload,
    ),
  });
  const artifactPayload = {
    version: 1,
    kind: 'PaperArtifactPackage',
    taskKey: 'paper_factory:paper-detached',
    paperId: 'paper-detached',
    artifacts: [{
      id: 'paper-detached:artifact:1',
      role: 'manuscript',
      filename: 'paper.pdf',
      path: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 16,
      hash: H('paper-pdf'),
      source: 'detached-fixture',
    }],
    artifactCount: 1,
    submitReady: true,
    candidateArtifactPackageHash:
      packageVerificationReceipt.verifiedArtifactPackageHash,
    packageVerificationReceiptHash:
      packageVerificationReceipt.packageVerificationReceiptHash,
    manuscriptPromotionGateHash:
      manuscriptPromotionGate.manuscriptPromotionGateHash,
    provenance: {
      generatedByPaperCore: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  };
  const artifactPackage = Object.freeze({
    ...artifactPayload,
    artifactPackageHash: hashPaperRecord('PaperArtifactPackage', artifactPayload),
  });
  return Object.freeze({
    artifactPackage,
    manuscriptPromotionGate,
    packageVerificationReceipt,
  });
}

function persistedAuthority(lifecycle) {
  const payload = {
    version: 1,
    kind: 'PersistedSubmissionHandoffExportAuthority',
    status: 'submission_handoff_export_authority_ready',
    messageId: 'submission:detached-fixture',
    paperId: lifecycle.request.manifest.paperId,
    dispatchAuthorizationHash:
      lifecycle.dispatchAuthorization.submissionDispatchAuthorizationHash,
    outbox: lifecycle.outbox,
    reviewedSubmitPreflightPacket:
      lifecycle.reviewedSubmitPreflightPacket,
    controlledExecutorReceipt: lifecycle.controlledExecutorReceipt,
    dispatchAuthorization: lifecycle.dispatchAuthorization,
    payloadBindingHash: H('persisted-payload'),
    rowBindingHash: H('persisted-row'),
    authorizationConsumptionHash: H('persisted-consumption'),
    releaseLockHash: H('persisted-release-lock'),
    providerCapabilityHash: H('persisted-provider-capability'),
    providerCapabilityValidFrom: '2026-08-17T00:00:00.000Z',
    providerCapabilityExpiresAt: '2026-08-19T00:00:00.000Z',
    responseCount: 0,
    deadLetterCount: 0,
    observedAt: OBSERVED_AT,
    blockers: [],
    readOnly: true,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffExportAuthorityHash: hashRecord(
      'PersistedSubmissionHandoffExportAuthority',
      payload,
    ),
  });
}

function releaseRecords({
  artifactPackage,
  lifecycle,
  manuscriptPromotionGate,
  packageVerificationReceipt,
}) {
  const releasePayload = {
    version: 1,
    kind: 'CampaignReleaseBundle',
    status: 'campaign_release_bundle_prepared',
    campaignId: lifecycle.request.campaignId,
    paperId: lifecycle.request.manifest.paperId,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    artifactPackage,
    packageVerificationReceiptHash:
      packageVerificationReceipt.packageVerificationReceiptHash,
    packageVerificationReceipt,
    manuscriptPromotionGateHash:
      manuscriptPromotionGate.manuscriptPromotionGateHash,
    manuscriptPromotionGate,
    packageOutput: {
      version: 1,
      kind: 'ImmutableCampaignPackageOutput',
      immutable: true,
      files: [],
      fileCount: 0,
      immutableCampaignPackageOutputHash: H('immutable-package-output'),
      externalActionPerformed: false,
    },
    createdAt: OBSERVED_AT,
    externalActionPerformed: false,
  };
  const campaignReleaseBundle = Object.freeze({
    ...releasePayload,
    campaignReleaseBundleHash: hashRecord(
      'CampaignReleaseBundle',
      releasePayload,
    ),
  });
  const materializationPayload = {
    version: 1,
    kind: 'CampaignReleaseBundleMaterializationReceipt',
    status: 'campaign_release_bundle_materialized',
    campaignReleaseBundleHash: campaignReleaseBundle.campaignReleaseBundleHash,
    path: '/origin/runtime/CAMPAIGN_RELEASE_BUNDLE.json',
    contentHash: H('materialized-release-content'),
    bytes: 1_024,
    atomicCreateIfAbsent: true,
    immutable: true,
    scopedFileReadReceiptHash: H('materialized-read'),
    externalActionPerformed: false,
  };
  const campaignReleaseMaterializationReceipt = Object.freeze({
    ...materializationPayload,
    campaignReleaseBundleMaterializationReceiptHash: hashRecord(
      'CampaignReleaseBundleMaterializationReceipt',
      materializationPayload,
    ),
  });
  const integrationDescriptorHash = H('integration-descriptor');
  const packageResultPayload = {
    version: 1,
    kind: 'CampaignReleasePackageResult',
    status: 'campaign_release_prepared',
    campaignId: campaignReleaseBundle.campaignId,
    paperId: campaignReleaseBundle.paperId,
    campaignReleaseBundleHash: campaignReleaseBundle.campaignReleaseBundleHash,
    releaseBundle: campaignReleaseBundle,
    artifactPackage,
    packageVerificationReceipt,
    manuscriptPromotionGate,
    campaignReleaseBundleMaterializationReceiptHash:
      campaignReleaseMaterializationReceipt
        .campaignReleaseBundleMaterializationReceiptHash,
    materializationReceipt: campaignReleaseMaterializationReceipt,
    externalActionPerformed: false,
  };
  const campaignReleasePackageResult = Object.freeze({
    ...Object.freeze({
      ...packageResultPayload,
      campaignReleasePackageResultHash: hashRecord(
        'CampaignReleasePackageResult',
        packageResultPayload,
      ),
    }),
    workspaceAttemptIntegration: Object.freeze({
      workspaceAttemptIntegrationDescriptorHash: integrationDescriptorHash,
    }),
  });
  const integrationPayload = {
    version: 1,
    kind: 'WorkspaceAttemptIntegrationReceipt',
    status: 'workspace_attempt_integrated',
    descriptorHash: integrationDescriptorHash,
    campaignId: campaignReleaseBundle.campaignId,
    integratedAt: OBSERVED_AT,
    externalActionPerformed: false,
  };
  const campaignReleaseIntegrationReceipt = Object.freeze({
    ...integrationPayload,
    workspaceAttemptIntegrationReceiptHash: hashRecord(
      'WorkspaceAttemptIntegrationReceipt',
      integrationPayload,
    ),
  });
  const promotionPayload = {
    version: 1,
    kind: 'CampaignReleasePromotionReceipt',
    status: 'campaign_release_current_completed',
    campaignId: campaignReleaseBundle.campaignId,
    paperId: campaignReleaseBundle.paperId,
    packageResultHash: hashRecord(
      'PaperCampaignNodeResult',
      campaignReleasePackageResult,
    ),
    integrationDescriptorHash: integrationPayload.descriptorHash,
    integrationReceiptHash:
      campaignReleaseIntegrationReceipt.workspaceAttemptIntegrationReceiptHash,
    campaignReleaseBundleHash: campaignReleaseBundle.campaignReleaseBundleHash,
    materializationReceiptHash:
      campaignReleaseMaterializationReceipt
        .campaignReleaseBundleMaterializationReceiptHash,
    packageNodeStatus: 'completed',
    campaignStatus: 'completed',
    submissionConsumable: true,
    externalActionPerformed: false,
  };
  const campaignReleasePromotionReceipt = Object.freeze({
    ...promotionPayload,
    campaignReleasePromotionReceiptHash: hashRecord(
      'CampaignReleasePromotionReceipt',
      promotionPayload,
    ),
  });
  const verificationPayload = {
    version: 1,
    kind: 'SubmissionCampaignReleaseVerificationReceipt',
    status: 'submission_campaign_release_verified',
    campaignId: campaignReleaseBundle.campaignId,
    paperId: campaignReleaseBundle.paperId,
    campaignReleaseBundleHash: campaignReleaseBundle.campaignReleaseBundleHash,
    campaignReleasePromotionReceiptHash:
      campaignReleasePromotionReceipt.campaignReleasePromotionReceiptHash,
    packageResultHash: campaignReleasePromotionReceipt.packageResultHash,
    integrationDescriptorHash:
      campaignReleasePromotionReceipt.integrationDescriptorHash,
    integrationReceiptHash:
      campaignReleasePromotionReceipt.integrationReceiptHash,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    packageVerificationReceiptHash:
      packageVerificationReceipt.packageVerificationReceiptHash,
    blockers: [],
    externalActionPerformed: false,
  };
  const campaignReleaseVerificationReceipt = Object.freeze({
    ...verificationPayload,
    submissionCampaignReleaseVerificationReceiptHash: hashRecord(
      'SubmissionCampaignReleaseVerificationReceipt',
      verificationPayload,
    ),
  });
  return Object.freeze({
    campaignReleaseBundle,
    campaignReleaseIntegrationReceipt,
    campaignReleaseMaterializationReceipt,
    campaignReleasePackageResult,
    campaignReleasePromotionReceipt,
    campaignReleaseVerificationReceipt,
  });
}

function authorityLineage(authority) {
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffAuthorityLineage',
    messageId: authority.messageId,
    paperId: authority.paperId,
    dispatchAuthorizationHash: authority.dispatchAuthorizationHash,
    submissionHandoffExportAuthorityHash:
      authority.submissionHandoffExportAuthorityHash,
    rowBindingHash: authority.rowBindingHash,
    authorizationConsumptionHash: authority.authorizationConsumptionHash,
    releaseLockHash: authority.releaseLockHash,
    payloadBindingHash: authority.payloadBindingHash,
    providerCapabilityHash: authority.providerCapabilityHash,
    providerCapabilityValidFrom: authority.providerCapabilityValidFrom,
    providerCapabilityExpiresAt: authority.providerCapabilityExpiresAt,
    responseCount: authority.responseCount,
    deadLetterCount: authority.deadLetterCount,
    observedAt: authority.observedAt,
    grantsExecutionPermission: false,
    requiresProviderActionTimeAuthorityRevalidation: true,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffAuthorityLineageHash: hashRecord(
      'SubmissionHandoffAuthorityLineage',
      payload,
    ),
  });
}

function fixtureRecords() {
  const packages = packageRecords();
  const lifecycle = buildSubmissionHandoffExportLifecycleFixture({
    artifactPackage: packages.artifactPackage,
    campaignId: 'campaign-detached',
    manuscriptPromotionGate: packages.manuscriptPromotionGate,
    now: new Date(OBSERVED_AT),
  });
  const authority = persistedAuthority(lifecycle);
  const requestVerificationReceipt = verifySubmissionHandoffExportRequest(
    lifecycle.request,
    {
      artifactPackageHash: packages.artifactPackage.artifactPackageHash,
      campaignId: lifecycle.request.campaignId,
      manuscriptPromotionGateHash:
        packages.manuscriptPromotionGate.manuscriptPromotionGateHash,
      paperId: lifecycle.request.manifest.paperId,
      submissionAuthority: authority,
    },
  );
  assert.equal(
    requestVerificationReceipt.status,
    'submission_handoff_export_request_verified',
    JSON.stringify(requestVerificationReceipt.blockers),
  );
  const release = releaseRecords({ ...packages, lifecycle });
  const capsule = createSubmissionHandoffDetachedRecordsCapsule({
    artifactPackage: packages.artifactPackage,
    campaignReleaseBundle: release.campaignReleaseBundle,
    campaignReleaseIntegrationReceipt:
      release.campaignReleaseIntegrationReceipt,
    campaignReleaseMaterializationReceipt:
      release.campaignReleaseMaterializationReceipt,
    campaignReleasePackageResult: release.campaignReleasePackageResult,
    campaignReleasePromotionReceipt: release.campaignReleasePromotionReceipt,
    campaignReleaseVerificationReceipt:
      release.campaignReleaseVerificationReceipt,
    packageVerificationReceipt: packages.packageVerificationReceipt,
    submissionAuthority: authority,
    submissionHandoffExportRequest: lifecycle.request,
    submissionHandoffExportRequestVerificationReceipt:
      requestVerificationReceipt,
  });
  return Object.freeze({
    authority,
    capsule,
    lifecycle,
    packages,
    release,
  });
}

function publicationLineage(finalName) {
  const publicationPayload = {
    version: 1,
    kind: 'SubmissionHandoffBundlePublication',
    finalRoot: `/detached/${finalName}`,
  };
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffBundlePublicationLineage',
    finalName,
    parentIdentity: { dev: '1', ino: '2' },
    stagingIdentity: { dev: '1', ino: '3' },
    submissionHandoffBundlePublicationHash: hashRecord(
      'SubmissionHandoffBundlePublication',
      publicationPayload,
    ),
  };
  return Object.freeze({
    ...payload,
    submissionHandoffBundlePublicationLineageHash: hashRecord(
      'SubmissionHandoffBundlePublicationLineage',
      payload,
    ),
  });
}

function writeBundle(bundleRoot, records, capsule = records.capsule) {
  fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  for (const document of capsule.documents) {
    const candidate = path.join(bundleRoot, document.path);
    fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
    fs.writeFileSync(candidate, document.bytes, { mode: 0o600 });
  }
  const { lifecycle, packages, release, authority } = records;
  const manifestPayload = {
    version: 1,
    kind: 'SubmissionHandoffBundleManifest',
    paperId: lifecycle.request.manifest.paperId,
    taskKey: lifecycle.request.manifest.taskKey,
    artifactPackageHash: packages.artifactPackage.artifactPackageHash,
    packageVerificationReceiptHash:
      packages.packageVerificationReceipt.packageVerificationReceiptHash,
    manifestHash: lifecycle.request.manifest.manifestHash,
    handoffEnvelopeHash: lifecycle.request.handoff.envelopeHash,
    replayGuardHash:
      lifecycle.request.replayGuard.submissionReplayGuardHash,
    reviewedSubmitPreflightPacketHash:
      lifecycle.request.reviewedSubmitPreflightPacket
        .reviewedSubmitPreflightPacketHash,
    dispatchAuthorizationHash:
      lifecycle.request.dispatchAuthorization
        .submissionDispatchAuthorizationHash,
    persistedSubmissionAuthority: authorityLineage(authority),
    grantsExternalExecutionPermission: false,
    requiresCurrentAuthorityRevalidation: true,
    submissionHandoffBundlePublicationLineage:
      publicationLineage(path.basename(bundleRoot)),
    provider: lifecycle.request.dispatchAuthorization.provider,
    accountId: lifecycle.request.dispatchAuthorization.accountId,
    nonce: lifecycle.request.dispatchAuthorization.nonce,
    reviewedSubmissionDecisionPacketHash:
      lifecycle.request.submissionDecisionPacket
        .reviewedSubmissionDecisionPacketHash,
    campaignReleaseBundleHash:
      release.campaignReleaseBundle.campaignReleaseBundleHash,
    sealedPackageOutput: null,
    submissionMetadata: lifecycle.request.submissionDecisionPacket.metadata,
    artifacts: [],
    artifactCount: 0,
    sealedPackageFileCount: 0,
    ...capsule.manifestBinding,
    externalActionPerformed: false,
  };
  const manifestDocument = {
    ...manifestPayload,
    submissionHandoffBundleManifestHash: hashRecord(
      'SubmissionHandoffBundleManifest',
      manifestPayload,
    ),
  };
  fs.writeFileSync(
    path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
    `${JSON.stringify(manifestDocument, null, 2)}\n`,
    { mode: 0o600 },
  );
  sealAndVerifySubmissionHandoffBundleSync({ bundleRoot, manifestDocument });
  return Object.freeze(manifestDocument);
}

function trustedAnchor(records, manifest) {
  return Object.freeze({
    version: 1,
    kind: 'SubmissionHandoffDetachedTrustedAnchor',
    submissionHandoffBundleManifestHash:
      manifest.submissionHandoffBundleManifestHash,
    submissionHandoffExportRequestHash:
      records.lifecycle.request.submissionHandoffExportRequestHash,
    submissionHandoffExportAuthorityHash:
      records.authority.submissionHandoffExportAuthorityHash,
    campaignReleaseBundleHash:
      records.release.campaignReleaseBundle.campaignReleaseBundleHash,
    dispatchAuthorizationHash:
      records.lifecycle.request.dispatchAuthorization
        .submissionDispatchAuthorizationHash,
  });
}

function rewriteManifest(bundleRoot, mutate) {
  restoreOwnerWrite(bundleRoot);
  const candidate = path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  delete manifest.submissionHandoffBundleManifestHash;
  mutate(manifest);
  manifest.submissionHandoffBundleManifestHash = hashRecord(
    'SubmissionHandoffBundleManifest',
    manifest,
  );
  fs.writeFileSync(candidate, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function makeReadOnly(candidate) {
  const entry = fs.lstatSync(candidate);
  if (entry.isDirectory()) {
    for (const name of fs.readdirSync(candidate)) {
      makeReadOnly(path.join(candidate, name));
    }
    fs.chmodSync(candidate, 0o555);
  } else {
    fs.chmodSync(candidate, 0o444);
  }
}

test('detached submission handoff requires external roots and verifies after origin deletion', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-detached-handoff-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  fs.writeFileSync(path.join(origin, 'paper.db'), 'origin-only');
  const records = fixtureRecords();
  const bundleRoot = path.join(origin, 'handoff');
  const manifest = writeBundle(bundleRoot, records);
  const anchor = trustedAnchor(records, manifest);

  const missingAnchor = verifyDetachedSubmissionHandoffBundle({ bundleRoot });
  assert.equal(missingAnchor.integrityVerified, false);
  assert.equal(missingAnchor.internalLineageVerified, false);
  assert.ok(missingAnchor.blockers.includes(
    'handoff_bundle_detached_trusted_anchor_required',
  ));
  for (const field of [
    'submissionHandoffBundleManifestHash',
    'submissionHandoffExportRequestHash',
    'submissionHandoffExportAuthorityHash',
    'campaignReleaseBundleHash',
    'dispatchAuthorizationHash',
  ]) {
    const incomplete = { ...anchor };
    delete incomplete[field];
    const blocked = verifyDetachedSubmissionHandoffBundle({
      bundleRoot,
      trustedAnchor: incomplete,
    });
    assert.equal(blocked.internalLineageVerified, false, field);
  }

  const transferredRoot = path.join(root, 'transferred');
  fs.cpSync(bundleRoot, transferredRoot, { recursive: true });
  restoreOwnerWrite(origin);
  fs.rmSync(origin, { recursive: true, force: true });
  makeReadOnly(transferredRoot);
  const verified = verifyDetachedSubmissionHandoffBundle({
    bundleRoot: transferredRoot,
    trustedAnchor: anchor,
  });
  assert.equal(
    verified.status,
    'submission_handoff_detached_internal_lineage_verified',
    JSON.stringify(verified.blockers),
  );
  assert.equal(verified.integrityVerified, true);
  assert.equal(verified.internalLineageVerified, true);
  assert.equal(verified.externalAuthorityVerified, false);
  assert.equal(verified.providerActionAuthorized, false);
  assert.deepEqual(verified.externalAuthorityBlockers, [
    'handoff_bundle_external_authority_verifier_required',
  ]);
});

test('detached records exact tree rejects missing, extra, duplicate, and tampered records', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-detached-tree-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const records = fixtureRecords();
  const original = path.join(root, 'original');
  const manifest = writeBundle(original, records);
  const anchor = trustedAnchor(records, manifest);

  const tampered = path.join(root, 'tampered');
  fs.cpSync(original, tampered, { recursive: true });
  restoreOwnerWrite(tampered);
  fs.appendFileSync(
    path.join(tampered, 'records', 'submission_handoff_export_request.json'),
    ' ',
  );
  makeReadOnly(tampered);
  assert.equal(verifyDetachedSubmissionHandoffBundle({
    bundleRoot: tampered,
    trustedAnchor: anchor,
  }).integrityVerified, false);

  const extra = path.join(root, 'extra');
  fs.cpSync(original, extra, { recursive: true });
  restoreOwnerWrite(extra);
  fs.writeFileSync(path.join(extra, 'records', 'unknown.json'), '{}\n');
  makeReadOnly(extra);
  assert.equal(verifyDetachedSubmissionHandoffBundle({
    bundleRoot: extra,
    trustedAnchor: anchor,
  }).integrityVerified, false);

  const missing = path.join(root, 'missing');
  fs.cpSync(original, missing, { recursive: true });
  const missingManifest = rewriteManifest(missing, (document) => {
    document.detachedRecords = document.detachedRecords.filter(
      (record) => record.role
        !== 'submission_handoff_export_request_verification_receipt',
    );
    document.submissionHandoffDetachedRecordSetHash =
      hashSubmissionHandoffDetachedRecordSet(document.detachedRecords);
    document.submissionHandoffExportRequestVerificationReceiptHash = null;
    fs.rmSync(path.join(
      missing,
      'records',
      'submission_handoff_export_request_verification_receipt.json',
    ));
  });
  makeReadOnly(missing);
  const missingVerification = verifyDetachedSubmissionHandoffBundle({
    bundleRoot: missing,
    trustedAnchor: {
      ...anchor,
      submissionHandoffBundleManifestHash:
        missingManifest.submissionHandoffBundleManifestHash,
    },
  });
  assert.equal(missingVerification.integrityVerified, true);
  assert.equal(missingVerification.internalLineageVerified, false);
  assert.ok(missingVerification.blockers.includes(
    'handoff_bundle_detached_record_required:submission_handoff_export_request_verification_receipt',
  ));

  const duplicate = path.join(root, 'duplicate');
  fs.cpSync(original, duplicate, { recursive: true });
  const duplicateManifest = rewriteManifest(duplicate, (document) => {
    document.detachedRecords.push(document.detachedRecords[0]);
    document.submissionHandoffDetachedRecordSetHash =
      hashSubmissionHandoffDetachedRecordSet(document.detachedRecords);
  });
  makeReadOnly(duplicate);
  const duplicateVerification = verifyDetachedSubmissionHandoffBundle({
    bundleRoot: duplicate,
    trustedAnchor: {
      ...anchor,
      submissionHandoffBundleManifestHash:
        duplicateManifest.submissionHandoffBundleManifestHash,
    },
  });
  assert.equal(duplicateVerification.integrityVerified, false);
});

test('a self-consistent rehashed bundle cannot replace an externally anchored manifest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-detached-anchor-'));
  t.after(() => {
    restoreOwnerWrite(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const records = fixtureRecords();
  const bundleRoot = path.join(root, 'bundle');
  const originalManifest = writeBundle(bundleRoot, records);
  const originalAnchor = trustedAnchor(records, originalManifest);

  const forgedManifest = rewriteManifest(bundleRoot, (document) => {
    const lineage = document.submissionHandoffBundlePublicationLineage;
    delete lineage.submissionHandoffBundlePublicationLineageHash;
    lineage.parentIdentity.ino = '999';
    lineage.submissionHandoffBundlePublicationLineageHash = hashRecord(
      'SubmissionHandoffBundlePublicationLineage',
      lineage,
    );
  });
  makeReadOnly(bundleRoot);
  const attackerAnchor = {
    ...originalAnchor,
    submissionHandoffBundleManifestHash:
      forgedManifest.submissionHandoffBundleManifestHash,
  };
  const selfConsistent = verifyDetachedSubmissionHandoffBundle({
    bundleRoot,
    trustedAnchor: attackerAnchor,
  });
  assert.equal(selfConsistent.integrityVerified, true);
  assert.equal(selfConsistent.internalLineageVerified, true);

  const rejected = verifyDetachedSubmissionHandoffBundle({
    bundleRoot,
    trustedAnchor: originalAnchor,
  });
  assert.equal(rejected.integrityVerified, true);
  assert.equal(rejected.internalLineageVerified, false);
  assert.ok(rejected.blockers.some((blocker) => blocker.includes(
    'handoff_bundle_detached_manifest_anchor_mismatch',
  )));
});
