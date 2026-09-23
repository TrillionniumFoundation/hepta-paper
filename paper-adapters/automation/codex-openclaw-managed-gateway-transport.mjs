import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  GATEWAY_ABORT_WINDOW_MS,
  GATEWAY_ARTIFACT_QUIET_WINDOW_MS,
  GATEWAY_SESSION_DELETE_WINDOW_MS,
  GATEWAY_TERMINAL_WAIT_WINDOW_MS,
  GATEWAY_RECONCILIATION_INITIAL_DELAY_MS,
  GATEWAY_RECONCILIATION_MAXIMUM_DELAY_MS,
  GATEWAY_RPC_ATTEMPT_TIMEOUT_MS,
  assertGatewayArtifactNamespacesEmpty,
  assertGatewayArtifactNamespacesQuiet,
  closeGatewayArtifactScope,
  closeGatewayAttemptWorkspace,
  openGatewayArtifactScope,
  openGatewayAttemptWorkspace,
  removeGatewayAttemptWorkspace,
  removeGatewaySessionArtifacts,
  retryableGatewayFailure,
  retryGatewayTransport,
  validateGatewayCleanupDescription,
  waitForGatewayReconciliation,
} from './codex-openclaw-managed-gateway-reconciliation.mjs';
import {
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';
import {
  isKnownOpenClawManagedCleanupFailureCode,
} from './codex-openclaw-managed-failure-code.mjs';
import {
  parseOpenClawManagedGatewayInvocation,
  parseOpenClawManagedGatewayResponse,
} from './codex-openclaw-managed-gateway-response.mjs';
import {
  agentTerminalResponseObserved,
  completeGatewayTerminalEvidence,
  gatewayAgentTimeoutBudget,
  gatewaySessionCas,
  gatewayTerminalObserved,
  openGatewayDispatchDeadline,
  validateGatewaySessionPatch,
} from './codex-openclaw-managed-gateway-session.mjs';

export { parseOpenClawManagedGatewayResponse };
export { gatewayAgentTimeoutBudget };

const GATEWAY_RPC_CLIENT = 'gateway-client';
const GATEWAY_RPC_MODE = 'backend';
const GATEWAY_RPC_SCOPES = Object.freeze(['operator.admin']);
const GATEWAY_WAIT_SLICE_MS = 25_000;
const MANAGED_NO_TOOL_DENYLIST = Object.freeze(['*']);
const SAFE_GATEWAY_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SESSION_CHANGED_REASON = 'session-changed';

function objectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function gatewayRpcExtra({ expectFinal = false, signal = null } = {}) {
  return Object.freeze({
    clientName: GATEWAY_RPC_CLIENT,
    mode: GATEWAY_RPC_MODE,
    scopes: GATEWAY_RPC_SCOPES,
    progress: false,
    expectFinal,
    ...(signal ? { signal } : {}),
  });
}

function safeGatewayFailure(error, signal) {
  const signalAborted = signal?.aborted === true;
  if (error?.name === 'AbortError') {
    return Object.freeze({
      kind: 'abort', code: null, reason: null, retryable: false,
      retryAfterMs: null,
    });
  }
  if (error?.name === 'GatewayTransportError'
    && ['closed', 'timeout'].includes(error?.kind)
    && objectRecord(error?.connectionDetails)) {
    return Object.freeze({
      kind: 'transport', code: null, reason: null, retryable: true,
      retryAfterMs: null,
    });
  }
  if (error?.name === 'GatewayClientRequestError') {
    const code = SAFE_GATEWAY_CODE.test(String(error?.gatewayCode || ''))
      ? String(error.gatewayCode) : null;
    const retryAfterMs = Number(error?.retryAfterMs);
    return Object.freeze({
      kind: 'server',
      code,
      reason: error?.details?.reason === SESSION_CHANGED_REASON
        ? SESSION_CHANGED_REASON : null,
      retryable: error?.retryable === true,
      retryAfterMs: Number.isSafeInteger(retryAfterMs)
        && retryAfterMs > 0 && retryAfterMs <= 60_000
        ? retryAfterMs : null,
    });
  }
  if (signalAborted) {
    return Object.freeze({
      kind: 'abort', code: null, reason: null, retryable: false,
      retryAfterMs: null,
    });
  }
  return Object.freeze({
    kind: 'unknown', code: null, reason: null, retryable: false,
    retryAfterMs: null,
  });
}

function projectedGatewayError(error, signal) {
  const failure = safeGatewayFailure(error, signal);
  const code = failure.kind === 'abort'
    ? 'codex_openclaw_managed_model_cancelled'
    : 'codex_openclaw_managed_agent_command_failed';
  const projected = runtimeError(code, { retryable: false });
  Object.defineProperty(projected, 'gatewayFailure', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: failure,
  });
  return projected;
}

