import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export {
  buildPdePoisson2dGpuArtifactManifest,
  buildPdePoisson2dGpuProducerSpecification,
  verifyPdePoisson2dGpuArtifactManifest,
  verifyPdePoisson2dGpuProducerSpecification,
} from './pde-poisson-2d-gpu-capability-contract.mjs';
export {
  buildPdePoisson2dIndependentCpuOracleReceipt,
  verifyPdePoisson2dIndependentCpuOracleReceipt,
} from './pde-poisson-2d-independent-cpu-oracle-contract.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const PACKAGE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,64})?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ENTRYPOINT = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const SAFE_CONTAINER_IMAGE = /^[a-z0-9][a-z0-9._/-]{0,191}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NVIDIA_GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE =
  'single-requested-device-selector-not-mig-or-vram-isolation-v1';
export const ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE =
  'not-enforced-shared-device-vram-v1';

export const ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES = Object.freeze([
  'bayesian',
  'causal-inference',
  'linear-algebra',
  'monte-carlo',
  'ode',
  'optimization',
  'pde',
  'signal-processing',
  'survival',
  'time-series',
]);

export const ADVANCED_NUMERICAL_PLUGIN_RUNTIME_LANGUAGES = Object.freeze([
  'julia',
  'python',
  'r',
]);

export const ADVANCED_NUMERICAL_PLUGIN_ASSURANCE_CONTRACT_KINDS = Object.freeze({
  oracle: 'independent-numeric-oracle-v1',
  replay: 'deterministic-process-replay-v1',
  uncertainty: 'typed-uncertainty-report-v1',
});

const DESCRIPTOR_KEYS = Object.freeze([
  'advancedNumericalPluginDescriptorHash',
  'analysisFamily',
  'assuranceContracts',
  'entrypoint',
  'kind',
  'limits',
  'networkPolicy',
  'pluginId',
  'pluginVersion',
  'runtime',
  'sourceIdentity',
  'version',
]);
const CPU_RUNTIME_KEYS = Object.freeze([
  'executable', 'executableHash', 'language', 'packageClosureHash',
]);
const GPU_RUNTIME_KEYS = Object.freeze([
  'containerExecutable', 'containerImage', 'containerImageDigest',
  'cpuFallbackPolicy', 'executable', 'executableHash',
  'gpuDeviceIsolationScope', 'gpuDeviceSelector', 'gpuMemoryLimitBytes',
  'gpuMemoryLimitEnforced', 'gpuMemoryLimitScope', 'language',
  'packageClosureHash', 'requiresGpu', 'runtimeProfile',
]);

function safeId(value) {
  const selected = String(value || '').trim();
  return SAFE_ID.test(selected) ? selected : null;
}

