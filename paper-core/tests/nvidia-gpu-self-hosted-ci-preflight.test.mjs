import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildNvidiaGpuSelfHostedCiPreflight,
  parseDockerRepoDigests,
  parseNvidiaGpuQueryCsv,
  runNvidiaGpuSelfHostedCiPreflight,
  verifyNvidiaGpuSelfHostedCiPreflight,
} from '../../paper-adapters/research-verify/nvidia-gpu-self-hosted-ci-preflight.mjs';

const IMAGE = 'hepta/python-gpu:0.15.0';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);
const GPU_ROW = 'GPU-01234567-89ab-cdef-0123-456789abcdef, RTX 4060, 8.9, 580.173.02';
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fakeSpawn(_command, args) {
  if (args[0] === '--query-gpu=uuid,name,compute_cap,driver_version') {
    return { status: 0, stdout: `${GPU_ROW}\n`, stderr: '' };
  }
  if (args[0] === 'rev-parse') {
    return { status: 0, stdout: `${COMMIT}\n`, stderr: '' };
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
      HEPTA_GPU_CI_RUNNER_LABELS: 'self-hosted,linux,x64,nvidia-gpu,nvidia-gpu-protected',
      HEPTA_GPU_CI_RUNNER_ATTESTED: 'true',
      HEPTA_GPU_CI_EXPECTED_COMMIT: COMMIT,
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
  assert.equal(receipt.productionQualificationMinted, false);
  assert.equal(receipt.exactCommitBinding, true);
  assert.equal(receipt.expectedCommit, COMMIT);
  assert.equal(receipt.observedCommit, COMMIT);
  assert.equal(receipt.replayRequirements.sameDevice.productionPromotionEligible, false);
  assert.equal(receipt.replayRequirements.secondHardware.status,
    'external_independent_replay_required');
  assert.deepEqual(receipt.blockers, []);
  assert.equal(verifyNvidiaGpuSelfHostedCiPreflight(receipt), true);
});
test('NVIDIA preflight fails closed for missing attestation, device drift, and image drift', () => {
  const base = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu,nvidia-gpu-protected',
    runnerAttestation: false,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    expectedCommit: COMMIT,
    observedCommit: COMMIT,
    observedGpu: parseNvidiaGpuQueryCsv(GPU_ROW),
    loadedRepoDigests: [`${IMAGE}@${DIGEST}`],
  });
  assert.equal(base.status, 'nvidia_gpu_self_hosted_ci_preflight_blocked');
  assert.ok(base.blockers.includes('nvidia_gpu_ci_runner_attestation_required'));
  assert.equal(base.productionPromotionEligible, false);
  assert.equal(verifyNvidiaGpuSelfHostedCiPreflight(base), true);

  const twoDevices = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu,nvidia-gpu-protected',
    runnerAttestation: true,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    expectedCommit: COMMIT,
    observedCommit: COMMIT,
    observedGpu: null,
    loadedRepoDigests: [`${IMAGE}@${DIGEST}`],
  });
  assert.ok(twoDevices.blockers.includes('nvidia_gpu_ci_exactly_one_gpu_required'));

  const imageDrift = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu,nvidia-gpu-protected',
    runnerAttestation: true,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    expectedCommit: COMMIT,
    observedCommit: COMMIT,
    observedGpu: parseNvidiaGpuQueryCsv(GPU_ROW),
    loadedRepoDigests: [`${IMAGE}@${'b'.repeat(64)}`],
  });
  assert.ok(imageDrift.blockers.includes('nvidia_gpu_ci_pinned_image_not_preloaded'));
  assert.equal(imageDrift.productionPromotionEligible, false);
});

test('NVIDIA preflight rejects an unprotected label set and exact-commit drift', () => {
  const unprotected = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu',
    runnerAttestation: true,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    expectedCommit: COMMIT,
    observedCommit: COMMIT,
    observedGpu: parseNvidiaGpuQueryCsv(GPU_ROW),
    loadedRepoDigests: [`${IMAGE}@${DIGEST}`],
  });
  assert.ok(unprotected.blockers.includes('nvidia_gpu_ci_runner_labels_invalid'));

  const drifted = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu,nvidia-gpu-protected',
    runnerAttestation: true,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    expectedCommit: COMMIT,
    observedCommit: 'b'.repeat(40),
    observedGpu: parseNvidiaGpuQueryCsv(GPU_ROW),
    loadedRepoDigests: [`${IMAGE}@${DIGEST}`],
  });
  assert.ok(drifted.blockers.includes('nvidia_gpu_ci_exact_commit_mismatch'));
  assert.equal(drifted.exactCommitBinding, false);
  assert.equal(verifyNvidiaGpuSelfHostedCiPreflight(drifted), true);
});

test('NVIDIA preflight cannot become ready without both commit observations', () => {
  const missing = buildNvidiaGpuSelfHostedCiPreflight({
    enabled: true,
    runnerLabels: 'self-hosted,linux,x64,nvidia-gpu,nvidia-gpu-protected',
    runnerAttestation: true,
    dockerImage: IMAGE,
    dockerImageDigest: DIGEST,
    observedGpu: parseNvidiaGpuQueryCsv(GPU_ROW),
    loadedRepoDigests: [`${IMAGE}@${DIGEST}`],
  });
  assert.ok(missing.blockers.includes('nvidia_gpu_ci_expected_commit_required'));
  assert.ok(missing.blockers.includes('nvidia_gpu_ci_observed_commit_unavailable'));
  assert.equal(missing.exactCommitBinding, false);
  assert.equal(missing.operationalSmokeReady, false);
  assert.equal(verifyNvidiaGpuSelfHostedCiPreflight(missing), true);
});

test('NVIDIA workflow routes only to protected runners and pins the event commit', () => {
  const workflow = fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github/workflows/gpu-scientific.yml'), 'utf8',
  );
  assert.match(workflow, /runs-on:\s*\[self-hosted, linux, x64, nvidia-gpu, nvidia-gpu-protected\]/u);
  assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /HEPTA_GPU_CI_EXPECTED_COMMIT:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /git rev-parse --verify HEAD\^\{commit\}/u);
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/u);
  assert.match(workflow, /productionQualificationMinted=false/u);
  assert.match(workflow, /SAME_DEVICE_REPLAY_SCOPE:\s*same-device-v1/u);
  assert.match(workflow, /SECOND_HARDWARE_REPLAY_SCOPE:\s*independent-second-hardware-v1/u);
  assert.match(workflow, /independent-second-hardware-replay/u);
});
