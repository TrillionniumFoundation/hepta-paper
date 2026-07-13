import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';
import { buildExecutorCapabilities, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';

function executor(executorId, overrides = {}) {
  const capabilities = buildExecutorCapabilities({
    executorId,
    sandboxModes: ['read-only', 'workspace-write'],
    networkPolicy: 'none',
    workspaceIsolation: true,
    maximumTimeoutMs: 1000,
    maximumOutputTokens: 1000,
    receiptKinds: ['AgentExecutionReceipt'],
    ...overrides,
  });
  return {
    executorId,
    capabilities: () => capabilities,
    async execute() { return { status: 'agent_execution_completed', agentExecutionReceiptHash: `sha256:${executorId}` }; },
  };
}

test('executor capability preflight reports precise unsupported requirements', () => {
  const capabilities = executor('cpu-only').capabilities();
  const report = evaluateExecutorCapabilityRequest({ capabilities, request: { sandbox: 'workspace-write', requiresGpu: true, timeoutMs: 2000, outputTokenBudget: 2000 } });
  assert.equal(report.status, 'executor_capability_mismatch');
  assert.deepEqual(report.blockers, ['executor_gpu_unsupported', 'executor_timeout_limit_exceeded', 'executor_output_token_limit_exceeded']);
});

test('agent backend router skips capability mismatches before invoking a backend', async () => {
  let primaryCalls = 0;
  const primary = executor('cpu-only');
  primary.execute = async () => { primaryCalls += 1; throw new Error('must not execute'); };
  const gpu = executor('gpu-worker', { gpu: true });
  const receipt = await createAgentBackendRouter({ primary, fallbacks: [gpu] }).execute({
    sandbox: 'workspace-write',
    context: { requiresGpu: true },
  });
  assert.equal(primaryCalls, 0);
  assert.equal(receipt.selectedExecutorId, 'gpu-worker');
  assert.equal(receipt.fallbackFailures[0].message, 'backend_capability_mismatch');
  assert.ok(receipt.fallbackFailures[0].blockers.includes('executor_gpu_unsupported'));
});
