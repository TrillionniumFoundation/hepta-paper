import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  parseOpenClawManagedGatewayResponse,
} from '../../paper-adapters/automation/codex-openclaw-managed-gateway-transport.mjs';
import {
  executeCodexOpenClawManaged,
  provisionCodexOpenClawManagedHome,
  readCodexOpenClawManagedConfiguration,
  verifyCodexOpenClawManagedLogin,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  AUTH_PROFILE_ID,
  assertManagedRuntimeClean,
  fixture,
  injectedModelRuntime,
} from './support/codex-openclaw-managed-runtime-fixture.mjs';

const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';
const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_KEY = `agent:hepta-paper-worker:subagent:hepta-managed-one-shot-${ATTEMPT_ID}`;

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected promise to reject');
}

function gatewayTemporaryWorkspaces() {
  return new Set(fs.readdirSync('/tmp').filter(
    (entry) => entry.startsWith('hepta-managed-gateway-rpc-'),
  ));
}

function gatewayResponse({
  runId = ATTEMPT_ID,
  sessionId = SESSION_ID,
  sessionKey = SESSION_KEY,
  model = 'gpt-5.6-sol',
  thinking = 'high',
} = {}) {
  return {
    runId,
    status: 'ok',
    summary: 'completed',
    result: {
      payloads: [{
        text: 'HEPTA_CODEX_CANARY_RESPONSE:42',
        mediaUrl: null,
      }],
      meta: {
        stopReason: 'stop',
        aborted: false,
        agentMeta: {
          sessionId,
          provider: 'openai',
          model,
          agentHarnessId: 'openclaw',
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
          },
        },
        requestShaping: { authMode: 'auth-profile', thinking },
        completion: { stopReason: 'stop', finishReason: 'stop' },
        executionTrace: {
          winnerProvider: 'openai',
          winnerModel: model,
          fallbackUsed: false,
          runner: 'embedded',
          attempts: [{
            provider: 'openai',
            model,
            result: 'success',
            stage: 'assistant',
          }],
        },
        systemPromptReport: {
          source: 'run',
          generatedAt: 1,
          sessionId,
          sessionKey,
          provider: 'openai',
          model,
          systemPrompt: {
            chars: 0,
            projectContextChars: 0,
            nonProjectContextChars: 0,
          },
          currentTurn: { promptChars: 10, runtimeContextChars: 0 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
        toolSummary: { calls: 0 },
        pendingToolCalls: [],
      },
      didSendViaMessagingTool: false,
      didDeliverSourceReplyViaMessageTool: false,
      didSendDeterministicApprovalPrompt: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSourceReplyPayloads: [],
      acceptedSessionSpawns: [],
      successfulCronAdds: 0,
    },
  };
}

function configureGatewayFixture(value) {
  provisionCodexOpenClawManagedHome({
    home: value.home,
    agentId: 'hepta-paper-worker',
    authProfileId: AUTH_PROFILE_ID,
    model: 'gpt-5.6-sol',
    openclawBinary: path.join(value.root, 'openclaw'),
    openclawConfigPath: value.openclawConfigPath,
    openclawStateDir: value.openclawStateDir,
    principalRole: 'research-author',
    thinking: 'adaptive',
    gatewayTransport: true,
    force: true,
  });
}

function gatewayTransportError(message = 'fixture transport secret') {
  const error = new Error(message);
  error.name = 'GatewayTransportError';
  error.kind = 'closed';
  error.connectionDetails = { phase: 'fixture' };
  return error;
}

function gatewayServerError(gatewayCode, {
  reason = null,
  retryable = false,
} = {}) {
  const error = new Error('fixture server secret');
  error.name = 'GatewayClientRequestError';
  error.gatewayCode = gatewayCode;
  error.retryable = retryable;
  error.retryAfterMs = retryable ? 1 : null;
  error.details = reason ? { reason, hidden: 'fixture secret' } : {};
  return error;
}

function gatewayAbortError() {
  const error = new Error('fixture abort');
  error.name = 'AbortError';
  return error;
}

function gatewayRuntime(value, {
  mutateFinal = null,
  invalidInitialPatch = false,
  onInitialPatch = null,
  omitLifecycleRevision = false,
  failAbortCount = 0,
  waitDelayMs = 0,
  waitFailure = null,
  waitStatus = 'ok',
  onAgentDispatch = null,
  agentFailure = null,
  agentGatewayDelayMs = 0,
  omitGatewayOAuth = false,
  patchFailure = null,
  patchDelayMs = 0,
  deleteFailuresBeforeSuccess = 0,
  deleteFailureKind = 'transport',
  deleteResponseLost = false,
  deletePermanentFailure = false,
  driftAfterDeleteFailure = false,
  updateAfterDeleteFailure = false,
  disappearBeforeDelete = false,
  onDelete = null,
  afterDelete = null,
} = {}) {
  const calls = [];
  let entry = null;
  let key = null;
  let revision = 0;
  let dispatched = false;
  let abortFailuresRemaining = failAbortCount;
  let deletionFailuresRemaining = deleteFailuresBeforeSuccess;
  let deleteAttempt = 0;
  let pendingPatchEntry = null;
  const loader = injectedModelRuntime(async () => {
    throw new Error('embedded model command must not run');
  }, {
    gatewayRpc: async ({
      method,
      options,
      params,
      extra,
      sessionStore,
      persistSessionStore,
      sessionsDir,
      internalRunsDir,
    }) => {
      calls.push({ method, options, params, extra });
      assert.equal(options.json, true);
      assert.equal(typeof options.timeout, 'string');
      assert.equal(extra.clientName, 'gateway-client');
      assert.equal(extra.mode, 'backend');
      assert.deepEqual(extra.scopes, ['operator.admin']);
      assert.equal(extra.progress, false);
      if (method === 'agent.identity.get') {
        assert.equal(extra.expectFinal, false);
        return { agentId: params.agentId, name: 'Fixture Agent' };
      }
      if (method === 'sessions.patch') {
        assert.equal(extra.expectFinal, false);
        key = params.key;
        if (patchFailure === 'before') throw gatewayTransportError();
        revision += 1;
        const nextEntry = {
          ...(entry || {}),
          sessionId: SESSION_ID,
          ...(!omitLifecycleRevision ? {
            lifecycleRevision: `revision-${revision}`,
          } : {}),
          updatedAt: revision,
          ...(Object.hasOwn(params, 'thinkingLevel') ? {
            thinkingLevel: params.thinkingLevel,
            inheritedToolDeny: params.inheritedToolDeny,
            execSecurity: params.execSecurity,
            elevatedLevel: params.elevatedLevel,
            subagentRole: params.subagentRole,
            subagentControlScope: params.subagentControlScope,
            sendPolicy: params.sendPolicy,
            ...(invalidInitialPatch ? {
              inheritedToolAllow: ['unexpected'],
            } : {}),
          } : {}),
        };
        if (patchFailure === 'delayed') {
          pendingPatchEntry = nextEntry;
          throw gatewayTransportError();
        }
        entry = nextEntry;
        sessionStore[key] = { ...entry };
        persistSessionStore();
        if (Object.hasOwn(params, 'thinkingLevel') && onInitialPatch) {
          onInitialPatch();
        }
        if (patchDelayMs > 0) {
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)), 0, 0, patchDelayMs,
          );
        }
        if (patchFailure === 'after') throw gatewayTransportError();
        return {
          ok: true,
          key,
          entry: { ...entry },
          resolved: {
            modelProvider: 'openai',
            model: 'gpt-5.6-sol',
            // sessions.patch reports configured session-runtime metadata.
            // Raw modelRun turns below independently request the OpenClaw
            // harness and prove it in the terminal agent response.
            agentRuntime: { id: 'codex', source: 'model' },
          },
        };
      }
      if (method === 'agent') {
        assert.equal(extra.expectFinal, true);
        assert.ok(extra.signal instanceof AbortSignal);
        assert.equal(params.sessionId, SESSION_ID);
        assert.equal(params.sessionKey, key);
        assert.equal(params.idempotencyKey, params.lane.split(':').at(-1));
        assert.equal(Object.hasOwn(params, 'provider'), false);
        assert.equal(Object.hasOwn(params, 'model'), false);
        assert.equal(params.promptMode, 'none');
        assert.equal(params.bootstrapContextMode, 'lightweight');
        assert.equal(params.suppressPromptPersistence, true);
        assert.equal(params.sessionEffects, 'internal');
        assert.equal(params.sourceReplyDeliveryMode, 'message_tool_only');
        assert.equal(params.disableMessageTool, true);
        assert.equal(params.modelRun, true);
        assert.equal(params.deliver, false);
        if (agentGatewayDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, agentGatewayDelayMs));
        }
        if (extra.signal.aborted) throw gatewayAbortError();
        if (dispatched) {
          throw new Error('duplicate model dispatch');
        }
        dispatched = true;
        for (const directory of [sessionsDir, internalRunsDir]) {
          fs.writeFileSync(
            path.join(directory, `${SESSION_ID}.jsonl`),
            '{"fixture":true}\n',
            { mode: 0o600 },
          );
        }
        if (onAgentDispatch) onAgentDispatch(extra.signal);
        if (extra.signal.aborted) throw gatewayAbortError();
        if (agentFailure === 'transport') throw gatewayTransportError();
        if (agentFailure === 'server') {
          throw gatewayServerError('INVALID_REQUEST', { retryable: true });
        }
        if (agentFailure === 'unknown') throw new Error('unknown fixture secret');
        if (agentFailure === 'in-flight') {
          return { runId: params.idempotencyKey, status: 'in_flight' };
        }
        const final = gatewayResponse({
          runId: params.idempotencyKey,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          thinking: params.thinking,
        });
        if (mutateFinal) mutateFinal(final);
        return final;
      }
      if (method === 'agent.wait') {
        assert.equal(extra.expectFinal, false);
        if (waitFailure === 'server') {
          throw gatewayServerError('INVALID_REQUEST');
        }
        if (waitDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitDelayMs));
        }
        return {
          runId: params.runId,
          status: waitStatus,
          startedAt: 1,
          endedAt: 2,
          ...(waitStatus === 'error' ? { error: { code: 'fixture' } } : {}),
        };
      }
      if (method === 'sessions.abort') {
        assert.equal(extra.expectFinal, false);
        if (abortFailuresRemaining > 0) {
          abortFailuresRemaining -= 1;
          throw gatewayTransportError();
        }
        return {
          ok: true,
          abortedRunId: null,
          status: 'no-active-run',
        };
      }
      if (method === 'sessions.delete') {
        assert.equal(extra.expectFinal, false);
        deleteAttempt += 1;
        if (onDelete) onDelete();
        assert.equal(params.key, key);
        const casDelete = Object.hasOwn(params, 'expectedSessionId');
        if (!casDelete && pendingPatchEntry) {
          entry = pendingPatchEntry;
          pendingPatchEntry = null;
          sessionStore[key] = { ...entry };
          persistSessionStore();
        }
        if (casDelete) {
          assert.equal(params.expectedSessionId, SESSION_ID);
          assert.equal(Object.hasOwn(params, 'expectedLifecycleRevision'), false);
          assert.equal(params.expectedSessionUpdatedAt, entry.updatedAt);
        }
        assert.equal(params.deleteTranscript, false);
        if (deletePermanentFailure) {
          throw gatewayServerError('INVALID_REQUEST');
        }
        if (disappearBeforeDelete && deleteAttempt === 1) {
          delete sessionStore[key];
          persistSessionStore();
          entry = null;
          throw gatewayServerError('INVALID_REQUEST', {
            reason: 'session-changed',
          });
        }
        if (deletionFailuresRemaining > 0) {
          deletionFailuresRemaining -= 1;
          if (driftAfterDeleteFailure) {
            entry = { ...entry, sessionId: `${SESSION_ID}-drift` };
            sessionStore[key] = { ...entry };
            persistSessionStore();
          }
          if (updateAfterDeleteFailure) {
            revision += 1;
            entry = { ...entry, updatedAt: revision };
            sessionStore[key] = { ...entry };
            persistSessionStore();
          }
          if (deleteFailureKind === 'session-changed') {
            throw gatewayServerError('INVALID_REQUEST', {
              reason: 'session-changed',
            });
          }
          if (deleteFailureKind === 'unavailable') {
            throw gatewayServerError('UNAVAILABLE');
          }
          throw gatewayTransportError();
        }
        const deletedEntry = Boolean(entry);
        delete sessionStore[key];
        persistSessionStore();
        entry = null;
        if (afterDelete) afterDelete();
        if (deleteResponseLost && deleteAttempt === 1) {
          throw gatewayTransportError();
        }
        return { ok: true, key, deleted: deletedEntry, archived: [] };
      }
      if (method === 'sessions.describe') {
        assert.equal(extra.expectFinal, false);
        return { session: entry ? { key, ...entry } : null };
      }
      throw new Error(`unexpected Gateway method: ${method}`);
    },
    omitAvailableProfile: omitGatewayOAuth,
  });
  return { calls, loader, entry: () => entry, dispatched: () => dispatched };
}

