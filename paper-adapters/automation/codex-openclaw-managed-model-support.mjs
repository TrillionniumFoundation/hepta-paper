import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

import {
  modelAttemptTraceHash,
  runtimeError,
  sha256,
} from './codex-openclaw-managed-runtime-common.mjs';
import {
  aggregateManagedUsage,
  managedUsageHash,
} from './codex-openclaw-managed-usage-evidence.mjs';
import {
  projectOpenClawManagedFailureCode,
} from './codex-openclaw-managed-failure-code.mjs';

const QUOTA_FAILURE_DETAIL =
  /(?:^|[^a-z0-9])(?:quota|usage[_ -]?limit|insufficient[_ -]?quota|(?:insufficient|no|out[_ -]+of)[_ -]+credits|credits[_ -]+(?:exhausted|depleted))(?:$|[^a-z0-9])/;
const RATE_LIMIT_FAILURE_DETAIL =
  /(?:^|[^a-z0-9])(?:rate[_ -]?limit(?:ed|ing)?|too[_ -]+many[_ -]+requests|429)(?:$|[^a-z0-9])/;
const AUTHENTICATION_FAILURE_DETAIL =
  /(?:^|[^a-z0-9])(?:auth(?:entication)?|unauthori[sz]ed|forbidden|401|403)(?:$|[^a-z0-9])/;
const CREDENTIAL_SECRET = '(?:(?:(?:api|access)[_ -]+)?token|api[_ -]+key)';
const INVALID_CREDENTIAL =
  '(?:invalid|expired|revoked|missing|rejected|denied|not[_ -]+valid)';
const CREDENTIAL_FAILURE_DETAIL = new RegExp(
  `(?:^|[^a-z0-9])(?:${INVALID_CREDENTIAL}[_ -]+${CREDENTIAL_SECRET}`
    + `|${CREDENTIAL_SECRET}[_ -]+(?:(?:is|was)[_ -]+)?${INVALID_CREDENTIAL}`
    + ')(?:$|[^a-z0-9])',
);
const ABORT_STOP_REASONS = new Set([
  'abort', 'aborted', 'cancel', 'canceled', 'cancelled',
]);

export function thinkingForModelAttempt(thinking, attempt) {
  if (thinking !== 'adaptive') return thinking;
  return ['high', 'medium', 'low'][attempt - 1] || 'low';
}

export function modelFailureClass({
  stopReason = '',
  errorCode = '',
  errorType = '',
  errorMessage = '',
  errorText = '',
  text = '',
} = {}) {
  if (ABORT_STOP_REASONS.has(stopReason)) return 'aborted';
  if (stopReason === 'length') return 'length';
  if (stopReason === 'toolUse') return 'tool_use';
  const failureDetail = [
    stopReason, errorCode, errorType, errorMessage, errorText,
  ].join(' ').toLowerCase();
  if (/abort|cancel/.test(failureDetail)) return 'aborted';
  if (/model.+not supported|unsupported.+model|unknown model/.test(failureDetail)) {
    return 'unsupported_model';
  }
  if (QUOTA_FAILURE_DETAIL.test(failureDetail)) {
    return 'quota';
  }
  if (RATE_LIMIT_FAILURE_DETAIL.test(failureDetail)) return 'rate_limited';
  if (AUTHENTICATION_FAILURE_DETAIL.test(failureDetail)
      || CREDENTIAL_FAILURE_DETAIL.test(failureDetail)) {
    return 'authentication';
  }
  if (/server_is_overloaded|overload|service_unavailable|\b503\b|temporar/.test(failureDetail)) {
    return 'overloaded';
  }
  if (/context|prompt too large|overflow/.test(failureDetail)) return 'context';
  const hasErrorDetail = [
    errorCode, errorType, errorMessage, errorText,
  ].some((value) => String(value || '').trim());
  if (!String(text || '').trim() && !hasErrorDetail) return 'empty';
  return 'transport';
}

