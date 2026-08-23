import { spawnSync as defaultSpawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMPUTE_CAPABILITY = /^\d{1,2}\.\d{1,2}$/u;
const DRIVER_VERSION = /^\d+(?:\.\d+){1,3}$/u;
const REQUIRED_RUNNER_LABELS = Object.freeze(['self-hosted', 'linux', 'x64', 'nvidia-gpu']);
const PREFLIGHT_KEYS = Object.freeze([
  'blockers', 'dockerImage', 'dockerImageDigest',
  'gpuDeviceObservation', 'kind', 'operationalSmokeReady',
  'productionPromotionEligible', 'runnerAttestation', 'runnerLabels',
  'ciOptIn', 'loadedRepoDigests', 'status', 'version',
  'nvidiaGpuSelfHostedCiPreflightHash',
]);
const GPU_OBSERVATION_KEYS = Object.freeze([
  'computeCapability', 'driverVersion', 'gpuModel', 'gpuUuid',
]);

export const NVIDIA_GPU_SELF_HOSTED_CI_POLICY = Object.freeze({
  version: 1,
  kind: 'NvidiaGpuSelfHostedCiPolicy',
  requiredRunnerLabels: REQUIRED_RUNNER_LABELS,
  deviceCount: 1,
  imageMustBePreloaded: true,
  imageDigestRequired: true,
  networkPullAllowed: false,
  bitwiseRebuildRequiredForPromotion: true,
  productionPromotionEligible: false,
});

function digest(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function uniqueSorted(values) {
  return Object.freeze([...new Set((values || []).map((value) => String(value).trim()))]
    .filter(Boolean)
    .sort());
}

function parseRunnerLabels(value) {
  if (Array.isArray(value)) return uniqueSorted(value);
  if (typeof value === 'string') return uniqueSorted(value.split(','));
  return Object.freeze([]);
}

export function parseNvidiaGpuQueryCsv(stdout) {
  const rows = String(stdout || '').split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((value) => value.trim()));
  if (rows.length !== 1 || rows[0].length !== 4) return null;
  const [gpuUuid, gpuModel, computeCapability, driverVersion] = rows[0];
  if (!GPU_UUID.test(gpuUuid) || !gpuModel || gpuModel.length > 256
    || !COMPUTE_CAPABILITY.test(computeCapability)
    || !DRIVER_VERSION.test(driverVersion)) return null;
  return Object.freeze({
    gpuUuid,
    gpuModel,
    computeCapability,
    driverVersion,
  });
}

export function parseDockerRepoDigests(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    if (!Array.isArray(parsed)) return null;
    return Object.freeze(uniqueSorted(parsed));
  } catch {
    return null;
  }
}

function canonicalImage(value) {
  const selected = String(value || '').trim();
  if (!selected || selected.length > 256 || /\s/u.test(selected)
    || selected.includes('@') || selected.includes('\\')) return null;
  return selected;
}

export function buildNvidiaGpuSelfHostedCiPreflight({
  enabled = false,
  runnerLabels = [],
  runnerAttestation = false,
  ciOptIn = enabled,
  dockerImage,
  dockerImageDigest,
  observedGpu = null,
  loadedRepoDigests = [],
  commandBlockers = [],
} = {}) {
  const image = canonicalImage(dockerImage);
  const imageDigest = digest(dockerImageDigest);
  const labels = parseRunnerLabels(runnerLabels);
  const observed = observedGpu && Object.keys(observedGpu).length === 4
    && Object.keys(observedGpu).every((key) => GPU_OBSERVATION_KEYS.includes(key))
    && GPU_UUID.test(observedGpu.gpuUuid || '')
    && typeof observedGpu.gpuModel === 'string' && observedGpu.gpuModel.length > 0
    && COMPUTE_CAPABILITY.test(observedGpu.computeCapability || '')
    && DRIVER_VERSION.test(observedGpu.driverVersion || '')
    ? Object.freeze({ ...observedGpu }) : null;
  const repoDigests = parseRunnerLabels(loadedRepoDigests);
  const blockers = uniqueSorted([
    ...commandBlockers,
    ...(enabled === true ? [] : ['nvidia_gpu_ci_opt_in_required']),
    ...(image ? [] : ['nvidia_gpu_ci_image_invalid']),
    ...(imageDigest ? [] : ['nvidia_gpu_ci_image_digest_invalid']),
    ...(REQUIRED_RUNNER_LABELS.every((label) => labels.includes(label))
      ? [] : ['nvidia_gpu_ci_runner_labels_invalid']),
    ...(runnerAttestation === true
      ? [] : ['nvidia_gpu_ci_runner_attestation_required']),
    ...(observed ? [] : ['nvidia_gpu_ci_exactly_one_gpu_required']),
    ...(image && imageDigest && repoDigests.includes(`${image}@${imageDigest}`)
      ? [] : ['nvidia_gpu_ci_pinned_image_not_preloaded']),
  ]);
  const payload = {
    version: 1,
    kind: 'NvidiaGpuSelfHostedCiPreflight',
    status: blockers.length
      ? 'nvidia_gpu_self_hosted_ci_preflight_blocked'
      : 'nvidia_gpu_self_hosted_ci_preflight_verified',
    runnerLabels: labels,
    runnerAttestation: runnerAttestation === true,
    ciOptIn: ciOptIn === true,
    dockerImage: image,
    dockerImageDigest: imageDigest,
    loadedRepoDigests: repoDigests,
    gpuDeviceObservation: observed,
    operationalSmokeReady: blockers.length === 0,
    productionPromotionEligible: false,
    blockers,
  };
  return Object.freeze({
    ...payload,
    nvidiaGpuSelfHostedCiPreflightHash: hashRecord(
      'NvidiaGpuSelfHostedCiPreflight', payload,
    ),
  });
}

