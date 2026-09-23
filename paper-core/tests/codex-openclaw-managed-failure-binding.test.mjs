import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedOpenClawManagedFailureExecutionBinding,
  OPENCLAW_MANAGED_INVOCATION_ID_ENV,
  OPENCLAW_MANAGED_PRINCIPAL_ID_ENV,
} from '../../paper-adapters/automation/codex-openclaw-managed-failure-execution-binding.mjs';
import {
  buildManagedWorkspaceSnapshot,
  buildOpenClawManagedFailureEvidence,
  executeCodexOpenClawManaged,
  readCodexOpenClawManagedConfiguration,
  verifyOpenClawManagedFailureEvidence,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  modelAttemptTraceHash,
  sha256,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime-common.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
  assistantMessage,
  executionPrompt,
  fixture,
  injectedModelRuntime,
} from './support/codex-openclaw-managed-runtime-fixture.mjs';

test('managed runtime binds failure evidence to the current execution request', async () => {
  const value = fixture();
  const executionInvocationId =
    'codex-exec:00000000-0000-4000-8000-000000000123';
  const principalId = 'codex-research-author:fixture';
  const stdin = executionPrompt(
    'Report the transient provider failure without editing files.',
    { role: 'writer' },
  );
  const environment = {
    ...value.environment,
    [OPENCLAW_MANAGED_INVOCATION_ID_ENV]: executionInvocationId,
    [OPENCLAW_MANAGED_PRINCIPAL_ID_ENV]: principalId,
    HEPTA_AUTOMATION_ROLE: 'writer',
  };
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin,
      environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
        'Our servers are currently overloaded.',
        {
          stopReason: 'error',
          errorCode: 'server_is_overloaded',
          errorType: 'service_unavailable_error',
        },
      )),
    }), (error) => {
      assert.equal(
        error.code,
        'codex_openclaw_managed_transient_provider_response',
      );
      const sensitiveStopReason =
        'error credential=sk-managed-trace-secret /private/provider/token.json';
      const sensitiveTraceReason =
        'provider response credential=sk-managed-reason-secret';
      const unsafeAttemptTrace = error.attemptTrace.map((attempt, index) => (
        index === 0 ? Object.freeze({
          ...attempt,
          stopReason: sensitiveStopReason,
          executionTrace: Object.freeze({
            winnerProvider: 'openai',
            winnerModel: 'gpt-5.6-sol',
            fallbackUsed: false,
            runner: 'embedded',
            attempts: Object.freeze([Object.freeze({
              provider: 'openai',
              model: 'gpt-5.6-sol',
              result: 'failure',
              stage: 'provider',
              reason: sensitiveTraceReason,
            })]),
          }),
        }) : attempt
      ));
      const unsafeError = Object.assign(new Error(error.message), {
        code: error.code,
        retryable: error.retryable,
        attemptTrace: Object.freeze(unsafeAttemptTrace),
        attemptTraceHash: modelAttemptTraceHash(unsafeAttemptTrace),
        runtimeProvenance: error.runtimeProvenance,
        openClawManagedFailureExecutionBinding:
          error.openClawManagedFailureExecutionBinding,
      });
      const evidence = buildOpenClawManagedFailureEvidence(unsafeError);
      const configuration = readCodexOpenClawManagedConfiguration({
        environment,
      });
      const sourceSnapshot = buildManagedWorkspaceSnapshot({
        workspace: value.workspace,
        maximumContextBytes: configuration.maximumContextBytes,
        maximumFileCount: configuration.maximumFileCount,
      });
      const expectedFailureExecutionBinding =
        expectedOpenClawManagedFailureExecutionBinding({
          agentId: configuration.agentId,
          executionInvocationId,
          originalPromptHash: sha256(stdin),
          configurationHash: configuration.configurationHash,
          expectedAuthSourceIdentityHash:
            configuration.openClawManagedAuthSourceIdentityHash,
          principalId,
          principalRole: 'research-author',
          executionRole: 'writer',
          sandbox: 'workspace-write',
          workspace: value.workspace,
          sourceSnapshotHash: sourceSnapshot.snapshotHash,
          sourceSnapshotFileCount: sourceSnapshot.fileCount,
          sourceSnapshotBytes: sourceSnapshot.byteCount,
        });
      const verification = {
        failureCode: error.code,
        model: 'gpt-5.6-sol',
        expectedAuthProfileIdentityHash:
          configuration.openClawManagedAuthProfileIdentityHash,
        expectedRuntimeProvenanceHash:
          FIXTURE_OPENCLAW_RUNTIME_PROVENANCE
            .openClawManagedRuntimeProvenanceHash,
        expectedFailureExecutionBinding,
      };
      assert.equal(evidence.version, 5);
      assert.equal(
        JSON.stringify(evidence).includes(sensitiveStopReason),
        false,
      );
      assert.equal(
        JSON.stringify(evidence).includes(sensitiveTraceReason),
        false,
      );
      assert.deepEqual(evidence.attemptTrace, evidence.attemptUsageEntries);
      assert.equal(
        evidence.failureExecutionBinding.executionInvocationId,
        executionInvocationId,
      );
      assert.equal(verifyOpenClawManagedFailureEvidence(
        evidence,
        verification,
      ), true);
      assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
        ...verification,
        expectedFailureExecutionBinding: null,
      }), false);
      for (const [key, replacement] of [
        ['agentId', 'different-agent'],
        ['sourceSnapshotHash', sha256('different-snapshot')],
        ['sourceSnapshotFileCount', sourceSnapshot.fileCount + 1],
        ['sourceSnapshotBytes', sourceSnapshot.byteCount + 1],
      ]) {
        assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
          ...verification,
          expectedFailureExecutionBinding: {
            ...expectedFailureExecutionBinding,
            [key]: replacement,
          },
        }), false, key);
      }
      assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
        ...verification,
        expectedFailureExecutionBinding: {
          ...expectedFailureExecutionBinding,
          executionInvocationId:
            'codex-exec:00000000-0000-4000-8000-000000000124',
        },
      }), false);
      assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
        ...verification,
        expectedFailureExecutionBinding: {
          ...expectedFailureExecutionBinding,
          originalPromptHash: sha256(`${stdin}\ntampered`),
        },
      }), false);
      const {
        openClawManagedCodexFailureUsageEvidenceHash: _claimedHash,
        ...evidencePayload
      } = evidence;
      const injectedAttemptTrace = evidence.attemptTrace.map((attempt, index) => (
        index === 0 ? { ...attempt, stopReason: sensitiveStopReason } : attempt
      ));
      const injectedPayload = {
        ...evidencePayload,
        attemptTrace: injectedAttemptTrace,
        attemptTraceHash: modelAttemptTraceHash(injectedAttemptTrace),
      };
      const injectedEvidence = {
        ...injectedPayload,
        openClawManagedCodexFailureUsageEvidenceHash: hashRecord(
          'OpenClawManagedCodexFailureUsageEvidence',
          injectedPayload,
        ),
      };
      assert.equal(verifyOpenClawManagedFailureEvidence(
        injectedEvidence,
        verification,
      ), false);
      return true;
    });
  } finally {
    value.cleanup();
  }
});