export function modelAttemptRecord({
  attemptNumber,
  attemptId,
  model,
  configuration,
  thinking,
  outcome,
  stopReason,
  errorClass,
  responseText,
  responseErrorText,
  resolvedThinking,
  executionTrace,
  response,
  sessionBindingBeforeHash,
  sessionBindingAfterHash,
  sessionCleanup,
  sessionCleanupHash,
  sessionCleanupVerified,
  usage,
} = {}) {
  const normalizedTrace = executionTrace
    ? Object.freeze({
      winnerProvider: executionTrace.winnerProvider || null,
      winnerModel: executionTrace.winnerModel || null,
      fallbackUsed: executionTrace.fallbackUsed === true,
      runner: executionTrace.runner || null,
      attempts: Object.freeze((executionTrace.attempts || []).map((entry) => (
        Object.freeze({
          provider: entry.provider || null,
          model: entry.model || null,
          result: entry.result || null,
          stage: entry.stage || null,
          reason: entry.reason || null,
        })
      ))),
    })
    : null;
  return Object.freeze({
    attemptNumber,
    attemptId,
    provider: model.provider,
    model: model.modelId,
    authProfileIdentityHash:
      configuration.openClawManagedAuthProfileIdentityHash,
    thinking,
    resolvedThinking: resolvedThinking || null,
    outcome,
    stopReason: stopReason || null,
    errorClass: errorClass || null,
    responseTextHash: responseText ? sha256(String(responseText)) : null,
    responseErrorHash: responseErrorText
      ? sha256(String(responseErrorText)) : null,
    authProfileOverrideSource: 'user',
    runtimeFallbackUsed: normalizedTrace?.fallbackUsed ?? false,
    executionTrace: normalizedTrace,
    executionTraceHash: normalizedTrace
      ? hashRecord(
        'OpenClawManagedCodexAppServerExecutionTrace',
        normalizedTrace,
      )
      : null,
    sessionBindingBeforeHash: sessionBindingBeforeHash || null,
    sessionBindingAfterHash: sessionBindingAfterHash || null,
    agentHarnessId: response?.meta?.agentMeta?.agentHarnessId || null,
    requestAuthMode: response?.meta?.requestShaping?.authMode || null,
    toolCallsObserved: Number(response?.meta?.toolSummary?.calls || 0),
    pendingToolCallCount: Array.isArray(response?.meta?.pendingToolCalls)
      ? response.meta.pendingToolCalls.length : 0,
    externalDeliveryObserved: agentCommandExternalDeliveryObserved(response),
    sessionCleanup: sessionCleanup || null,
    sessionCleanupHash: sessionCleanupHash || null,
    sessionCleanupVerified: sessionCleanupVerified === true,
    usage,
    usageHash: hashRecord(
      'OpenClawManagedCodexAppServerAttemptUsage',
      { attemptId, usage },
    ),
  });
}

export function errorWithAttemptTrace(code, attempts, {
  retryable = true,
  runtimeProvenance = null,
} = {}) {
  const error = runtimeError(code, { retryable });
  error.attemptTrace = Object.freeze([...attempts]);
  error.attemptTraceHash = modelAttemptTraceHash(error.attemptTrace);
  const usage = aggregateManagedUsage(error.attemptTrace.map((attempt) => attempt.usage));
  if (usage) {
    error.usage = usage;
    error.usageHash = managedUsageHash(usage);
  }
  if (runtimeProvenance) error.runtimeProvenance = runtimeProvenance;
  return error;
}

export function failureWithCompletedManagedUsage(error, managed) {
  const code = projectOpenClawManagedFailureCode(
    error?.code || error?.message,
  );
  if (Array.isArray(error?.attemptTrace) && error.attemptTrace.length > 0) {
    if (error.code === code && error.message === code) return error;
    return errorWithAttemptTrace(code, error.attemptTrace, {
      retryable: error?.retryable === true,
      runtimeProvenance: error?.runtimeProvenance
        || managed?.runtimeProvenance || null,
    });
  }
  return errorWithAttemptTrace(code, managed?.attemptTrace || [], {
    retryable: error?.retryable === true,
    runtimeProvenance: managed?.runtimeProvenance || null,
  });
}

export function agentCommandText(result) {
  if (!Array.isArray(result?.payloads)
    || result.payloads.some((entry) => (
      entry?.isError === true
      || entry?.isReasoning === true
      || entry?.isCommentary === true
      || entry?.mediaUrl
      || (Array.isArray(entry?.mediaUrls) && entry.mediaUrls.length > 0)
    ))) {
    return '';
  }
  return result.payloads
    .filter((entry) => typeof entry?.text === 'string')
    .map((entry) => entry.text)
    .join('')
    .trim();
}

