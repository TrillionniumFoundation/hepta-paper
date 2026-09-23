import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { verifyProductionOsSandboxWorkerReceipt } from './os-sandbox-worker-receipt-contract.mjs';

export const RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS = Object.freeze({
  maximumWallTimeMs: 300_000,
  maximumCpuSeconds: 120,
  maximumMemoryBytes: 1024 * 1024 * 1024,
  maximumProcesses: 32,
});
export const TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS = Object.freeze({
  maximumWallTimeMs: 60_000,
  maximumCpuSeconds: 60,
  maximumMemoryBytes: 1024 * 1024 * 1024,
  maximumProcesses: 32,
  finalizationReserveMs: 30_000,
});
export const SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS =
  'nominal-sum-of-per-worker-rlimit-cpu-v1';

const ADVANCED_TYPED_NUMERIC_ORACLES = new Set([
  'condition-number-bound-v1',
  'convergence-rate-bound-v1',
  'error-bound-v1',
  'optimality-gap-bound-v1',
]);

export function verifyRawEventRecomputationResourceBudget(budget) {
  return hasExactPlainObjectKeys(budget, [
    'cpuSeconds', 'maximumProcesses', 'memoryBytes', 'timeoutMs',
  ])
    && Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs >= 1
    && budget.timeoutMs <= RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs
    && Number.isSafeInteger(budget.memoryBytes) && budget.memoryBytes >= 1
    && budget.memoryBytes <= RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes
    && Number.isSafeInteger(budget.cpuSeconds) && budget.cpuSeconds >= 1
    && budget.cpuSeconds <= RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds
    && Number.isSafeInteger(budget.maximumProcesses) && budget.maximumProcesses >= 1
    && budget.maximumProcesses <= RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses;
}

export function rawEventRecomputationResourceBudgetsEqual(left, right) {
  return verifyRawEventRecomputationResourceBudget(left)
    && verifyRawEventRecomputationResourceBudget(right)
    && left.timeoutMs === right.timeoutMs
    && left.memoryBytes === right.memoryBytes
    && left.cpuSeconds === right.cpuSeconds
    && left.maximumProcesses === right.maximumProcesses;
}

export function verifyTypedNumericRecomputationResourceBudget(budget) {
  return hasExactPlainObjectKeys(budget, [
    'cpuSeconds', 'maximumProcesses', 'memoryBytes', 'timeoutMs',
  ])
    && Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs >= 1
    && budget.timeoutMs
      <= TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs
    && Number.isSafeInteger(budget.memoryBytes) && budget.memoryBytes >= 1
    && budget.memoryBytes
      <= TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes
    && Number.isSafeInteger(budget.cpuSeconds) && budget.cpuSeconds >= 1
    && budget.cpuSeconds
      <= TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds
    && Number.isSafeInteger(budget.maximumProcesses) && budget.maximumProcesses >= 1
    && budget.maximumProcesses
      <= TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses;
}

export function typedNumericRecomputationResourceBudgetsEqual(left, right) {
  return verifyTypedNumericRecomputationResourceBudget(left)
    && verifyTypedNumericRecomputationResourceBudget(right)
    && left.timeoutMs === right.timeoutMs
    && left.memoryBytes === right.memoryBytes
    && left.cpuSeconds === right.cpuSeconds
    && left.maximumProcesses === right.maximumProcesses;
}

export function systemBenchmarkTypedNumericRecomputationRequired(experimentIr) {
  return Array.isArray(experimentIr?.oracleAbi?.requiredOracleTypes)
    && experimentIr.oracleAbi.requiredOracleTypes.some((type) => (
      ADVANCED_TYPED_NUMERIC_ORACLES.has(type)
    ));
}