test('gateway transport binds a current-agent OAuth route without profile identity', () => {
  const value = fixture();
  try {
    const before = readCodexOpenClawManagedConfiguration({
      environment: value.environment,
    });
    assert.equal(before.gatewayTransport, false);
    configureGatewayFixture(value);
    const after = readCodexOpenClawManagedConfiguration({
      environment: value.environment,
    });
    assert.equal(after.gatewayTransport, true);
    assert.equal(
      after.openClawManagedAuthBindingMode,
      'current-agent-gateway-oauth-route',
    );
    assert.equal(after.authProfileId, null);
    assert.equal(after.openClawManagedAuthProfileIdentityHash, null);
    assert.match(
      after.openClawManagedGatewayRouteIdentityHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.notEqual(after.configurationHash, before.configurationHash);
    const source = fs.readFileSync(path.join(value.home, 'config.toml'), 'utf8');
    assert.doesNotMatch(source, /auth_profile_id/);
    assert.match(source, /auth_binding_mode = "current-agent-gateway-oauth"/);
  } finally {
    value.cleanup();
  }
});

test('gateway response parser requires the real isolated direct-RPC shape', () => {
  const configuration = {
    agentId: 'hepta-paper-worker',
    authProfileId: null,
  };
  const model = { provider: 'openai', modelId: 'gpt-5.6-sol' };
  const options = {
    configuration,
    model,
    runId: ATTEMPT_ID,
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    thinking: 'high',
  };
  assert.equal(
    parseOpenClawManagedGatewayResponse(gatewayResponse(), options)
      .meta.agentMeta.agentHarnessId,
    'openclaw',
  );
  const realRawGatewayShape = gatewayResponse();
  realRawGatewayShape.result.meta.systemPromptReport.skills = {
    promptChars: 711,
    hash: 'a'.repeat(64),
    entries: [{ name: 'acp-router', blockChars: 711 }],
  };
  delete realRawGatewayShape.result.meta.toolSummary;
  delete realRawGatewayShape.result.meta.pendingToolCalls;
  for (const key of [
    'didSendViaMessagingTool',
    'didDeliverSourceReplyViaMessageTool',
    'didSendDeterministicApprovalPrompt',
    'messagingToolSentTexts',
    'messagingToolSentMediaUrls',
    'messagingToolSentTargets',
    'messagingToolSourceReplyPayloads',
    'acceptedSessionSpawns',
    'successfulCronAdds',
  ]) delete realRawGatewayShape.result[key];
  assert.equal(
    parseOpenClawManagedGatewayResponse(realRawGatewayShape, options)
      .meta.systemPromptReport.systemPrompt.chars,
    0,
  );
  for (const mutate of [
    (response) => { response.runId = 'drift'; },
    (response) => { response.result.payloads[0].mediaUrl = 'file:///tmp/x'; },
    (response) => { response.result.meta.toolSummary.calls = 1; },
    (response) => { response.result.didSendViaMessagingTool = true; },
    (response) => { response.result.acceptedSessionSpawns = [{}]; },
    (response) => { response.result.deliveryStatus = { status: 'sent' }; },
    (response) => { response.result.meta.agentMeta.model = 'gpt-5.6-drift'; },
    (response) => { response.result.meta.agentMeta.agentHarnessId = 'codex'; },
    (response) => { response.result.meta.executionTrace.fallbackUsed = true; },
    (response) => {
      response.result.meta.systemPromptReport.systemPrompt.chars = 1;
    },
    (response) => {
      response.result.meta.systemPromptReport.skills = {
        promptChars: 1,
        entries: [],
      };
    },
    (response) => {
      response.result.meta.systemPromptReport.tools.entries.push({
        name: 'message',
      });
    },
    (response) => {
      response.result.meta.requestShaping.effectiveAuthProfileId =
        'openai:undisclosed@example.test';
    },
  ]) {
    const response = gatewayResponse();
    mutate(response);
    assert.throws(
      () => parseOpenClawManagedGatewayResponse(response, options),
      /codex_openclaw_managed_/,
    );
  }
});

test('gateway login status proves the exact current-agent route by RPC', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value);
    assert.deepEqual(await verifyCodexOpenClawManagedLogin({
      environment: value.environment,
      modelRuntimeLoader: runtime.loader,
    }), { agentId: 'hepta-paper-worker' });
    assert.deepEqual(runtime.calls.map((entry) => entry.method), [
      'agent.identity.get',
    ]);
  } finally {
    value.cleanup();
  }
});
test('gateway login fails closed when the exact agent OAuth binding is absent', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { omitGatewayOAuth: true });
    const error = await captureRejection(verifyCodexOpenClawManagedLogin({
      environment: value.environment,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_login_unavailable');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /fixture|secret/);
  } finally {
    value.cleanup();
  }
});
test('managed one-shot accepts configured Codex metadata, uses the raw OpenClaw harness, and cleans its exact session', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value);
    const result = await executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    });
    assert.equal(result.stdout, 'HEPTA_CODEX_CANARY_RESPONSE:42\n');
    assert.deepEqual(runtime.calls.map((entry) => entry.method), [
      'sessions.describe',
      'sessions.patch',
      'agent',
      'sessions.describe',
      'sessions.delete',
    ]);
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'agent').length,
      1,
    );
    const agentCall = runtime.calls.find((entry) => entry.method === 'agent');
    assert.equal(agentCall.extra.expectFinal, true);
    assert.ok(agentCall.extra.signal instanceof AbortSignal);
    assert.ok(Number(agentCall.params.timeout) * 1000
      < Number(agentCall.options.timeout));
    const initialPatch = runtime.calls.find(
      (entry) => entry.method === 'sessions.patch',
    ).params;
    assert.deepEqual(initialPatch.inheritedToolDeny, ['*']);
    assert.equal(Object.hasOwn(initialPatch, 'inheritedToolAllow'), false);
    assert.equal(Object.hasOwn(initialPatch, 'model'), false);
    assert.equal(initialPatch.execSecurity, 'deny');
    assert.equal(initialPatch.elevatedLevel, 'off');
    assert.equal(initialPatch.subagentRole, 'leaf');
    assert.equal(initialPatch.subagentControlScope, 'none');
    assert.equal(initialPatch.sendPolicy, 'deny');
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('new Gateway session without lifecycle revision is deleted by session id CAS', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { omitLifecycleRevision: true });
    const result = await executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    });
    assert.equal(result.stdout, 'HEPTA_CODEX_CANARY_RESPONSE:42\n');
    const deletion = runtime.calls.find((entry) => (
      entry.method === 'sessions.delete'
    ));
    assert.equal(deletion.params.expectedSessionId, SESSION_ID);
    assert.equal(
      Object.hasOwn(deletion.params, 'expectedLifecycleRevision'),
      false,
    );
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('policy-invalid terminal response preserves usage without redundant abort', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      mutateFinal(response) {
        response.result.meta.systemPromptReport.tools.entries.push({
          name: 'message',
        });
      },
    });
    const error = await captureRejection(
      executeCodexOpenClawManaged({
        args: [
          '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
          '--cd', value.workspace, '-',
        ],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        timeoutMs: 5000,
        modelRuntimeLoader: runtime.loader,
      }),
    );
    assert.equal(
      error.code,
      'codex_openclaw_managed_agent_policy_violation',
    );
    assert.equal(error.usage.totalTokens, 20);
    assert.equal(error.attemptTrace.length, 1);
    assert.equal(error.attemptTrace[0].errorClass, 'policy_violation');
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.abort'),
      false,
    );
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('transport loss after dispatch never redispatches and preserves evidence', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { agentFailure: 'transport' });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_agent_command_failed');
    assert.doesNotMatch(error.message, /fixture|secret/);
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'agent').length,
      1,
    );
    assert.ok(runtime.calls.some((entry) => entry.method === 'agent.wait'));
    assert.ok(runtime.calls.some((entry) => entry.method === 'sessions.abort'));
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.delete'),
      false,
    );
    assert.ok(runtime.entry());
    assert.ok(fs.existsSync(path.join(value.sessionsDir, `${SESSION_ID}.jsonl`)));
  } finally {
    value.cleanup();
  }
});