export function agentCommandErrorText(result) {
  if (!Array.isArray(result?.payloads)) return '';
  return result.payloads
    .filter((entry) => entry?.isError === true
      && typeof entry?.text === 'string')
    .map((entry) => entry.text)
    .join(' ')
    .trim()
    .slice(0, 16 * 1024);
}

export function agentCommandExternalDeliveryObserved(result) {
  return Boolean(
    result?.didSendViaMessagingTool
    || result?.didDeliverSourceReplyViaMessageTool
    || result?.didSendDeterministicApprovalPrompt
    || (result?.messagingToolSentTexts || []).length
    || (result?.messagingToolSentMediaUrls || []).length
    || (result?.messagingToolSentTargets || []).length
    || (result?.messagingToolSourceReplyPayloads || []).length
    || (result?.acceptedSessionSpawns || []).length
    || Number(result?.successfulCronAdds || 0) > 0
  );
}

export function agentCommandIsolationObserved(result) {
  return Boolean(
    result
    && result?.meta?.aborted !== true
    && !result?.meta?.error
    && (!Array.isArray(result?.meta?.pendingToolCalls)
      || result.meta.pendingToolCalls.length === 0)
    && Number(result?.meta?.toolSummary?.calls || 0) === 0
    && !agentCommandExternalDeliveryObserved(result)
  );
}

export function completionAbortScope(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('managed model timeout'));
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
    },
  });
}

export async function loadRuntimeWithinAbortScope({
  modelRuntimeLoader,
  configuration,
  abortScope,
} = {}) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      abortScope.signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(
      reject,
      runtimeError(
        abortScope.timedOut()
          ? 'codex_openclaw_managed_model_timeout'
          : 'codex_openclaw_managed_model_cancelled',
        { retryable: abortScope.timedOut() },
      ),
    );
    if (abortScope.signal.aborted) {
      onAbort();
      return;
    }
    abortScope.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => modelRuntimeLoader(configuration))
      .then(
        (runtime) => finish(resolve, runtime),
        (error) => finish(reject, error),
      );
  });
}

export function verifyExplicitProfileAvailable({
  runtime,
  configuration,
} = {}) {
  let store;
  try {
    store = runtime.ensureAuthProfileStore(runtime.agentDir, {
      allowKeychainPrompt: false,
      config: runtime.cfg,
      externalCliProfileIds: [configuration.authProfileId],
      readOnly: true,
      syncExternalCli: false,
    });
  } catch {
    throw runtimeError('codex_openclaw_managed_auth_profile_binding_failed');
  }
  const credential = store?.profiles?.[configuration.authProfileId];
  if (!credential) {
    throw runtimeError('codex_openclaw_managed_auth_profile_binding_failed');
  }
  if (String(credential.provider || '') !== 'openai'
    || !['oauth', 'token', 'api_key'].includes(String(credential.type || ''))) {
    throw runtimeError('codex_openclaw_managed_auth_profile_binding_invalid');
  }
  return true;
}

export function validCodexAppServerExecutionTrace(trace, model, {
  requireSuccess = true,
} = {}) {
  return Boolean(
    trace
    && trace.winnerProvider === model.provider
    && trace.winnerModel === model.modelId
    && trace.fallbackUsed === false
    && trace.runner === 'embedded'
    && Array.isArray(trace.attempts)
    && trace.attempts.length === 1
    && trace.attempts.every((attempt) => (
      attempt?.provider === model.provider
      && attempt?.model === model.modelId
      && !['rotate_profile', 'fallback_model'].includes(attempt?.result)
    ))
    && (!requireSuccess
      || (trace.attempts.at(-1)?.result === 'success'
        && trace.attempts.at(-1)?.stage === 'assistant'))
  );
}

export function codexAppServerTraceViolatesPin(trace, model) {
  if (!trace) return false;
  return Boolean(
    trace.fallbackUsed !== false
    || trace.runner !== 'embedded'
    || !Array.isArray(trace.attempts)
    || trace.attempts.length !== 1
    || (trace.winnerProvider && trace.winnerProvider !== model.provider)
    || (trace.winnerModel && trace.winnerModel !== model.modelId)
    || (Array.isArray(trace.attempts) && trace.attempts.some((attempt) => (
      attempt?.provider !== model.provider
      || attempt?.model !== model.modelId
      || ['rotate_profile', 'fallback_model'].includes(attempt?.result)
    )))
  );
}