async function gatewayRpc(runtime, method, params, {
  dispatchDeadline = null,
  timeoutMs,
  expectFinal = false,
  onDispatch = null,
  signal = null,
} = {}) {
  let selectedParams = params;
  let selectedTimeoutMs = timeoutMs;
  let dispatchScope = null;
  if (signal?.aborted) {
    throw projectedGatewayError(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      signal,
    );
  }
  if (dispatchDeadline !== null) {
    if (method !== 'agent') {
      throw runtimeError('codex_openclaw_managed_agent_command_failed');
    }
    const finalBudget = gatewayAgentTimeoutBudget(
      Number(dispatchDeadline) - Date.now(),
    );
    selectedParams = Object.freeze({
      ...params,
      timeout: finalBudget.serverTimeoutSeconds,
    });
    selectedTimeoutMs = finalBudget.clientTimeoutMs;
    dispatchScope = openGatewayDispatchDeadline(signal, dispatchDeadline);
  }
  const selectedSignal = dispatchScope?.signal || signal;
  if (typeof onDispatch === 'function') onDispatch();
  try {
    let response;
    try {
      response = await runtime.callGatewayFromCli(
        method,
        { json: true, timeout: String(Math.floor(selectedTimeoutMs)) },
        selectedParams,
        gatewayRpcExtra({ expectFinal, signal: selectedSignal }),
      );
    } catch (error) {
      if (dispatchScope?.deadlineExpired()) {
        throw runtimeError('codex_openclaw_managed_model_timeout');
      }
      throw projectedGatewayError(error, selectedSignal);
    }
    if (dispatchScope?.deadlineExpired()) {
      throw runtimeError('codex_openclaw_managed_model_timeout');
    }
    return response;
  } finally {
    dispatchScope?.close();
  }
}

function gatewayAgentOAuthBindingAvailable(runtime) {
  let store;
  try {
    store = runtime.ensureAuthProfileStore(runtime.agentDir, {
      allowKeychainPrompt: false,
      config: runtime.cfg,
      readOnly: true,
      syncExternalCli: false,
    });
  } catch {
    return false;
  }
  return Object.values(store?.profiles || {}).some((credential) => (
    credential?.provider === 'openai'
    && credential?.type === 'oauth'
    && ['refresh', 'access', 'token'].some((field) => (
      typeof credential?.[field] === 'string'
      && credential[field].length > 0
    ))
  ));
}

export async function verifyOpenClawManagedGatewayRoute({
  runtime,
  configuration,
  timeoutMs = 10_000,
} = {}) {
  if (!gatewayAgentOAuthBindingAvailable(runtime)) {
    throw runtimeError(
      'codex_openclaw_managed_login_unavailable',
      { retryable: true },
    );
  }
  let identity;
  try {
    identity = await gatewayRpc(runtime, 'agent.identity.get', {
      agentId: configuration.agentId,
    }, { timeoutMs });
  } catch {
    throw runtimeError(
      'codex_openclaw_managed_login_unavailable',
      { retryable: true },
    );
  }
  if (!objectRecord(identity) || identity.agentId !== configuration.agentId) {
    throw runtimeError('codex_openclaw_managed_login_unavailable');
  }
  return Object.freeze({
    agentId: identity.agentId,
    gatewayAgentRoute: true,
  });
}

