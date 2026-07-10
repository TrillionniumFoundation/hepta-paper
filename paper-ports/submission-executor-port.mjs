export function assertSubmissionExecutorPort(executor) {
  for (const field of ['executorId', 'provider', 'accountId', 'workspaceRoot']) {
    if (!executor?.[field]) throw new Error(`SubmissionExecutorPort.${field} is required`);
  }
  if (executor.externalWorkspace !== true) throw new Error('Submission executor must run in an external workspace');
  if (typeof executor.dispatch !== 'function') throw new Error('SubmissionExecutorPort.dispatch is required');
  return executor;
}

export function submissionExecutorDescriptor(executor) {
  const port = assertSubmissionExecutorPort(executor);
  return Object.freeze({
    version: 1,
    kind: 'SubmissionExecutorDescriptor',
    executorId: port.executorId,
    provider: port.provider,
    accountId: port.accountId,
    workspaceRoot: port.workspaceRoot,
    externalWorkspace: true,
  });
}

