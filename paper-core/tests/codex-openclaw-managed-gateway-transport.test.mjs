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

function gatewayRuntime(value, {
  mutateFinal = null,
  failWaitOnce = false,
  invalidInitialPatch = false,
  onInitialPatch = null,
  omitLifecycleRevision = false,
  failAbortImmediately = false,
  waitDelayMs = 0,
  onAgentAccepted = null,
} = {}) {
  const calls = [];
  let entry = null;
  let key = null;
  let revision = 0;
  let dispatched = false;
  let terminal = false;
  let waitFailed = false;
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
      assert.equal(extra.expectFinal, false);
      if (method === 'agent.identity.get') {
        return { agentId: params.agentId, name: 'Fixture Agent' };
      }
      if (method === 'sessions.patch') {
        key = params.key;
        revision += 1;
        entry = {
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
        sessionStore[key] = { ...entry };
        persistSessionStore();
        if (Object.hasOwn(params, 'thinkingLevel') && onInitialPatch) {
          onInitialPatch();
        }
        return {
          ok: true,
          key,
          entry: { ...entry },
          resolved: {
            modelProvider: 'openai',
            model: 'gpt-5.6-sol',
            agentRuntime: 'openclaw',
          },
        };
      }
      if (method === 'agent') {
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
        if (!dispatched) {
          dispatched = true;
          for (const directory of [sessionsDir, internalRunsDir]) {
            fs.writeFileSync(
              path.join(directory, `${SESSION_ID}.jsonl`),
              '{"fixture":true}\n',
              { mode: 0o600 },
            );
          }
          const accepted = {
            runId: params.idempotencyKey,
            sessionKey: key,
            status: 'accepted',
            acceptedAt: 1,
          };
          if (onAgentAccepted) onAgentAccepted();
          return accepted;
        }
        assert.equal(terminal, true);
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
        if (failWaitOnce && !waitFailed) {
          waitFailed = true;
          throw new Error('simulated Gateway wait transport failure');
        }
        if (waitDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitDelayMs));
        }
        terminal = true;
        return {
          runId: params.runId,
          status: 'ok',
          startedAt: 1,
          endedAt: 2,
        };
      }
      if (method === 'sessions.abort') {
        if (failAbortImmediately) {
          throw new Error('simulated immediate abort RPC rejection');
        }
        terminal = true;
        return {
          ok: true,
          abortedRunId: null,
          status: 'no-active-run',
        };
      }
      if (method === 'sessions.delete') {
        assert.equal(params.key, key);
        assert.equal(params.expectedSessionId, SESSION_ID);
        if (entry.lifecycleRevision) {
          assert.equal(params.expectedLifecycleRevision, entry.lifecycleRevision);
        } else {
          assert.equal(Object.hasOwn(params, 'expectedLifecycleRevision'), false);
        }
        assert.equal(params.expectedSessionUpdatedAt, entry.updatedAt);
        const source = path.join(sessionsDir, `${SESSION_ID}.jsonl`);
        const archived = `${source}.deleted.fixture`;
        const archivedPaths = [];
        if (fs.existsSync(source)) {
          fs.renameSync(source, archived);
          archivedPaths.push(archived);
        }
        delete sessionStore[key];
        persistSessionStore();
        entry = null;
        return { ok: true, key, deleted: true, archived: archivedPaths };
      }
      if (method === 'sessions.describe') {
        return { session: entry ? { key, ...entry } : null };
      }
      throw new Error(`unexpected Gateway method: ${method}`);
    },
  });
  return { calls, loader };
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

test('managed one-shot uses direct Gateway RPC and cleans its exact session', async () => {
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
      'sessions.patch',
      'agent',
      'agent.wait',
      'agent',
      'sessions.patch',
      'sessions.delete',
      'sessions.describe',
    ]);
    const initialPatch = runtime.calls[0].params;
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

test('policy-invalid final response is aborted and cleaned without fallback', async () => {
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
    await assert.rejects(
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
      /codex_openclaw_managed_agent_policy_violation/,
    );
    assert.ok(runtime.calls.some((entry) => entry.method === 'sessions.abort'));
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('post-dispatch Gateway failure aborts the active run before cleanup', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { failWaitOnce: true });
    await assert.rejects(
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
      /codex_openclaw_managed_agent_command_failed/,
    );
    assert.ok(runtime.calls.some((entry) => entry.method === 'sessions.abort'));
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('invalid created Gateway session binding is deleted without dispatch', async () => {
  const value = fixture();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, { invalidInitialPatch: true });
    await assert.rejects(
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
      /codex_openclaw_managed_session_binding_failed/,
    );
    assert.equal(runtime.calls.some((entry) => entry.method === 'agent'), false);
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('pre-dispatch abort cleans the created session without invoking agent', async () => {
  const value = fixture();
  const controller = new AbortController();
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      onInitialPatch() { controller.abort(); },
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
    assert.equal(runtime.calls.some((entry) => entry.method === 'agent'), false);
    assert.equal(
      runtime.calls.some((entry) => entry.method === 'sessions.abort'),
      false,
    );
    assert.deepEqual(runtime.calls.map((entry) => entry.method), [
      'sessions.patch',
      'sessions.patch',
      'sessions.delete',
      'sessions.describe',
    ]);
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('immediate abort RPC rejection is handled while terminal wait is pending', async () => {
  const value = fixture();
  const controller = new AbortController();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    configureGatewayFixture(value);
    const runtime = gatewayRuntime(value, {
      failAbortImmediately: true,
      waitDelayMs: 50,
      onAgentAccepted() { controller.abort(); },
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
    assertManagedRuntimeClean(value);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    value.cleanup();
  }
});