export function allocateSystemBenchmarkVerifierCpuSeconds(
  aggregateCpuSeconds,
  executionUnitCount,
  experimentIr,
) {
  const aggregate = Number(aggregateCpuSeconds);
  const units = Number(executionUnitCount);
  const available = Number.isSafeInteger(aggregate) && Number.isSafeInteger(units)
    ? Math.max(0, aggregate - units) : 0;
  const typedNumericRequired = systemBenchmarkTypedNumericRecomputationRequired(experimentIr);
  const typedNumericCpuSeconds = typedNumericRequired
    ? Math.min(
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds,
      Math.floor(available / 2),
    ) : 0;
  return Object.freeze({
    typedNumericRequired,
    typedNumericCpuSeconds,
    rawEventCpuSeconds: Math.min(
      RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds,
      Math.max(0, available - typedNumericCpuSeconds),
    ),
  });
}

export function buildTypedNumericRecomputationResourceBudget({
  remainingWallTimeMs,
  cpuSeconds,
  memoryBytes,
  maximumProcesses,
} = {}) {
  return Object.freeze({
    timeoutMs: Math.min(
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs,
      Math.floor(Number(remainingWallTimeMs)
        - TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.finalizationReserveMs),
    ),
    cpuSeconds: Number(cpuSeconds),
    memoryBytes: Math.min(
      Number(memoryBytes),
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes,
    ),
    maximumProcesses: Math.min(
      Number(maximumProcesses),
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses,
    ),
  });
}

export function verifySystemBenchmarkTypedNumericResourceBudget(receipt) {
  const required = systemBenchmarkTypedNumericRecomputationRequired(receipt?.experimentIr);
  const processReceipt = receipt?.analysisObservationAuthority
    ?.typedNumericOracleRecomputationReceipt || null;
  if (!required) return processReceipt === null;
  const budget = processReceipt?.resourceBudget;
  const sandboxReceipt = processReceipt?.osSandboxWorkerReceipt;
  return processReceipt?.version === 3
    && processReceipt?.status === 'independent_typed_numeric_oracle_recomputation_verified'
    && processReceipt?.cpuBudgetSemantics === SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
    && verifyTypedNumericRecomputationResourceBudget(budget)
    && verifyProductionOsSandboxWorkerReceipt(sandboxReceipt)
    && Array.isArray(sandboxReceipt?.blockers) && sandboxReceipt.blockers.length === 0
    && sandboxReceipt?.externalActionPerformed === false
    && budget.timeoutMs === sandboxReceipt?.limits?.timeoutMs
    && budget.memoryBytes === sandboxReceipt?.limits?.memoryBytes
    && budget.cpuSeconds === sandboxReceipt?.limits?.cpuSeconds
    && budget.maximumProcesses === sandboxReceipt?.limits?.maximumPids
    && budget.memoryBytes <= receipt.workerMemoryBytes
    && budget.maximumProcesses <= receipt.workerMaximumProcesses;
}

export function verifySystemBenchmarkArmBatchResourceBudget(batchReceipt, harnessReceipt) {
  const budget = batchReceipt?.resourceBudget;
  const runnerReceipt = batchReceipt?.runnerReceipt;
  return budget?.absoluteDeadlineEpochMs === harnessReceipt?.absoluteDeadlineEpochMs
    && harnessReceipt.cpuBudgetSemantics === SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
    && Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs >= 1
    && Number.isSafeInteger(budget.cpuSeconds) && budget.cpuSeconds >= 1
    && budget.memoryBytes === harnessReceipt.workerMemoryBytes
    && budget.maximumProcesses === harnessReceipt.workerMaximumProcesses
    && budget.requiresGpu === harnessReceipt.gpuRequired
    && runnerReceipt?.limits?.timeoutMs === budget.timeoutMs
    && runnerReceipt?.limits?.memoryBytes === budget.memoryBytes
    && runnerReceipt?.limits?.cpuSeconds === budget.cpuSeconds
    && runnerReceipt?.limits?.maximumPids === budget.maximumProcesses
    && runnerReceipt?.isolation?.cpuLimitVerified === true
    && runnerReceipt?.isolation?.cpuLimitScope
      === 'process-thread-group-not-descendant-tree-v1'
    && Boolean(runnerReceipt?.isolation?.gpuAccessRequested) === harnessReceipt.gpuRequired;
}