function requiredHash(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function compileAssuranceContracts(value) {
  if (!hasExactObjectKeys(value, ['oracle', 'replay', 'uncertainty'])) {
    throw new Error('advanced_numerical_plugin_assurance_contracts_invalid');
  }
  return Object.freeze(Object.fromEntries(Object.entries(
    ADVANCED_NUMERICAL_PLUGIN_ASSURANCE_CONTRACT_KINDS,
  ).map(([name, kind]) => {
    const contract = value[name];
    if (!hasExactObjectKeys(contract, ['contractHash', 'kind'])
      || contract.kind !== kind || !requiredHash(contract.contractHash)) {
      throw new Error('advanced_numerical_plugin_assurance_contracts_invalid');
    }
    return [name, Object.freeze({
      kind,
      contractHash: requiredHash(contract.contractHash),
    })];
  })));
}

function compileRuntime(value, version) {
  if (version === 1) {
    if (!hasExactObjectKeys(value, CPU_RUNTIME_KEYS)
      || !ADVANCED_NUMERICAL_PLUGIN_RUNTIME_LANGUAGES.includes(value.language)
      || !safeId(value.executable) || !requiredHash(value.executableHash)
      || !requiredHash(value.packageClosureHash)) {
      throw new Error('advanced_numerical_plugin_runtime_invalid');
    }
    return Object.freeze({
      language: value.language,
      executable: value.executable,
      executableHash: requiredHash(value.executableHash),
      packageClosureHash: requiredHash(value.packageClosureHash),
    });
  }
  if (version !== 2 || !hasExactObjectKeys(value, GPU_RUNTIME_KEYS)
    || value.language !== 'python' || value.runtimeProfile !== 'pythonGpu'
    || value.requiresGpu !== true || value.cpuFallbackPolicy !== 'forbidden'
    || !safeId(value.executable) || value.executable !== value.containerExecutable
    || !safeId(value.containerExecutable) || !requiredHash(value.executableHash)
    || !requiredHash(value.packageClosureHash)
    || !SAFE_CONTAINER_IMAGE.test(String(value.containerImage || ''))
    || !requiredHash(value.containerImageDigest)
    || requiredHash(value.packageClosureHash) !== requiredHash(value.containerImageDigest)
    || !NVIDIA_GPU_UUID.test(String(value.gpuDeviceSelector || ''))
    || value.gpuDeviceIsolationScope !== ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE
    || value.gpuMemoryLimitBytes !== null || value.gpuMemoryLimitEnforced !== false
    || value.gpuMemoryLimitScope !== ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE) {
    throw new Error('advanced_numerical_plugin_gpu_runtime_invalid');
  }
  return Object.freeze({
    language: 'python',
    executable: value.executable,
    executableHash: requiredHash(value.executableHash),
    packageClosureHash: requiredHash(value.packageClosureHash),
    runtimeProfile: 'pythonGpu',
    requiresGpu: true,
    containerImage: value.containerImage,
    containerImageDigest: requiredHash(value.containerImageDigest),
    containerExecutable: value.containerExecutable,
    gpuDeviceSelector: value.gpuDeviceSelector,
    cpuFallbackPolicy: 'forbidden',
    gpuDeviceIsolationScope: ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE,
    gpuMemoryLimitBytes: null,
    gpuMemoryLimitEnforced: false,
    gpuMemoryLimitScope: ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE,
  });
}

export function buildAdvancedNumericalGpuRuntimeAuthority(descriptor) {
  if (!verifyAdvancedNumericalPluginDescriptor(descriptor) || descriptor.version !== 2) {
    throw new Error('advanced_numerical_plugin_gpu_runtime_authority_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalGpuRuntimeAuthority',
    pluginDescriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    ...descriptor.runtime,
  };
  return Object.freeze({
    ...payload,
    advancedNumericalGpuRuntimeAuthorityHash:
      hashRecord('AdvancedNumericalGpuRuntimeAuthority', payload),
  });
}

export function compileAdvancedNumericalPluginDescriptor(value = {}) {
  const version = value.version === undefined ? 1 : Number(value.version);
  const pluginId = safeId(value.pluginId);
  const pluginVersion = String(value.pluginVersion || '');
  const analysisFamily = String(value.analysisFamily || '');
  const runtime = value.runtime;
  const entrypoint = value.entrypoint;
  const sourceIdentity = value.sourceIdentity;
  const limits = value.limits;
  if (!pluginId || !PACKAGE_VERSION.test(pluginVersion)
    || !ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES.includes(analysisFamily)
    || ![1, 2].includes(version)
    || !hasExactObjectKeys(entrypoint, ['relativePath', 'sha256'])
    || !SAFE_ENTRYPOINT.test(String(entrypoint.relativePath || ''))
    || !requiredHash(entrypoint.sha256)
    || !hasExactObjectKeys(sourceIdentity, ['merkleHash', 'workspaceManifestHash'])
    || !requiredHash(sourceIdentity.merkleHash)
    || !requiredHash(sourceIdentity.workspaceManifestHash)
    || !hasExactObjectKeys(limits, [
      'cpuSeconds', 'maximumCapturedBytes', 'maximumOutputBytes',
      'maximumProcesses', 'memoryBytes', 'timeoutMs',
    ])
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1
    || limits.timeoutMs > 24 * 60 * 60 * 1_000
    || !Number.isSafeInteger(limits.cpuSeconds) || limits.cpuSeconds < 1
    || !Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes < 64 * 1024 * 1024
    || !Number.isSafeInteger(limits.maximumProcesses) || limits.maximumProcesses < 1
    || !Number.isSafeInteger(limits.maximumOutputBytes) || limits.maximumOutputBytes < 1
    || !Number.isSafeInteger(limits.maximumCapturedBytes)
    || limits.maximumCapturedBytes < 1
    || limits.maximumCapturedBytes > limits.maximumOutputBytes
    || value.networkPolicy !== 'none') {
    throw new Error('advanced_numerical_plugin_descriptor_invalid');
  }
  const payload = {
    version,
    kind: 'AdvancedNumericalPluginDescriptor',
    pluginId,
    pluginVersion,
    analysisFamily,
    runtime: compileRuntime(runtime, version),
    entrypoint: Object.freeze({
      relativePath: entrypoint.relativePath,
      sha256: requiredHash(entrypoint.sha256),
    }),
    sourceIdentity: Object.freeze({
      merkleHash: requiredHash(sourceIdentity.merkleHash),
      workspaceManifestHash: requiredHash(sourceIdentity.workspaceManifestHash),
    }),
    limits: Object.freeze({ ...limits }),
    networkPolicy: 'none',
    assuranceContracts: compileAssuranceContracts(value.assuranceContracts),
  };
  return Object.freeze({
    ...payload,
    advancedNumericalPluginDescriptorHash:
      hashRecord('AdvancedNumericalPluginDescriptor', payload),
  });
}

export function verifyAdvancedNumericalPluginDescriptor(value) {
  if (!hasExactObjectKeys(value, DESCRIPTOR_KEYS)) return false;
  try {
    const { advancedNumericalPluginDescriptorHash: _hash, ...input } = value;
    return JSON.stringify(compileAdvancedNumericalPluginDescriptor(input))
      === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function buildAdvancedNumericalPluginRequest({
  descriptor,
  runId,
  input,
  seed,
} = {}) {
  if (!verifyAdvancedNumericalPluginDescriptor(descriptor)
    || !safeId(runId) || !Number.isSafeInteger(seed)) {
    throw new Error('advanced_numerical_plugin_request_invalid');
  }
  let frozenInput = null;
  try {
    frozenInput = deepFreezeJsonValue(structuredClone(input));
  } catch {
    throw new Error('advanced_numerical_plugin_request_input_invalid');
  }
  const encoded = JSON.stringify(frozenInput);
  if (Buffer.byteLength(encoded) > 32 * 1024) {
    throw new Error('advanced_numerical_plugin_request_input_too_large');
  }
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalPluginRequest',
    runId,
    pluginId: descriptor.pluginId,
    pluginDescriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    analysisFamily: descriptor.analysisFamily,
    seed,
    input: frozenInput,
    assuranceContracts: descriptor.assuranceContracts,
  };
  return Object.freeze({
    ...payload,
    advancedNumericalPluginRequestHash:
      hashRecord('AdvancedNumericalPluginRequest', payload),
  });
}

export function verifyAdvancedNumericalPluginResult(result, {
  descriptor,
  request,
} = {}) {
  if (!result || result.version !== 1
    || result.kind !== 'AdvancedNumericalPluginResult'
    || result.status !== 'advanced_numerical_computation_completed'
    || result.pluginId !== descriptor?.pluginId
    || result.analysisFamily !== descriptor?.analysisFamily
    || result.requestHash !== request?.advancedNumericalPluginRequestHash
    || result.oracleContractHash !== descriptor?.assuranceContracts?.oracle?.contractHash
    || result.replayContractHash !== descriptor?.assuranceContracts?.replay?.contractHash
    || result.uncertaintyContractHash
      !== descriptor?.assuranceContracts?.uncertainty?.contractHash
    || ![
      'estimateArtifactHash', 'oracleReceiptHash', 'replayReceiptHash',
      'uncertaintyArtifactHash', 'uncertaintyReceiptHash',
      'advancedNumericalPluginResultHash',
    ].every((field) => requiredHash(result[field]))) return false;
  const { advancedNumericalPluginResultHash, ...payload } = result;
  return hashRecord('AdvancedNumericalPluginResult', payload)
    === advancedNumericalPluginResultHash;
}
