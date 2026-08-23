import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNvidiaGpuSelfHostedCiPreflight,
  parseDockerRepoDigests,
  parseNvidiaGpuQueryCsv,
  runNvidiaGpuSelfHostedCiPreflight,
  verifyNvidiaGpuSelfHostedCiPreflight,
} from '../../paper-adapters/research-verify/nvidia-gpu-self-hosted-ci-preflight.mjs';

const IMAGE = 'hepta/python-gpu:0.15.0';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const GPU_ROW = 'GPU-01234567-89ab-cdef-0123-456789abcdef, RTX 4060, 8.9, 580.173.02';

function fakeSpawn(_command, args) {
  if (args[0] === '--query-gpu=uuid,name,compute_cap,driver_version') {
    return { status: 0, stdout: `${GPU_ROW}\n`, stderr: '' };
  }
  return {
    status: 0,
    stdout: JSON.stringify([`${IMAGE}@${DIGEST}`]),
    stderr: '',
  };
}

test('NVIDIA preflight accepts only an explicitly attested, one-device pinned runner', () => {
  assert.deepEqual(parseNvidiaGpuQueryCsv(GPU_ROW), {
    gpuUuid: 'GPU-01234567-89ab-cdef-0123-456789abcdef',
    gpuModel: 'RTX 4060',
    computeCapability: '8.9',
    driverVersion: '580.173.02',
  });
  assert.deepEqual(parseDockerRepoDigests(JSON.stringify([
    `${IMAGE}@${DIGEST}`,
  ])), [`${IMAGE}@${DIGEST}`]);
  const receipt = runNvidiaGpuSelfHostedCiPreflight({
    env: {
      HEPTA_ENABLE_GPU_CI: 'true',
      HEPTA_GPU_CI_RUNNER_LABELS: 'self-hosted,linux,x64,nvidia-gpu',
      HEPTA_GPU_CI_RUNNER_ATTESTED: 'true',
      HEPTA_GPU_CI_IMAGE: IMAGE,
      HEPTA_GPU_CI_IMAGE_DIGEST: DIGEST,
    },
    spawnSync: fakeSpawn,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
  });
  assert.equal(receipt.status, 'nvidia_gpu_self_hosted_ci_preflight_verified');
  assert.equal(receipt.operationalSmokeReady, true);
  assert.equal(receipt.productionPromotionEligible, false);
  assert.deepEqual(receipt.blockers, []);
  assert.equal(verifyNvidiaGpuSelfHostedCiPreflight(receipt), true);
});
test('NVIDIA preflight fails closed for missing attestation, device drift, and image drift', () => {
  const base = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu',
    runnerAttestation: false,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    observedGpu: parseNvidiaGpuQueryCsv(GPU_ROW),
    loadedRepoDigests: [`${IMAGE}@${DIGEST}`],
  });
  assert.equal(base.status, 'nvidia_gpu_self_hosted_ci_preflight_blocked');
  assert.ok(base.blockers.includes('nvidia_gpu_ci_runner_attestation_required'));
  assert.equal(base.productionPromotionEligible, false);
  assert.equal(verifyNvidiaGpuSelfHostedCiPreflight(base), true);

  const twoDevices = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu',
    runnerAttestation: true,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    observedGpu: null,
    loadedRepoDigests: [`${IMAGE}@${DIGEST}`],
  });
  assert.ok(twoDevices.blockers.includes('nvidia_gpu_ci_exactly_one_gpu_required'));

  const imageDrift = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu',
    runnerAttestation: true,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    observedGpu: parseNvidiaGpuQueryCsv(GPU_ROW),
    loadedRepoDigests: [`${IMAGE}@${'b'.repeat(64)}`],
  });
  assert.ok(imageDrift.blockers.includes('nvidia_gpu_ci_pinned_image_not_preloaded'));
  assert.equal(imageDrift.productionPromotionEligible, false);
});
