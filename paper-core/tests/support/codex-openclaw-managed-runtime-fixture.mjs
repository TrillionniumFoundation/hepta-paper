import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildOpenClawManagedFailureEvidence,
  buildOpenClawManagedExecutionMetadata,
  provisionCodexOpenClawManagedHome,
  readCodexOpenClawManagedConfiguration,
  verifyOpenClawManagedFailureEvidence,
} from '../../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS,
} from '../../../paper-adapters/automation/codex-openclaw-managed-configuration.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

export const MAIN_TEX_MUTATION_POLICY = Object.freeze({
  allowedPaths: Object.freeze(['main.tex']),
  allowedPrefixes: Object.freeze([]),
  allowedExtensions: Object.freeze([]),
  forbiddenPaths: Object.freeze([]),
  forbiddenExtensions: Object.freeze([]),
});
export const AUTH_PROFILE_ID = 'openai:fixture@example.test';
const fixtureRuntimeBindings = Object.freeze(
  OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.map((descriptor, index) => (
    Object.freeze({
      ordinal: index + 1,
      packageName: descriptor.packageName,
      packageExport: descriptor.packageExport,
      runtimeRole: descriptor.locationProperty,
      requiredExports: Object.freeze([...descriptor.requiredExports]),
      runtimeFilePathHash: hashRecord(
        'FixtureOpenClawRuntimeFilePath',
        { packageExport: descriptor.packageExport },
      ),
      runtimeFileContentHash: hashRecord(
        'FixtureOpenClawRuntimeFileContent',
        { packageExport: descriptor.packageExport },
      ),
    })
  )),
);
const fixtureRuntimeProvenancePayload = Object.freeze({
  version: 1,
  kind: 'OpenClawManagedCodexRuntimeProvenance',
  packageName: 'openclaw',
  packageRootPathHash: hashRecord('FixtureOpenClawPackageRoot', {}),
  packageManifestContentHash: hashRecord('FixtureOpenClawPackageManifest', {}),
  moduleBindings: fixtureRuntimeBindings,
});
export const FIXTURE_OPENCLAW_RUNTIME_PROVENANCE = Object.freeze({
  ...fixtureRuntimeProvenancePayload,
  openClawManagedRuntimeProvenanceHash: hashRecord(
    'OpenClawManagedCodexRuntimeProvenance',
    fixtureRuntimeProvenancePayload,
  ),
});

