import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

// Routers and workspace-isolation wrappers append transport metadata after the
// executor has minted the receipt. Those fields are deliberately outside the
// executor-owned AgentExecutionReceipt hash domain.
export function agentExecutionReceiptPayload(receipt) {
  const {
    agentExecutionReceiptHash: _agentExecutionReceiptHash,
    selectedExecutorId: _selectedExecutorId,
    fallbackCount: _fallbackCount,
    fallbackFailures: _fallbackFailures,
    isolatedWorkspaceRetained: _isolatedWorkspaceRetained,
    workspaceContentPolicy: _workspaceContentPolicy,
    isolatedAgentMergeReceiptHash: _isolatedAgentMergeReceiptHash,
    ...payload
  } = receipt || {};
  return payload;
}

export function verifyAgentExecutionReceipt(receipt, { requireCompleted = true } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  if (requireCompleted && receipt.status !== 'agent_execution_completed') return false;
  return Boolean(receipt.agentExecutionReceiptHash
    && hashRecord('AgentExecutionReceipt', agentExecutionReceiptPayload(receipt))
      === receipt.agentExecutionReceiptHash);
}
