export function assertTaskFlowPort(taskFlow) {
  for (const method of ['createManaged', 'runTask', 'setWaiting', 'resume', 'finish', 'fail', 'requestCancel', 'cancel', 'getTaskSummary']) {
    if (typeof taskFlow?.[method] !== 'function') throw new Error(`TaskFlowPort.${method} is required`);
  }
  return taskFlow;
}
