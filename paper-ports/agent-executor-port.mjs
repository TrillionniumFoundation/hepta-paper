import { assertExecutorCapabilities } from './executor-capabilities.mjs';

export function assertAgentExecutorPort(executor) {
  if (typeof executor?.execute !== 'function') throw new Error('AgentExecutorPort.execute is required');
  if (!executor?.executorId) throw new Error('AgentExecutorPort.executorId is required');
  if (typeof executor?.capabilities !== 'function') throw new Error('AgentExecutorPort.capabilities is required');
  const capabilities = assertExecutorCapabilities(executor.capabilities());
  if (capabilities.executorId !== executor.executorId) throw new Error('AgentExecutorPort capability executorId mismatch');
  if (capabilities.externalActions) throw new Error('AgentExecutorPort cannot declare external actions');
  return executor;
}