export function verifySystemBenchmarkHarnessResourceBudget(receipt, {
  executionUnitCount,
  requireDistinctProcesses = false,
  processIdentityHashes = [],
  launcherPids = [],
  executionAttemptIds = [],
  environmentBindingHashes = [],
} = {}) {
  const recomputationAssurance = receipt?.independentRawEventRecomputationAssurance
    ?.processIsolatedRawEventRecomputationAssurance;
  const recomputationBudget = recomputationAssurance?.resourceBudget;
  const recomputationLimits = recomputationAssurance?.osSandboxWorkerReceipt?.limits;
  const typedNumericBudget = receipt?.analysisObservationAuthority
    ?.typedNumericOracleRecomputationReceipt?.resourceBudget || null;
  const experimentBudget = receipt?.experimentIr?.execution?.budget;
  const processExecutionManifest = (receipt?.armBatchExecutions || []).map((batch) => ({
    executionAttemptId: batch.executionAttemptId,
    executionProcessIdentityHash: batch.executionProcessIdentityHash,
    launcherPid: batch.runnerReceipt.executionProcessIdentity?.launcherPid || null,
    environmentBindingHash: batch.runnerReceipt.environmentBindingHash,
    cellIds: batch.cellIds,
    resourceBudget: batch.resourceBudget,
  }));
  const allocatedCpuSeconds = (receipt?.armBatchExecutions || [])
    .reduce((sum, batch) => sum + Number(batch.resourceBudget?.cpuSeconds || 0), 0);
  return receipt?.processExecutionManifestHash === hashRecord('SystemBenchmarkProcessExecutionManifest', processExecutionManifest)
    && receipt.cpuBudgetSemantics === SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
    && experimentBudget?.cpuBudgetSemantics === SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
    && Number.isSafeInteger(receipt.absoluteDeadlineEpochMs)
    && receipt.absoluteDeadlineEpochMs >= 0
    && receipt.absoluteDeadlineEpochMs === experimentBudget?.absoluteDeadlineEpochMs
    && Number.isSafeInteger(receipt.aggregateCpuSeconds) && receipt.aggregateCpuSeconds >= executionUnitCount
    && receipt.aggregateCpuSeconds === experimentBudget?.aggregateCpuSeconds
    && Number.isSafeInteger(receipt.allocatedCpuSeconds) && receipt.allocatedCpuSeconds >= executionUnitCount
    && receipt.allocatedCpuSeconds <= receipt.aggregateCpuSeconds
    && receipt.allocatedCpuSeconds === allocatedCpuSeconds
    && verifyRawEventRecomputationResourceBudget(recomputationBudget)
    && verifySystemBenchmarkTypedNumericResourceBudget(receipt)
    && receipt.allocatedCpuSeconds + recomputationBudget.cpuSeconds
      + Number(typedNumericBudget?.cpuSeconds || 0)
      <= receipt.aggregateCpuSeconds
    && recomputationBudget.memoryBytes <= receipt.workerMemoryBytes
    && recomputationBudget.maximumProcesses <= receipt.workerMaximumProcesses
    && recomputationBudget.timeoutMs === recomputationLimits?.timeoutMs
    && recomputationBudget.memoryBytes === recomputationLimits?.memoryBytes
    && recomputationBudget.cpuSeconds === recomputationLimits?.cpuSeconds
    && recomputationBudget.maximumProcesses === recomputationLimits?.maximumPids
    && Number.isSafeInteger(receipt.workerMemoryBytes) && receipt.workerMemoryBytes >= 1
    && receipt.workerMemoryBytes === experimentBudget?.workerMemoryBytes
    && Number.isSafeInteger(receipt.workerMaximumProcesses) && receipt.workerMaximumProcesses >= 1
    && receipt.workerMaximumProcesses === experimentBudget?.workerMaximumProcesses
    && typeof receipt.gpuRequired === 'boolean'
    && receipt.gpuRequired === experimentBudget?.gpuRequired
    && (!requireDistinctProcesses || [processIdentityHashes, launcherPids, executionAttemptIds, environmentBindingHashes]
      .every((values) => new Set(values).size === executionUnitCount));
}