async function abortGatewayRun(runtime, {
  attemptId,
  configuration,
  sessionKey,
  timeoutMs,
} = {}) {
  const response = await gatewayRpc(runtime, 'sessions.abort', {
    key: sessionKey,
    runId: attemptId,
    agentId: configuration.agentId,
  }, { timeoutMs });
  if (response?.ok !== true
    || !['aborted', 'no-active-run'].includes(response.status)
    || (response.abortedRunId !== null
      && response.abortedRunId !== attemptId)) {
    throw runtimeError('codex_openclaw_managed_agent_command_failed');
  }
  return response;
}

async function awaitGatewayTerminal(runtime, {
  attemptId,
  deadline,
} = {}) {
  for (;;) {
    const wait = await retryGatewayTransport(async (remainingMs) => {
      const waitTimeoutMs = Math.min(GATEWAY_WAIT_SLICE_MS, remainingMs);
      return await gatewayRpc(runtime, 'agent.wait', {
        runId: attemptId,
        timeoutMs: waitTimeoutMs,
      }, {
        timeoutMs: Math.min(
          GATEWAY_RPC_ATTEMPT_TIMEOUT_MS,
          remainingMs,
          waitTimeoutMs + 5_000,
        ),
      });
    }, { allowUnavailable: true, deadline });
    if (wait?.runId !== attemptId) {
      throw runtimeError('codex_openclaw_managed_agent_command_failed');
    }
    if (!['ok', 'error', 'timeout'].includes(wait.status)) {
      throw runtimeError('codex_openclaw_managed_agent_command_failed');
    }
    const pollingTimeout = wait.status === 'timeout'
      && wait.endedAt === undefined
      && wait.stopReason === undefined
      && wait.error === undefined;
    if (!pollingTimeout) return wait;
    if (Date.now() >= deadline) return wait;
  }
}

async function settleGatewayRunForCleanup(runtime, {
  attemptId,
  configuration,
  sessionKey,
} = {}) {
  const abortDeadline = Date.now() + GATEWAY_ABORT_WINDOW_MS;
  const terminalDeadline = Date.now() + GATEWAY_TERMINAL_WAIT_WINDOW_MS;
  const [abortOutcome, terminalOutcome] = await Promise.allSettled([
    retryGatewayTransport(
      async (remainingMs) => await abortGatewayRun(runtime, {
        attemptId,
        configuration,
        sessionKey,
        timeoutMs: Math.min(GATEWAY_RPC_ATTEMPT_TIMEOUT_MS, remainingMs),
      }),
      { allowUnavailable: true, deadline: abortDeadline },
    ),
    awaitGatewayTerminal(runtime, {
      attemptId,
      deadline: terminalDeadline,
    }),
  ]);
  return Object.freeze({
    abortVerified: abortOutcome.status === 'fulfilled',
    terminalVerified: terminalOutcome.status === 'fulfilled'
      && gatewayTerminalObserved(terminalOutcome.value),
  });
}

