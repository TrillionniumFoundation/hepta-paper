import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { environmentBomBuildAssessment } from '../../paper-domain/automation/runtime-build-reproducibility-contract.mjs';
import { collectEmpiricalEnvironmentBom } from './environment-bom-collector.mjs';
import { observeAdvancedNumericalHostRuntimeClosure } from './advanced-numerical-host-runtime-closure.mjs';

export function prepareWorkerEnvironmentBom({
  executionIdentity,
  language,
  executable,
  requiresGpu,
  determinismPolicy,
  deterministicSeed,
  limits,
  env,
  runtimePackageClosure = null,
  runtimeBuildReproducibility = null,
  runtimeExecutableSnapshot = null,
  sourceExecutionSnapshot = null,
  workExecutionSnapshot = null,
  spawnSyncImpl = undefined,
} = {}) {
  let observedRuntimePackageClosure;
  try {
    observedRuntimePackageClosure = observeAdvancedNumericalHostRuntimeClosure({
      runtimePackageClosure, runtimeExecutableSnapshot, sourceExecutionSnapshot, workExecutionSnapshot,
    });
  } catch (error) {
    throw new WorkerEnvironmentBomClosureError(error);
  }
  let environmentBom = null;
  try {
    environmentBom = collectEmpiricalEnvironmentBom({
      executionIdentity,
      language: language || 'unknown',
      executable,
      requiresGpu,
      determinismPolicy,
      deterministicSeed,
      resourceLimits: limits,
      env,
      runtimePackageClosure: observedRuntimePackageClosure,
      buildReproducibility: environmentBomBuildAssessment(runtimeBuildReproducibility),
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
  } catch { /* fail closed below */ }
  const verification = verifyEmpiricalEnvironmentBom(environmentBom);
  return Object.freeze({
    environmentBom,
    environmentBomHash: verification.valid ? environmentBom.environmentBomHash : null,
    blockers: Object.freeze(verification.valid ? [] : ['worker_environment_bom_invalid', ...verification.blockers]),
  });
}

export function createWorkerEnvironmentBomPreparer({
  maximumTimeoutMs,
  maximumMemoryBytes,
  maximumCpuSeconds,
  maximumPids,
  maximumOutputBytes,
  maximumCapturedBytes,
  spawnSyncImpl = undefined,
} = {}) {
  return (input = {}) => {
    const limits = Object.freeze({
      timeoutMs: Math.min(Number(input.timeoutMs ?? 30_000), maximumTimeoutMs),
      memoryBytes: Math.min(Number(input.memoryBytes ?? maximumMemoryBytes), maximumMemoryBytes),
      cpuSeconds: Math.min(Number(input.cpuSeconds ?? maximumCpuSeconds), maximumCpuSeconds),
      maximumPids: Math.min(Number(input.maximumProcesses ?? maximumPids), maximumPids),
      maximumOutputBytes: Math.min(Number(input.requestedMaximumOutputBytes ?? maximumOutputBytes), maximumOutputBytes),
      maximumCapturedBytes,
    });
    const binding = prepareWorkerEnvironmentBom({ ...input, limits, spawnSyncImpl });
    return Object.freeze({ ...binding, limits });
  };
}

// The engine retains cleanup; this component owns the exact BOM preparation
// refusal report. It establishes no positive isolation or runtime authority.
export function workerEnvironmentBomPreparationFailure(error, availability) {
  return {
    ok: false,
    status: 'os_sandbox_worker_blocked',
    blockers: [error.message],
    availability,
    isolation: {
      kernelNetworkIsolationVerified: false,
      filesystemNamespaceVerified: false,
      sourceReadOnlyVerified: false,
      resourceLimitsVerified: false,
    },
  };
}

// Only the closure observer refusal has the engine's historical blocked-report
// behavior. Other preparer exceptions retain their original thrown boundary.
export class WorkerEnvironmentBomClosureError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
  }
}