test('managed availability canary binds failure evidence to its nonce-bearing request', async () => {
  const value = fixture();
  const executionInvocationId =
    'codex-exec:00000000-0000-4000-8000-000000000223';
  const principalId = 'hepta-model-availability-canary';
  const executionRole = 'model-availability-canary';
  const stdin = executionPrompt([
    'HEPTA_CODEX_MODEL_CANARY_CHALLENGE 0123456789abcdef0123456789abcdef.',
    'Add decimal integers 123456 and 234567.',
    'Return exactly one line using prefix HEPTA_CODEX_CANARY_RESPONSE, then a colon, then the decimal sum.',
  ].join(' '), { role: executionRole, sandbox: 'read-only' });
  const environment = {
    ...value.environment,
    [OPENCLAW_MANAGED_INVOCATION_ID_ENV]: executionInvocationId,
    [OPENCLAW_MANAGED_PRINCIPAL_ID_ENV]: principalId,
    HEPTA_AUTOMATION_ROLE: executionRole,
  };
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin,
      environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
        'Our servers are currently overloaded.',
        {
          stopReason: 'error',
          errorCode: 'server_is_overloaded',
          errorType: 'service_unavailable_error',
        },
      )),
    }), (error) => {
      const evidence = buildOpenClawManagedFailureEvidence(error);
      const configuration = readCodexOpenClawManagedConfiguration({ environment });
      const sourceSnapshot = buildManagedWorkspaceSnapshot({
        workspace: value.workspace,
        maximumContextBytes: configuration.maximumContextBytes,
        maximumFileCount: configuration.maximumFileCount,
      });
      const expectedFailureExecutionBinding =
        expectedOpenClawManagedFailureExecutionBinding({
          agentId: configuration.agentId,
          executionInvocationId,
          originalPromptHash: sha256(stdin),
          configurationHash: configuration.configurationHash,
          expectedAuthSourceIdentityHash:
            configuration.openClawManagedAuthSourceIdentityHash,
          principalId,
          principalRole: 'research-author',
          executionRole,
          sandbox: 'read-only',
          workspace: value.workspace,
          sourceSnapshotHash: sourceSnapshot.snapshotHash,
          sourceSnapshotFileCount: sourceSnapshot.fileCount,
          sourceSnapshotBytes: sourceSnapshot.byteCount,
        });
      assert.equal(evidence.version, 5);
      assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
        failureCode: error.code,
        model: 'gpt-5.6-sol',
        expectedAuthProfileIdentityHash:
          configuration.openClawManagedAuthProfileIdentityHash,
        expectedRuntimeProvenanceHash:
          FIXTURE_OPENCLAW_RUNTIME_PROVENANCE.openClawManagedRuntimeProvenanceHash,
        expectedFailureExecutionBinding,
      }), true);
      return true;
    });
  } finally {
    value.cleanup();
  }
});
