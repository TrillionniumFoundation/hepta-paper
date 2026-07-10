export function assertWorkerRunnerPort(runner) {
  if (typeof runner?.run !== 'function') throw new Error('WorkerRunnerPort.run is required');
  if (!runner?.runnerId) throw new Error('WorkerRunnerPort.runnerId is required');
  return runner;
}