export function executionPrompt(text, {
  role = 'writer',
  sandbox = 'workspace-write',
  workspaceMutationPolicy = sandbox === 'workspace-write'
    ? MAIN_TEX_MUTATION_POLICY : null,
} = {}) {
  return `${buildOpenClawManagedExecutionMetadata({
    role,
    sandbox,
    workspaceMutationPolicy,
  })}\n\n${text}`;
}
export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-managed-codex-test-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'author-home');
  const openclaw = path.join(root, 'openclaw');
  const openclawStateDir = path.join(root, 'openclaw-state');
  const openclawConfigPath = path.join(openclawStateDir, 'openclaw.json');
  const agentDir = path.join(
    openclawStateDir,
    'agents',
    'hepta-paper-worker',
    'agent',
  );
  const sessionsDir = path.join(
    openclawStateDir,
    'agents',
    'hepta-paper-worker',
    'sessions',
  );
  const sessionStorePath = path.join(sessionsDir, 'sessions.json');
  const internalRunsDir = path.join(openclawStateDir, 'internal-agent-runs');
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(internalRunsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'before\n', { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC.json'), '{"claims":[]}\n', { mode: 0o600 });
  fs.writeFileSync(openclaw, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(openclawConfigPath, `${JSON.stringify({
    agents: {
      list: [{
        id: 'hepta-paper-worker',
        runRetries: { base: 1, perProfile: 0, min: 1, max: 1 },
      }],
    },
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(sessionStorePath, '{}\n', { mode: 0o600 });
  provisionCodexOpenClawManagedHome({
    home,
    agentId: 'hepta-paper-worker',
    authProfileId: AUTH_PROFILE_ID,
    model: 'gpt-5.6-sol',
    openclawBinary: openclaw,
    openclawConfigPath,
    openclawStateDir,
    principalRole: 'research-author',
    thinking: 'adaptive',
  });
  return {
    root,
    workspace,
    home,
    openclawStateDir,
    openclawConfigPath,
    agentDir,
    sessionsDir,
    sessionStorePath,
    internalRunsDir,
    environment: { ...process.env, CODEX_HOME: home },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export function assistantMessage(text, {
  provider = 'openai',
  model = 'gpt-5.6-sol',
  stopReason = 'stop',
  errorCode = null,
  errorType = null,
  errorMessage = null,
  authMode = 'auth-profile',
  agentHarnessId = 'codex',
  executionTrace = null,
  fallbackUsed = false,
  toolCalls = 0,
  pendingToolCalls = [],
  externalDelivery = false,
  completionStopReason = stopReason,
  finishReason = stopReason,
  resolvedThinking = null,
  sessionId = null,
  sessionFile = null,
  usage = null,
  lastCallUsage = null,
  omitUsage = false,
} = {}) {
  return {
    text,
    provider,
    model,
    stopReason,
    errorCode,
    errorType,
    errorMessage,
    authMode,
    agentHarnessId,
    executionTrace,
    fallbackUsed,
    toolCalls,
    pendingToolCalls,
    externalDelivery,
    completionStopReason,
    finishReason,
    resolvedThinking,
    sessionId,
    sessionFile,
    usage,
    lastCallUsage,
    omitUsage,
  };
}

export function injectedModelRuntime(completion, {
  availableProfileId = AUTH_PROFILE_ID,
  omitAvailableProfile = false,
  availableProfileProvider = 'openai',
  availableProfileType = 'oauth',
  onLoad = null,
  onPrepare = null,
  onCompletion = null,
  onDispose = null,
  gatewayRpc = null,
} = {}) {
  return async (configuration) => {
    if (onLoad) onLoad(configuration);
    const cfg = Object.freeze({ fixture: true });
    const agentDir = path.join(
      configuration.openclawStateDir,
      'agents',
      configuration.agentId,
      'agent',
    );
    const sessionsDir = path.join(
      configuration.openclawStateDir,
      'agents',
      configuration.agentId,
      'sessions',
    );
    const sessionStorePath = path.join(sessionsDir, 'sessions.json');
    const internalRunsDir = path.join(
      configuration.openclawStateDir,
      'internal-agent-runs',
    );
    const sessionStore = {};
    const persistSessionStore = () => fs.writeFileSync(
      sessionStorePath,
      `${JSON.stringify(sessionStore)}\n`,
      { mode: 0o600 },
    );
    const materializeResult = (descriptor, options) => {
      const provider = descriptor.provider;
      const model = descriptor.model;
      const failed = descriptor.stopReason !== 'stop';
      const trace = descriptor.executionTrace || {
        winnerProvider: provider,
        winnerModel: model,
        fallbackUsed: descriptor.fallbackUsed,
        runner: 'embedded',
        attempts: [{
          provider,
          model,
          result: failed ? 'error' : 'success',
          stage: 'assistant',
          reason: descriptor.errorCode,
        }],
      };
      return {
        payloads: descriptor.text === null || descriptor.text === undefined
          ? []
          : [{
            text: descriptor.text,
            ...(failed ? { isError: true } : {}),
          }],
        meta: {
          stopReason: descriptor.stopReason,
          aborted: false,
          ...(descriptor.errorMessage
            ? { error: { message: descriptor.errorMessage } } : {}),
          agentMeta: {
            sessionId: descriptor.sessionId || options.sessionId,
            provider,
            model,
            agentHarnessId: descriptor.agentHarnessId,
            sessionFile: descriptor.sessionFile || path.join(
              internalRunsDir,
              `${options.sessionId}.jsonl`,
            ),
            ...(!descriptor.omitUsage ? {
              usage: descriptor.usage || {
                input: 10,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 20,
              },
            } : {}),
            ...(descriptor.lastCallUsage
              ? { lastCallUsage: descriptor.lastCallUsage } : {}),
          },
          requestShaping: {
            authMode: descriptor.authMode,
            thinking: descriptor.resolvedThinking || options.thinking,
          },
          completion: {
            stopReason: descriptor.completionStopReason,
            finishReason: descriptor.finishReason,
          },
          executionTrace: trace,
          toolSummary: { calls: descriptor.toolCalls },
          pendingToolCalls: descriptor.pendingToolCalls,
        },
        didSendViaMessagingTool: descriptor.externalDelivery,
        didDeliverSourceReplyViaMessageTool: false,
        didSendDeterministicApprovalPrompt: false,
        messagingToolSentTexts: descriptor.externalDelivery ? ['sent'] : [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [],
        acceptedSessionSpawns: [],
        successfulCronAdds: 0,
      };
    };
    return Object.freeze({
      cfg,
      runtimeProvenance: FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
      agentDir,
      sessionsDir,
      sessionStorePath,
      internalRunsDir,
      ensureAuthProfileStore(requestedAgentDir, options) {
        if (onPrepare) onPrepare({ requestedAgentDir, ...options });
        return {
          profiles: {
            ...(omitAvailableProfile ? {} : {
              [availableProfileId]: {
                provider: availableProfileProvider,
                type: availableProfileType,
                token: 'fixture-secret-never-reported',
              },
            }),
          },
        };
      },
      async upsertSessionEntry({
        sessionKey,
        entry,
      }) {
        sessionStore[sessionKey] = { ...entry };
        persistSessionStore();
      },
      getSessionEntry({ sessionKey }) {
        return sessionStore[sessionKey]
          ? { ...sessionStore[sessionKey] } : null;
      },
      async updateSessionStore(requestedPath, mutator) {
        assert.equal(requestedPath, sessionStorePath);
        mutator(sessionStore);
        persistSessionStore();
      },
      resolveSessionFilePath(sessionId) {
        return path.join(sessionsDir, `${sessionId}.jsonl`);
      },
      async callGatewayFromCli(method, options, params, extra) {
        if (!gatewayRpc) throw new Error('unexpected Gateway RPC');
        return await gatewayRpc({
          method,
          options,
          params,
          extra,
          sessionStore,
          persistSessionStore,
          sessionsDir,
          internalRunsDir,
          materializeResult,
        });
      },
      async agentCommand(options, runtime) {
        if (onCompletion) onCompletion(options);
        assert.equal(typeof runtime.log, 'function');
        const entry = sessionStore[options.sessionKey];
        assert.deepEqual({
          sessionId: entry?.sessionId,
          authProfileOverride: entry?.authProfileOverride,
          authProfileOverrideSource: entry?.authProfileOverrideSource,
          providerOverride: entry?.providerOverride,
          modelOverride: entry?.modelOverride,
          modelOverrideSource: entry?.modelOverrideSource,
          agentRuntimeOverride: entry?.agentRuntimeOverride,
        }, {
          sessionId: options.sessionId,
          authProfileOverride: AUTH_PROFILE_ID,
          authProfileOverrideSource: 'user',
          providerOverride: 'openai',
          modelOverride: 'gpt-5.6-sol',
          modelOverrideSource: 'user',
          agentRuntimeOverride: 'codex',
        });
        for (const directory of [sessionsDir, internalRunsDir]) {
          fs.writeFileSync(
            path.join(directory, `${options.sessionId}.jsonl`),
            '{"fixture":true}\n',
            { mode: 0o600 },
          );
          fs.writeFileSync(
            path.join(directory, `${options.sessionId}.trajectory.jsonl`),
            '{"fixtureTrajectory":true}\n',
            { mode: 0o600 },
          );
        }
        const controls = Object.freeze({
          sessionStore,
          replaceSessionEntry(nextEntry) {
            sessionStore[options.sessionKey] = { ...nextEntry };
            persistSessionStore();
          },
          deleteSessionEntry() {
            delete sessionStore[options.sessionKey];
            persistSessionStore();
          },
          writeUnexpectedArtifact(name = `${options.sessionId}.unexpected`) {
            fs.writeFileSync(
              path.join(internalRunsDir, name),
              'unexpected\n',
              { mode: 0o600 },
            );
          },
        });
        return materializeResult(
          await completion(options, controls),
          options,
        );
      },
      async disposeRegisteredAgentHarnesses() {
        if (onDispose) onDispose();
      },
      silentRuntime: Object.freeze({
        log() {},
        error() {},
        exit(code) {
          assert.equal(Number(code), 0);
        },
      }),
    });
  };
}

export function assertManagedRuntimeClean(value) {
  assert.deepEqual(
    JSON.parse(fs.readFileSync(value.sessionStorePath, 'utf8')),
    {},
  );
  assert.deepEqual(
    fs.readdirSync(value.sessionsDir).filter(
      (entry) => entry !== 'sessions.json',
    ),
    [],
  );
  assert.deepEqual(fs.readdirSync(value.internalRunsDir), []);
}

export function assertCompleteManagedFailureUsage(error, environment, failureCode) {
  assert.equal(error.code, failureCode);
  assert.deepEqual(error.usage, {
    input: 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
  });
  const evidence = buildOpenClawManagedFailureEvidence(error);
  const configuration = readCodexOpenClawManagedConfiguration({ environment });
  assert.equal(evidence.version, 4);
  assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
    failureCode,
    model: 'gpt-5.6-sol',
    expectedAuthProfileIdentityHash:
      configuration.openClawManagedAuthProfileIdentityHash,
    expectedRuntimeProvenanceHash:
      FIXTURE_OPENCLAW_RUNTIME_PROVENANCE.openClawManagedRuntimeProvenanceHash,
    allowLegacyAudit: true,
  }), true);
  return true;
}

export function assertIncompleteManagedFailureUsage(error, environment, failureCode, {
  errorClass = 'session_cleanup_failed',
} = {}) {
  assert.equal(error.code, failureCode);
  assert.equal(error.retryable, false);
  assert.equal(Object.hasOwn(error, 'usage'), false);
  assert.equal(error.attemptTrace.length, 1);
  assert.equal(error.attemptTrace[0].usage, null);
  assert.equal(error.attemptTrace[0].errorClass, errorClass);
  const evidence = buildOpenClawManagedFailureEvidence(error);
  const configuration = readCodexOpenClawManagedConfiguration({ environment });
  assert.equal(evidence.version, 4);
  assert.equal(evidence.failureCode, failureCode);
  assert.equal(evidence.failureDisposition, 'permanent');
  assert.equal(evidence.usageComplete, false);
  assert.equal(evidence.usage, null);
  assert.equal(evidence.externalModelInvocationPerformed, true);
  assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
    failureCode,
    model: 'gpt-5.6-sol',
    expectedAuthProfileIdentityHash:
      configuration.openClawManagedAuthProfileIdentityHash,
    expectedRuntimeProvenanceHash:
      FIXTURE_OPENCLAW_RUNTIME_PROVENANCE.openClawManagedRuntimeProvenanceHash,
    allowLegacyAudit: true,
  }), true);
  return true;
}
