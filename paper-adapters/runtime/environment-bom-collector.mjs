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

function safeSpawn(spawnSyncImpl, executable, args, environment = {}) {
  try {
    const result = spawnSyncImpl(executable, args, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH || '', ...environment },
    });
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

function machineIdentityObservation(readFileSyncImpl) {
  for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = String(readFileSyncImpl(candidate, 'utf8')).trim();
      if (!/^[A-Za-z0-9-]{16,128}$/.test(value)) continue;
      return Object.freeze({
        machineIdentityHash: hashRecord('EmpiricalMachineIdentity', {
          source: candidate,
          value,
        }),
        machineIdentityObservation: candidate === '/etc/machine-id'
          ? 'linux_etc_machine_id_hash'
          : 'linux_dbus_machine_id_hash',
      });
    } catch {}
  }
  return Object.freeze({
    machineIdentityHash: null,
    machineIdentityObservation: 'unobserved',
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

function hostNumericalRuntimeObservation({ language, executable, env, spawnSyncImpl }) {
  const normalizedLanguage = String(language || '').toLowerCase();
  const probeEnvironment = Object.fromEntries(Object.entries(env || {})
    .filter(([key]) => THREAD_KEYS.includes(key) || ['OMP_DYNAMIC', 'MKL_DYNAMIC'].includes(key)));
  if (normalizedLanguage === 'node') {
    const behavior = Object.freeze({
      dot: [0.125, -0.25, 0.5, 1].reduce(
        (sum, value, index) => sum + (value * [8, 4, 2, 1][index]),
        0,
      ),
      hypot: Math.hypot(3, 4, 12),
      log1p: Math.log1p(Number.EPSILON),
      sqrt: Math.sqrt(2),
    });
    return Object.freeze({
      blasImplementationHash: null,
      blasImplementationObservation: 'unobserved',
      numericalLibraryBehaviorHash: hashRecord(
        'EmpiricalNumericalLibraryBehavior',
        behavior,
      ),
      numericalLibraryBehaviorObservation: 'ecmascript_number_behavior_probe_v1',
    });
  }
  const probes = {
    python: {
      implementation: ['-c', 'import numpy as n; n.show_config()'],
      behavior: ['-c', 'import json,numpy as n; a=n.array([0.125,-0.25,0.5,1.0],dtype=n.float64); b=n.array([8.0,4.0,2.0,1.0],dtype=n.float64); print(json.dumps({"dot":float(n.dot(a,b)),"norm":float(n.linalg.norm(a)),"solve":float(n.linalg.solve(n.array([[3.0,1.0],[1.0,2.0]]),n.array([9.0,8.0]))[0])},sort_keys=True,separators=(",",":")))'],
      observation: 'python_numpy_behavior_probe_v1',
    },
    r: {
      implementation: ['-e', 'cat(capture.output(sessionInfo()), sep="\\n")'],
      behavior: ['-e', 'cat(sprintf("dot=%.17g;norm=%.17g;solve=%.17g",crossprod(c(.125,-.25,.5,1),c(8,4,2,1)),sqrt(crossprod(c(.125,-.25,.5,1))),solve(matrix(c(3,1,1,2),2,2,byrow=TRUE),c(9,8))[1]))'],
      observation: 'r_numeric_behavior_probe_v1',
    },
    julia: {
      implementation: ['-e', 'using LinearAlgebra; println(BLAS.get_config())'],
      behavior: ['-e', 'using LinearAlgebra, Printf; a=[.125,-.25,.5,1.0]; b=[8.0,4.0,2.0,1.0]; @printf("dot=%.17g;norm=%.17g;solve=%.17g",dot(a,b),norm(a),([3.0 1.0;1.0 2.0]\\[9.0,8.0])[1])'],
      observation: 'julia_linear_algebra_behavior_probe_v1',
    },
  };
  const selected = probes[normalizedLanguage];
  if (!selected) return Object.freeze({
    blasImplementationHash: null,
    blasImplementationObservation: 'unobserved',
    numericalLibraryBehaviorHash: null,
    numericalLibraryBehaviorObservation: 'unobserved',
  });
  const implementation = safeSpawn(
    spawnSyncImpl,
    executable,
    selected.implementation,
    probeEnvironment,
  );
  const behavior = safeSpawn(
    spawnSyncImpl,
    executable,
    selected.behavior,
    probeEnvironment,
  );
  return Object.freeze({
    blasImplementationHash: implementation
      ? hashRecord('EmpiricalBlasImplementation', implementation) : null,
    blasImplementationObservation: implementation
      ? `${normalizedLanguage}_runtime_configuration_probe_v1` : 'unobserved',
    numericalLibraryBehaviorHash: behavior
      ? hashRecord('EmpiricalNumericalLibraryBehavior', behavior) : null,
    numericalLibraryBehaviorObservation: behavior
      ? selected.observation : 'unobserved',
  });
}

function numericRuntimeObservation({
  env = {}, language, executable, executionIdentity, spawnSyncImpl,
}) {
  const threads = Object.freeze(Object.fromEntries(THREAD_KEYS
    .filter((key) => env[key] !== undefined)
    .map((key) => [key, String(env[key])])));
  const explicitSingleThreadPolicy = THREAD_KEYS.every((key) => String(env[key] || '') === '1');
  const dynamicThreadingDisabled = ['OMP_DYNAMIC', 'MKL_DYNAMIC']
    .every((key) => ['false', '0'].includes(String(env[key] || '').trim().toLowerCase()));
  const suppliedBlasHash = SHA256.test(String(executionIdentity?.blasImplementationHash || ''))
    ? String(executionIdentity.blasImplementationHash).toLowerCase() : null;
  const suppliedBehaviorHash = SHA256.test(String(
    executionIdentity?.numericalLibraryBehaviorHash || '',
  )) ? String(executionIdentity.numericalLibraryBehaviorHash).toLowerCase() : null;
  const observedRuntime = suppliedBlasHash || suppliedBehaviorHash
    ? Object.freeze({
      blasImplementationHash: suppliedBlasHash,
      blasImplementationObservation: suppliedBlasHash
        ? 'runtime_identity_attestation' : 'unobserved',
      numericalLibraryBehaviorHash: suppliedBehaviorHash,
      numericalLibraryBehaviorObservation: suppliedBehaviorHash
        ? 'runtime_identity_attestation' : 'unobserved',
    })
    : executionIdentity?.runtimeType === 'container'
      ? Object.freeze({
        blasImplementationHash: null,
        blasImplementationObservation: 'unobserved',
        numericalLibraryBehaviorHash: null,
        numericalLibraryBehaviorObservation: 'unobserved',
      })
      : hostNumericalRuntimeObservation({ language, executable, env, spawnSyncImpl });
  return Object.freeze({
    threads,
    dynamicThreadingDisabled,
    explicitSingleThreadPolicy,
    policyObservation: 'worker_environment_allowlist',
    ...observedRuntime,
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
  const numericRuntime = numericRuntimeObservation({
    env,
    language,
    executable,
    executionIdentity,
    spawnSyncImpl,
  });
  const runtime = runtimeObservation({ executionIdentity, language, executable, runtimePackageClosure, spawnSyncImpl, fsModule });
  const gpu = gpuObservation({ required: requiresGpu, spawnSyncImpl });
  const determinism = determinismObservation({ requiresGpu, determinismPolicy, deterministicSeed, numericRuntime });
  const machineIdentity = machineIdentityObservation(readFileSyncImpl);
  const observedClaims = [
    'operating_system_and_architecture',
    'hashed_cpu_model_and_flags',
    'effective_resource_limits',
    runtime.type === 'container' ? 'container_image_content_digest' : 'host_executable_content_hash',
    ...(gpu.status === 'observed' ? ['hashed_gpu_model_compute_driver_and_runtime'] : []),
    ...(numericRuntime.explicitSingleThreadPolicy ? ['numeric_thread_environment_policy'] : []),
    ...(machineIdentity.machineIdentityHash ? ['hashed_machine_identity'] : []),
    ...(numericRuntime.blasImplementationHash ? ['blas_implementation_identity'] : []),
    ...(numericRuntime.numericalLibraryBehaviorHash
      ? ['numerical_library_behavior_identity'] : []),
  ];
  const unobservedClaims = [
    'bitwise_runtime_image_rebuild',
    'numerical_library_behavioral_equivalence',
    ...(machineIdentity.machineIdentityHash ? [] : ['machine_identity']),
    ...(numericRuntime.blasImplementationHash ? [] : ['blas_implementation_identity']),
    ...(numericRuntime.numericalLibraryBehaviorHash
      ? [] : ['numerical_library_behavior_identity']),
    ...(runtime.packageClosure.basis === 'unobserved' ? ['runtime_package_closure'] : []),
    ...(requiresGpu && gpu.status !== 'observed' ? ['gpu_hardware_and_driver_identity'] : []),
  ];
  return buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: process.platform,
      architecture: process.arch,
      kernelReleaseHash: hashRecord('EmpiricalKernelRelease', osModule.release()),
      ...machineIdentity,
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
