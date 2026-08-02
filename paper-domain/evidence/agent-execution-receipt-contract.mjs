import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const AGENT_USAGE_FIELDS = Object.freeze([
  'cacheRead',
  'cacheWrite',
  'input',
  'output',
  'totalTokens',
]);

function optionalUsageCost(value) {
  const values = ['costUsd', 'cost_usd']
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key)
      && value[key] !== undefined)
    .map((key) => value[key]);
  if (!values.length) return Object.freeze({ present: false, valid: true, value: null });
  const valid = values.every((candidate) => Number.isFinite(candidate) && candidate >= 0)
    && new Set(values).size === 1;
  return Object.freeze({ present: true, valid, value: valid ? values[0] : null });
}

function usageMetric(value, aliases, { required = true, fallback = null } = {}) {
  const values = aliases
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key)
      && value[key] !== undefined)
    .map((key) => value[key]);
  if (!values.length) return required ? null : fallback;
  if (values.some((candidate) => !Number.isSafeInteger(candidate)
      || candidate < 0)
    || new Set(values).size !== 1) return null;
  return values[0];
}

export function normalizeAgentExecutionUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = usageMetric(value, ['input', 'inputTokens', 'input_tokens']);
  const output = usageMetric(value, ['output', 'outputTokens', 'output_tokens']);
  const cacheRead = usageMetric(
    value,
    ['cacheRead', 'cacheReadTokens', 'cache_read_tokens'],
    { required: false, fallback: 0 },
  );
  const cacheWrite = usageMetric(
    value,
    ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens'],
    { required: false, fallback: 0 },
  );
  const totalTokens = usageMetric(
    value,
    ['totalTokens', 'total_tokens', 'total'],
  );
  const cost = optionalUsageCost(value);
  if ([input, output, cacheRead, cacheWrite, totalTokens].includes(null)
    || totalTokens !== input + output + cacheRead + cacheWrite
    || !cost.valid) return null;
  return Object.freeze({
    cacheRead,
    cacheWrite,
    input,
    output,
    totalTokens,
    ...(cost.present ? { costUsd: cost.value } : {}),
  });
}

export function agentExecutionUsageHash(value) {
  const usage = normalizeAgentExecutionUsage(value);
  return usage ? hashRecord('AgentExecutionUsage', usage) : null;
}

function aggregateAgentExecutionUsage(usages) {
  const normalized = usages.map(normalizeAgentExecutionUsage);
  if (!normalized.length || normalized.includes(null)) return null;
  const aggregate = Object.fromEntries(AGENT_USAGE_FIELDS.map((field) => [
    field,
    normalized.reduce((sum, usage) => sum + usage[field], 0),
  ]));
  if (!AGENT_USAGE_FIELDS.every((field) => Number.isSafeInteger(aggregate[field]))) return null;
  if (normalized.every((usage) => Object.hasOwn(usage, 'costUsd'))) {
    const costUsd = normalized.reduce((sum, usage) => sum + usage.costUsd, 0);
    if (!Number.isFinite(costUsd) || costUsd < 0) return null;
    aggregate.costUsd = costUsd;
  }
  return Object.freeze(aggregate);
}

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
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    agentWorkspacePostimageBinding: _agentWorkspacePostimageBinding,
    agentBackendUsage: _agentBackendUsage,
    agentBackendUsageReceipt: _agentBackendUsageReceipt,
    agentBackendUsageReceiptHash: _agentBackendUsageReceiptHash,
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