test('retryable server rejection never retries the side-effecting agent RPC', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      agentFailure: 'server',
      waitStatus: 'error',
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_agent_command_failed');
    assert.doesNotMatch(error.message, /fixture|secret|INVALID_REQUEST/);
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'agent').length,
      1,
    );
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.delete'),
      false,
    );
    assert.ok(runtime.entry());
  } finally {
    value.cleanup();
  }
});

test('non-final in-flight agent response preserves outcome evidence', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { agentFailure: 'in-flight' });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_agent_command_failed');
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.delete'),
      false,
    );
    assert.ok(runtime.entry());
    assert.ok(fs.existsSync(path.join(value.sessionsDir, `${SESSION_ID}.jsonl`)));
  } finally {
    value.cleanup();
  }
});

test('delete barrier retries a transient active-session rejection', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      deleteFailuresBeforeSuccess: 1,
      deleteFailureKind: 'session-changed',
      updateAfterDeleteFailure: true,
    });
    const result = await executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    });
    assert.equal(result.stdout, 'HEPTA_CODEX_CANARY_RESPONSE:42\n');
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'sessions.delete').length,
      2,
    );
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'sessions.describe').length,
      3,
    );
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('delete response loss reconciles entry absence as success', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { deleteResponseLost: true });
    const result = await executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    });
    assert.equal(result.stdout, 'HEPTA_CODEX_CANARY_RESPONSE:42\n');
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'sessions.delete').length,
      1,
    );
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'sessions.describe').length,
      3,
    );
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('delete barrier retries real UNAVAILABLE without a retryable flag', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      deleteFailuresBeforeSuccess: 1,
      deleteFailureKind: 'unavailable',
    });
    const result = await executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    });
    assert.equal(result.stdout, 'HEPTA_CODEX_CANARY_RESPONSE:42\n');
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'sessions.delete').length,
      2,
    );
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('lost patch response is fenced behind its delayed lifecycle commit', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { patchFailure: 'delayed' });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_agent_command_failed');
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'agent'), false,
    );
    const fence = runtime.calls.find((entry) => (
      entry.method === 'sessions.delete'
    ));
    assert.equal(Object.hasOwn(fence.params, 'expectedSessionId'), false);
    assert.equal(runtime.entry(), null);
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('delete reconciliation fails closed on session identity drift', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      deleteFailuresBeforeSuccess: 1,
      driftAfterDeleteFailure: true,
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_entry_binding_changed',
    );
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'sessions.delete').length,
      1,
    );
    assert.ok(runtime.entry());
    assert.ok(fs.existsSync(path.join(value.sessionsDir, `${SESSION_ID}.jsonl`)));
  } finally {
    value.cleanup();
  }
});