async function deleteGatewaySessionBarrier(runtime, {
  configuration,
  deadline,
  prepared: initialPrepared,
  sessionKey,
} = {}) {
  if (!initialPrepared) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_entry_inspection_failed',
    );
  }
  let prepared = initialPrepared;
  let delayMs = GATEWAY_RECONCILIATION_INITIAL_DELAY_MS;
  let deletionAttempted = false;
  for (;;) {
    const described = await retryGatewayTransport(
      async (remainingMs) => await gatewayRpc(
        runtime,
        'sessions.describe',
        { key: sessionKey },
        {
          timeoutMs: Math.min(
            GATEWAY_RPC_ATTEMPT_TIMEOUT_MS,
            remainingMs,
          ),
        },
      ),
      { allowUnavailable: true, deadline },
    );
    const description = validateGatewayCleanupDescription(described, {
      prepared,
      sessionKey,
    });
    if (!description) {
      if (deletionAttempted) return Object.freeze({ prepared });
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_entry_disappeared_during_delete',
      );
    }
    const deletionCas = Object.freeze({
      ...prepared,
      updatedAt: description.updatedAt,
    });
    prepared = deletionCas;
    let deleted;
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      deletionAttempted = true;
      deleted = await gatewayRpc(runtime, 'sessions.delete', {
        key: sessionKey,
        agentId: configuration.agentId,
        deleteTranscript: false,
        expectedSessionId: deletionCas.sessionId,
        expectedSessionUpdatedAt: deletionCas.updatedAt,
        emitLifecycleHooks: false,
      }, {
        timeoutMs: Math.min(
          GATEWAY_RPC_ATTEMPT_TIMEOUT_MS,
          remainingMs,
        ),
      });
    } catch (error) {
      const sessionChanged = error?.gatewayFailure?.kind === 'server'
        && error.gatewayFailure.reason === SESSION_CHANGED_REASON;
      if ((!sessionChanged
          && !retryableGatewayFailure(error, { allowUnavailable: true }))
        || Date.now() >= deadline) throw error;
      await waitForGatewayReconciliation({ deadline, delayMs });
      delayMs = Math.min(
        GATEWAY_RECONCILIATION_MAXIMUM_DELAY_MS,
        delayMs * 2,
      );
      continue;
    }
    if (deleted?.ok === true
      && deleted.key === sessionKey
      && deleted.deleted === true
      && Array.isArray(deleted.archived)
      && deleted.archived.length === 0) {
      return Object.freeze({ prepared });
    }
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_entry_delete_failed',
    );
  }
}

async function fenceUnknownGatewayPatch(runtime, {
  configuration,
  deadline,
  sessionKey,
} = {}) {
  const deleted = await retryGatewayTransport(
    async (remainingMs) => await gatewayRpc(
      runtime,
      'sessions.delete',
      {
        key: sessionKey,
        agentId: configuration.agentId,
        deleteTranscript: false,
        emitLifecycleHooks: false,
      },
      {
        timeoutMs: Math.min(
          GATEWAY_RPC_ATTEMPT_TIMEOUT_MS,
          remainingMs,
        ),
      },
    ),
    { allowUnavailable: true, deadline },
  );
  if (deleted?.ok !== true
    || deleted.key !== sessionKey
    || typeof deleted.deleted !== 'boolean'
    || !Array.isArray(deleted.archived)
    || deleted.archived.length !== 0) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_entry_delete_failed',
    );
  }
  for (let inspection = 0; inspection < 2; inspection += 1) {
    const described = await retryGatewayTransport(
      async (remainingMs) => await gatewayRpc(
        runtime,
        'sessions.describe',
        { key: sessionKey },
        {
          timeoutMs: Math.min(
            GATEWAY_RPC_ATTEMPT_TIMEOUT_MS,
            remainingMs,
          ),
        },
      ),
      { allowUnavailable: true, deadline },
    );
    if (!objectRecord(described) || described.session !== null) {
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_entry_remained',
      );
    }
    if (inspection === 0) {
      await waitForGatewayReconciliation({
        deadline,
        delayMs: GATEWAY_ARTIFACT_QUIET_WINDOW_MS,
      });
    }
  }
}