export function buildAgentBackendUsageReceipt({
  attempts = [],
  selectedExecutorId = null,
  status,
} = {}) {
  const preparedAttempts = attempts.map((attempt, index) => {
    const receipt = attempt?.receipt || null;
    const receiptVerified = verifyAgentExecutionReceipt(receipt, {
      requireCompleted: false,
    });
    return {
      attemptId: String(attempt?.attemptId || `backend-attempt-${index + 1}`),
      executorId: String(attempt?.executorId || receipt?.executorId || ''),
      receipt,
      receiptVerified,
    };
  });
  const attemptIdCounts = new Map();
  const receiptHashCounts = new Map();
  for (const attempt of preparedAttempts) {
    attemptIdCounts.set(
      attempt.attemptId,
      Number(attemptIdCounts.get(attempt.attemptId) || 0) + 1,
    );
    if (attempt.receiptVerified) {
      const receiptHash = attempt.receipt.agentExecutionReceiptHash;
      receiptHashCounts.set(
        receiptHash,
        Number(receiptHashCounts.get(receiptHash) || 0) + 1,
      );
    }
  }
  const normalizedAttempts = preparedAttempts.map((attempt, index) => {
    const {
      attemptId, executorId, receipt, receiptVerified,
    } = attempt;
    const attemptIdentityVerified = Boolean(
      attemptId
      && executorId
      && attemptIdCounts.get(attemptId) === 1
      && (!receiptVerified || (
        receiptHashCounts.get(receipt.agentExecutionReceiptHash) === 1
        && receipt.executorId === executorId
      )),
    );
    const usageRequired = !receiptVerified
      || receipt?.externalModelInvocationPerformed !== false;
    const usageReported = receiptVerified && receipt?.usage !== null
      && receipt?.usage !== undefined;
    const usage = usageReported ? normalizeAgentExecutionUsage(receipt.usage) : null;
    const sourceUsageComplete = receiptVerified && receipt?.usageComplete !== false;
    return Object.freeze({
      ordinal: index + 1,
      attemptId,
      executorId,
      attemptIdentityVerified,
      receiptVerified,
      agentExecutionReceipt: receiptVerified ? receipt : null,
      agentExecutionReceiptHash: receiptVerified
        ? receipt.agentExecutionReceiptHash : null,
      receiptStatus: receiptVerified ? receipt.status : null,
      sourceUsageComplete,
      usageRequired,
      usageReported,
      usageVerified: sourceUsageComplete && (usageRequired
        ? usageReported && usage !== null
        : !usageReported || usage !== null),
      usage,
      usageHash: usage ? agentExecutionUsageHash(usage) : null,
    });
  });
  const reportedUsages = normalizedAttempts
    .filter((attempt) => attempt.usageReported)
    .map((attempt) => attempt.usage);
  const usage = reportedUsages.length
    ? aggregateAgentExecutionUsage(reportedUsages) : null;
  const usageComplete = normalizedAttempts.every((attempt) => (
    attempt.attemptIdentityVerified
      && attempt.receiptVerified
      && attempt.usageVerified
  ))
    && (!reportedUsages.length || usage !== null);
  const payload = {
    version: 1,
    kind: 'AgentBackendUsageReceipt',
    status,
    selectedExecutorId,
    attempts: Object.freeze(normalizedAttempts),
    usageComplete,
    usage,
    usageHash: usage ? agentExecutionUsageHash(usage) : null,
  };
  return Object.freeze({
    ...payload,
    agentBackendUsageReceiptHash: hashRecord('AgentBackendUsageReceipt', payload),
  });
}

export function verifyAgentBackendUsageReceipt(receipt, {
  selectedAgentExecutionReceiptHash = null,
} = {}) {
  try {
    if (receipt?.kind !== 'AgentBackendUsageReceipt'
      || receipt?.version !== 1
      || !['agent_backend_selected', 'all_agent_backends_failed'].includes(receipt.status)
      || !Array.isArray(receipt.attempts)) return false;
    const rebuilt = buildAgentBackendUsageReceipt({
      attempts: receipt.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        executorId: attempt.executorId,
        receipt: attempt.agentExecutionReceipt,
      })),
      selectedExecutorId: receipt.selectedExecutorId,
      status: receipt.status,
    });
    return receipt.attempts.every((attempt) => attempt.attemptIdentityVerified === true)
      && JSON.stringify(rebuilt) === JSON.stringify(receipt)
      && (!selectedAgentExecutionReceiptHash
        || receipt.attempts.some((attempt) => (
          attempt.agentExecutionReceiptHash === selectedAgentExecutionReceiptHash
          && attempt.executorId === receipt.selectedExecutorId
        )));
  } catch {
    return false;
  }
}

