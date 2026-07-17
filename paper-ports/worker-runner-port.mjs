import { assertExecutorCapabilities } from './executor-capabilities.mjs';

export function assertWorkerRunnerPort(runner) {
  if (Number(runner?.version || 0) < 4) throw new Error('WorkerRunnerPort.version 4 with execution identity capability is required');
  if (typeof runner?.run !== 'function') throw new Error('WorkerRunnerPort.run is required');
  if (!runner?.runnerId) throw new Error('WorkerRunnerPort.runnerId is required');
  if (typeof runner?.capabilities !== 'function') throw new Error('WorkerRunnerPort.capabilities is required');
  if (typeof runner?.resolveExecutionRuntimeIdentity !== 'function') throw new Error('WorkerRunnerPort.resolveExecutionRuntimeIdentity is required');
  if (runner?.deprecatedRunInputs) throw new Error('WorkerRunnerPort deprecated run inputs must be removed');
  const capabilities = assertExecutorCapabilities(runner.capabilities());
  if (capabilities.executorId !== runner.runnerId) throw new Error('WorkerRunnerPort capability runnerId mismatch');
  if (capabilities.externalActions) throw new Error('WorkerRunnerPort cannot declare external actions');
  return runner;
}
