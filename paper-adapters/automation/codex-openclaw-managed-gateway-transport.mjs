import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';

const GATEWAY_RPC_CLIENT = 'gateway-client';
const GATEWAY_RPC_MODE = 'backend';
const GATEWAY_RPC_SCOPES = Object.freeze(['operator.admin']);
const GATEWAY_CLEANUP_TIMEOUT_MS = 30_000;
const GATEWAY_WAIT_SLICE_MS = 25_000;
const MANAGED_NO_TOOL_DENYLIST = Object.freeze(['*']);

function objectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function gatewayRpcExtra({ expectFinal = false } = {}) {
  return Object.freeze({
    clientName: GATEWAY_RPC_CLIENT,
    mode: GATEWAY_RPC_MODE,
    scopes: GATEWAY_RPC_SCOPES,
    progress: false,
    expectFinal,
  });
}

async function gatewayRpc(runtime, method, params, {
  timeoutMs,
  expectFinal = false,
} = {}) {
  try {
    return await runtime.callGatewayFromCli(
      method,
      {
        json: true,
        timeout: String(Math.max(1, Math.floor(timeoutMs))),
      },
      params,
      gatewayRpcExtra({ expectFinal }),
    );
  } catch {
    throw runtimeError('codex_openclaw_managed_agent_command_failed');
  }
}

export async function verifyOpenClawManagedGatewayRoute({
  runtime,
  configuration,
  timeoutMs = 10_000,
} = {}) {
  const identity = await gatewayRpc(runtime, 'agent.identity.get', {
    agentId: configuration.agentId,
  }, { timeoutMs });
  if (!objectRecord(identity) || identity.agentId !== configuration.agentId) {
    throw runtimeError('codex_openclaw_managed_login_unavailable');
  }
  return Object.freeze({
    agentId: identity.agentId,
    gatewayAgentRoute: true,
  });
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
    // OpenClaw reports the resident skill catalog even for a raw model run.
    // The actual provider-visible prompt is `systemPrompt`, which must remain
    // empty; the catalog is accepted only as well-formed diagnostic metadata.
    && validDiagnosticSkillCatalog(report.skills)
    && report.tools?.listChars === 0
    && report.tools?.schemaChars === 0
    && sameArray(report.tools?.entries, [])
    && report.currentTurn?.runtimeContextChars === 0
  );
}

