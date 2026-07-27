import {
  createOutOfProcessAdvancedNumericalPluginRunner,
  verifyAdvancedNumericalPluginSignedBundle,
} from '../../paper-adapters/automation/out-of-process-advanced-numerical-plugin-runner.mjs';
import {
  createOsSandboxedWorkerRunner,
} from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';

export function composeAdvancedNumericalPluginRuntime({
  bundle,
  trustStore,
  qualification = null,
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
