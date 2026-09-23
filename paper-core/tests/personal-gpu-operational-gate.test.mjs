import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import {
  buildPersonalGpuOperationalReceipt,
  verifyPersonalGpuOperationalReceipt,
} from '../../paper-domain/research/personal-gpu-operational-gate-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('PersonalGpuOperationalGateTest', { label });
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const GPU = {
  gpuUuid: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee',
  gpuModel: 'NVIDIA GeForce RTX 4060',
  computeCapability: '8.9',
  driverVersion: '580.173.02',
  memoryMiB: 8188,
};

function evidence() {
  const deepLearning = {
    status: 'personal_deep_learning_gpu_verified_non_promotable',
    originalReceiptHash: H('dl-original'),
    replayReceiptHash: H('dl-replay'),
    sameDeviceReplayHash: H('dl-same-device'),
    cpuOracleHash: H('dl-cpu'),
    cpuOracleStatus: 'process_isolated_deep_learning_cpu_oracle_verified',
    hiddenEvaluationHash: H('dl-hidden'),
    hiddenEvaluationStatus: 'deep_learning_hidden_evaluation_recorded',
    modelIrHash: H('model'),
    datasetManifestHash: H('dataset'),
    checkpointManifestHash: H('checkpoint'),
    deterministicReplay: true,
    errorBudgetHash: H('budget'),
  };
  return {
    pde: {
      status: 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable',
      receiptHash: H('pde'),
      cpuOracleStatus: 'process_isolated_pde_poisson_2d_cpu_oracle_verified',
      cpuOracleHash: H('pde-cpu'),
      scientificChecksPassed: true,
    },
    deepLearning,
    ir: {
      modelHash: deepLearning.modelIrHash,
      datasetHash: deepLearning.datasetManifestHash,
      checkpointHash: deepLearning.checkpointManifestHash,
      modelExecutableCodeEmbedded: false,
      checkpointExecutablePayloadAllowed: false,
      pickleAllowed: false,
    },
  };
}

test('personal gate receipt can be ready locally while release promotion stays false', () => {
  const value = evidence();
  const receipt = buildPersonalGpuOperationalReceipt({
    createdAtEpochMs: 1_750_000_000_000,
    workspaceCommit: COMMIT,
    gpu: GPU,
    runtime: {
      image: 'hepta/python-gpu:0.15.0', imageDigest: H('image'),
      dockerDigestBound: true, networkDisabled: true, singleDevicePinned: true,
    },
    ...value,
  });
  assert.equal(receipt.personalProductionReady, true);
  assert.equal(receipt.releaseBoundary.releasePromotionEligible, false);
  assert.equal(receipt.localPolicy.secondHardwareStatus, 'not_applicable_for_personal_use');
  assert.deepEqual(receipt.blockers, []);
  assert.equal(verifyPersonalGpuOperationalReceipt(receipt), true);
});

test('personal gate rejects forged readiness and records local failures', () => {
  const value = evidence();
  const blocked = buildPersonalGpuOperationalReceipt({
    createdAtEpochMs: 1_750_000_000_000,
    workspaceCommit: COMMIT,
    gpu: GPU,
    runtime: {
      image: 'hepta/python-gpu:0.15.0', imageDigest: H('image'),
      dockerDigestBound: true, networkDisabled: false, singleDevicePinned: true,
    },
    ...value,
  });
  assert.equal(blocked.personalProductionReady, false);
  assert.ok(blocked.blockers.includes('personal_gpu_receipt_runtime_invalid'));
  assert.equal(verifyPersonalGpuOperationalReceipt(blocked), true);

  const forged = structuredClone(buildPersonalGpuOperationalReceipt({
    createdAtEpochMs: 1_750_000_000_000,
    workspaceCommit: COMMIT,
    gpu: GPU,
    runtime: {
      image: 'hepta/python-gpu:0.15.0', imageDigest: H('image'),
      dockerDigestBound: true, networkDisabled: true, singleDevicePinned: true,
    },
    ...value,
  }));
  forged.personalProductionReady = false;
  assert.equal(verifyPersonalGpuOperationalReceipt(forged), false);
});

test('CLI check is fail-closed when no local receipt exists', () => {
  const bin = path.resolve('paper-core/bin/personal-gpu-operational-gate.mjs');
  const result = spawnSync(process.execPath, [
    bin, '--check', '--receipt', '/tmp/hepta-personal-gpu-receipt-that-does-not-exist.json',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 2);
  const value = JSON.parse(result.stdout);
  assert.equal(value.kind, 'PersonalGpuOperationalReceipt');
  assert.equal(value.personalProductionReady, false);
  assert.ok(value.blockers.some((item) => item.startsWith('personal_gpu_gate_failed:')));
  assert.equal(verifyPersonalGpuOperationalReceipt(value), true);
});
