import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  GPU_SCIENTIFIC_CAMPAIGN_RELEASE_AUTHORITY_BLOCKER,
  GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  buildGpuScientificCampaignProductionQualificationAuthority,
  buildGpuScientificCampaignPromotionEvidence,
  buildGpuScientificCampaignQualificationEvidence,
  buildGpuScientificCampaignQualificationRequest,
  buildGpuScientificCampaignSameDeviceReplayReceipt,
  verifyGpuScientificCampaignProductionQualificationAuthority,
  verifyGpuScientificCampaignPromotionEvidence,
  verifyGpuScientificCampaignQualificationEvidence,
  verifyGpuScientificCampaignQualificationRequest,
  verifyGpuScientificCampaignSameDeviceReplayReceipt,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import {
  createGpuScientificCampaignPromotionAuthorityVerifier,
  verifyGpuScientificCampaignQualificationEvidenceAuthority,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';
import {
  signAuthorityDocument,
} from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('GpuScientificCampaignPromotionTest', { label });
const GPU_SELECTOR = 'GPU-12345678-1234-1234-1234-123456789abc';
const REPLAYED_AT = '2026-08-14T00:00:00.000Z';
const REPLAY_SIGNED_AT = '2026-08-14T00:01:00.000Z';
const QUALIFICATION_SIGNED_AT = '2026-08-14T00:02:00.000Z';
const REPLAY_EXPIRES_AT = '2026-08-20T00:00:00.000Z';
const QUALIFICATION_EXPIRES_AT = '2026-08-19T00:00:00.000Z';
const VERIFICATION_TIME = new Date('2026-08-15T00:00:00.000Z');

function publicKeyPem(keyPair) {
  return keyPair.publicKey.export({ type: 'spki', format: 'pem' });
}

function authorityKey({
  keyId,
  role,
  subjectId,
  organization,
  processIdentityHash,
  keyPair,
} = {}) {
  return Object.freeze({
    keyId,
    status: 'active',
    algorithm: 'ed25519',
    roles: Object.freeze([role]),
    subjectId,
    organization,
    processIdentityHash,
    publicKeyPem: publicKeyPem(keyPair),
  });
}

function qualificationRequest() {
  return buildGpuScientificCampaignQualificationRequest({
    campaignId: 'campaign-gpu-promotion',
    paperId: 'paper-gpu-promotion',
    campaignPlanHash: H('campaign-plan'),
    nodeId: 'campaign-gpu-promotion:0:gpu-scientific-execution',
    attemptId: 'attempt-gpu-promotion',
    leaseGeneration: 3,
    executionPlanHash: H('execution-plan'),
    taskSetHash: H('task-set'),
    gpuDeviceSelector: GPU_SELECTOR,
    gpuScientificCampaignAttemptAuthorityHash: H('attempt-authority'),
    gpuScientificCampaignExecutionResultHash: H('raw-result'),
    artifactArchiveManifestHash: H('artifact-archive-manifest'),
    scientificOutputCommitmentHash: H('scientific-output'),
    pdeTaskReceiptHash: H('pde-task-receipt'),
    deepLearningTaskReceiptHash: H('deep-learning-task-receipt'),
    runtimeImageDigest: H('runtime-image'),
    runtimePackageClosureHash: H('runtime-package-closure'),
    originalExecutionProcessIdentityHashes: {
      pde: H('original-pde-process'),
      deepLearning: H('original-deep-learning-process'),
    },
  });
}

function signedReplay({ request, keyPair, keyId = 'gpu-replay-key' } = {}) {
  const input = {
    request,
    replayPdeTaskReceiptHash: H('replay-pde-task-receipt'),
    replayDeepLearningTaskReceiptHash: H('replay-deep-learning-task-receipt'),
    replayExecutionProcessIdentityHashes: {
      pde: H('replay-pde-process'),
      deepLearning: H('replay-deep-learning-process'),
    },
    replayScientificOutputCommitmentHash:
      request.scientificOutputCommitmentHash,
    replayedAt: REPLAYED_AT,
    signedAt: REPLAY_SIGNED_AT,
    validFrom: REPLAY_SIGNED_AT,
    expiresAt: REPLAY_EXPIRES_AT,
  };
  const unsigned = buildGpuScientificCampaignSameDeviceReplayReceipt(input);
  const signed = signAuthorityDocument(unsigned, {
    privateKeyPem: keyPair.privateKey,
    keyId,
    role: GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  });
  return buildGpuScientificCampaignSameDeviceReplayReceipt({
    ...input,
    signatures: signed.signatures,
  });
}

function signedProductionAuthority({
  request,
  replay,
  keyPair,
  keyId = 'gpu-production-qualification-key',
} = {}) {
  const input = {
    request,
    sameDeviceReplayReceipt: replay,
    signedAt: QUALIFICATION_SIGNED_AT,
    validFrom: QUALIFICATION_SIGNED_AT,
    expiresAt: QUALIFICATION_EXPIRES_AT,
  };
  const unsigned = buildGpuScientificCampaignProductionQualificationAuthority(
    input,
  );
  const signed = signAuthorityDocument(unsigned, {
    privateKeyPem: keyPair.privateKey,
    keyId,
    role: GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  });
  return buildGpuScientificCampaignProductionQualificationAuthority({
    ...input,
    signatures: signed.signatures,
  });
}

function fixture({ sharedKey = false } = {}) {
  const request = qualificationRequest();
  const replayKey = crypto.generateKeyPairSync('ed25519');
  const productionKey = sharedKey
    ? replayKey : crypto.generateKeyPairSync('ed25519');
  const replay = signedReplay({ request, keyPair: replayKey });
  const productionAuthority = signedProductionAuthority({
    request,
    replay,
    keyPair: productionKey,
  });
  const qualificationEvidence = buildGpuScientificCampaignQualificationEvidence({
    request,
    sameDeviceReplayReceipt: replay,
    productionQualificationAuthority: productionAuthority,
  });
  const trustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: Object.freeze([
      authorityKey({
        keyId: 'gpu-replay-key',
        role: GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
        subjectId: 'gpu-replay-subject',
        organization: 'Independent Replay Lab',
        processIdentityHash: H('replay-authority-process'),
        keyPair: replayKey,
      }),
      authorityKey({
        keyId: 'gpu-production-qualification-key',
        role: GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
        subjectId: 'gpu-production-qualification-subject',
        organization: 'Independent Qualification Lab',
        processIdentityHash: H('qualification-authority-process'),
        keyPair: productionKey,
      }),
    ]),
  });
  return Object.freeze({
    request,
    replay,
    productionAuthority,
    qualificationEvidence,
    replayKey,
    productionKey,
    trustStore,
  });
}

