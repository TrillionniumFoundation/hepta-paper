import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const THREAD_KEYS = Object.freeze([
  'OMP_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'MKL_NUM_THREADS',
  'NUMEXPR_NUM_THREADS',
  'BLIS_NUM_THREADS',
  'VECLIB_MAXIMUM_THREADS',
]);

function safeSpawn(spawnSyncImpl, executable, args) {
  try {
    const result = spawnSyncImpl(executable, args, { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH || '' } });
    return result?.status === 0 ? String(result.stdout || '').trim() : '';
  } catch { return ''; }
}

function safeReadCpuInfo(readFileSyncImpl) {
  try { return String(readFileSyncImpl('/proc/cpuinfo', 'utf8')); } catch { return ''; }
}

function cpuObservation({ readFileSyncImpl, osModule }) {
  const text = safeReadCpuInfo(readFileSyncImpl);
  const model = text.match(/^model name\s*:\s*(.+)$/im)?.[1]?.trim()
    || osModule.cpus?.()?.[0]?.model
    || 'unobserved';
  const flags = (text.match(/^flags\s*:\s*(.+)$/im)?.[1] || '')
    .split(/\s+/).map((value) => value.trim()).filter(Boolean).sort();
  const logicalProcessorCount = Math.max(1, Number(osModule.cpus?.()?.length || 1));
  return Object.freeze({
    modelHash: hashRecord('EmpiricalCpuModel', String(model)),
    flagsHash: hashRecord('EmpiricalCpuFlags', flags),
    logicalProcessorCount,
    observation: text ? 'linux_proc_cpuinfo' : 'node_os_cpu_fallback',
  });
}

function gpuObservation({ required, spawnSyncImpl }) {
  if (!required) return Object.freeze({ required: false, status: 'not_required', deviceCount: 0 });
  const csv = safeSpawn(spawnSyncImpl, 'nvidia-smi', ['--query-gpu=name,compute_cap,driver_version', '--format=csv,noheader,nounits']);
  const summary = safeSpawn(spawnSyncImpl, 'nvidia-smi', []);
  const rows = csv.split(/\r?\n/).map((line) => line.split(',').map((part) => part.trim())).filter((parts) => parts.length === 3 && parts.every(Boolean));
  const runtimeVersion = summary.match(/CUDA Version:\s*([0-9.]+)/i)?.[1] || '';
  if (!rows.length || !runtimeVersion) return Object.freeze({ required: true, status: 'unavailable', deviceCount: 0 });
  return Object.freeze({
    required: true,
    status: 'observed',
    deviceCount: rows.length,
    modelSetHash: hashRecord('EmpiricalGpuModelSet', rows.map(([model]) => model).sort()),
    computeCapabilitySetHash: hashRecord('EmpiricalGpuComputeCapabilitySet', rows.map(([, capability]) => capability).sort()),
    driverVersionHash: hashRecord('EmpiricalGpuDriverVersionSet', rows.map(([, , driver]) => driver).sort()),
    runtimeVersionHash: hashRecord('EmpiricalGpuRuntimeVersion', runtimeVersion),
  });
}

function numericRuntimeObservation(env = {}) {
  const threads = Object.freeze(Object.fromEntries(THREAD_KEYS
    .filter((key) => env[key] !== undefined)
    .map((key) => [key, String(env[key])])));
  const explicitSingleThreadPolicy = THREAD_KEYS.every((key) => String(env[key] || '') === '1');
  const dynamicThreadingDisabled = ['OMP_DYNAMIC', 'MKL_DYNAMIC']
    .every((key) => ['false', '0'].includes(String(env[key] || '').trim().toLowerCase()));
  return Object.freeze({
    threads,
    dynamicThreadingDisabled,
    explicitSingleThreadPolicy,
    policyObservation: 'worker_environment_allowlist',
    blasImplementationHash: null,
  });
}

function resolveHostExecutable(executable, { spawnSyncImpl, fsModule }) {
  const supplied = String(executable || '');
  const resolved = path.isAbsolute(supplied) ? supplied : safeSpawn(spawnSyncImpl, 'which', [supplied]);
  if (!resolved) return null;
  try {
    const real = fsModule.realpathSync.native(resolved);
    const stat = fsModule.lstatSync(real);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return Object.freeze({ path: real, hash: sha256FileSync(real) });
  } catch { return null; }
}

