import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { buildExecutorCapabilities, capabilityRequestFromExecution, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';

export function createAgentBackendRouter({ primary, fallbacks = [], health = () => ({}), failureThreshold = 3, cooldownMs = 60000, now = () => Date.now() } = {}) {
  const executors = [primary, ...fallbacks].filter(Boolean);
  if (!executors.length) throw new Error('at least one agent executor is required');
  executors.forEach(assertAgentExecutorPort);
  const failuresByExecutor = new Map();
  const unavailableUntil = new Map();
  const backendCapabilities = executors.map((executor) => executor.capabilities());
  const capabilities = buildExecutorCapabilities({
    executorId: 'agent-backend-router-v1',
    sandboxModes: [...new Set(backendCapabilities.flatMap((item) => item.sandboxModes))],
    networkPolicy: 'provider-controlled',
    workspaceIsolation: backendCapabilities.every((item) => item.workspaceIsolation),
    languages: [...new Set(backendCapabilities.flatMap((item) => item.languages))],
    gpu: backendCapabilities.some((item) => item.gpu),
    maximumTimeoutMs: backendCapabilities.every((item) => item.maximumTimeoutMs !== null)
      ? Math.max(...backendCapabilities.map((item) => item.maximumTimeoutMs))
      : null,
    maximumOutputTokens: backendCapabilities.every((item) => item.maximumOutputTokens !== null)
      ? Math.max(...backendCapabilities.map((item) => item.maximumOutputTokens))
      : null,
    receiptKinds: [...new Set(backendCapabilities.flatMap((item) => item.receiptKinds))],
    provider: 'routed',
  });
  const backendStatus = () => Object.freeze(Object.fromEntries(executors.map((executor) => [executor.executorId, {
    failureCount: Number(failuresByExecutor.get(executor.executorId) || 0),
    unavailableUntil: unavailableUntil.get(executor.executorId) || null,
    available: Number(unavailableUntil.get(executor.executorId) || 0) <= now(),
  }])));
  return assertAgentExecutorPort({
    version: 1,
    kind: 'AgentBackendRouter',
    executorId: 'agent-backend-router-v1',
    capabilities: () => capabilities,
    backendCapabilities: () => backendCapabilities,
    backendStatus,
    async execute(input = {}) {
      const failures = [];
      const snapshot = health();
      for (const executor of executors) {
        const preflight = evaluateExecutorCapabilityRequest({ capabilities: executor.capabilities(), request: capabilityRequestFromExecution(input) });
        if (preflight.blockers.length) {
          failures.push({ executorId: executor.executorId, message: 'backend_capability_mismatch', blockers: preflight.blockers, receiptHash: null });
          continue;
        }
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
