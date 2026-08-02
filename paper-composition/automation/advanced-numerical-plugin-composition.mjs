import {
  createOutOfProcessAdvancedNumericalPluginRunner,
  verifyAdvancedNumericalPluginSignedBundle,
} from '../../paper-adapters/automation/out-of-process-advanced-numerical-plugin-runner.mjs';
import {
  readAdvancedNumericalPluginRuntimeConfiguration,
} from '../../paper-adapters/automation/advanced-numerical-plugin-runtime-configuration.mjs';
import {
  createOsSandboxedWorkerRunner,
} from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';

export function composeAdvancedNumericalPluginRuntime({
  bundle,
  trustStore,
  qualification = null,
  qualificationEvidence = null,
  qualificationTrustStore = null,
  pluginRoot,
  outputRoot,
  now = new Date(),
} = {}) {
  const verifiedBundle = verifyAdvancedNumericalPluginSignedBundle(bundle, {
    trustStore,
    now,
  });
  const descriptor = verifiedBundle.descriptor;
  const workerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: [descriptor.runtime.executable],
    allowedRoots: [pluginRoot],
    allowedOutputRoots: [outputRoot],
    maximumTimeoutMs: descriptor.limits.timeoutMs,
    maximumMemoryBytes: descriptor.limits.memoryBytes,
    maximumCpuSeconds: descriptor.limits.cpuSeconds,
    maximumPids: descriptor.limits.maximumProcesses,
    maximumOutputBytes: descriptor.limits.maximumOutputBytes,
    maximumCapturedBytes: descriptor.limits.maximumCapturedBytes,
  });
  const runner = createOutOfProcessAdvancedNumericalPluginRunner({
    signedBundle: bundle,
    trustStore,
    qualification,
    qualificationEvidence,
    qualificationTrustStore,
    workerRunner,
    pluginRoot,
    outputRoot,
    now,
  });
  return Object.freeze({
    verifiedBundle,
    descriptor,
    workerRunner,
    runner,
  });
}

export function composeConfiguredAdvancedNumericalPluginRuntime({
  configurationPath,
  expectedConfigurationHash = null,
  requireProductionQualification = false,
  now,
} = {}) {
  const runtimeConfiguration = readAdvancedNumericalPluginRuntimeConfiguration({
    configurationPath,
    expectedConfigurationHash,
    requireProductionQualification,
  });
  const runtime = composeAdvancedNumericalPluginRuntime({
    bundle: runtimeConfiguration.bundle,
    trustStore: runtimeConfiguration.trustStore,
    qualification: runtimeConfiguration.qualification,
    qualificationEvidence: runtimeConfiguration.qualificationEvidence,
    qualificationTrustStore: runtimeConfiguration.qualificationTrustStore,
    pluginRoot: runtimeConfiguration.pluginRoot,
    outputRoot: runtimeConfiguration.outputRoot,
    now,
  });
  return Object.freeze({
    ...runtime,
    runtimeConfiguration,
  });
}