test('permanent delete failure preserves the session and artifacts', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { deletePermanentFailure: true });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_entry_delete_failed',
    );
    assert.ok(runtime.entry());
    assert.ok(fs.existsSync(path.join(value.sessionsDir, `${SESSION_ID}.jsonl`)));
    assert.ok(fs.existsSync(path.join(value.internalRunsDir, `${SESSION_ID}.jsonl`)));
  } finally {
    value.cleanup();
  }
});

test('cleanup failure remains authoritative and preserves completed usage', async () => {
  const value = fixture();
  const controller = new AbortController();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      deletePermanentFailure: true,
      onDelete() { controller.abort(); },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      signal: controller.signal,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_entry_delete_failed',
    );
    assert.equal(error.retryable, false);
    assert.equal(error.usage.totalTokens, 20);
    assert.equal(error.attemptTrace.length, 1);
    assert.equal(error.attemptTrace[0].errorClass, 'session_cleanup_failed');
    assert.equal(error.attemptTrace[0].usage.totalTokens, 20);
    assert.ok(runtime.entry());
  } finally {
    value.cleanup();
  }
});

test('unknown same-identity artifact is preserved and fails cleanup closed', async () => {
  const value = fixture();
  const unexpected = path.join(
    value.internalRunsDir,
    `${SESSION_ID}.unexpected-evidence`,
  );
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      onAgentDispatch() {
        fs.writeFileSync(unexpected, 'preserve\n', { mode: 0o600 });
      },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
    );
    assert.equal(fs.readFileSync(unexpected, 'utf8'), 'preserve\n');
    assert.equal(runtime.entry(), null);
  } finally {
    value.cleanup();
  }
});
test('artifact arriving during the quiet window is preserved and fails closed', async () => {
  const value = fixture();
  const delayed = path.join(
    value.internalRunsDir,
    `${SESSION_ID}.unexpected-late-evidence`,
  );
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      afterDelete() {
        setTimeout(() => {
          fs.writeFileSync(delayed, 'late evidence\n', { mode: 0o600 });
        }, 5);
      },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
    );
    assert.equal(fs.readFileSync(delayed, 'utf8'), 'late evidence\n');
  } finally {
    value.cleanup();
  }
});
test('legacy crash quarantine is globally discovered and blocks a new run', async () => {
  const value = fixture();
  const quarantine = path.join(
    value.internalRunsDir,
    `.hepta-cleanup-999-${'a'.repeat(32)}`,
  );
  try {
    configureGatewayFixture(value);
    fs.writeFileSync(quarantine, 'preserved transcript\n', { mode: 0o600 });
    const before = gatewayTemporaryWorkspaces();
    const runtime = gatewayRuntime(value);
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
    );
    assert.equal(fs.readFileSync(quarantine, 'utf8'), 'preserved transcript\n');
    assert.deepEqual(gatewayTemporaryWorkspaces(), before);
  } finally {
    value.cleanup();
  }
});

