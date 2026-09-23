import { spawnSync as defaultSpawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMPUTE_CAPABILITY = /^\d{1,2}\.\d{1,2}$/u;
const DRIVER_VERSION = /^\d+(?:\.\d+){1,3}$/u;
// `nvidia-gpu-protected` is intentionally separate from the broad capability
// label.  The former must be attached only to the attested, isolated runner
// group; accepting `nvidia-gpu` alone would allow an arbitrary self-hosted
// runner to receive repository code.
const REQUIRED_RUNNER_LABELS = Object.freeze([
  'self-hosted', 'linux', 'x64', 'nvidia-gpu', 'nvidia-gpu-protected',
]);
const PREFLIGHT_KEYS = Object.freeze([
  'blockers', 'dockerImage', 'dockerImageDigest',
  'gpuDeviceObservation', 'kind', 'operationalSmokeReady',
  'productionPromotionEligible', 'runnerAttestation', 'runnerLabels',
  'ciOptIn', 'loadedRepoDigests', 'expectedCommit', 'observedCommit',
  'exactCommitBinding', 'replayRequirements', 'productionQualificationMinted',
  'status', 'version',
  'nvidiaGpuSelfHostedCiPreflightHash',
]);
const GPU_OBSERVATION_KEYS = Object.freeze([
  'computeCapability', 'driverVersion', 'gpuModel', 'gpuUuid',
]);

export const NVIDIA_GPU_SELF_HOSTED_CI_POLICY = Object.freeze({
  version: 2,
  kind: 'NvidiaGpuSelfHostedCiPolicy',
  requiredRunnerLabels: REQUIRED_RUNNER_LABELS,
  deviceCount: 1,
  imageMustBePreloaded: true,
  imageDigestRequired: true,
  networkPullAllowed: false,
  exactCommitBindingRequired: true,
  sameDeviceReplayScope: 'same-device-v1',
  secondHardwareReplayScope: 'independent-second-hardware-v1',
  independentSecondHardwareRequiredForPromotion: true,
  bitwiseRebuildRequiredForPromotion: true,
  productionPromotionEligible: false,
  productionQualificationMinted: false,
});

function digest(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function commit(value) {
  const selected = String(value || '').trim().toLowerCase();
  return COMMIT.test(selected) ? selected : null;
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
  expectedCommit,
  observedCommit,
  commandBlockers = [],
} = {}) {
  const image = canonicalImage(dockerImage);
  const imageDigest = digest(dockerImageDigest);
  const expected = commit(expectedCommit);
  const observedSource = commit(observedCommit);
  const labels = parseRunnerLabels(runnerLabels);
  const observed = observedGpu && Object.keys(observedGpu).length === 4
    && Object.keys(observedGpu).every((key) => GPU_OBSERVATION_KEYS.includes(key))
    && GPU_UUID.test(observedGpu.gpuUuid || '')
    && typeof observedGpu.gpuModel === 'string' && observedGpu.gpuModel.length > 0
    && COMPUTE_CAPABILITY.test(observedGpu.computeCapability || '')
    && DRIVER_VERSION.test(observedGpu.driverVersion || '')
    ? Object.freeze({ ...observedGpu }) : null;
  const repoDigests = parseRunnerLabels(loadedRepoDigests);
  const exactCommitBinding = Boolean(expected && observedSource
    && expected === observedSource);
  // These are deliberately requirements, not evidence.  The preflight can
  // establish runner readiness, but it cannot execute or independently
  // attest either replay scope.  Keeping both scopes in every receipt makes
  // that boundary machine-readable and prevents a local admin from turning a
  // smoke run into production qualification.
  const replayRequirements = Object.freeze({
    sameDevice: Object.freeze({
      scope: 'same-device-v1',
      status: 'contract_only_not_observed',
      evidenceHash: null,
      productionPromotionEligible: false,
    }),
    secondHardware: Object.freeze({
      scope: 'independent-second-hardware-v1',
      status: 'external_independent_replay_required',
      evidenceHash: null,
      productionPromotionEligible: false,
    }),
  });
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
    ...(expected ? [] : ['nvidia_gpu_ci_expected_commit_required']),
    ...(observedSource ? [] : ['nvidia_gpu_ci_observed_commit_unavailable']),
    ...(exactCommitBinding ? [] : (expected && observedSource
      ? ['nvidia_gpu_ci_exact_commit_mismatch'] : [])),
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
    expectedCommit: expected,
    observedCommit: observedSource,
    exactCommitBinding,
    gpuDeviceObservation: observed,
    replayRequirements,
    operationalSmokeReady: blockers.length === 0,
    productionPromotionEligible: false,
    productionQualificationMinted: false,
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
      expectedCommit: value.expectedCommit,
      observedCommit: value.observedCommit,
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
  expectedCommit = env.HEPTA_GPU_CI_EXPECTED_COMMIT || env.GITHUB_SHA,
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
  const source = invoke(spawnSync, 'git', [
    'rev-parse', '--verify', 'HEAD^{commit}',
  ]);
  return buildNvidiaGpuSelfHostedCiPreflight({
    enabled: env.HEPTA_ENABLE_GPU_CI === 'true',
    runnerLabels: env.HEPTA_GPU_CI_RUNNER_LABELS,
    runnerAttestation: env.HEPTA_GPU_CI_RUNNER_ATTESTED === 'true',
    ciOptIn: env.HEPTA_ENABLE_GPU_CI === 'true',
    dockerImage: image,
    dockerImageDigest: digestValue,
    expectedCommit,
    observedCommit: String(source.stdout || '').trim(),
    observedGpu: parseNvidiaGpuQueryCsv(gpu.stdout),
    loadedRepoDigests: parseDockerRepoDigests(docker.stdout) || [],
    commandBlockers: [gpu.blocker, docker.blocker, source.blocker].filter(Boolean),
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
