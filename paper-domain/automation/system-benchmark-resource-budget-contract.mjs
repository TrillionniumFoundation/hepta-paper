import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function verifySystemBenchmarkArmBatchResourceBudget(batchReceipt, harnessReceipt) {
  const budget = batchReceipt?.resourceBudget;
  const runnerReceipt = batchReceipt?.runnerReceipt;
  return budget?.absoluteDeadlineEpochMs === harnessReceipt?.absoluteDeadlineEpochMs
    && Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs >= 1
    && Number.isSafeInteger(budget.cpuSeconds) && budget.cpuSeconds >= 1
    && budget.memoryBytes === harnessReceipt.workerMemoryBytes
    && budget.maximumProcesses === harnessReceipt.workerMaximumProcesses
    && budget.requiresGpu === harnessReceipt.gpuRequired
    && runnerReceipt?.limits?.timeoutMs === budget.timeoutMs
    && runnerReceipt?.limits?.memoryBytes === budget.memoryBytes
    && runnerReceipt?.limits?.cpuSeconds === budget.cpuSeconds
    && runnerReceipt?.limits?.maximumPids === budget.maximumProcesses
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
    && Number.isFinite(receipt.absoluteDeadlineEpochMs)
    && Number.isSafeInteger(receipt.aggregateCpuSeconds) && receipt.aggregateCpuSeconds >= executionUnitCount
    && Number.isSafeInteger(receipt.allocatedCpuSeconds) && receipt.allocatedCpuSeconds >= executionUnitCount
    && receipt.allocatedCpuSeconds <= receipt.aggregateCpuSeconds
    && receipt.allocatedCpuSeconds === allocatedCpuSeconds
    && Number.isSafeInteger(receipt.workerMemoryBytes) && receipt.workerMemoryBytes >= 1
    && Number.isSafeInteger(receipt.workerMaximumProcesses) && receipt.workerMaximumProcesses >= 1
    && typeof receipt.gpuRequired === 'boolean'
    && (!requireDistinctProcesses || [processIdentityHashes, launcherPids, executionAttemptIds, environmentBindingHashes]
      .every((values) => new Set(values).size === executionUnitCount));
}
