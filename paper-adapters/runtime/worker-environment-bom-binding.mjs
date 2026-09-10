import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { environmentBomBuildAssessment } from '../../paper-domain/automation/runtime-build-reproducibility-contract.mjs';
import { collectEmpiricalEnvironmentBom } from './environment-bom-collector.mjs';

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
  spawnSyncImpl = undefined,
} = {}) {
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
      runtimePackageClosure,
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
