export function assertSchedulerPort(scheduler) {
  if (Number(scheduler?.version || 0) < 1) throw new Error('SchedulerPort.version 1 is required');
  for (const method of ['sleep', 'setInterval', 'clearInterval']) {
    if (typeof scheduler?.[method] !== 'function') throw new Error(`SchedulerPort.${method} is required`);
  }
  return scheduler;
}
