import { assertExecutorCapabilities } from './executor-capabilities.mjs';

export function assertWorkerRunnerPort(runner) {
  if (typeof runner?.run !== 'function') throw new Error('WorkerRunnerPort.run is required');
  if (!runner?.runnerId) throw new Error('WorkerRunnerPort.runnerId is required');
  if (typeof runner?.capabilities !== 'function') throw new Error('WorkerRunnerPort.capabilities is required');
  const capabilities = assertExecutorCapabilities(runner.capabilities());
  if (capabilities.executorId !== runner.runnerId) throw new Error('WorkerRunnerPort capability runnerId mismatch');
  if (capabilities.externalActions) throw new Error('WorkerRunnerPort cannot declare external actions');
  return runner;
}
