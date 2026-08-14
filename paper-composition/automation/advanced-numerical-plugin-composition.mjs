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
import {
  createCampaignAdvancedNumericalExecutionAdapter,
} from '../../paper-adapters/automation/campaign-advanced-numerical-execution-adapter.mjs';
import {
  verifyAdvancedNumericalCampaignExecutionPlan,
} from '../../paper-domain/automation/advanced-numerical-campaign-execution-contract.mjs';
import {
  buildAdvancedNumericalGpuRuntimeAuthority,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';

export {
  PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
  runProcessIsolatedPdePoisson2dIndependentCpuOracle,
  verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts,
} from '../../paper-adapters/research-verify/process-isolated-pde-poisson-2d-independent-cpu-oracle.mjs';

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
  const gpuRuntimeAuthority = descriptor.version === 2
    ? buildAdvancedNumericalGpuRuntimeAuthority(descriptor) : null;
  const workerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: gpuRuntimeAuthority ? [] : [descriptor.runtime.executable],
    allowedContainerImages: gpuRuntimeAuthority
      ? [descriptor.runtime.containerImage, descriptor.runtime.containerImageDigest] : [],
    allowGpu: Boolean(gpuRuntimeAuthority),
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
    gpuRuntimeAuthority,
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

export function composeCampaignAdvancedNumericalExecution({
  plan,
  configurationPath,
  now,
} = {}) {
  if (!verifyAdvancedNumericalCampaignExecutionPlan(plan)) {
    throw new Error('campaign_advanced_numerical_execution_plan_invalid');
  }
  const runtime = composeConfiguredAdvancedNumericalPluginRuntime({
    configurationPath,
    expectedConfigurationHash:
      plan.pluginRuntimeIdentity.configurationHash,
    requireProductionQualification: false,
    now,
  });
  const execution = createCampaignAdvancedNumericalExecutionAdapter({ runtime });
  if (execution.capabilities().pluginRuntimeIdentityHash
    !== plan.pluginRuntimeIdentityHash) {
    throw new Error('campaign_advanced_numerical_runtime_identity_mismatch');
  }
  return Object.freeze({ runtime, execution });
}
