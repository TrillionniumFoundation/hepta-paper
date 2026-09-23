import assert from 'node:assert/strict';
import test from 'node:test';

import {
  managedAuthEvidence,
  verifyOpenClawManagedExecutionEvidence,
} from '../../paper-adapters/automation/codex-openclaw-managed-execution-evidence.mjs';
import {
  buildOpenClawManagedFailureEvidence,
  verifyOpenClawManagedFailureEvidence,
} from '../../paper-adapters/automation/codex-openclaw-managed-usage-evidence.mjs';
import {
  modelAttemptTraceHash,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime-common.mjs';
import {
  FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
} from './support/codex-openclaw-managed-runtime-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('GatewayEvidenceTest', { label });

function gatewayAttempt() {
  const attemptId = '12345678-1234-4123-8123-123456789abc';
  const usage = Object.freeze({
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  });
  const cleanup = Object.freeze({
    sessionEntryRemoved: true,
    artifactsRemoved: true,
    attemptWorkspaceRemoved: true,
  });
  const trace = Object.freeze({
    winnerProvider: 'openai',
    winnerModel: 'gpt-5.6-sol',
    fallbackUsed: false,
    runner: 'embedded',
    attempts: Object.freeze([Object.freeze({
      provider: 'openai', model: 'gpt-5.6-sol', result: 'success',
      stage: 'assistant', reason: null,
    })]),
  });
  return Object.freeze({
    attemptNumber: 1,
    attemptId,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    authProfileIdentityHash: null,
    authBindingMode: 'current-agent-gateway-oauth-route',
    gatewayRouteIdentityHash: H('gateway-route'),
    thinking: 'high',
    resolvedThinking: 'high',
    outcome: 'completed',
    stopReason: 'stop',
    errorClass: null,
    responseTextHash: H('response'),
    responseErrorHash: null,
    authProfileOverrideSource: null,
    runtimeFallbackUsed: false,
    executionTrace: trace,
    executionTraceHash: hashRecord(
      'OpenClawManagedCodexAppServerExecutionTrace', trace,
    ),
    sessionBindingBeforeHash: H('session-binding'),
    sessionBindingAfterHash: H('session-binding'),
    agentHarnessId: 'openclaw',
    requestAuthMode: 'auth-profile',
    toolCallsObserved: 0,
    pendingToolCallCount: 0,
    externalDeliveryObserved: false,
    sessionCleanup: cleanup,
    sessionCleanupHash: hashRecord(
      'OpenClawManagedCodexAppServerSessionCleanup', cleanup,
    ),
    sessionCleanupVerified: true,
    usage,
    usageHash: hashRecord(
      'OpenClawManagedCodexAppServerAttemptUsage', { attemptId, usage },
    ),
  });
}

test('Gateway execution evidence binds a route without claiming a profile', () => {
  const attempt = gatewayAttempt();
  const evidence = managedAuthEvidence({
    managed: {
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.6-sol',
      completionInvocationId: `openclaw-gateway-agent-rpc:${attempt.attemptId}`,
      successfulAttemptId: attempt.attemptId,
      successfulResponseHash: attempt.responseTextHash,
      successfulSessionBindingHash: attempt.sessionBindingAfterHash,
      attemptTrace: [attempt],
      attemptTraceHash: modelAttemptTraceHash([attempt]),
      attemptCount: 1,
      thinking: 'high',
      usage: attempt.usage,
      runtimeProvenance: FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
    },
    snapshot: { snapshotHash: H('snapshot'), fileCount: 1, byteCount: 10 },
    configuration: {
      gatewayTransport: true,
      agentId: 'independent-helper',
      principalRole: 'research-author',
      configurationHash: H('configuration'),
      openClawManagedAuthProfileIdentityHash: null,
      openClawManagedGatewayRouteIdentityHash: H('gateway-route'),
      openClawManagedAuthSourceIdentityHash: H('auth-source'),
      thinking: 'high',
    },
    changedPaths: [],
    validation: { reportedChecks: [] },
    originalPromptHash: H('prompt'),
  });
  const expected = {
    originalPromptHash: H('prompt'), model: 'gpt-5.6-sol', changedPaths: [],
    expectedConfigurationHash: H('configuration'),
    expectedRuntimeProvenanceHash: FIXTURE_OPENCLAW_RUNTIME_PROVENANCE
      .openClawManagedRuntimeProvenanceHash,
    expectedAuthBindingMode: 'current-agent-gateway-oauth-route',
    expectedAuthProfileIdentityHash: null,
    expectedGatewayRouteIdentityHash: H('gateway-route'),
    expectedAuthSourceIdentityHash: H('auth-source'),
  };
  assert.equal(evidence.version, 7);
  assert.equal(evidence.openClawManagedAuthProfileIdentityHash, null);
  assert.equal(
    evidence.contextInheritance,
    'provider-visible-context-forbidden-and-observed-empty',
  );
  assert.equal(evidence.residentSkillCatalogInjectionObserved, false);
  assert.equal(evidence.providerToolSurfaceObservedEmpty, true);
  assert.equal(
    evidence.sideEffectTelemetryMode,
    'openclaw-optional-positive-evidence-none-observed',
  );
  assert.equal(verifyOpenClawManagedExecutionEvidence(evidence, expected), true);
  assert.equal(verifyOpenClawManagedExecutionEvidence(evidence, {
    ...expected, expectedGatewayRouteIdentityHash: H('other-route'),
  }), false);
  assert.equal(verifyOpenClawManagedExecutionEvidence({
    ...evidence,
    residentSkillCatalogInjectionObserved: true,
  }, expected), false);
  assert.equal(verifyOpenClawManagedExecutionEvidence({
    ...evidence,
    sideEffectTelemetryMode: 'explicit-zero-fields',
  }, expected), false);
});

test('Gateway failure evidence uses route-bound v6 entries', () => {
  const attempt = Object.freeze({
    ...gatewayAttempt(), outcome: 'transient_provider_failure',
    stopReason: 'error', errorClass: 'overloaded', responseTextHash: null,
  });
  const bindingPayload = {
    version: 1,
    kind: 'OpenClawManagedCodexFailureExecutionBinding',
    executionInvocationId: 'codex-exec:12345678-1234-4123-8123-123456789abc',
    originalPromptHash: H('prompt'),
    configurationHash: H('configuration'),
    openClawManagedAuthSourceIdentityHash: H('auth-source'),
    agentId: 'independent-helper',
    principalId: 'principal:test',
    principalRole: 'research-author',
    executionRole: 'writer',
    sandbox: 'workspace-write',
    workspacePathHash: H('workspace'),
    sourceSnapshotHash: H('snapshot'),
    sourceSnapshotFileCount: 1,
    sourceSnapshotBytes: 10,
  };
  const failureExecutionBinding = Object.freeze({
    ...bindingPayload,
    failureExecutionBindingHash: hashRecord(
      'OpenClawManagedCodexFailureExecutionBinding', bindingPayload,
    ),
  });
  const error = Object.assign(new Error(
    'codex_openclaw_managed_transient_provider_response',
  ), {
    code: 'codex_openclaw_managed_transient_provider_response',
    retryable: true,
    attemptTrace: [attempt],
    attemptTraceHash: modelAttemptTraceHash([attempt]),
    runtimeProvenance: FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
    openClawManagedFailureExecutionBinding: failureExecutionBinding,
  });
  const evidence = buildOpenClawManagedFailureEvidence(error);
  const expectedBinding = Object.fromEntries(Object.entries(bindingPayload)
    .filter(([key]) => !['version', 'kind'].includes(key)));
  assert.equal(evidence.version, 6);
  assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
    failureCode: error.code,
    model: 'gpt-5.6-sol',
    expectedAuthBindingMode: 'current-agent-gateway-oauth-route',
    expectedAuthProfileIdentityHash: null,
    expectedGatewayRouteIdentityHash: H('gateway-route'),
    expectedRuntimeProvenanceHash: FIXTURE_OPENCLAW_RUNTIME_PROVENANCE
      .openClawManagedRuntimeProvenanceHash,
    expectedFailureExecutionBinding: expectedBinding,
  }), true);
});
