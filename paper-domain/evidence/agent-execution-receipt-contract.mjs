import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function normalizedWorkspacePath(value) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return relative && !relative.startsWith('/')
    && !relative.split('/').some((part) => !part || part === '.' || part === '..')
    ? relative
    : null;
}

export function buildAgentWorkspacePostimageBinding({ changedPaths = [], files = [] } = {}) {
  const normalizedPaths = [...new Set(changedPaths.map(normalizedWorkspacePath))].sort();
  const normalizedFiles = files.map((file) => Object.freeze({
    path: normalizedWorkspacePath(file?.path),
    hash: file?.hash === null ? null : String(file?.hash || '').toLowerCase(),
  })).sort((left, right) => (String(left.path) < String(right.path) ? -1
    : String(left.path) > String(right.path) ? 1 : 0));
  if (normalizedPaths.length !== changedPaths.length || normalizedPaths.some((value) => !value)
    || normalizedFiles.length !== normalizedPaths.length
    || normalizedFiles.some((file) => !file.path
      || (file.hash !== null && !SHA256.test(file.hash)))
    || JSON.stringify(normalizedFiles.map((file) => file.path)) !== JSON.stringify(normalizedPaths)) {
    throw new Error('agent_workspace_postimage_binding_input_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AgentWorkspacePostimageBinding',
    changedPaths: Object.freeze(normalizedPaths),
    files: Object.freeze(normalizedFiles),
  };
  return Object.freeze({
    ...payload,
    agentWorkspacePostimageBindingHash:
      hashRecord('AgentWorkspacePostimageBinding', payload),
  });
}

export function verifyAgentWorkspacePostimageBinding(binding, {
  requiredPath = null,
  requiredHash = null,
} = {}) {
  try {
    const rebuilt = buildAgentWorkspacePostimageBinding({
      changedPaths: binding?.changedPaths,
      files: binding?.files,
    });
    if (JSON.stringify(rebuilt) !== JSON.stringify(binding)) return false;
    if (requiredPath === null) return true;
    const normalizedRequiredPath = normalizedWorkspacePath(requiredPath);
    const normalizedRequiredHash = String(requiredHash || '').toLowerCase();
    return Boolean(normalizedRequiredPath && SHA256.test(normalizedRequiredHash)
      && rebuilt.files.some((file) => file.path === normalizedRequiredPath
        && file.hash === normalizedRequiredHash));
  } catch {
    return false;
  }
}

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
    isolatedAgentMergeReceipt: _isolatedAgentMergeReceipt,
    agentWorkspacePostimageBinding: _agentWorkspacePostimageBinding,
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