export async function runOpenClawManagedGatewayOneShot({
  runtime,
  configuration,
  model,
  prompt,
  thinking,
  attemptId,
  sessionKey,
  attemptWorkspace,
  abortSignal,
  timeoutMs,
} = {}) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let prepared = null;
  let result = null;
  let primaryFailure = null;
  let artifactScope = null;
  let attemptWorkspaceScope = null;
  let artifactNamespaceReady = false;
  let patchAttempted = false;
  let dispatchAttempted = false;
  let terminalResponseObserved = false;
  let terminalEvidenceComplete = false;
  let dispatchOutcomeUncertain = false;
  try {
    attemptWorkspaceScope = openGatewayAttemptWorkspace(attemptWorkspace);
    artifactScope = openGatewayArtifactScope(runtime, {
      agentId: configuration.agentId,
      openclawStateDir: configuration.openclawStateDir,
    });
    assertGatewayArtifactNamespacesEmpty(artifactScope, [attemptId]);
    const existing = await gatewayRpc(runtime, 'sessions.describe', {
      key: sessionKey,
    }, { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (!objectRecord(existing) || existing.session !== null) {
      throw runtimeError('codex_openclaw_managed_session_binding_failed');
    }
    patchAttempted = true;
    const patched = await gatewayRpc(runtime, 'sessions.patch', {
      key: sessionKey,
      agentId: configuration.agentId,
      thinkingLevel: thinking,
      inheritedToolDeny: MANAGED_NO_TOOL_DENYLIST,
      execSecurity: 'deny',
      elevatedLevel: 'off',
      subagentRole: 'leaf',
      subagentControlScope: 'none',
      sendPolicy: 'deny',
    }, { timeoutMs: Math.max(1, deadline - Date.now()) });
    prepared = gatewaySessionCas(patched, sessionKey);
    if (prepared) {
      assertGatewayArtifactNamespacesEmpty(
        artifactScope,
        [attemptId, prepared.sessionId],
      );
      artifactNamespaceReady = true;
    }
    prepared = validateGatewaySessionPatch(patched, {
      model,
      sessionKey,
      thinking,
    });
    if (abortSignal?.aborted) {
      throw runtimeError('codex_openclaw_managed_model_cancelled');
    }
    const agentParams = Object.freeze({
      message: prompt,
      agentId: configuration.agentId,
      sessionId: prepared.sessionId,
      sessionKey,
      thinking,
      deliver: false,
      lane: `hepta-paper-managed:${attemptId}`,
      cleanupBundleMcpOnRunEnd: true,
      modelRun: true,
      promptMode: 'none',
      bootstrapContextMode: 'lightweight',
      suppressPromptPersistence: true,
      sessionEffects: 'internal',
      sourceReplyDeliveryMode: 'message_tool_only',
      disableMessageTool: true,
      idempotencyKey: attemptId,
    });
    let terminalResponse;
    try {
      terminalResponse = await gatewayRpc(
        runtime,
        'agent',
        agentParams,
        {
          dispatchDeadline: deadline,
          expectFinal: true,
          onDispatch() { dispatchAttempted = true; },
          signal: abortSignal,
        },
      );
    } catch (error) {
      // Once the side-effecting RPC has been entered, an exception never
      // proves that the provider was not invoked. agent.wait can prove only
      // that the run ended; it cannot recover the final result or usage.
      if (dispatchAttempted) dispatchOutcomeUncertain = true;
      throw error;
    }
    terminalResponseObserved = agentTerminalResponseObserved(
      terminalResponse,
      attemptId,
    );
    if (!terminalResponseObserved) {
      dispatchOutcomeUncertain = true;
      throw runtimeError('codex_openclaw_managed_agent_command_failed');
    }
    terminalEvidenceComplete = completeGatewayTerminalEvidence(
      terminalResponse,
      {
        attemptId,
        configuration,
        model,
        sessionId: prepared.sessionId,
        sessionKey,
      },
    );
    result = terminalResponse.result;
    let invocation;
    try {
      invocation = parseOpenClawManagedGatewayInvocation(
        terminalResponse,
        {
          configuration,
          model,
          runId: attemptId,
          sessionId: prepared.sessionId,
          sessionKey,
          thinking,
        },
      );
    } catch (error) {
      if (error && typeof error === 'object') {
        Object.defineProperty(
          error,
          'managedGatewayTerminalValidationFailure',
          { enumerable: false, value: true },
        );
      }
      throw error;
    }
    result = invocation.result;
    if (invocation.thrown) throw invocation.thrown;
  } catch (error) {
    primaryFailure = error;
  }

  if (primaryFailure && dispatchAttempted && !terminalResponseObserved) {
    dispatchOutcomeUncertain = true;
    await settleGatewayRunForCleanup(runtime, {
      attemptId,
      configuration,
      sessionKey,
    });
  }

  let cleanupFailure = null;
  let patchEntryAbsenceVerified = false;
  if (patchAttempted && !prepared && !dispatchAttempted) {
    try {
      await fenceUnknownGatewayPatch(runtime, {
        configuration,
        deadline: Date.now() + GATEWAY_SESSION_DELETE_WINDOW_MS,
        sessionKey,
      });
      assertGatewayArtifactNamespacesEmpty(artifactScope, [attemptId]);
      patchEntryAbsenceVerified = true;
    } catch {
      cleanupFailure = runtimeError(
        'codex_openclaw_managed_session_cleanup_entry_inspection_failed',
      );
    }
  }
  let sessionEntryRemoved = !patchAttempted || patchEntryAbsenceVerified;
  let artifactsRemoved = !dispatchAttempted;
  let attemptWorkspaceRemoved = false;
  const preserveUncertainDispatch = dispatchOutcomeUncertain
    || (dispatchAttempted && !terminalEvidenceComplete);
  if (!cleanupFailure && !preserveUncertainDispatch && prepared) {
    try {
      const deletion = await deleteGatewaySessionBarrier(runtime, {
        configuration,
        deadline: Date.now() + GATEWAY_SESSION_DELETE_WINDOW_MS,
        prepared,
        sessionKey,
      });
      prepared = deletion.prepared || prepared;
      sessionEntryRemoved = true;
      if (!artifactNamespaceReady) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
        );
      }
      removeGatewaySessionArtifacts(
        artifactScope,
        [attemptId, prepared.sessionId],
      );
      await assertGatewayArtifactNamespacesQuiet(
        artifactScope,
        [attemptId, prepared.sessionId],
      );
      artifactsRemoved = true;
    } catch (error) {
      cleanupFailure = isKnownOpenClawManagedCleanupFailureCode(error?.code)
        ? error
        : runtimeError(
          'codex_openclaw_managed_session_cleanup_entry_delete_failed',
        );
    }
  } else if (!cleanupFailure
    && patchAttempted
    && !prepared
    && !patchEntryAbsenceVerified
    && !preserveUncertainDispatch) {
    cleanupFailure = runtimeError(
      'codex_openclaw_managed_session_cleanup_entry_inspection_failed',
    );
  }
  try {
    removeGatewayAttemptWorkspace(attemptWorkspaceScope);
    attemptWorkspaceRemoved = true;
  } catch {
    cleanupFailure ||= runtimeError(
      'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed',
    );
  } finally {
    try {
      closeGatewayAttemptWorkspace(attemptWorkspaceScope);
    } catch {
      cleanupFailure ||= runtimeError(
        'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed',
      );
    }
    try {
      closeGatewayArtifactScope(artifactScope);
    } catch {
      cleanupFailure ||= runtimeError(
        'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
      );
    }
  }
  if (cleanupFailure) {
    if (result) {
      cleanupFailure.managedInvocationFailure = Object.freeze({
        result,
        thrown: primaryFailure,
        sessionBindingBeforeHash: prepared?.bindingHash || null,
      });
    }
    throw cleanupFailure;
  }
  if (primaryFailure && !result) throw primaryFailure;
  const sessionCleanup = Object.freeze({
    sessionEntryRemoved,
    artifactsRemoved,
    attemptWorkspaceRemoved,
  });
  return Object.freeze({
    result,
    thrown: primaryFailure,
    sessionBindingBeforeHash: prepared.bindingHash,
    sessionBindingAfterHash: prepared.bindingHash,
    sessionCleanup,
    sessionCleanupHash: hashRecord(
      'OpenClawManagedCodexAppServerSessionCleanup',
      sessionCleanup,
    ),
    cleanupVerified: Object.values(sessionCleanup).every(Boolean),
    gatewayAgentRoute: true,
  });
}