export function verifyNvidiaGpuSelfHostedCiPreflight(value) {
  if (!value || JSON.stringify(Object.keys(value).sort())
    !== JSON.stringify([...PREFLIGHT_KEYS].sort())) return false;
  try {
    const rebuilt = buildNvidiaGpuSelfHostedCiPreflight({
      enabled: value.ciOptIn === true,
      runnerLabels: value.runnerLabels,
      runnerAttestation: value.runnerAttestation,
      ciOptIn: value.ciOptIn,
      dockerImage: value.dockerImage,
      dockerImageDigest: value.dockerImageDigest,
      observedGpu: value.gpuDeviceObservation,
      loadedRepoDigests: value.loadedRepoDigests,
    });
    // `enabled` is intentionally inferred only for the hash rebuild.  A
    // blocked receipt is still valid evidence of a fail-closed decision.
    return JSON.stringify(rebuilt) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function invoke(spawnSync, command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (!result || result.status !== 0) {
      return { stdout: '', blocker: `nvidia_gpu_ci_command_failed:${command}` };
    }
    return { stdout: String(result.stdout || ''), blocker: null };
  } catch (error) {
    return {
      stdout: '',
      blocker: `nvidia_gpu_ci_command_failed:${command}:${error?.code || 'error'}`,
    };
  }
}

export function runNvidiaGpuSelfHostedCiPreflight({
  env = process.env,
  spawnSync = defaultSpawnSync,
  dockerImage = env.HEPTA_GPU_CI_IMAGE,
  dockerImageDigest = env.HEPTA_GPU_CI_IMAGE_DIGEST,
} = {}) {
  const gpu = invoke(spawnSync, 'nvidia-smi', [
    '--query-gpu=uuid,name,compute_cap,driver_version',
    '--format=csv,noheader,nounits',
  ]);
  const image = canonicalImage(dockerImage);
  const digestValue = digest(dockerImageDigest);
  const docker = image && digestValue
    ? invoke(spawnSync, 'docker', [
      'image', 'inspect', `${image}@${digestValue}`, '--format', '{{json .RepoDigests}}',
    ]) : { stdout: '', blocker: 'nvidia_gpu_ci_image_reference_invalid' };
  return buildNvidiaGpuSelfHostedCiPreflight({
    enabled: env.HEPTA_ENABLE_GPU_CI === 'true',
    runnerLabels: env.HEPTA_GPU_CI_RUNNER_LABELS,
    runnerAttestation: env.HEPTA_GPU_CI_RUNNER_ATTESTED === 'true',
    ciOptIn: env.HEPTA_ENABLE_GPU_CI === 'true',
    dockerImage: image,
    dockerImageDigest: digestValue,
    observedGpu: parseNvidiaGpuQueryCsv(gpu.stdout),
    loadedRepoDigests: parseDockerRepoDigests(docker.stdout) || [],
    commandBlockers: [gpu.blocker, docker.blocker].filter(Boolean),
  });
}

function isMain(moduleUrl) {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

if (isMain(import.meta.url)) {
  const receipt = runNvidiaGpuSelfHostedCiPreflight();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.blockers.length ? 2 : 0;
}
