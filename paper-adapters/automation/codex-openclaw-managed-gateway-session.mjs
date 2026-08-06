import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';
import {
  normalizeManagedUsage,
} from './codex-openclaw-managed-usage-evidence.mjs';

const MANAGED_NO_TOOL_DENYLIST = Object.freeze(['*']);

function objectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function gatewaySessionProjection(patched, model, thinking) {
  const entry = patched?.entry;
  return Object.freeze({
    key: patched?.key || null,
    sessionId: entry?.sessionId || null,
    lifecycleRevision: entry?.lifecycleRevision || null,
    updatedAt: entry?.updatedAt ?? null,
    authProfileOverride: entry?.authProfileOverride ?? null,
    providerOverride: entry?.providerOverride ?? null,
    modelOverride: entry?.modelOverride ?? null,
    resolvedProvider: patched?.resolved?.modelProvider ?? null,
    resolvedModel: patched?.resolved?.model ?? null,
    resolvedAgentRuntime: patched?.resolved?.agentRuntime ?? null,
    thinkingLevel: entry?.thinkingLevel ?? null,
    inheritedToolAllow: entry?.inheritedToolAllow ?? null,
    inheritedToolDeny: entry?.inheritedToolDeny ?? null,
    execSecurity: entry?.execSecurity ?? null,
    elevatedLevel: entry?.elevatedLevel ?? null,
    subagentRole: entry?.subagentRole ?? null,
    subagentControlScope: entry?.subagentControlScope ?? null,
    sendPolicy: entry?.sendPolicy ?? null,
    requestedProvider: model.provider,
    requestedModel: model.modelId,
    requestedThinking: thinking,
  });
}

export function validateGatewaySessionPatch(patched, {
  model,
  sessionKey,
  thinking,
} = {}) {
  const projection = gatewaySessionProjection(patched, model, thinking);
  if (patched?.ok !== true
    || projection.key !== sessionKey
    || !projection.sessionId
    || !Number.isFinite(projection.updatedAt)
    || projection.authProfileOverride !== null
    || projection.providerOverride !== null
    || projection.modelOverride !== null
    || projection.resolvedProvider !== model.provider
    || projection.resolvedModel !== model.modelId
    || projection.resolvedAgentRuntime !== 'openclaw'
    || projection.thinkingLevel !== thinking
    || projection.inheritedToolAllow !== null
    || !sameArray(projection.inheritedToolDeny, MANAGED_NO_TOOL_DENYLIST)
    || projection.execSecurity !== 'deny'
    || projection.elevatedLevel !== 'off'
    || projection.subagentRole !== 'leaf'
    || projection.subagentControlScope !== 'none'
    || projection.sendPolicy !== 'deny') {
    throw runtimeError('codex_openclaw_managed_session_binding_failed');
  }
  return Object.freeze({
    sessionId: projection.sessionId,
    lifecycleRevision: projection.lifecycleRevision,
    updatedAt: projection.updatedAt,
    bindingHash: hashRecord(
      'OpenClawManagedGatewaySessionBinding',
      {
        ...projection,
        lifecycleRevision: null,
        updatedAt: null,
      },
    ),
  });
}

export function gatewaySessionCas(patched, sessionKey) {
  const entry = patched?.entry;
  if (patched?.ok !== true
    || patched.key !== sessionKey
    || !objectRecord(entry)
    || typeof entry.sessionId !== 'string'
    || !entry.sessionId.trim()
    || (entry.lifecycleRevision !== undefined
      && entry.lifecycleRevision !== null
      && (typeof entry.lifecycleRevision !== 'string'
        || !entry.lifecycleRevision.trim()))
    || !Number.isFinite(entry.updatedAt)) return null;
  return Object.freeze({
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision || null,
    updatedAt: entry.updatedAt,
    bindingHash: null,
  });
}

export function agentTerminalResponseObserved(response, attemptId) {
  return Boolean(objectRecord(response)
    && response.runId === attemptId
    && ['ok', 'error', 'timeout'].includes(response.status)
    && objectRecord(response.result));
}

export function completeGatewayTerminalEvidence(response, {
  attemptId,
  configuration,
  model,
  sessionId,
  sessionKey,
} = {}) {
  const agentMeta = response?.result?.meta?.agentMeta;
  const usage = normalizeManagedUsage(agentMeta?.usage, {
    lastCallUsage: agentMeta?.lastCallUsage,
  });
  return agentTerminalResponseObserved(response, attemptId)
    && agentMeta?.sessionId === sessionId
    && (agentMeta?.sessionKey === undefined
      || agentMeta.sessionKey === sessionKey)
    && (agentMeta?.agentId === undefined
      || agentMeta.agentId === configuration.agentId)
    && agentMeta?.provider === model.provider
    && agentMeta?.model === model.modelId
    && usage !== null;
}

export function gatewayTerminalObserved(wait) {
  if (!objectRecord(wait) || wait.pendingError === true) return false;
  if (['ok', 'error'].includes(wait.status)) {
    return Number.isFinite(wait.endedAt)
      || typeof wait.stopReason === 'string'
      || wait.error !== undefined;
  }
  return wait.status === 'timeout'
    && (Number.isFinite(wait.endedAt)
      || typeof wait.stopReason === 'string'
      || wait.error !== undefined);
}

export function gatewayAgentTimeoutBudget(timeoutMs) {
  const clientTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || 1));
  if (clientTimeoutMs < 1_250) {
    throw runtimeError('codex_openclaw_managed_model_timeout');
  }
  const graceMs = Math.min(
    10_000,
    Math.max(250, Math.floor(clientTimeoutMs / 20)),
  );
  return Object.freeze({
    clientTimeoutMs,
    graceMs,
    serverTimeoutSeconds: Math.max(
      1,
      Math.floor(Math.max(1, clientTimeoutMs - graceMs) / 1000),
    ),
  });
}

export function openGatewayDispatchDeadline(parentSignal, deadline) {
  const absoluteDeadline = Number(deadline);
  const controller = new AbortController();
  let cause = null;
  const abort = (selectedCause) => {
    if (cause !== null) return;
    cause = selectedCause;
    controller.abort();
  };
  const onParentAbort = () => abort('parent');
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(
    () => abort('deadline'),
    Math.max(0, absoluteDeadline - Date.now()),
  );
  timer.unref?.();
  Object.defineProperty(controller.signal, 'aborted', {
    configurable: false,
    get: () => cause !== null || Date.now() >= absoluteDeadline,
  });
  return Object.freeze({
    signal: controller.signal,
    deadlineExpired: () => cause === 'deadline'
      || (cause === null && Date.now() >= absoluteDeadline),
    close() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  });
}