function runtimeObservation({ executionIdentity, language, executable, runtimePackageClosure, spawnSyncImpl, fsModule }) {
  const type = executionIdentity?.runtimeType;
  const identityHash = String(executionIdentity?.runtimeIdentityHash || '').toLowerCase();
  if (type === 'container') {
    const digest = String(executionIdentity?.digest || executionIdentity?.containerImageDigest || '').toLowerCase();
    return Object.freeze({
      type,
      identityHash,
      language,
      languageVersionHash: SHA256.test(String(executionIdentity?.languageVersionHash || ''))
        ? executionIdentity.languageVersionHash
        : null,
      containerImageDigest: digest,
      hostExecutableHash: null,
      packageClosure: runtimePackageClosure || Object.freeze({
        basis: 'container_image_digest',
        identityHash: digest,
        manifestHash: null,
        observedPackageCount: 0,
      }),
    });
  }
  const host = resolveHostExecutable(executable, { spawnSyncImpl, fsModule });
  const versionText = safeSpawn(spawnSyncImpl, host?.path || executable, ['--version']);
  return Object.freeze({
    type: 'host',
    identityHash,
    language,
    languageVersionHash: versionText ? hashRecord('EmpiricalLanguageVersion', versionText) : null,
    containerImageDigest: null,
    hostExecutableHash: host?.hash || null,
    packageClosure: runtimePackageClosure || Object.freeze({
      basis: 'unobserved', identityHash: null, manifestHash: null, observedPackageCount: 0,
    }),
  });
}

function determinismObservation({ requiresGpu, determinismPolicy, deterministicSeed, numericRuntime }) {
  const explicitlyRequested = determinismPolicy === 'explicit_deterministic_cpu';
  const deterministicSeedBound = deterministicSeed !== undefined && deterministicSeed !== null && String(deterministicSeed) !== '';
  let classification = 'unknown';
  if (requiresGpu) classification = 'gpu_nondeterministic';
  else if (determinismPolicy === 'nondeterministic') classification = 'nondeterministic';
  else if (explicitlyRequested) classification = 'explicit_deterministic_cpu';
  return Object.freeze({
    classification,
    explicitlyRequested,
    deterministicSeedRequired: explicitlyRequested,
    deterministicSeedBound,
    threadPolicyVerified: numericRuntime.explicitSingleThreadPolicy && numericRuntime.dynamicThreadingDisabled,
    gpuDeterminismVerified: false,
  });
}

function defaultBuildAssessment(runtime, supplied) {
  if (supplied) return supplied;
  const contentPinned = runtime.type === 'container' && SHA256.test(String(runtime.containerImageDigest || ''));
  return Object.freeze({
    status: contentPinned ? 'runtime_content_identity_pinned_rebuild_not_assessed' : 'build_reproducibility_unverified',
    runtimeContentIdentityPinned: contentPinned,
    bitwiseRebuildVerified: false,
    definitionHash: null,
    blockers: contentPinned
      ? ['bitwise_rebuild_not_verified', 'runtime_build_definition_not_bound']
      : ['runtime_content_identity_not_pinned', 'bitwise_rebuild_not_verified'],
  });
}

export function collectEmpiricalEnvironmentBom({
  executionIdentity,
  language,
  executable,
  requiresGpu = false,
  determinismPolicy = 'unknown',
  deterministicSeed = null,
  resourceLimits = {},
  env = {},
  runtimePackageClosure = null,
  buildReproducibility = null,
  spawnSyncImpl = spawnSync,
  readFileSyncImpl = fs.readFileSync,
  fsModule = fs,
  osModule = os,
} = {}) {
  const numericRuntime = numericRuntimeObservation(env);
  const runtime = runtimeObservation({ executionIdentity, language, executable, runtimePackageClosure, spawnSyncImpl, fsModule });
  const gpu = gpuObservation({ required: requiresGpu, spawnSyncImpl });
  const determinism = determinismObservation({ requiresGpu, determinismPolicy, deterministicSeed, numericRuntime });
  const observedClaims = [
    'operating_system_and_architecture',
    'hashed_cpu_model_and_flags',
    'effective_resource_limits',
    runtime.type === 'container' ? 'container_image_content_digest' : 'host_executable_content_hash',
    ...(gpu.status === 'observed' ? ['hashed_gpu_model_compute_driver_and_runtime'] : []),
    ...(numericRuntime.explicitSingleThreadPolicy ? ['numeric_thread_environment_policy'] : []),
  ];
  const unobservedClaims = [
    'machine_identity',
    'bitwise_runtime_image_rebuild',
    'numerical_library_behavioral_equivalence',
    ...(numericRuntime.blasImplementationHash ? [] : ['blas_implementation_identity']),
    ...(runtime.packageClosure.basis === 'unobserved' ? ['runtime_package_closure'] : []),
    ...(requiresGpu && gpu.status !== 'observed' ? ['gpu_hardware_and_driver_identity'] : []),
  ];
  return buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: process.platform,
      architecture: process.arch,
      kernelReleaseHash: hashRecord('EmpiricalKernelRelease', osModule.release()),
      cpu: cpuObservation({ readFileSyncImpl, osModule }),
    },
    runtime,
    gpu,
    numericRuntime,
    limits: resourceLimits,
    determinism,
    buildReproducibility: defaultBuildAssessment(runtime, buildReproducibility),
    observedClaims,
    unobservedClaims,
  });
}
