const NETWORK_POLICIES = new Set(['none', 'sandbox-restricted', 'local-provider-only', 'provider-controlled', 'provider-scoped']);

function strings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))].sort();
}

function finiteLimit(value, field) {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) throw new Error(`ExecutorCapabilities.${field} must be a positive finite number or null`);
  return normalized;
}

export function buildExecutorCapabilities({
  executorId,
  sandboxModes = [],
  networkPolicy = 'none',
  externalActions = false,
  workspaceIsolation = false,
  languages = ['*'],
  gpu = false,
  maximumTimeoutMs = null,
  maximumOutputTokens = null,
  receiptKinds = [],
  provider = null,
} = {}) {
  const record = Object.freeze({
    version: 1,
    kind: 'ExecutorCapabilities',
    executorId: String(executorId || ''),
    sandboxModes: strings(sandboxModes),
    networkPolicy: String(networkPolicy || ''),
    externalActions: externalActions === true,
    workspaceIsolation: workspaceIsolation === true,
    languages: strings(languages),
    gpu: gpu === true,
    maximumTimeoutMs: finiteLimit(maximumTimeoutMs, 'maximumTimeoutMs'),
    maximumOutputTokens: finiteLimit(maximumOutputTokens, 'maximumOutputTokens'),
    receiptKinds: strings(receiptKinds),
    provider: provider || null,
  });
  return assertExecutorCapabilities(record);
}

export function assertExecutorCapabilities(capabilities) {
  if (capabilities?.kind !== 'ExecutorCapabilities' || capabilities?.version !== 1) throw new Error('ExecutorCapabilities v1 required');
  if (!capabilities.executorId) throw new Error('ExecutorCapabilities.executorId is required');
  if (!Array.isArray(capabilities.sandboxModes) || !capabilities.sandboxModes.length) throw new Error('ExecutorCapabilities.sandboxModes is required');
  if (!NETWORK_POLICIES.has(capabilities.networkPolicy)) throw new Error('ExecutorCapabilities.networkPolicy is invalid');
  if (!Array.isArray(capabilities.languages) || !capabilities.languages.length) throw new Error('ExecutorCapabilities.languages is required');
  if (!Array.isArray(capabilities.receiptKinds) || !capabilities.receiptKinds.length) throw new Error('ExecutorCapabilities.receiptKinds is required');
  return capabilities;
}

export function evaluateExecutorCapabilityRequest({ capabilities, request = {} } = {}) {
  const declared = assertExecutorCapabilities(capabilities);
  const blockers = [];
  if (request.sandbox && !declared.sandboxModes.includes(request.sandbox)) blockers.push(`executor_sandbox_unsupported:${request.sandbox}`);
  if (request.language && !declared.languages.includes('*') && !declared.languages.includes(request.language)) {
    blockers.push(`executor_language_unsupported:${request.language}`);
  }
  if (request.requiresGpu === true && declared.gpu !== true) blockers.push('executor_gpu_unsupported');
  if (request.requiresWorkspaceIsolation === true && declared.workspaceIsolation !== true) blockers.push('executor_workspace_isolation_required');
  if (request.requiresNetworkIsolation === true && !['none', 'sandbox-restricted', 'local-provider-only'].includes(declared.networkPolicy)) {
    blockers.push(`executor_network_isolation_not_guaranteed:${declared.networkPolicy}`);
  }
  if (request.externalAction === true && declared.externalActions !== true) blockers.push('executor_external_action_unsupported');
  if (request.timeoutMs && declared.maximumTimeoutMs !== null && Number(request.timeoutMs) > declared.maximumTimeoutMs) blockers.push('executor_timeout_limit_exceeded');
  if (request.outputTokenBudget && declared.maximumOutputTokens !== null && Number(request.outputTokenBudget) > declared.maximumOutputTokens) blockers.push('executor_output_token_limit_exceeded');
  return Object.freeze({
    version: 1,
    kind: 'ExecutorCapabilityPreflight',
    executorId: declared.executorId,
    status: blockers.length ? 'executor_capability_mismatch' : 'executor_capability_ready',
    blockers,
  });
}

export function capabilityRequestFromExecution(input = {}) {
  return {
    sandbox: input.sandbox || null,
    language: input.context?.language || input.language || null,
    requiresGpu: input.context?.requiresGpu === true || input.requiresGpu === true,
    requiresWorkspaceIsolation: input.requiredCapabilities?.workspaceIsolation === true,
    requiresNetworkIsolation: input.requiredCapabilities?.networkIsolation === true,
    externalAction: input.requiredCapabilities?.externalAction === true,
    timeoutMs: input.timeoutMs || null,
    outputTokenBudget: input.outputTokenBudget || null,
  };
}