export function parseOpenClawManagedGatewayResponse(response, {
  configuration,
  model,
  runId,
  sessionId,
  sessionKey,
  thinking,
} = {}) {
  const result = response?.result;
  const meta = result?.meta;
  const agentMeta = meta?.agentMeta;
  const executionTrace = meta?.executionTrace;
  const attempts = executionTrace?.attempts;
  const payload = result?.payloads?.[0];
  if (!objectRecord(response)
    || response.runId !== runId
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
    || !payload.text.trim()
    || !objectRecord(meta)
    || !objectRecord(agentMeta)) {
    throw runtimeError('codex_openclaw_managed_agent_command_failed');
  }
  if (explicitAuthProfileObserved(response)) {
    throw runtimeError('codex_openclaw_managed_model_resolution_mismatch');
  }
  if (agentMeta.sessionId !== sessionId
    || (agentMeta.sessionKey !== undefined && agentMeta.sessionKey !== sessionKey)
    || (agentMeta.agentId !== undefined
      && agentMeta.agentId !== configuration.agentId)
    || agentMeta.provider !== model.provider
    || agentMeta.model !== model.modelId
    || agentMeta.agentHarnessId !== 'openclaw'
    || meta?.requestShaping?.authMode !== 'auth-profile'
    || meta?.requestShaping?.thinking !== thinking
    || meta.stopReason !== 'stop'
    || meta.aborted !== false
    || meta.error !== undefined
    || meta.completion?.stopReason !== 'stop'
    || meta.completion?.finishReason !== 'stop'
    || !Number.isSafeInteger(agentMeta.usage?.input)
    || agentMeta.usage.input < 0
    || !Number.isSafeInteger(agentMeta.usage?.output)
    || agentMeta.usage.output < 0
    || !Number.isSafeInteger(
      agentMeta.usage?.totalTokens ?? agentMeta.usage?.total,
    )
    || (agentMeta.usage?.totalTokens ?? agentMeta.usage?.total) <= 0) {
    throw runtimeError('codex_openclaw_managed_model_resolution_mismatch');
  }
  if (!Array.isArray(attempts)
    || attempts.length !== 1
    || attempts[0]?.provider !== model.provider
    || attempts[0]?.model !== model.modelId
    || attempts[0]?.result !== 'success'
    || executionTrace.winnerProvider !== model.provider
    || executionTrace.winnerModel !== model.modelId
    || executionTrace.fallbackUsed !== false
    || executionTrace.runner !== 'embedded') {
    throw runtimeError('codex_openclaw_managed_runtime_fallback_observed');
  }
  if (externalActionObserved(result)
    || !isolatedSystemPromptReport(meta.systemPromptReport, {
      model,
      sessionId,
      sessionKey,
    })) {
    throw runtimeError('codex_openclaw_managed_agent_policy_violation');
  }
  return result;
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

function validateGatewaySessionPatch(patched, {
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

function gatewaySessionCas(patched, sessionKey) {
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

function validateAcceptedAgentResponse(response, {
  attemptId,
  configuration,
  sessionKey,
} = {}) {
  if (!objectRecord(response)
    || response.runId !== attemptId
    || response.status !== 'accepted'
    || response.sessionKey !== sessionKey
    || (response.agentId !== undefined
      && response.agentId !== configuration.agentId)) {
    throw runtimeError('codex_openclaw_managed_agent_command_failed');
  }
}

function gatewayTerminalObserved(wait) {
  return Boolean(wait && (
    wait.status === 'ok'
    || wait.status === 'error'
    || (wait.status === 'timeout'
      && (wait.endedAt !== undefined
        || wait.stopReason !== undefined
        || wait.error !== undefined))
  ));
}

function removeExactRegularArtifact(candidate, roots) {
  const resolved = path.resolve(String(candidate || ''));
  if (!roots.some((root) => resolved.startsWith(`${root}${path.sep}`))) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
  if (!fs.existsSync(resolved)) return;
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
  }
  fs.rmSync(resolved, { force: true });
  if (fs.existsSync(resolved)) {
    throw runtimeError(
      'codex_openclaw_managed_session_cleanup_artifact_removal_failed',
    );
  }
}

function exactGatewayArtifacts(runtime, sessionId, runId) {
  const suffixes = [
    '.jsonl',
    '.trajectory.jsonl',
    '.trajectory-path.json',
    '.jsonl.codex-app-server.json',
    '.jsonl.codex-app-server.json.migrated',
  ];
  return [...new Set([sessionId, runId])].flatMap((identity) => (
    [runtime.sessionsDir, runtime.internalRunsDir].flatMap((directory) => (
      suffixes.map((suffix) => path.join(directory, `${identity}${suffix}`))
    ))
  ));
}

function gatewayArtifactResidue(runtime, sessionId, runId) {
  const prefixes = [...new Set([sessionId, runId])].map((entry) => `${entry}.`);
  return [runtime.sessionsDir, runtime.internalRunsDir].flatMap((directory) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
      .map((entry) => path.join(directory, entry));
  });
}

async function abortGatewayRun(runtime, {
  attemptId,
  configuration,
  sessionKey,
} = {}) {
  const response = await gatewayRpc(runtime, 'sessions.abort', {
    key: sessionKey,
    runId: attemptId,
    agentId: configuration.agentId,
  }, { timeoutMs: GATEWAY_CLEANUP_TIMEOUT_MS });
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
  abortSignal,
  deadline,
} = {}) {
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const wait = await gatewayRpc(runtime, 'agent.wait', {
      runId: attemptId,
      timeoutMs: Math.min(GATEWAY_WAIT_SLICE_MS, remaining),
    }, {
      timeoutMs: Math.min(GATEWAY_WAIT_SLICE_MS, remaining) + 5_000,
    });
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
    if (abortSignal?.aborted || Date.now() >= deadline) return wait;
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
  const roots = [
    path.resolve(runtime.sessionsDir),
    path.resolve(runtime.internalRunsDir),
  ];
  let prepared = null;
  let result = null;
  let primaryFailure = null;
  let abortPromise = null;
  let runTerminationVerified = false;
  let dispatchAttempted = false;
  const abort = () => {
    if (prepared && dispatchAttempted && !abortPromise) {
      abortPromise = abortGatewayRun(runtime, {
        attemptId,
        configuration,
        sessionKey,
      }).then(
        (response) => Object.freeze({ ok: true, response, error: null }),
        (error) => Object.freeze({ ok: false, response: null, error }),
      );
    }
  };
  abortSignal?.addEventListener('abort', abort, { once: true });
  try {
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
      timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
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
    dispatchAttempted = true;
    const accepted = await gatewayRpc(
      runtime,
      'agent',
      agentParams,
      { timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    validateAcceptedAgentResponse(accepted, {
      attemptId,
      configuration,
      sessionKey,
    });
    if (abortSignal?.aborted) abort();
    let terminal = await awaitGatewayTerminal(runtime, {
      attemptId,
      abortSignal,
      deadline: abortSignal?.aborted
        ? Date.now() + GATEWAY_CLEANUP_TIMEOUT_MS : deadline,
    });
    runTerminationVerified = gatewayTerminalObserved(terminal);
    if (abortSignal?.aborted || Date.now() >= deadline) {
      abort();
      const abortOutcome = await abortPromise;
      terminal = await awaitGatewayTerminal(runtime, {
        attemptId,
        abortSignal: null,
        deadline: Date.now() + GATEWAY_CLEANUP_TIMEOUT_MS,
      });
      runTerminationVerified = gatewayTerminalObserved(terminal);
      if (!abortOutcome.ok && !runTerminationVerified) {
        throw abortOutcome.error;
      }
    }
    const terminalResponse = await gatewayRpc(
      runtime,
      'agent',
      agentParams,
      { timeoutMs: GATEWAY_CLEANUP_TIMEOUT_MS },
    );
    if (terminalResponse?.status === 'accepted'
      || terminalResponse?.status === 'in_flight'
      || terminal?.status === 'timeout') {
      throw runtimeError('codex_openclaw_managed_agent_command_failed');
    }
    result = parseOpenClawManagedGatewayResponse(terminalResponse, {
      configuration,
      model,
      runId: attemptId,
      sessionId: prepared.sessionId,
      sessionKey,
      thinking,
    });
    runTerminationVerified = true;
  } catch (error) {
    primaryFailure = error;
  } finally {
    abortSignal?.removeEventListener('abort', abort);
  }

  if (primaryFailure && dispatchAttempted) {
    try {
      abort();
      const abortOutcome = abortPromise ? await abortPromise : null;
      const terminal = await awaitGatewayTerminal(runtime, {
        attemptId,
        abortSignal: null,
        deadline: Date.now() + GATEWAY_CLEANUP_TIMEOUT_MS,
      });
      runTerminationVerified = gatewayTerminalObserved(terminal);
      if (abortOutcome && !abortOutcome.ok && !runTerminationVerified) {
        throw abortOutcome.error;
      }
    } catch (error) {
      primaryFailure = error;
    }
  }

  let cleanupFailure = null;
  let sessionEntryRemoved = false;
  let artifactsRemoved = false;
  let attemptWorkspaceRemoved = false;
  if (!prepared) {
    try {
      const described = await gatewayRpc(runtime, 'sessions.describe', {
        key: sessionKey,
      }, { timeoutMs: GATEWAY_CLEANUP_TIMEOUT_MS });
      if (objectRecord(described?.session)
        && typeof described.session.sessionId === 'string'
        && described.session.sessionId.trim()) {
        prepared = Object.freeze({
          sessionId: described.session.sessionId,
          lifecycleRevision: null,
          updatedAt: null,
          bindingHash: null,
        });
      }
    } catch { /* the primary failure remains authoritative */ }
  }
  if (prepared) {
    try {
      if (dispatchAttempted && !runTerminationVerified) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_entry_delete_failed',
        );
      }
      const latestPatch = await gatewayRpc(runtime, 'sessions.patch', {
        key: sessionKey,
        agentId: configuration.agentId,
      }, { timeoutMs: GATEWAY_CLEANUP_TIMEOUT_MS });
      const latest = gatewaySessionCas(latestPatch, sessionKey);
      if (!latest) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_entry_inspection_failed',
        );
      }
      if (latest.sessionId !== prepared.sessionId
        || (prepared.bindingHash !== null
          && validateGatewaySessionPatch(latestPatch, {
            model,
            sessionKey,
            thinking,
          }).bindingHash !== prepared.bindingHash)) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_entry_binding_changed',
        );
      }
      prepared = Object.freeze({
        ...latest,
        bindingHash: prepared.bindingHash,
      });
      const deleted = await gatewayRpc(runtime, 'sessions.delete', {
        key: sessionKey,
        agentId: configuration.agentId,
        deleteTranscript: true,
        expectedSessionId: prepared.sessionId,
        ...(prepared.lifecycleRevision ? {
          expectedLifecycleRevision: prepared.lifecycleRevision,
        } : {}),
        expectedSessionUpdatedAt: prepared.updatedAt,
        emitLifecycleHooks: false,
      }, { timeoutMs: GATEWAY_CLEANUP_TIMEOUT_MS });
      if (deleted?.ok !== true
        || deleted.key !== sessionKey
        || deleted.deleted !== true
        || !Array.isArray(deleted.archived)) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_entry_delete_failed',
        );
      }
      sessionEntryRemoved = true;
      for (const archived of deleted.archived) {
        removeExactRegularArtifact(archived, roots);
      }
      for (const artifact of exactGatewayArtifacts(
        runtime,
        prepared.sessionId,
        attemptId,
      )) removeExactRegularArtifact(artifact, roots);
      if (gatewayArtifactResidue(
        runtime,
        prepared.sessionId,
        attemptId,
      ).length !== 0) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
        );
      }
      artifactsRemoved = true;
      const described = await gatewayRpc(runtime, 'sessions.describe', {
        key: sessionKey,
      }, { timeoutMs: GATEWAY_CLEANUP_TIMEOUT_MS });
      if (!objectRecord(described) || described.session !== null) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_entry_remained',
        );
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    fs.rmSync(attemptWorkspace, { recursive: true, force: true });
    if (fs.existsSync(attemptWorkspace)) throw new Error('workspace remained');
    attemptWorkspaceRemoved = true;
  } catch {
    cleanupFailure ||= runtimeError(
      'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed',
    );
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
  if (primaryFailure) throw primaryFailure;
  const sessionCleanup = Object.freeze({
    sessionEntryRemoved,
    artifactsRemoved,
    attemptWorkspaceRemoved,
  });
  return Object.freeze({
    result,
    thrown: null,
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