test('symlink artifact is never followed or deleted outside the pinned root', async () => {
  const value = fixture();
  const sentinel = path.join(value.root, 'outside-sentinel');
  const artifact = path.join(value.internalRunsDir, `${SESSION_ID}.jsonl`);
  try {
    fs.writeFileSync(sentinel, 'outside\n', { mode: 0o600 });
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      onAgentDispatch() {
        fs.unlinkSync(artifact);
        fs.symlinkSync(sentinel, artifact);
      },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside\n');
    assert.equal(fs.lstatSync(artifact).isSymbolicLink(), true);
  } finally {
    value.cleanup();
  }
});

test('hard-linked artifact is preserved instead of unlinking shared evidence', async () => {
  const value = fixture();
  const artifact = path.join(value.internalRunsDir, `${SESSION_ID}.jsonl`);
  const outsideLink = path.join(value.root, 'outside-hardlink');
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      onAgentDispatch() { fs.linkSync(artifact, outsideLink); },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
    assert.equal(fs.existsSync(artifact), true);
    assert.equal(fs.readFileSync(outsideLink, 'utf8'), '{"fixture":true}\n');
    assert.equal(fs.statSync(outsideLink).nlink, 2);
  } finally {
    value.cleanup();
  }
});

test('runtime artifact-root replacement cannot redirect cleanup', async () => {
  const value = fixture();
  const original = `${value.internalRunsDir}.pinned-original`;
  const outside = path.join(value.root, 'outside-artifacts');
  const sentinel = path.join(outside, `${SESSION_ID}.jsonl`);
  try {
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.writeFileSync(sentinel, 'outside\n', { mode: 0o600 });
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      onAgentDispatch() {
        fs.renameSync(value.internalRunsDir, original);
        fs.symlinkSync(outside, value.internalRunsDir);
      },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside\n');
  } finally {
    value.cleanup();
  }
});

