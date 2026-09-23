import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createGpuScientificCampaignQualificationIntakeRepository,
  gpuScientificCampaignQualificationIntakePath,
} from '../../paper-adapters/automation/gpu-scientific-campaign-qualification-intake-repository.mjs';
import {
  GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  buildGpuScientificCampaignProductionQualificationAuthority,
  buildGpuScientificCampaignQualificationEvidence,
  buildGpuScientificCampaignQualificationRequest,
  buildGpuScientificCampaignSameDeviceReplayReceipt,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;

function request() {
  return buildGpuScientificCampaignQualificationRequest({
    campaignId: 'campaign',
    paperId: 'paper',
    campaignPlanHash: H('1'),
    nodeId: 'campaign:0:gpu-scientific-execution',
    attemptId: 'attempt',
    leaseGeneration: 1,
    executionPlanHash: H('2'),
    taskSetHash: H('3'),
    gpuDeviceSelector: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee',
    gpuScientificCampaignAttemptAuthorityHash: H('5'),
    gpuScientificCampaignExecutionResultHash: H('6'),
    artifactArchiveManifestHash: H('7'),
    scientificOutputCommitmentHash: H('8'),
    pdeTaskReceiptHash: H('9'),
    deepLearningTaskReceiptHash: H('a'),
    runtimeImageDigest: H('b'),
    runtimePackageClosureHash: H('c'),
    originalExecutionProcessIdentityHashes: Object.freeze({
      deepLearning: H('d'),
      pde: H('e'),
    }),
  });
}

function signature(keyId, role) {
  return Object.freeze({
    algorithm: 'ed25519',
    keyId,
    role,
    value: Buffer.alloc(64, keyId.length).toString('base64'),
  });
}

function evidence(selectedRequest = request()) {
  const replay = buildGpuScientificCampaignSameDeviceReplayReceipt({
    request: selectedRequest,
    replayPdeTaskReceiptHash: H('f'),
    replayDeepLearningTaskReceiptHash: H('0'),
    replayExecutionProcessIdentityHashes: {
      deepLearning: H('2'),
      pde: H('3'),
    },
    replayScientificOutputCommitmentHash:
      selectedRequest.scientificOutputCommitmentHash,
    replayedAt: '2026-08-14T00:01:00.000Z',
    signedAt: '2026-08-14T00:02:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
    signatures: [signature(
      'replay-key',
      GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
    )],
  });
  const authority = buildGpuScientificCampaignProductionQualificationAuthority({
    request: selectedRequest,
    sameDeviceReplayReceipt: replay,
    signedAt: '2026-08-14T00:03:00.000Z',
    expiresAt: '2026-08-19T00:00:00.000Z',
    signatures: [signature(
      'qualification-key',
      GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
    )],
  });
  return buildGpuScientificCampaignQualificationEvidence({
    request: selectedRequest,
    sameDeviceReplayReceipt: replay,
    productionQualificationAuthority: authority,
  });
}

test('qualification intake path is deterministic and rejects arbitrary scope/hash input', () => {
  const root = path.join(os.tmpdir(), 'hepta-intake-root');
  assert.equal(gpuScientificCampaignQualificationIntakePath({
    runtimeRoot: root,
    qualificationRequestHash: H('a'),
  }), path.join(
    root,
    'external-qualification-intake',
    'gpu-scientific',
    'a'.repeat(64),
    'GPU_SCIENTIFIC_CAMPAIGN_QUALIFICATION_AUTHORITY.json',
  ));
  assert.throws(() => gpuScientificCampaignQualificationIntakePath({
    runtimeRoot: '/', qualificationRequestHash: H('a'),
  }), /intake_scope_invalid/);
  assert.throws(() => gpuScientificCampaignQualificationIntakePath({
    runtimeRoot: root, qualificationRequestHash: '../escape',
  }), /intake_scope_invalid/);
});

test('qualification intake reads only the deterministic private no-clobber authority file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-intake-'));
  try {
    const repository = createGpuScientificCampaignQualificationIntakeRepository({
      runtimeRoot: root,
    });
    const selectedRequest = request();
    assert.equal(repository.resolve({ request: selectedRequest }), null);
    const candidate = gpuScientificCampaignQualificationIntakePath({
      runtimeRoot: root,
      qualificationRequestHash:
        selectedRequest.gpuScientificCampaignQualificationRequestHash,
    });
    fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(candidate), 0o700);
    fs.writeFileSync(candidate, `${JSON.stringify(evidence(selectedRequest))}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    const intake = repository.resolve({ request: selectedRequest });
    assert.equal(
      intake.evidence.gpuScientificCampaignQualificationRequestHash,
      selectedRequest.gpuScientificCampaignQualificationRequestHash,
    );
    fs.chmodSync(candidate, 0o644);
    assert.throws(() => repository.resolve({ request: selectedRequest }),
      /intake_file_unsafe/);
    assert.throws(() => repository.resolve({ request: { ...selectedRequest,
      campaignId: 'other-campaign' } }),
      /intake_request_invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