export function verifiedAgentExecutionUsage(receipt, { requireCompleted = true } = {}) {
  if (!verifyAgentExecutionReceipt(receipt, { requireCompleted })) return null;
  if (receipt.usageComplete === false) return null;
  if (receipt.agentBackendUsageReceipt || receipt.agentBackendUsageReceiptHash) {
    const routed = receipt.agentBackendUsageReceipt;
    return verifyAgentBackendUsageReceipt(routed, {
      selectedAgentExecutionReceiptHash: receipt.agentExecutionReceiptHash,
    })
      && routed.agentBackendUsageReceiptHash === receipt.agentBackendUsageReceiptHash
      && routed.usageComplete === true
      && JSON.stringify(receipt.agentBackendUsage) === JSON.stringify(routed.usage)
      ? routed.usage : null;
  }
  return receipt.usage === null || receipt.usage === undefined
    ? null : normalizeAgentExecutionUsage(receipt.usage);
}

export function buildAgentExecutionUsageBinding(receipt, {
  requireCompleted = true,
} = {}) {
  if (!verifyAgentExecutionReceipt(receipt, { requireCompleted })) return null;
  const usage = verifiedAgentExecutionUsage(receipt, { requireCompleted });
  const usageRequired = receipt.externalModelInvocationPerformed !== false
    || Boolean(receipt.agentBackendUsageReceipt || receipt.agentBackendUsageReceiptHash);
  if ((usageRequired || (receipt.usage !== null && receipt.usage !== undefined))
    && usage === null) return null;
  const payload = {
    version: 1,
    kind: 'AgentExecutionUsageBinding',
    agentExecutionReceiptHash: receipt.agentExecutionReceiptHash,
    agentBackendUsageReceiptHash: receipt.agentBackendUsageReceiptHash || null,
    usage,
    usageHash: usage ? agentExecutionUsageHash(usage) : null,
  };
  return Object.freeze({
    ...payload,
    agentExecutionUsageBindingHash: hashRecord('AgentExecutionUsageBinding', payload),
  });
}

export function verifyAgentExecutionUsageBinding(binding, {
  agentExecutionReceipt = null,
} = {}) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  if (!verifyAgentExecutionReceipt(agentExecutionReceipt)) return false;
  const rebuilt = buildAgentExecutionUsageBinding(agentExecutionReceipt);
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(binding)) return false;
  const {
    agentExecutionUsageBindingHash: claimedHash,
    ...payload
  } = binding;
  const usage = payload.usage === null
    ? null : normalizeAgentExecutionUsage(payload.usage);
  return Boolean(
    Object.keys(binding).length === 7
    && payload.version === 1
    && payload.kind === 'AgentExecutionUsageBinding'
    && SHA256.test(String(payload.agentExecutionReceiptHash || ''))
    && (payload.agentBackendUsageReceiptHash === null
      || SHA256.test(String(payload.agentBackendUsageReceiptHash || '')))
    && (payload.usage === null
      ? payload.usageHash === null
      : (usage
        && JSON.stringify(payload.usage) === JSON.stringify(usage)
        && payload.usageHash === agentExecutionUsageHash(usage)))
    && claimedHash === hashRecord('AgentExecutionUsageBinding', payload)
  );
}

export function buildAgentPostprocessingFailureUsageReceipt(agentExecutionReceipt) {
  const agentExecutionUsageBinding = buildAgentExecutionUsageBinding(
    agentExecutionReceipt,
  );
  if (!agentExecutionUsageBinding || !agentExecutionUsageBinding.usage) return null;
  const payload = {
    version: 1,
    kind: 'AgentPostprocessingFailureUsageReceipt',
    status: 'agent_postprocessing_failed',
    agentExecutionReceiptHash: agentExecutionReceipt.agentExecutionReceiptHash,
    agentExecutionReceipt,
    usage: agentExecutionUsageBinding.usage,
    agentExecutionUsageBindingHash:
      agentExecutionUsageBinding.agentExecutionUsageBindingHash,
    agentExecutionUsageBinding,
  };
  return Object.freeze({
    ...payload,
    agentPostprocessingFailureUsageReceiptHash:
      hashRecord('AgentPostprocessingFailureUsageReceipt', payload),
  });
}

export function verifyAgentPostprocessingFailureUsageReceipt(receipt) {
  try {
    const rebuilt = buildAgentPostprocessingFailureUsageReceipt(
      receipt?.agentExecutionReceipt,
    );
    return rebuilt !== null && JSON.stringify(rebuilt) === JSON.stringify(receipt);
  } catch {
    return false;
  }
}
