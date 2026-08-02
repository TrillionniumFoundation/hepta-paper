import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedOpenClawManagedFailureExecutionBinding,
  OPENCLAW_MANAGED_INVOCATION_ID_ENV,
  OPENCLAW_MANAGED_PRINCIPAL_ID_ENV,
} from '../../paper-adapters/automation/codex-openclaw-managed-failure-execution-binding.mjs';
import {
  buildOpenClawManagedFailureEvidence,
  executeCodexOpenClawManaged,
  readCodexOpenClawManagedConfiguration,
  verifyOpenClawManagedFailureEvidence,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  sha256,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime-common.mjs';
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
      const evidence = buildOpenClawManagedFailureEvidence(error);
      const configuration = readCodexOpenClawManagedConfiguration({
        environment,
      });
      const expectedFailureExecutionBinding =
        expectedOpenClawManagedFailureExecutionBinding({
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
      return true;
    });
  } finally {
    value.cleanup();
  }
});
