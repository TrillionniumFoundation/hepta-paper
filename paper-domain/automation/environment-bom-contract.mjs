import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_TYPES = new Set(['container', 'host']);
const GPU_STATUSES = new Set(['not_required', 'observed', 'unavailable']);
const DETERMINISM_CLASSES = new Set([
  'explicit_deterministic_cpu',
  'nondeterministic',
  'unknown',
  'gpu_nondeterministic',
]);
const PACKAGE_CLOSURE_BASES = new Set(['container_image_digest', 'content_manifest', 'unobserved']);
const BUILD_STATUSES = new Set([
  'not_assessed',
  'build_reproducibility_unverified',
  'runtime_content_identity_pinned_rebuild_not_assessed',
  'runtime_content_identity_pinned_rebuild_not_verified',
  'bitwise_rebuild_verified',
]);
const NUMERIC_THREAD_KEYS = new Set([
  'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
  'BLIS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'RAYON_NUM_THREADS',
]);
const REQUIRED_SINGLE_THREAD_KEYS = Object.freeze([
  'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
  'BLIS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS',
]);

function sortedStrings(values) {
  return Object.freeze([...new Set((values || []).map(String).filter(Boolean))].sort());
}

function isCanonicalStringSet(values) {
  return Array.isArray(values) && JSON.stringify(values) === JSON.stringify([...new Set(values.map(String).filter(Boolean))].sort());
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validHash(value) {
  return SHA256.test(String(value || ''));
}

function hashPayload(kind, value, hashKey) {
  const payload = { ...value };
  delete payload[hashKey];
  return hashRecord(kind, payload);
}

function normalizeLimits(limits = {}) {
  const payload = Object.freeze({
    timeoutMs: Number(limits.timeoutMs || 0),
    memoryBytes: Number(limits.memoryBytes || 0),
    cpuSeconds: Number(limits.cpuSeconds || 0),
    maximumPids: Number(limits.maximumPids || 0),
    maximumOutputBytes: Number(limits.maximumOutputBytes || 0),
    maximumCapturedBytes: Number(limits.maximumCapturedBytes || 0),
  });
  return Object.freeze({
    ...payload,
    resourceLimitsHash: hashRecord('EmpiricalEnvironmentResourceLimits', payload),
  });
}

function normalizePlatform(platform = {}) {
  const cpu = Object.freeze({
    modelHash: String(platform.cpu?.modelHash || '').toLowerCase(),
    flagsHash: String(platform.cpu?.flagsHash || '').toLowerCase(),
    logicalProcessorCount: Number(platform.cpu?.logicalProcessorCount || 0),
    observation: String(platform.cpu?.observation || 'unobserved'),
  });
  const payload = Object.freeze({
    operatingSystem: String(platform.operatingSystem || '').toLowerCase(),
    architecture: String(platform.architecture || '').toLowerCase(),
    kernelReleaseHash: String(platform.kernelReleaseHash || '').toLowerCase(),
    machineIdentityHash: platform.machineIdentityHash
      ? String(platform.machineIdentityHash).toLowerCase() : null,
    machineIdentityObservation: String(
      platform.machineIdentityObservation || 'unobserved',
    ),
    cpu,
  });
  return Object.freeze({
    ...payload,
    hardwareIdentityHash: hashRecord('EmpiricalEnvironmentHardwareIdentity', payload),
  });
}

function normalizeRuntime(runtime = {}) {
  const packageClosure = Object.freeze({
    basis: String(runtime.packageClosure?.basis || 'unobserved'),
    identityHash: runtime.packageClosure?.identityHash ? String(runtime.packageClosure.identityHash).toLowerCase() : null,
    manifestHash: runtime.packageClosure?.manifestHash ? String(runtime.packageClosure.manifestHash).toLowerCase() : null,
    observedPackageCount: Number(runtime.packageClosure?.observedPackageCount || 0),
  });
  const payload = Object.freeze({
    type: String(runtime.type || ''),
    identityHash: String(runtime.identityHash || '').toLowerCase(),
    language: String(runtime.language || '').toLowerCase(),
    languageVersionHash: runtime.languageVersionHash ? String(runtime.languageVersionHash).toLowerCase() : null,
    containerImageDigest: runtime.containerImageDigest ? String(runtime.containerImageDigest).toLowerCase() : null,
    hostExecutableHash: runtime.hostExecutableHash ? String(runtime.hostExecutableHash).toLowerCase() : null,
    packageClosure,
  });
  return Object.freeze({
    ...payload,
    runtimeClosureHash: hashRecord('EmpiricalEnvironmentRuntimeClosure', payload),
  });
}

function normalizeGpu(gpu = {}) {
  const payload = Object.freeze({
    required: gpu.required === true,
    status: String(gpu.status || (gpu.required ? 'unavailable' : 'not_required')),
    deviceCount: Number(gpu.deviceCount || 0),
    modelSetHash: gpu.modelSetHash ? String(gpu.modelSetHash).toLowerCase() : null,
    computeCapabilitySetHash: gpu.computeCapabilitySetHash ? String(gpu.computeCapabilitySetHash).toLowerCase() : null,
    driverVersionHash: gpu.driverVersionHash ? String(gpu.driverVersionHash).toLowerCase() : null,
    runtimeVersionHash: gpu.runtimeVersionHash ? String(gpu.runtimeVersionHash).toLowerCase() : null,
  });
  return Object.freeze({
    ...payload,
    gpuIdentityHash: hashRecord('EmpiricalEnvironmentGpuIdentity', payload),
  });
}

function normalizeNumericRuntime(numericRuntime = {}) {
  const threads = Object.freeze(Object.fromEntries(Object.entries(numericRuntime.threads || {})
    .map(([key, value]) => [String(key), String(value)])
    .sort(([left], [right]) => left.localeCompare(right))));
  const payload = Object.freeze({
    threads,
    dynamicThreadingDisabled: numericRuntime.dynamicThreadingDisabled === true,
    explicitSingleThreadPolicy: numericRuntime.explicitSingleThreadPolicy === true,
    policyObservation: String(numericRuntime.policyObservation || 'environment_allowlist'),
    blasImplementationHash: numericRuntime.blasImplementationHash ? String(numericRuntime.blasImplementationHash).toLowerCase() : null,
    blasImplementationObservation: String(
      numericRuntime.blasImplementationObservation || 'unobserved',
    ),
    numericalLibraryBehaviorHash: numericRuntime.numericalLibraryBehaviorHash
      ? String(numericRuntime.numericalLibraryBehaviorHash).toLowerCase() : null,
    numericalLibraryBehaviorObservation: String(
      numericRuntime.numericalLibraryBehaviorObservation || 'unobserved',
    ),
  });
  return Object.freeze({
    ...payload,
    numericRuntimePolicyHash: hashRecord('EmpiricalNumericRuntimePolicy', payload),
  });
}

function normalizeDeterminism(determinism = {}) {
  const payload = Object.freeze({
    classification: String(determinism.classification || 'unknown'),
    explicitlyRequested: determinism.explicitlyRequested === true,
    deterministicSeedRequired: determinism.deterministicSeedRequired === true,
    deterministicSeedBound: determinism.deterministicSeedBound === true,
    threadPolicyVerified: determinism.threadPolicyVerified === true,
    gpuDeterminismVerified: determinism.gpuDeterminismVerified === true,
  });
  return Object.freeze({
    ...payload,
    determinismPolicyHash: hashRecord('EmpiricalDeterminismPolicy', payload),
  });
}

function normalizeBuildReproducibility(build = {}) {
  const payload = Object.freeze({
    status: String(build.status || 'not_assessed'),
    runtimeContentIdentityPinned: build.runtimeContentIdentityPinned === true,
    bitwiseRebuildVerified: build.bitwiseRebuildVerified === true,
    definitionHash: build.definitionHash ? String(build.definitionHash).toLowerCase() : null,
    evidenceHash: build.evidenceHash ? String(build.evidenceHash).toLowerCase() : null,
    blockers: sortedStrings(build.blockers),
  });
  return Object.freeze({
    ...payload,
    buildReproducibilityHash: hashRecord('RuntimeBuildReproducibilityAssessment', payload),
  });
}

export function buildEmpiricalEnvironmentBom(input = {}) {
  const payload = Object.freeze({
    version: 2,
    kind: 'EmpiricalEnvironmentBOM',
    assurance: 'observed_runtime_hardware_numeric_behavior_and_execution_policy_not_bitwise_rebuild',
    platform: normalizePlatform(input.platform),
    runtime: normalizeRuntime(input.runtime),
    gpu: normalizeGpu(input.gpu),
    numericRuntime: normalizeNumericRuntime(input.numericRuntime),
    limits: normalizeLimits(input.limits),
    determinism: normalizeDeterminism(input.determinism),
    buildReproducibility: normalizeBuildReproducibility(input.buildReproducibility),
    observedClaims: sortedStrings(input.observedClaims),
    unobservedClaims: sortedStrings(input.unobservedClaims),
  });
  return Object.freeze({
    ...payload,
    environmentBomHash: hashRecord('EmpiricalEnvironmentBOM', payload),
  });
}

export function verifyEmpiricalEnvironmentBom(bom) {
  const blockers = [];
  if (!bom || bom.version !== 2 || bom.kind !== 'EmpiricalEnvironmentBOM'
    || bom.assurance !== 'observed_runtime_hardware_numeric_behavior_and_execution_policy_not_bitwise_rebuild') {
    return Object.freeze({ valid: false, blockers: Object.freeze(['environment_bom_shape_invalid']) });
  }
  if (!validHash(bom.environmentBomHash)
    || hashPayload('EmpiricalEnvironmentBOM', bom, 'environmentBomHash') !== bom.environmentBomHash) blockers.push('environment_bom_hash_invalid');
  const platform = bom.platform || {};
  if (!platform.operatingSystem || !platform.architecture || !validHash(platform.kernelReleaseHash)
    || !validHash(platform.cpu?.modelHash) || !validHash(platform.cpu?.flagsHash)
    || !positiveInteger(platform.cpu?.logicalProcessorCount)
    || (platform.machineIdentityHash !== null
      && !validHash(platform.machineIdentityHash))
    || (platform.machineIdentityHash === null
      && platform.machineIdentityObservation !== 'unobserved')
    || (validHash(platform.machineIdentityHash)
      && platform.machineIdentityObservation === 'unobserved')
    || !validHash(platform.hardwareIdentityHash)
    || hashPayload('EmpiricalEnvironmentHardwareIdentity', platform, 'hardwareIdentityHash') !== platform.hardwareIdentityHash) blockers.push('environment_bom_hardware_identity_invalid');
  const runtime = bom.runtime || {};
  if (!RUNTIME_TYPES.has(runtime.type) || !validHash(runtime.identityHash) || !runtime.language
    || !validHash(runtime.runtimeClosureHash)
    || hashPayload('EmpiricalEnvironmentRuntimeClosure', runtime, 'runtimeClosureHash') !== runtime.runtimeClosureHash
    || !PACKAGE_CLOSURE_BASES.has(runtime.packageClosure?.basis)
    || (runtime.languageVersionHash !== null && !validHash(runtime.languageVersionHash))
    || (runtime.packageClosure?.identityHash !== null && !validHash(runtime.packageClosure?.identityHash))
    || (runtime.packageClosure?.manifestHash !== null && !validHash(runtime.packageClosure?.manifestHash))
    || !Number.isSafeInteger(runtime.packageClosure?.observedPackageCount)
    || runtime.packageClosure?.observedPackageCount < 0
    || (runtime.type === 'container' && (!validHash(runtime.containerImageDigest) || runtime.hostExecutableHash !== null))
    || (runtime.type === 'host' && (!validHash(runtime.hostExecutableHash) || runtime.containerImageDigest !== null))) blockers.push('environment_bom_runtime_closure_invalid');
  if ((runtime.packageClosure?.basis === 'container_image_digest'
      && (runtime.type !== 'container' || runtime.packageClosure.identityHash !== runtime.containerImageDigest || runtime.packageClosure.manifestHash !== null))
    || (runtime.packageClosure?.basis === 'content_manifest'
      && (!validHash(runtime.packageClosure.manifestHash)
        || runtime.packageClosure.identityHash !== hashRecord('RuntimePackageClosureIdentity', {
          manifestHash: runtime.packageClosure.manifestHash,
          observedPackageCount: runtime.packageClosure.observedPackageCount,
        })))
    || (runtime.packageClosure?.basis === 'unobserved'
      && (runtime.packageClosure.identityHash !== null || runtime.packageClosure.manifestHash !== null || runtime.packageClosure.observedPackageCount !== 0))) {
    blockers.push('environment_bom_package_closure_binding_invalid');
  }
  const gpu = bom.gpu || {};
  if (!GPU_STATUSES.has(gpu.status) || !validHash(gpu.gpuIdentityHash)
    || hashPayload('EmpiricalEnvironmentGpuIdentity', gpu, 'gpuIdentityHash') !== gpu.gpuIdentityHash
    || (gpu.required && (gpu.status !== 'observed' || !positiveInteger(gpu.deviceCount)
      || !validHash(gpu.modelSetHash) || !validHash(gpu.computeCapabilitySetHash)
      || !validHash(gpu.driverVersionHash) || !validHash(gpu.runtimeVersionHash)))
    || (!gpu.required && gpu.status !== 'not_required')) blockers.push('environment_bom_gpu_identity_invalid');
  const numeric = bom.numericRuntime || {};
  if (!validHash(numeric.numericRuntimePolicyHash)
    || hashPayload('EmpiricalNumericRuntimePolicy', numeric, 'numericRuntimePolicyHash') !== numeric.numericRuntimePolicyHash
    || typeof numeric.threads !== 'object' || Array.isArray(numeric.threads)
    || (numeric.blasImplementationHash !== null
      && !validHash(numeric.blasImplementationHash))
    || (numeric.blasImplementationHash === null
      && numeric.blasImplementationObservation !== 'unobserved')
    || (validHash(numeric.blasImplementationHash)
      && numeric.blasImplementationObservation === 'unobserved')
    || (numeric.numericalLibraryBehaviorHash !== null
      && !validHash(numeric.numericalLibraryBehaviorHash))
    || (numeric.numericalLibraryBehaviorHash === null
      && numeric.numericalLibraryBehaviorObservation !== 'unobserved')
    || (validHash(numeric.numericalLibraryBehaviorHash)
      && numeric.numericalLibraryBehaviorObservation === 'unobserved')
    || Object.entries(numeric.threads).some(([key, value]) => !NUMERIC_THREAD_KEYS.has(key) || !/^[1-9][0-9]*$/.test(String(value)))) blockers.push('environment_bom_numeric_runtime_policy_invalid');
  if (numeric.explicitSingleThreadPolicy === true
    && (REQUIRED_SINGLE_THREAD_KEYS.some((key) => numeric.threads?.[key] !== '1')
      || Object.values(numeric.threads || {}).some((value) => value !== '1'))) blockers.push('environment_bom_single_thread_policy_invalid');
  const limits = bom.limits || {};
  if (![limits.timeoutMs, limits.memoryBytes, limits.cpuSeconds, limits.maximumPids, limits.maximumOutputBytes, limits.maximumCapturedBytes].every(positiveInteger)
    || !validHash(limits.resourceLimitsHash)
    || hashPayload('EmpiricalEnvironmentResourceLimits', limits, 'resourceLimitsHash') !== limits.resourceLimitsHash) blockers.push('environment_bom_resource_limits_invalid');
  const determinism = bom.determinism || {};
  if (!DETERMINISM_CLASSES.has(determinism.classification)
    || !validHash(determinism.determinismPolicyHash)
    || hashPayload('EmpiricalDeterminismPolicy', determinism, 'determinismPolicyHash') !== determinism.determinismPolicyHash) blockers.push('environment_bom_determinism_policy_invalid');
  const build = bom.buildReproducibility || {};
  if (!BUILD_STATUSES.has(build.status) || !Array.isArray(build.blockers)
    || !validHash(build.buildReproducibilityHash)
    || hashPayload('RuntimeBuildReproducibilityAssessment', build, 'buildReproducibilityHash') !== build.buildReproducibilityHash
    || (build.definitionHash !== null && !validHash(build.definitionHash))
    || (build.evidenceHash !== null && !validHash(build.evidenceHash))
    || (build.bitwiseRebuildVerified && (build.status !== 'bitwise_rebuild_verified'
      || build.runtimeContentIdentityPinned !== true || !validHash(build.definitionHash)
      || !validHash(build.evidenceHash) || build.blockers.length > 0))
    || (!build.bitwiseRebuildVerified && build.status === 'bitwise_rebuild_verified')) blockers.push('environment_bom_build_reproducibility_invalid');
  if (!Array.isArray(bom.observedClaims) || !Array.isArray(bom.unobservedClaims)
    || !isCanonicalStringSet(bom.observedClaims) || !isCanonicalStringSet(bom.unobservedClaims)
    || bom.observedClaims.some((claim) => bom.unobservedClaims.includes(claim))) blockers.push('environment_bom_assurance_scope_invalid');
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

export function environmentBomSupportsDeterministicCpuCache(bom) {
  const verification = verifyEmpiricalEnvironmentBom(bom);
  const blockers = [...verification.blockers];
  if (bom?.gpu?.required || bom?.gpu?.status !== 'not_required') blockers.push('environment_bom_cache_gpu_forbidden');
  if (bom?.determinism?.classification !== 'explicit_deterministic_cpu'
    || bom?.determinism?.explicitlyRequested !== true
    || bom?.determinism?.deterministicSeedRequired !== true
    || bom?.determinism?.deterministicSeedBound !== true
    || bom?.determinism?.threadPolicyVerified !== true) blockers.push('environment_bom_cache_determinism_unverified');
  if (bom?.numericRuntime?.explicitSingleThreadPolicy !== true
    || bom?.numericRuntime?.dynamicThreadingDisabled !== true) blockers.push('environment_bom_cache_thread_policy_unverified');
  if (!validHash(bom?.platform?.machineIdentityHash)) blockers.push('environment_bom_cache_machine_identity_unverified');
  if (!validHash(bom?.numericRuntime?.blasImplementationHash)) blockers.push('environment_bom_cache_blas_identity_unverified');
  if (!validHash(bom?.numericRuntime?.numericalLibraryBehaviorHash)) blockers.push('environment_bom_cache_numeric_behavior_unverified');
  if (bom?.runtime?.packageClosure?.basis === 'unobserved'
    || !validHash(bom?.runtime?.packageClosure?.identityHash)) blockers.push('environment_bom_cache_runtime_closure_unverified');
  if (bom?.buildReproducibility?.runtimeContentIdentityPinned !== true) blockers.push('environment_bom_cache_runtime_content_unpinned');
  return Object.freeze({ cacheable: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}

export function verifyEnvironmentBomAgainstWorkerReceipt(bom, receipt) {
  const verification = verifyEmpiricalEnvironmentBom(bom);
  if (!verification.valid || !receipt) return false;
  return bom.environmentBomHash === receipt.environmentBomHash
    && bom.runtime.identityHash === receipt.runtimeIdentityHash
    && bom.runtime.type === receipt.runtimeIdentityType
    && (bom.runtime.type !== 'container' || bom.runtime.containerImageDigest === receipt.containerImageDigest)
    && bom.gpu.required === Boolean(receipt.isolation?.gpuAccessRequested)
    && bom.limits.timeoutMs === receipt.limits?.timeoutMs
    && bom.limits.memoryBytes === receipt.limits?.memoryBytes
    && bom.limits.cpuSeconds === receipt.limits?.cpuSeconds
    && bom.limits.maximumPids === receipt.limits?.maximumPids
    && bom.limits.maximumOutputBytes === receipt.limits?.maximumOutputBytes
    && bom.limits.maximumCapturedBytes === receipt.limits?.maximumCapturedBytes;
}
