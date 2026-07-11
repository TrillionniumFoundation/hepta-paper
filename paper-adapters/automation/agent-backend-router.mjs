import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';

export function createAgentBackendRouter({ primary, fallbacks = [], health = () => ({}), failureThreshold = 3, cooldownMs = 60000, now = () => Date.now() } = {}) {
  const executors = [primary, ...fallbacks].filter(Boolean);
  if (!executors.length) throw new Error('at least one agent executor is required');
  executors.forEach(assertAgentExecutorPort);
  const failuresByExecutor = new Map();
  const unavailableUntil = new Map();
  const backendStatus = () => Object.freeze(Object.fromEntries(executors.map((executor) => [executor.executorId, {
    failureCount: Number(failuresByExecutor.get(executor.executorId) || 0),
    unavailableUntil: unavailableUntil.get(executor.executorId) || null,
    available: Number(unavailableUntil.get(executor.executorId) || 0) <= now(),
  }])));
  return assertAgentExecutorPort({
    version: 1,
    kind: 'AgentBackendRouter',
    executorId: 'agent-backend-router-v1',
    backendStatus,
    async execute(input = {}) {
      const failures = [];
      const snapshot = health();
      for (const executor of executors) {
        if (snapshot[executor.executorId] === false) {
          failures.push({ executorId: executor.executorId, message: 'backend_health_probe_unavailable', receiptHash: null });
          continue;
        }
        if (executors.length > 1 && Number(unavailableUntil.get(executor.executorId) || 0) > now()) {
          failures.push({ executorId: executor.executorId, message: 'backend_circuit_breaker_open', receiptHash: null });
          continue;
        }
        try {
          const receipt = await executor.execute(input);
          failuresByExecutor.set(executor.executorId, 0);
          unavailableUntil.delete(executor.executorId);
          return Object.freeze({ ...receipt, selectedExecutorId: executor.executorId, fallbackCount: failures.length, fallbackFailures: failures });
        } catch (error) {
          failures.push({
            executorId: executor.executorId,
            message: String(error?.message || error).slice(0, 500),
            receiptHash: error?.receipt?.agentExecutionReceiptHash || null,
            receiptStatus: error?.receipt?.status || null,
            blockers: Array.isArray(error?.receipt?.blockers) ? error.receipt.blockers.slice(0, 20) : [],
            stderrTail: String(error?.receipt?.stderrTail || '').slice(-2000),
          });
          const failureCount = Number(failuresByExecutor.get(executor.executorId) || 0) + 1;
          failuresByExecutor.set(executor.executorId, failureCount);
          if (failureCount >= Math.max(1, Number(failureThreshold))) unavailableUntil.set(executor.executorId, now() + Math.max(1000, Number(cooldownMs)));
          if (error?.retryable === false) break;
        }
      }
      const error = new Error(`all_agent_backends_failed:${failures.map((item) => item.executorId).join(',')}`);
      error.retryable = true;
      error.failures = failures;
      throw error;
    },
  });
}