test('GPU campaign promotion contracts preserve a two-stage fail-closed authority chain', () => {
  const value = fixture();
  assert.equal(verifyGpuScientificCampaignQualificationRequest(value.request), true);
  assert.equal(verifyGpuScientificCampaignSameDeviceReplayReceipt(
    value.replay,
    { request: value.request },
  ), true);
  assert.equal(verifyGpuScientificCampaignProductionQualificationAuthority(
    value.productionAuthority,
    { request: value.request, sameDeviceReplayReceipt: value.replay },
  ), true);
  assert.equal(verifyGpuScientificCampaignQualificationEvidence(
    value.qualificationEvidence,
  ), true);
  assert.equal(value.qualificationEvidence.productionQualified, true);
  assert.equal(value.qualificationEvidence.promotionEligible, false);
  assert.deepEqual(value.qualificationEvidence.blockers, [
    GPU_SCIENTIFIC_CAMPAIGN_RELEASE_AUTHORITY_BLOCKER,
  ]);

  const inspection = verifyGpuScientificCampaignQualificationEvidenceAuthority({
    qualificationEvidence: value.qualificationEvidence,
    trustStore: value.trustStore,
    now: VERIFICATION_TIME,
  });
  assert.equal(inspection.valid, true);
  assert.equal(inspection.cryptographicSignaturesVerified, true);
  assert.equal(inspection.authorityIdentityIndependenceVerified, true);

  const promotion = buildGpuScientificCampaignPromotionEvidence({
    qualificationEvidence: value.qualificationEvidence,
    researchEvidenceCapsuleManifestHash: H('release-capsule-manifest'),
    researchEvidenceCapsuleManifestFileHash:
      H('release-capsule-manifest-file'),
    researchExecutionReleaseAttestationHash: H('release-attestation'),
  });
  assert.equal(verifyGpuScientificCampaignPromotionEvidence(promotion), true);
  assert.equal(promotion.productionQualified, true);
  assert.equal(promotion.promotionEligible, true);
  assert.deepEqual(promotion.blockers, []);
});

