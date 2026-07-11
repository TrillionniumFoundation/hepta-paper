export function assertAgentExecutorPort(executor) {
  if (typeof executor?.execute !== 'function') throw new Error('AgentExecutorPort.execute is required');
  if (!executor?.executorId) throw new Error('AgentExecutorPort.executorId is required');
  return executor;
}