test('failure final preserves usage and the exact timeout failure', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      mutateFinal(response) {
        response.status = 'timeout';
        response.summary = 'aborted';
        response.stopReason = 'rpc';
        response.timeoutPhase = 'provider';
        response.result.payloads = [{
          text: 'The model did not produce a response before the model idle timeout.',
          isError: true,
        }];
        response.result.meta.aborted = true;
        response.result.meta.timeoutPhase = 'provider';
        response.result.meta.error = {
          kind: 'incomplete_turn',
          message: 'model idle timeout',
          fallbackSafe: false,
        };
        delete response.result.meta.stopReason;
        delete response.result.meta.requestShaping;
        delete response.result.meta.completion;
        delete response.result.meta.executionTrace;
      },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_model_timeout');
    assert.deepEqual(error.usage, {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
    });
    assert.equal(error.attemptTrace.length, 1);
    assert.equal(error.attemptTrace[0].errorClass, 'timeout');
    assert.deepEqual(error.attemptTrace[0].usage, error.usage);
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('retry-limit final tolerates omitted success diagnostics but preserves usage', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      mutateFinal(response) {
        response.result.payloads = [{
          text: 'Exceeded retry limit after one pinned provider attempt.',
          isError: true,
        }];
        response.result.meta.stopReason = 'error';
        response.result.meta.error = {
          kind: 'retry_limit',
          message: 'Exceeded retry limit.',
        };
        delete response.result.meta.agentMeta.agentHarnessId;
        delete response.result.meta.requestShaping;
        delete response.result.meta.completion;
        delete response.result.meta.executionTrace;
        delete response.result.meta.systemPromptReport;
      },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(
      error.code,
      'codex_openclaw_managed_transient_provider_response',
    );
    assert.equal(error.usage.totalTokens, 20);
    assert.equal(error.attemptTrace[0].usage.totalTokens, 20);
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

for (const [usageFailure, mutateUsage] of [
  ['missing usage', (agentMeta) => { delete agentMeta.usage; }],
  ['inconsistent total', (agentMeta) => { agentMeta.usage.totalTokens = 19; }],
  ['oversized last call', (agentMeta) => {
    agentMeta.lastCallUsage = {
      input: 11, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 21,
    };
  }],
]) {
  test(`failure final with ${usageFailure} preserves evidence`, async () => {
    const value = fixture();
    try {
      configureGatewayFixture(value);
      const runtime = gatewayRuntime(value, {
        mutateFinal(response) {
          response.result.payloads = [{ text: 'provider failure', isError: true }];
          response.result.meta.stopReason = 'error';
          response.result.meta.error = { kind: 'provider_error' };
          mutateUsage(response.result.meta.agentMeta);
        },
      });
      const error = await captureRejection(executeCodexOpenClawManaged({
        args: ['--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
          '--cd', value.workspace, '-'],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        timeoutMs: 5000,
        modelRuntimeLoader: runtime.loader,
      }));
      assert.equal(error.code, 'codex_openclaw_managed_usage_invalid');
      assert.equal(error.attemptTrace[0].usage, null);
      assert.equal(runtime.calls.some(
        (entry) => entry.method === 'sessions.delete'), false);
      assert.ok(runtime.entry());
      assert.ok(fs.existsSync(path.join(value.sessionsDir, `${SESSION_ID}.jsonl`)));
    } finally {
      value.cleanup();
    }
  });
}

test('expired dispatch deadline cleans the session without invoking agent', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { patchDelayMs: 1400 });
    await assert.rejects(
      executeCodexOpenClawManaged({
        args: [
          '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
          '--cd', value.workspace, '-',
        ],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        timeoutMs: 1300,
        modelRuntimeLoader: runtime.loader,
      }),
      /codex_openclaw_managed_model_timeout/,
    );
    assert.equal(runtime.calls.some((entry) => entry.method === 'agent'), false);
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.abort'),
      false,
    );
    assert.deepEqual(runtime.calls.map((entry) => entry.method), [
      'sessions.describe',
      'sessions.patch',
      'sessions.describe',
      'sessions.delete',
    ]);
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('deadline signal blocks provider dispatch after internal Gateway delay', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { agentGatewayDelayMs: 1400 });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: ['--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      timeoutMs: 1300,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_model_timeout');
    assert.equal(runtime.dispatched(), false);
    assert.equal(runtime.calls.some(
      (entry) => entry.method === 'sessions.delete'), false);
    assert.ok(runtime.entry());
  } finally {
    value.cleanup();
  }
});