test('same-device replay requires equal scientific output and independent processes', () => {
  const request = qualificationRequest();
  const replayKey = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => buildGpuScientificCampaignSameDeviceReplayReceipt({
    request,
    replayPdeTaskReceiptHash: H('replay-pde'),
    replayDeepLearningTaskReceiptHash: H('replay-deep-learning'),
    replayExecutionProcessIdentityHashes: {
      pde: H('other-pde-process'),
      deepLearning: H('other-deep-learning-process'),
    },
    replayScientificOutputCommitmentHash: H('changed-output'),
    replayedAt: REPLAYED_AT,
    signedAt: REPLAY_SIGNED_AT,
    expiresAt: REPLAY_EXPIRES_AT,
  }), /same_device_replay_binding_invalid/);
  assert.throws(() => buildGpuScientificCampaignSameDeviceReplayReceipt({
    request,
    replayPdeTaskReceiptHash: H('replay-pde'),
    replayDeepLearningTaskReceiptHash: H('replay-deep-learning'),
    replayExecutionProcessIdentityHashes: {
      pde: request.originalExecutionProcessIdentityHashes.pde,
      deepLearning: H('other-deep-learning-process'),
    },
    replayScientificOutputCommitmentHash:
      request.scientificOutputCommitmentHash,
    replayedAt: REPLAYED_AT,
    signedAt: REPLAY_SIGNED_AT,
    expiresAt: REPLAY_EXPIRES_AT,
  }), /same_device_replay_binding_invalid/);

  const valid = signedReplay({ request, keyPair: replayKey });
  const tampered = structuredClone(valid);
  tampered.runtimeImageDigest = H('different-runtime-image');
  assert.equal(verifyGpuScientificCampaignSameDeviceReplayReceipt(
    tampered,
    { request },
  ), false);
});

test('authority verification fails closed without trust or with expired authority', () => {
  const value = fixture();
  const missingTrust = verifyGpuScientificCampaignQualificationEvidenceAuthority({
    qualificationEvidence: value.qualificationEvidence,
    trustStore: null,
    now: VERIFICATION_TIME,
  });
  assert.equal(missingTrust.valid, false);
  assert.ok(missingTrust.blockers.some((blocker) => (
    blocker.includes('authority_trust_store_missing_or_invalid')
  )));

  const expired = verifyGpuScientificCampaignQualificationEvidenceAuthority({
    qualificationEvidence: value.qualificationEvidence,
    trustStore: value.trustStore,
    now: new Date('2026-08-21T00:00:00.000Z'),
  });
  assert.equal(expired.valid, false);
  assert.ok(expired.blockers.some((blocker) => blocker.includes('authority_expired')));
});

test('replay and production qualification authorities require independent control', () => {
  const sharedKeyValue = fixture({ sharedKey: true });
  const sharedKeyInspection =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence: sharedKeyValue.qualificationEvidence,
      trustStore: sharedKeyValue.trustStore,
      now: VERIFICATION_TIME,
    });
  assert.equal(sharedKeyInspection.valid, false);
  assert.ok(sharedKeyInspection.blockers.includes(
    'gpu_scientific_campaign_authority_public_key_independence_required',
  ));

  const value = fixture();
  const sameOrganizationTrustStore = structuredClone(value.trustStore);
  sameOrganizationTrustStore.keys[1].organization =
    sameOrganizationTrustStore.keys[0].organization;
  const sameOrganization =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence: value.qualificationEvidence,
      trustStore: sameOrganizationTrustStore,
      now: VERIFICATION_TIME,
    });
  assert.equal(sameOrganization.valid, false);
  assert.ok(sameOrganization.blockers.includes(
    'gpu_scientific_campaign_authority_organization_independence_required',
  ));

  const localIdentity =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence: value.qualificationEvidence,
      trustStore: value.trustStore,
      now: VERIFICATION_TIME,
      forbiddenSubjectIds: ['gpu-replay-subject'],
    });
  assert.equal(localIdentity.valid, false);
  assert.ok(localIdentity.blockers.includes(
    'same_device_replay:authority_subject_not_independent',
  ));

  const originalExecutorTrustStore = structuredClone(value.trustStore);
  originalExecutorTrustStore.keys[0].processIdentityHash =
    value.request.originalExecutionProcessIdentityHashes.pde;
  const originalExecutor =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence: value.qualificationEvidence,
      trustStore: originalExecutorTrustStore,
      now: VERIFICATION_TIME,
    });
  assert.equal(originalExecutor.valid, false);
  assert.ok(originalExecutor.blockers.includes(
    'same_device_replay:authority_process_not_independent',
  ));
});

