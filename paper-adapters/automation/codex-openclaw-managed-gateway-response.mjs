import {
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';

function objectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function explicitAuthProfileObserved(value) {
  if (Array.isArray(value)) return value.some(explicitAuthProfileObserved);
  if (!objectRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => (
    (['authProfileId', 'authProfileOverride', 'effectiveAuthProfileId']
      .includes(key) && entry !== null && entry !== undefined)
    || explicitAuthProfileObserved(entry)
  ));
}

function externalActionObserved(result) {
  const falseFields = [
    'didSendViaMessagingTool',
    'didDeliverSourceReplyViaMessageTool',
    'didSendDeterministicApprovalPrompt',
  ];
  const emptyArrayFields = [
    'messagingToolSentTexts',
    'messagingToolSentMediaUrls',
    'messagingToolSentTargets',
    'messagingToolSourceReplyPayloads',
    'acceptedSessionSpawns',
  ];
  const toolSummary = result?.meta?.toolSummary;
  return falseFields.some((key) => Object.hasOwn(result || {}, key)
      && result[key] !== false)
    || emptyArrayFields.some((key) => Object.hasOwn(result || {}, key)
      && !sameArray(result[key], []))
    || (Object.hasOwn(result || {}, 'successfulCronAdds')
      && result.successfulCronAdds !== 0)
    || (Object.hasOwn(result || {}, 'deliverySucceeded')
      && result.deliverySucceeded !== false)
    || Object.hasOwn(result || {}, 'deliveryStatus')
    || (toolSummary !== undefined
      && (!objectRecord(toolSummary) || toolSummary.calls !== 0))
    || (Object.hasOwn(result?.meta || {}, 'pendingToolCalls')
      && !sameArray(result.meta.pendingToolCalls, []));
}

function validDiagnosticSkillCatalog(skills) {
  if (!objectRecord(skills)
    || !Number.isSafeInteger(skills.promptChars)
    || skills.promptChars < 0
    || !Array.isArray(skills.entries)
    || (skills.hash !== undefined
      && !/^[0-9a-f]{64}$/.test(String(skills.hash)))) {
    return false;
  }
  if ((skills.promptChars === 0) !== (skills.entries.length === 0)) {
    return false;
  }
  return skills.entries.every((entry) => (
    objectRecord(entry)
    && typeof entry.name === 'string'
    && entry.name.trim().length > 0
    && Number.isSafeInteger(entry.blockChars)
    && entry.blockChars >= 0
  ));
}

function isolatedSystemPromptReport(report, {
  model,
  sessionId,
  sessionKey,
} = {}) {
  return Boolean(
    objectRecord(report)
    && report.sessionId === sessionId
    && report.sessionKey === sessionKey
    && report.provider === model.provider
    && report.model === model.modelId
    && report.systemPrompt?.chars === 0
    && report.systemPrompt?.projectContextChars === 0
    && report.systemPrompt?.nonProjectContextChars === 0
    && sameArray(report.injectedWorkspaceFiles, [])
    // Raw runs can report the resident skill catalog as diagnostics even
    // though it was not included in the provider-visible system prompt.
    && validDiagnosticSkillCatalog(report.skills)
    && report.tools?.listChars === 0
    && report.tools?.schemaChars === 0
    && sameArray(report.tools?.entries, [])
    && report.currentTurn?.runtimeContextChars === 0
  );
}

function validUsage(usage) {
  return Number.isSafeInteger(usage?.input)
    && usage.input >= 0
    && Number.isSafeInteger(usage?.output)
    && usage.output >= 0
    && Number.isSafeInteger(usage?.totalTokens ?? usage?.total)
    && (usage.totalTokens ?? usage.total) > 0;
}

function validateExactModelBinding(result, response, {
  configuration,
  model,
  sessionId,
  sessionKey,
  thinking,
  allowMissingFailureDiagnostics = false,
} = {}) {
  const meta = result?.meta;
  const agentMeta = meta?.agentMeta;
  const shaping = meta?.requestShaping;
  if (!objectRecord(meta)
    || !objectRecord(agentMeta)
    || agentMeta.sessionId !== sessionId
    || (agentMeta.sessionKey !== undefined && agentMeta.sessionKey !== sessionKey)
    || (agentMeta.agentId !== undefined
      && agentMeta.agentId !== configuration.agentId)
    || agentMeta.provider !== model.provider
    || agentMeta.model !== model.modelId
    || ((!allowMissingFailureDiagnostics
        || agentMeta.agentHarnessId !== undefined)
      && agentMeta.agentHarnessId !== 'openclaw')
    || (!allowMissingFailureDiagnostics && !validUsage(agentMeta.usage))
    || explicitAuthProfileObserved(response)) {
    throw runtimeError('codex_openclaw_managed_model_resolution_mismatch');
  }
  if (allowMissingFailureDiagnostics) {
    if (shaping !== undefined
      && (!objectRecord(shaping)
        || (shaping.authMode !== undefined
          && shaping.authMode !== 'auth-profile')
        || (shaping.thinking !== undefined && shaping.thinking !== thinking))) {
      throw runtimeError('codex_openclaw_managed_model_resolution_mismatch');
    }
  } else if (shaping?.authMode !== 'auth-profile'
    || shaping?.thinking !== thinking) {
    throw runtimeError('codex_openclaw_managed_model_resolution_mismatch');
  }
  const report = meta.systemPromptReport;
  if (externalActionObserved(result)
    || ((!allowMissingFailureDiagnostics || report !== undefined)
      && !isolatedSystemPromptReport(report, {
        model,
        sessionId,
        sessionKey,
      }))) {
    throw runtimeError('codex_openclaw_managed_agent_policy_violation');
  }
  return { meta, agentMeta };
}

function validateExecutionTrace(trace, model, { requireSuccess } = {}) {
  if (!objectRecord(trace)
    || !Array.isArray(trace.attempts)
    || trace.attempts.length !== 1
    || trace.attempts[0]?.provider !== model.provider
    || trace.attempts[0]?.model !== model.modelId
    || typeof trace.attempts[0]?.result !== 'string'
    || !trace.attempts[0].result.trim()
    || (requireSuccess && trace.attempts[0]?.result !== 'success')
    || (trace.winnerProvider !== undefined
      && trace.winnerProvider !== model.provider)
    || (trace.winnerModel !== undefined
      && trace.winnerModel !== model.modelId)
    || trace.fallbackUsed !== false
    || trace.runner !== 'embedded'
    || ['rotate_profile', 'fallback_model']
      .includes(trace.attempts[0]?.result)) {
    throw runtimeError('codex_openclaw_managed_runtime_fallback_observed');
  }
}

export function parseOpenClawManagedGatewayResponse(response, options = {}) {
  const result = response?.result;
  const payload = result?.payloads?.[0];
  if (!objectRecord(response)
    || response.runId !== options.runId
    || response.status !== 'ok'
    || response.summary !== 'completed'
    || !objectRecord(result)
    || !Array.isArray(result.payloads)
    || result.payloads.length !== 1
    || !objectRecord(payload)
    || JSON.stringify(Object.keys(payload).sort())
      !== JSON.stringify(['mediaUrl', 'text'])
    || payload.mediaUrl !== null
    || typeof payload.text !== 'string'
    || !payload.text.trim()) {
    throw runtimeError('codex_openclaw_managed_agent_command_failed');
  }
  const { meta } = validateExactModelBinding(result, response, options);
  if (meta.stopReason !== 'stop'
    || meta.aborted !== false
    || meta.error !== undefined
    || meta.completion?.stopReason !== 'stop'
    || meta.completion?.finishReason !== 'stop') {
    throw runtimeError('codex_openclaw_managed_model_resolution_mismatch');
  }
  validateExecutionTrace(meta.executionTrace, options.model, {
    requireSuccess: true,
  });
  return result;
}

function validFailurePayloads(payloads) {
  const allowedKeys = new Set([
    'isCommentary', 'isError', 'isReasoning', 'mediaUrl', 'mediaUrls', 'text',
  ]);
  return Array.isArray(payloads)
    && payloads.every((payload) => (
      objectRecord(payload)
      && Object.keys(payload).every((key) => allowedKeys.has(key))
      && typeof payload.text === 'string'
      && !payload.mediaUrl
      && (payload.mediaUrls === undefined
        || (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length === 0))
      && ['isCommentary', 'isError', 'isReasoning'].every((key) => (
        payload[key] === undefined || typeof payload[key] === 'boolean'
      ))
    ));
}

function failureObserved(response, result) {
  const meta = result?.meta;
  return response?.status !== 'ok'
    || response?.summary !== 'completed'
    || meta?.aborted === true
    || meta?.error !== undefined
    || (meta?.stopReason !== undefined && meta.stopReason !== 'stop')
    || result?.payloads?.some((payload) => payload?.isError === true);
}

function terminalFailure(response, result) {
  const stopReason = String(
    result?.meta?.stopReason || response?.stopReason || '',
  ).toLowerCase();
  const timeoutPhase = String(
    result?.meta?.timeoutPhase || response?.timeoutPhase || '',
  ).toLowerCase();
  const providerStarted = result?.meta?.providerStarted
    ?? response?.providerStarted;
  if (providerStarted === true
    || ['provider', 'preflight', 'post_turn'].includes(timeoutPhase)) {
    return runtimeError('codex_openclaw_managed_model_timeout', {
      retryable: true,
    });
  }
  if (response?.status === 'timeout'
    || /abort|cancel|rpc/.test(stopReason)
    || result?.meta?.aborted === true) {
    return runtimeError('codex_openclaw_managed_model_cancelled');
  }
  return runtimeError('codex_openclaw_managed_agent_command_failed', {
    retryable: true,
  });
}

export function parseOpenClawManagedGatewayInvocation(response, options = {}) {
  if (!failureObserved(response, response?.result)) {
    return Object.freeze({
      result: parseOpenClawManagedGatewayResponse(response, options),
      thrown: null,
    });
  }
  const result = response?.result;
  if (!objectRecord(response)
    || response.runId !== options.runId
    || !['ok', 'error', 'timeout'].includes(response.status)
    || !objectRecord(result)
    || !validFailurePayloads(result.payloads)) {
    throw runtimeError('codex_openclaw_managed_agent_command_failed');
  }
  const { meta } = validateExactModelBinding(result, response, {
    ...options,
    allowMissingFailureDiagnostics: true,
  });
  if (meta.executionTrace !== undefined) {
    validateExecutionTrace(meta.executionTrace, options.model, {
      requireSuccess: false,
    });
  }
  return Object.freeze({
    result,
    thrown: terminalFailure(response, result),
  });
}