test('post-dispatch abort retries settlement but preserves unknown result evidence', async () => {
  const value = fixture();
  const controller = new AbortController();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      failAbortCount: 1,
      waitDelayMs: 50,
      onAgentDispatch() { controller.abort(); },
    });
    await assert.rejects(
      executeCodexOpenClawManaged({
        args: [
          '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
          '--cd', value.workspace, '-',
        ],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        signal: controller.signal,
        timeoutMs: 5000,
        modelRuntimeLoader: runtime.loader,
      }),
      /codex_openclaw_managed_model_cancelled/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.ok(runtime.calls.some((entry) => entry.method === 'sessions.abort'));
    assert.equal(
      runtime.calls.filter((entry) => entry.method === 'sessions.abort').length,
      2,
    );
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.delete'),
      false,
    );
    assert.ok(runtime.entry());
    assert.ok(fs.existsSync(path.join(value.sessionsDir, `${SESSION_ID}.jsonl`)));
    assert.ok(fs.existsSync(path.join(value.internalRunsDir, `${SESSION_ID}.jsonl`)));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    value.cleanup();
  }
});

test('cancel preserves session evidence when terminal state cannot be proven', async () => {
  const value = fixture();
  const controller = new AbortController();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      waitFailure: 'server',
      onAgentDispatch() { controller.abort(); },
    });
    const error = await captureRejection(executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol', '--sandbox', 'read-only',
        '--cd', value.workspace, '-',
      ],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      signal: controller.signal,
      timeoutMs: 5000,
      modelRuntimeLoader: runtime.loader,
    }));
    assert.equal(error.code, 'codex_openclaw_managed_model_cancelled');
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.delete'),
      false,
    );
    assert.ok(runtime.entry());
    assert.ok(fs.existsSync(path.join(value.sessionsDir, `${SESSION_ID}.jsonl`)));
  } finally {
    value.cleanup();
  }
});