test('production verifier requires a current forbidden-identity context', () => {
  const value = fixture();
  const ready = createGpuScientificCampaignPromotionAuthorityVerifier({
    trustStoreProvider: () => value.trustStore,
    clock: { now: () => VERIFICATION_TIME },
    forbiddenIdentityProvider: () => ({
      identityContextReady: true,
      forbiddenSubjectIds: ['research-author-subject'],
      forbiddenPublicKeySpkiHashes: [H('author-key')],
      forbiddenProcessIdentityHashes: [H('author-process')],
      blockers: [],
    }),
  }).verify({ qualificationEvidence: value.qualificationEvidence });
  assert.equal(ready.valid, true);

  const unavailable = createGpuScientificCampaignPromotionAuthorityVerifier({
    trustStoreProvider: () => value.trustStore,
    clock: { now: () => VERIFICATION_TIME },
    forbiddenIdentityProvider: () => {
      throw new Error('author_identity_context_unavailable');
    },
  }).verify({ qualificationEvidence: value.qualificationEvidence });
  assert.equal(unavailable.valid, false);
  assert.ok(unavailable.blockers.includes(
    'gpu_scientific_campaign_forbidden_identity_context_required',
  ));
  assert.ok(unavailable.blockers.includes(
    'forbidden_identity_context:author_identity_context_unavailable',
  ));

  let dynamicTrustStoreReads = 0;
  let forbiddenObservedAt = null;
  const releaseScoped = createGpuScientificCampaignPromotionAuthorityVerifier({
    trustStoreProvider: () => {
      dynamicTrustStoreReads += 1;
      throw new Error('dynamic_trust_store_must_not_be_read');
    },
    clock: { now: () => new Date('2026-08-30T00:00:00.000Z') },
    forbiddenIdentityProvider: ({ observedAt }) => {
      forbiddenObservedAt = observedAt;
      return {
        identityContextReady: true,
        forbiddenSubjectIds: ['research-author-subject'],
        forbiddenPublicKeySpkiHashes: [H('author-key')],
        forbiddenProcessIdentityHashes: [H('author-process')],
        blockers: [],
      };
    },
  }).verify({
    qualificationEvidence: value.qualificationEvidence,
    trustStore: value.trustStore,
    observedAt: VERIFICATION_TIME.toISOString(),
  });
  assert.equal(releaseScoped.valid, true);
  assert.equal(dynamicTrustStoreReads, 0);
  assert.equal(forbiddenObservedAt, VERIFICATION_TIME.toISOString());
});

test('final promotion evidence is hash-bound to release authority and rejects drift', () => {
  const value = fixture();
  assert.throws(() => buildGpuScientificCampaignPromotionEvidence({
    qualificationEvidence: value.qualificationEvidence,
    researchEvidenceCapsuleManifestHash: H('manifest'),
    researchEvidenceCapsuleManifestFileHash: null,
    researchExecutionReleaseAttestationHash: H('attestation'),
  }), /promotion_release_binding_invalid/);

  const promotion = buildGpuScientificCampaignPromotionEvidence({
    qualificationEvidence: value.qualificationEvidence,
    researchEvidenceCapsuleManifestHash: H('manifest'),
    researchEvidenceCapsuleManifestFileHash: H('manifest-file'),
    researchExecutionReleaseAttestationHash: H('attestation'),
  });
  const changedAttestation = structuredClone(promotion);
  changedAttestation.researchExecutionReleaseAttestationHash =
    H('changed-attestation');
  assert.equal(verifyGpuScientificCampaignPromotionEvidence(
    changedAttestation,
  ), false);
  const flippedPreRelease = structuredClone(value.qualificationEvidence);
  flippedPreRelease.promotionEligible = true;
  assert.equal(verifyGpuScientificCampaignQualificationEvidence(
    flippedPreRelease,
  ), false);
});
