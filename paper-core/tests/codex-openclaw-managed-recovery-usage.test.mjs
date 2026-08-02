import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildOpenClawManagedFailureEvidence,
  executeCodexOpenClawManaged,
  OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
  readCodexOpenClawManagedConfiguration,
  verifyOpenClawManagedExecutionEvidence,
  verifyOpenClawManagedFailureEvidence,
  verifyCodexOpenClawManagedLogin,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTH_PROFILE_ID,
  FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
  assistantMessage,
  assertCompleteManagedFailureUsage,
  assertIncompleteManagedFailureUsage,
  assertManagedRuntimeClean,
  executionPrompt,
  fixture,
  injectedModelRuntime,
} from './support/codex-openclaw-managed-runtime-fixture.mjs';

const EXPECTED_RUNTIME_PROVENANCE_HASH =
  FIXTURE_OPENCLAW_RUNTIME_PROVENANCE.openClawManagedRuntimeProvenanceHash;

function withRuntimeBindings(provenance, moduleBindings) {
  const {
    openClawManagedRuntimeProvenanceHash: _claimedHash,
    ...payload
  } = provenance;
  const changed = { ...payload, moduleBindings };
  return {
    ...changed,
    openClawManagedRuntimeProvenanceHash: hashRecord(
      'OpenClawManagedCodexRuntimeProvenance',
      changed,
    ),
  };
}

function withExecutionRuntimeProvenance(evidence, runtimeProvenance) {
  const {
    openClawManagedCodexExecutionHash: _claimedHash,
    ...payload
  } = evidence;
  const changed = {
    ...payload,
    openClawManagedRuntimeProvenance: runtimeProvenance,
  };
  return {
    ...changed,
    openClawManagedCodexExecutionHash: hashRecord(
      'OpenClawManagedCodexAppServerExecution',
      changed,
    ),
  };
}

test('managed cleanup marks entry disappearance retryable only after residue verification', async () => {
  const clean = fixture();
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', clean.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: clean.environment,
      modelRuntimeLoader: injectedModelRuntime(async (_options, controls) => {
        controls.deleteSessionEntry();
        return assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42');
      }),
    }), (error) => {
      assert.equal(
        error.code,
        'codex_openclaw_managed_session_cleanup_entry_disappeared_after_residue_verification',
      );
      assert.equal(error.retryable, true);
      return true;
    });
    assertManagedRuntimeClean(clean);
  } finally {
    clean.cleanup();
  }

  const residue = fixture();
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', residue.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: residue.environment,
      modelRuntimeLoader: injectedModelRuntime(async (options, controls) => {
        controls.deleteSessionEntry();
        controls.writeUnexpectedArtifact(`${options.sessionId}.unexpected`);
        return assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42');
      }),
    }), (error) => {
      assert.equal(
        error.code,
        'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
      );
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    residue.cleanup();
  }
});

test('managed cleanup failures preserve unknown usage evidence from returned responses', async (context) => {
  await context.test('invalid usage plus artifact residue', async () => {
    const value = fixture();
    try {
      await assert.rejects(() => executeCodexOpenClawManaged({
        args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        modelRuntimeLoader: injectedModelRuntime(async (_options, controls) => {
          controls.writeUnexpectedArtifact();
          return assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42', {
            usage: { total: 5 },
          });
        }),
      }), (error) => assertIncompleteManagedFailureUsage(
        error,
        value.environment,
        'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
      ));
      assert.equal(fs.readdirSync(value.internalRunsDir).length, 1);
    } finally {
      value.cleanup();
    }
  });

  await context.test('missing usage plus verified entry disappearance', async () => {
    const value = fixture();
    try {
      await assert.rejects(() => executeCodexOpenClawManaged({
        args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        modelRuntimeLoader: injectedModelRuntime(async (_options, controls) => {
          controls.deleteSessionEntry();
          return assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42', {
            omitUsage: true,
          });
        }),
      }), (error) => assertIncompleteManagedFailureUsage(
        error,
        value.environment,
        'codex_openclaw_managed_session_cleanup_entry_disappeared_after_residue_verification',
      ));
      assertManagedRuntimeClean(value);
    } finally {
      value.cleanup();
    }
  });
});

test('managed no-response failures stop after the first unknown-usage attempt', async (context) => {
  const cases = [
    {
      name: 'transient agent-command failure with successful cleanup',
      expectedCode: 'codex_openclaw_managed_transient_provider_response',
      expectedErrorClass: 'overloaded',
      completion: async () => {
        const error = new Error('fixture transient provider transport failure');
        error.code = 'server_is_overloaded';
        error.type = 'service_unavailable_error';
        throw error;
      },
      timeoutMs: 5000,
    },
    {
      name: 'timeout with successful cleanup',
      expectedCode: 'codex_openclaw_managed_model_timeout',
      expectedErrorClass: 'aborted',
      completion: async (options) => await new Promise((resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          const error = new Error('fixture model timeout');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
      timeoutMs: 50,
    },
  ];
  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const value = fixture();
      let calls = 0;
      try {
        await assert.rejects(() => executeCodexOpenClawManaged({
          args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
          stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
          environment: value.environment,
          timeoutMs: candidate.timeoutMs,
          modelRuntimeLoader: injectedModelRuntime(async (options, controls) => {
            calls += 1;
            return await candidate.completion(options, controls);
          }),
        }), (error) => assertIncompleteManagedFailureUsage(
          error,
          value.environment,
          candidate.expectedCode,
          { errorClass: candidate.expectedErrorClass },
        ));
        assert.equal(calls, 1);
        assertManagedRuntimeClean(value);
      } finally {
        value.cleanup();
      }
    });
  }
});

test('managed execution preserves blocked business results but rejects incomplete responses', async () => {
  const value = fixture();
  try {
    const blocked = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Update main.tex.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(JSON.stringify({
        status: 'blocked',
        summary: 'cannot continue',
        edits: [{ path: 'main.tex', content: 'changed\n' }],
        checksRun: [],
        blockers: ['missing evidence'],
      }))),
    });
    assert.deepEqual(blocked.changedPaths, ['main.tex']);
    const blockedOutput = JSON.parse(blocked.stdout);
    const {
      [OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD]: blockedManagedEvidence,
      ...blockedRoleOutput
    } = blockedOutput;
    assert.deepEqual(blockedRoleOutput, {
      status: 'blocked',
      summary: 'cannot continue',
      checksRun: [],
      blockers: ['missing evidence'],
    });
    assert.deepEqual(blockedManagedEvidence, blocked.managedAuth);
    fs.writeFileSync(path.join(value.workspace, 'main.tex'), 'before\n');
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Update main.tex.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(JSON.stringify({
        status: 'completed',
        summary: 'missing blockers',
        edits: [{ path: 'main.tex', content: 'changed\n' }],
        checksRun: [],
      }))),
    }), (error) => assertCompleteManagedFailureUsage(
      error,
      value.environment,
      'codex_openclaw_managed_structured_output_invalid',
    ));
    assert.equal(fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8'), 'before\n');
  } finally {
    value.cleanup();
  }
});

test('managed read-only execution rejects a model edit before workspace mutation', async () => {
  const value = fixture();
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Review only.', {
        role: 'formal-review',
        sandbox: 'read-only',
      }),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(JSON.stringify({
        status: 'completed',
        summary: 'bad edit',
        edits: [{ path: 'main.tex', content: 'changed\n' }],
        checksRun: [],
        blockers: [],
      }))),
    }), (error) => assertCompleteManagedFailureUsage(
      error,
      value.environment,
      'codex_openclaw_managed_read_only_edit_forbidden',
    ));
    assert.equal(fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8'), 'before\n');
  } finally {
    value.cleanup();
  }
});

test('managed execution rejects workspace preimage drift before applying model edits', async () => {
  const value = fixture();
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Update main.tex.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => {
        fs.writeFileSync(path.join(value.workspace, 'main.tex'), 'concurrent\n');
        return assistantMessage(JSON.stringify({
          status: 'completed',
          summary: 'updated',
          edits: [{ path: 'main.tex', content: 'model\n' }],
          checksRun: [],
          blockers: [],
        }));
      }),
    }), (error) => assertCompleteManagedFailureUsage(
      error,
      value.environment,
      'codex_openclaw_managed_workspace_snapshot_changed',
    ));
    assert.equal(
      fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8'),
      'concurrent\n',
    );
  } finally {
    value.cleanup();
  }
});

test('managed post-model parsing, configuration, edit, and canary failures preserve usage evidence', async (context) => {
  const cases = [
    {
      name: 'malformed JSON',
      failureCode: 'codex_openclaw_managed_structured_output_invalid',
      response: () => assistantMessage('not-json'),
    },
    {
      name: 'configuration drift',
      failureCode: 'codex_openclaw_managed_configuration_changed',
      response: (value) => {
        const managedConfigPath = path.join(value.home, 'config.toml');
        fs.writeFileSync(
          managedConfigPath,
          fs.readFileSync(managedConfigPath, 'utf8').replace(
            'maximum_file_count = 96',
            'maximum_file_count = 95',
          ),
        );
        return assistantMessage(JSON.stringify({
          status: 'completed',
          summary: 'configuration changed after the call',
          edits: [],
          checksRun: [],
          blockers: [],
        }));
      },
    },
    {
      name: 'duplicate edit materialization policy',
      failureCode: 'codex_openclaw_managed_duplicate_edit',
      response: () => assistantMessage(JSON.stringify({
        status: 'completed',
        summary: 'duplicate edit must be rejected',
        edits: [
          { path: 'main.tex', content: 'first\n' },
          { path: 'main.tex', content: 'second\n' },
        ],
        checksRun: [],
        blockers: [],
      })),
    },
  ];
  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const value = fixture();
      try {
        await assert.rejects(() => executeCodexOpenClawManaged({
          args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
          stdin: executionPrompt('Report completion without unsafe changes.'),
          environment: value.environment,
          modelRuntimeLoader: injectedModelRuntime(
            async () => candidate.response(value),
          ),
        }), (error) => assertCompleteManagedFailureUsage(
          error,
          value.environment,
          candidate.failureCode,
        ));
      } finally {
        value.cleanup();
      }
    });
  }

  await context.test('invalid canary response', async () => {
    const value = fixture();
    try {
      await assert.rejects(() => executeCodexOpenClawManaged({
        args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        modelRuntimeLoader: injectedModelRuntime(
          async () => assistantMessage('invalid canary response'),
        ),
      }), (error) => assertCompleteManagedFailureUsage(
        error,
        value.environment,
        'codex_openclaw_managed_canary_response_invalid',
      ));
    } finally {
      value.cleanup();
    }
  });
});

test('managed live canary preserves the native Codex canary response contract', async () => {
  const value = fixture();
  try {
    const result = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(
        async () => assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42'),
      ),
    });
    assert.equal(result.stdout, 'HEPTA_CODEX_CANARY_RESPONSE:42\n');
    assert.deepEqual(result.changedPaths, []);
  } finally {
    value.cleanup();
  }
});

test('managed model retries overload high then medium with fresh user-locked sessions and a hashed trace', async () => {
  const value = fixture();
  const prepareCalls = [];
  const completionCalls = [];
  try {
    const stdin = executionPrompt('Return a completed result without changing files.');
    const result = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin,
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => (
        completionCalls.length === 1
          ? assistantMessage('Our servers are currently overloaded.', {
            stopReason: 'error',
            errorCode: 'server_is_overloaded',
            errorType: 'service_unavailable_error',
          })
          : assistantMessage(JSON.stringify({
            status: 'completed',
            summary: 'completed after overload',
            edits: [],
            checksRun: [],
            blockers: [],
          }))
      ), {
        onPrepare(options) { prepareCalls.push(options); },
        onCompletion(options) { completionCalls.push(options); },
      }),
    });
    assert.deepEqual(result.changedPaths, []);
    assert.equal(JSON.parse(result.stdout).status, 'completed');
    assert.equal(prepareCalls.length, 1);
    assert.deepEqual(
      prepareCalls[0].externalCliProfileIds,
      [AUTH_PROFILE_ID],
    );
    assert.equal(completionCalls.length, 2);
    assert.deepEqual(
      completionCalls.map((call) => call.provider),
      ['openai', 'openai'],
    );
    assert.deepEqual(
      completionCalls.map((call) => call.thinking),
      ['high', 'medium'],
    );
    assert.equal(
      new Set(completionCalls.map((call) => call.sessionId)).size,
      2,
    );
    assert.ok(completionCalls.every(
      (call) => call.sessionId === call.runId
        && call.sessionKey.endsWith(call.sessionId),
    ));
    assertManagedRuntimeClean(value);
    assert.equal(result.managedAuth.modelAttemptCount, 2);
    assert.equal(result.managedAuth.attemptTrace.length, 2);
    assert.deepEqual(
      result.managedAuth.attemptTrace.map((attempt) => attempt.attemptNumber),
      [1, 2],
    );
    assert.deepEqual(
      result.managedAuth.attemptTrace.map((attempt) => attempt.thinking),
      ['high', 'medium'],
    );
    assert.deepEqual(
      result.managedAuth.attemptTrace.map((attempt) => attempt.outcome),
      ['transient_provider_failure', 'completed'],
    );
    assert.equal(result.managedAuth.attemptTrace[0].stopReason, 'error');
    assert.equal(result.managedAuth.attemptTrace[0].errorClass, 'overloaded');
    assert.equal(result.managedAuth.attemptTrace[1].stopReason, 'stop');
    for (const attempt of result.managedAuth.attemptTrace) {
      assert.equal(attempt.provider, 'openai');
      assert.equal(attempt.model, 'gpt-5.6-sol');
      assert.equal(
        attempt.authProfileIdentityHash,
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      );
      assert.match(attempt.attemptId, /^[a-z0-9][a-z0-9:._-]+$/);
      assert.equal(
        attempt.sessionBindingBeforeHash,
        attempt.sessionBindingAfterHash,
      );
      assert.equal(attempt.sessionCleanupVerified, true);
      assert.equal(attempt.runtimeFallbackUsed, false);
      assert.equal(attempt.executionTrace.runner, 'embedded');
      assert.deepEqual(attempt.usage, {
        input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      });
      assert.equal(attempt.usageHash, hashRecord(
        'OpenClawManagedCodexAppServerAttemptUsage',
        { attemptId: attempt.attemptId, usage: attempt.usage },
      ));
      assert.equal(JSON.stringify(attempt).includes(AUTH_PROFILE_ID), false);
    }
    assert.deepEqual(result.managedAuth.usage, {
      input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
    });
    assert.equal(result.managedAuth.attemptTrace[0].responseTextHash, null);
    assert.match(
      result.managedAuth.attemptTrace[0].responseErrorHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(
      result.managedAuth.attemptTrace[1].responseTextHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(
      result.managedAuth.successfulAttemptId,
      result.managedAuth.attemptTrace[1].attemptId,
    );
    assert.equal(
      result.managedAuth.completionInvocationId,
      `openclaw-codex-app-server:${result.managedAuth.successfulAttemptId}`,
    );
    assert.equal(
      result.managedAuth.successfulResponseHash,
      result.managedAuth.attemptTrace[1].responseTextHash,
    );
    assert.equal(
      result.managedAuth.attemptTraceHash,
      hashRecord('OpenClawManagedCodexAppServerAttemptTrace', {
        attempts: result.managedAuth.attemptTrace,
      }),
    );
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: [],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), true);
    const {
      openClawManagedCodexExecutionHash: _managedExecutionHash,
      ...managedEvidencePayload
    } = result.managedAuth;
    const legacyAttemptTrace = managedEvidencePayload.attemptTrace.map((attempt) => {
      const { usage: _usage, usageHash: _usageHash, ...legacyAttempt } = attempt;
      return legacyAttempt;
    });
    const { usage: _usage, usageHash: _usageHash, ...legacyEvidenceBase } = managedEvidencePayload;
    const legacyPayload = {
      ...legacyEvidenceBase,
      version: 4,
      attemptTrace: legacyAttemptTrace,
      attemptTraceHash: hashRecord('OpenClawManagedCodexAppServerAttemptTrace', {
        attempts: legacyAttemptTrace,
      }),
    };
    const legacyEvidence = {
      ...legacyPayload,
      openClawManagedCodexExecutionHash: hashRecord(
        'OpenClawManagedCodexAppServerExecution', legacyPayload,
      ),
    };
    const legacyVerificationInput = {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: [],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    };
    const {
      expectedRuntimeProvenanceHash: _runtimeExpectation,
      ...missingRuntimeExpectation
    } = legacyVerificationInput;
    assert.equal(verifyOpenClawManagedExecutionEvidence(
      result.managedAuth,
      missingRuntimeExpectation,
    ), false);
    const {
      openClawManagedRuntimeProvenance: _runtimeProvenance,
      ...missingRuntimePayload
    } = managedEvidencePayload;
    assert.equal(verifyOpenClawManagedExecutionEvidence({
      ...missingRuntimePayload,
      openClawManagedCodexExecutionHash: hashRecord(
        'OpenClawManagedCodexAppServerExecution',
        missingRuntimePayload,
      ),
    }, legacyVerificationInput), false);
    const runtimeBindings = result.managedAuth
      .openClawManagedRuntimeProvenance.moduleBindings;
    const contentTamperedProvenance = withRuntimeBindings(
      result.managedAuth.openClawManagedRuntimeProvenance,
      runtimeBindings.map((binding, index) => (index === 0
        ? { ...binding, runtimeFileContentHash: `sha256:${'0'.repeat(64)}` }
        : binding)),
    );
    assert.equal(verifyOpenClawManagedExecutionEvidence(
      withExecutionRuntimeProvenance(
        result.managedAuth,
        contentTamperedProvenance,
      ),
      legacyVerificationInput,
    ), false);
    const aliasTamperedProvenance = withRuntimeBindings(
      result.managedAuth.openClawManagedRuntimeProvenance,
      runtimeBindings.map((binding, index) => (
        index < 2 ? {
          ...binding,
          runtimeRole: runtimeBindings[1 - index].runtimeRole,
        } : binding
      )),
    );
    assert.equal(verifyOpenClawManagedExecutionEvidence(
      withExecutionRuntimeProvenance(
        result.managedAuth,
        aliasTamperedProvenance,
      ),
      legacyVerificationInput,
    ), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence(
      legacyEvidence,
      legacyVerificationInput,
    ), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence(legacyEvidence, {
      ...legacyVerificationInput,
      allowLegacyVersion4: true,
    }), true);
    const invalidUsagePayload = {
      ...managedEvidencePayload,
      usage: { ...managedEvidencePayload.usage, totalTokens: -1 },
    };
    assert.equal(verifyOpenClawManagedExecutionEvidence({
      ...invalidUsagePayload,
      openClawManagedCodexExecutionHash: hashRecord(
        'OpenClawManagedCodexAppServerExecution',
        invalidUsagePayload,
      ),
    }, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: [],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), false);
    const { usage: _strippedUsage, usageHash: _strippedUsageHash,
      ...strippedUsagePayload } = managedEvidencePayload;
    assert.equal(verifyOpenClawManagedExecutionEvidence({
      ...strippedUsagePayload,
      openClawManagedCodexExecutionHash: hashRecord(
        'OpenClawManagedCodexAppServerExecution', strippedUsagePayload,
      ),
    }, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol', changedPaths: [],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), false);
  } finally {
    value.cleanup();
  }
});

test('managed usage canonicalizes the three cache-inclusive OpenAI shapes observed in campaign 48', async (context) => {
  const cases = [
    { input: 33020, cacheRead: 7936, output: 1068, total: 34088 },
    { input: 33020, cacheRead: 7936, output: 1135, total: 34155 },
    { input: 33031, cacheRead: 7936, output: 1359, total: 34390 },
  ];
  for (const [index, usage] of cases.entries()) {
    await context.test(`campaign 48 attempt ${index + 1}`, async () => {
      const value = fixture();
      try {
        const stdin = executionPrompt('Report completion without editing files.');
        const result = await executeCodexOpenClawManaged({
          args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
          stdin,
          environment: value.environment,
          modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
            JSON.stringify({
              status: 'completed',
              summary: 'completed with cache-inclusive OpenAI usage',
              edits: [],
              checksRun: [],
              blockers: [],
            }),
            { usage },
          )),
        });
        const canonical = {
          input: usage.input - usage.cacheRead,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: 0,
          totalTokens: usage.total,
        };
        assert.deepEqual(result.managedAuth.usage, canonical);
        assert.deepEqual(result.managedAuth.attemptTrace[0].usage, canonical);
        assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
          originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
          model: 'gpt-5.6-sol',
          changedPaths: [],
          expectedConfigurationHash: result.managedAuth.configurationHash,
          expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
          expectedAuthProfileIdentityHash:
            result.managedAuth.openClawManagedAuthProfileIdentityHash,
          expectedAuthSourceIdentityHash:
            result.managedAuth.openClawManagedAuthSourceIdentityHash,
        }), true);
      } finally {
        value.cleanup();
      }
    });
  }
});

test('managed usage preserves native cache-exclusive OpenClaw accounting', async () => {
  const value = fixture();
  try {
    const result = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Report completion without editing files.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
        JSON.stringify({
          status: 'completed', summary: 'completed', edits: [], checksRun: [], blockers: [],
        }),
        { usage: { input: 9586, output: 5, cacheRead: 5888, total: 15479 } },
      )),
    });
    assert.deepEqual(result.managedAuth.usage, {
      input: 9586,
      output: 5,
      cacheRead: 5888,
      cacheWrite: 0,
      totalTokens: 15479,
    });
  } finally {
    value.cleanup();
  }
});

test('managed usage accepts an uncached OpenClaw total with omitted zero cache fields', async () => {
  const value = fixture();
  try {
    const result = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Report completion without editing files.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
        JSON.stringify({
          status: 'completed', summary: 'completed', edits: [], checksRun: [], blockers: [],
        }),
        {
          usage: {
            input: 15359,
            output: 15,
            cacheRead: undefined,
            cacheWrite: undefined,
            total: 15374,
          },
        },
      )),
    });
    assert.deepEqual(result.managedAuth.usage, {
      input: 15359,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15374,
    });
  } finally {
    value.cleanup();
  }
});

test('managed usage rejects incomplete or zero response accounting with explicit unknown-usage evidence', async (context) => {
  const cases = [
    {
      name: 'zero output omitted',
      usage: { input: 100, output: undefined, total: 100 },
    },
    {
      name: 'zero input omitted',
      usage: { input: undefined, output: 5, total: 5 },
    },
    {
      name: 'total only',
      usage: { total: 5 },
    },
    {
      name: 'all zero',
      usage: { input: 0, output: 0, total: 0 },
    },
    {
      name: 'invalid usage with observed external delivery',
      usage: { total: 5 },
      externalDelivery: true,
    },
  ];
  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const value = fixture();
      try {
        await assert.rejects(() => executeCodexOpenClawManaged({
          args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
          stdin: executionPrompt('Report completion without editing files.'),
          environment: value.environment,
          modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
            JSON.stringify({
              status: 'completed', summary: 'completed', edits: [], checksRun: [], blockers: [],
            }),
            {
              usage: candidate.usage,
              externalDelivery: candidate.externalDelivery === true,
            },
          )),
        }), (error) => {
          assert.equal(error.code, 'codex_openclaw_managed_usage_invalid');
          assert.equal(error.retryable, false);
          assert.equal(Object.hasOwn(error, 'usage'), false);
          const evidence = buildOpenClawManagedFailureEvidence(error);
          assert.equal(evidence.version, 4);
          assert.equal(evidence.usageComplete, false);
          assert.equal(evidence.usage, null);
          assert.equal(evidence.externalModelInvocationPerformed, true);
          assert.equal(
            evidence.externalActionPerformed,
            candidate.externalDelivery === true ? true : false,
          );
          assert.equal(
            evidence.externalSideEffectPerformed,
            candidate.externalDelivery === true ? true : false,
          );
          const configuration = readCodexOpenClawManagedConfiguration({
            environment: value.environment,
          });
          assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
            failureCode: error.code,
            model: 'gpt-5.6-sol',
            expectedAuthProfileIdentityHash:
              configuration.openClawManagedAuthProfileIdentityHash,
            expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
          }), true);
          return true;
        });
      } finally {
        value.cleanup();
      }
    });
  }
});

test('managed usage-invalid evidence preserves the known lower bound from earlier attempts', async () => {
  const value = fixture();
  let calls = 0;
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Report completion without editing files.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => {
        calls += 1;
        return calls === 1
          ? assistantMessage('Our servers are currently overloaded.', {
            stopReason: 'error',
            errorCode: 'server_is_overloaded',
            errorType: 'service_unavailable_error',
          })
          : assistantMessage(JSON.stringify({
            status: 'completed',
            summary: 'the final response omitted component accounting',
            edits: [],
            checksRun: [],
            blockers: [],
          }), { usage: { total: 5 } });
      }),
    }), (error) => {
      assert.equal(error.code, 'codex_openclaw_managed_usage_invalid');
      assert.equal(Object.hasOwn(error, 'usage'), false);
      const evidence = buildOpenClawManagedFailureEvidence(error);
      assert.equal(evidence.version, 4);
      assert.equal(evidence.modelAttemptCount, 2);
      assert.equal(evidence.usageComplete, false);
      assert.deepEqual(evidence.usage, {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
      });
      assert.deepEqual(
        evidence.attemptUsageEntries.map((entry) => entry.usageCompleteness),
        ['complete', 'unknown_invalid'],
      );
      const configuration = readCodexOpenClawManagedConfiguration({
        environment: value.environment,
      });
      assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
        failureCode: error.code,
        model: 'gpt-5.6-sol',
        expectedAuthProfileIdentityHash:
          configuration.openClawManagedAuthProfileIdentityHash,
        expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      }), true);
      return true;
    });
    assert.equal(calls, 2);
  } finally {
    value.cleanup();
  }
});

test('managed usage preserves cumulative components when OpenClaw reports only the last-call total', async () => {
  const value = fixture();
  try {
    const result = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Report completion without editing files.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
        JSON.stringify({
          status: 'completed', summary: 'completed', edits: [], checksRun: [], blockers: [],
        }),
        {
          usage: { input: 66040, output: 2203, cacheRead: 15872, total: 34155 },
          lastCallUsage: { input: 33020, output: 1135, cacheRead: 7936, total: 34155 },
        },
      )),
    });
    assert.deepEqual(result.managedAuth.usage, {
      input: 50168,
      output: 2203,
      cacheRead: 15872,
      cacheWrite: 0,
      totalTokens: 68243,
    });
  } finally {
    value.cleanup();
  }
});

test('managed usage rejects unexplained or tampered aggregate totals', async (context) => {
  const cases = [
    {
      name: 'missing last-call usage',
      usage: { input: 66040, output: 2203, cacheRead: 15872, total: 34155 },
      lastCallUsage: null,
    },
    {
      name: 'last-call total mismatch',
      usage: { input: 66040, output: 2203, cacheRead: 15872, total: 34155 },
      lastCallUsage: { input: 33020, output: 1068, cacheRead: 7936, total: 34088 },
    },
    {
      name: 'last-call component exceeds cumulative component',
      usage: { input: 66040, output: 2203, cacheRead: 15872, total: 34155 },
      lastCallUsage: { input: 33020, output: 1135, cacheRead: 15873, total: 34155 },
    },
    {
      name: 'conflicting total alias',
      usage: {
        input: 66040, output: 2203, cacheRead: 15872,
        total: 34155, totalTokens: 68243,
      },
      lastCallUsage: { input: 33020, output: 1135, cacheRead: 7936, total: 34155 },
    },
    {
      name: 'non-additive last-call usage',
      usage: { input: 66040, output: 2203, cacheRead: 15872, total: 34155 },
      lastCallUsage: { input: 33020, output: 1135, cacheRead: 7936, total: 34154 },
    },
    {
      name: 'cache read exceeds inclusive input',
      usage: { input: 7000, output: 100, cacheRead: 7936, total: 7100 },
      lastCallUsage: null,
    },
    {
      name: 'exact aggregate contradicts last-call input semantics',
      usage: { input: 9586, output: 5, cacheRead: 5888, total: 15479 },
      lastCallUsage: { input: 100, output: 5, cacheRead: 50, total: 105 },
    },
    {
      name: 'exact aggregate is smaller than the last call',
      usage: { input: 100, output: 5, cacheRead: 50, total: 105 },
      lastCallUsage: { input: 101, output: 5, cacheRead: 50, total: 106 },
    },
    {
      name: 'cached cumulative usage with an uncached last call is ambiguous',
      usage: { input: 33120, output: 1073, cacheRead: 7936, total: 105 },
      lastCallUsage: { input: 100, output: 5, cacheRead: 0, total: 105 },
    },
  ];
  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const value = fixture();
      try {
        await assert.rejects(() => executeCodexOpenClawManaged({
          args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
          stdin: executionPrompt('Report completion without editing files.'),
          environment: value.environment,
          modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
            JSON.stringify({
              status: 'completed',
              summary: 'usage must remain fail closed',
              edits: [],
              checksRun: [],
              blockers: [],
            }),
            candidate,
          )),
        }), (error) => {
          assert.equal(error.message, 'codex_openclaw_managed_usage_invalid');
          assert.equal(error.retryable, false);
          return true;
        });
      } finally {
        value.cleanup();
      }
    });
  }
});

test('managed structured execution retries an incomplete turn with fresh user-locked session evidence', async () => {
  const value = fixture();
  const prepareCalls = [];
  const completionCalls = [];
  try {
    const stdin = executionPrompt('Update main.tex after a transient incomplete turn.');
    const result = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin,
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => (
        completionCalls.length === 1
          ? assistantMessage('⚠️ Agent couldn\'t generate a response. Please try again.', {
            stopReason: 'error',
            errorCode: 'incomplete_turn',
            errorType: 'incomplete_turn',
          })
          : assistantMessage(JSON.stringify({
            status: 'completed',
            summary: 'updated after retry',
            edits: [{ path: 'main.tex', content: 'after retry\n' }],
            checksRun: [],
            blockers: [],
          }))
      ), {
        onPrepare(options) { prepareCalls.push(options); },
        onCompletion(options) { completionCalls.push(options); },
      }),
    });
    assert.equal(fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8'), 'after retry\n');
    assert.deepEqual(result.changedPaths, ['main.tex']);
    assert.equal(prepareCalls.length, 1);
    assert.equal(completionCalls.length, 2);
    assert.deepEqual(
      prepareCalls[0].externalCliProfileIds,
      [AUTH_PROFILE_ID],
    );
    assert.deepEqual(
      completionCalls.map((call) => call.thinking),
      ['high', 'medium'],
    );
    assert.equal(
      new Set(completionCalls.map((call) => call.sessionId)).size,
      2,
    );
    assertManagedRuntimeClean(value);
    assert.equal(result.managedAuth.modelAttemptCount, 2);
    assert.equal(
      result.managedAuth.successfulAttemptId,
      result.managedAuth.attemptTrace[1].attemptId,
    );
    assert.equal(
      result.managedAuth.successfulResponseHash,
      result.managedAuth.attemptTrace[1].responseTextHash,
    );
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), true);
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedConfigurationHash: `sha256:${'0'.repeat(64)}`,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash: `sha256:${'0'.repeat(64)}`,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
    }), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence(result.managedAuth, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash: `sha256:${'0'.repeat(64)}`,
    }), false);
    assert.equal(verifyOpenClawManagedExecutionEvidence({
      ...result.managedAuth,
      attemptTrace: result.managedAuth.attemptTrace.map((attempt, index) => (
        index === 0 ? { ...attempt, thinking: 'low' } : attempt
      )),
    }, {
      originalPromptHash: `sha256:${crypto.createHash('sha256').update(stdin).digest('hex')}`,
      model: 'gpt-5.6-sol',
      changedPaths: ['main.tex'],
      expectedConfigurationHash: result.managedAuth.configurationHash,
      expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      expectedAuthProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      expectedAuthSourceIdentityHash:
        result.managedAuth.openClawManagedAuthSourceIdentityHash,
    }), false);
    assert.equal(result.managedAuth.thinkingStrategy, 'high-medium-low');
    assert.equal(result.managedAuth.resolvedThinkingLevel, 'medium');
  } finally {
    value.cleanup();
  }
});

test('managed model preserves a structured business blocker mentioning a non-deliverable turn', async () => {
  const value = fixture();
  let completionCalls = 0;
  try {
    const result = await executeCodexOpenClawManaged({
      args: ['--sandbox', 'workspace-write', '--cd', value.workspace, '-'],
      stdin: executionPrompt('Report the blocker without editing files.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => {
        completionCalls += 1;
        return assistantMessage(JSON.stringify({
          status: 'blocked',
          summary: 'Evidence records non_deliverable_terminal_turn, context overflow, quota, and temporary overload.',
          edits: [],
          checksRun: [],
          blockers: ['The provider quota phrase is a business diagnostic, not a transport result.'],
        }));
      }),
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'blocked');
    assert.deepEqual(output.blockers, [
      'The provider quota phrase is a business diagnostic, not a transport result.',
    ]);
    assert.equal(completionCalls, 1);
    assert.equal(result.managedAuth.modelAttemptCount, 1);
  } finally {
    value.cleanup();
  }
});

test('managed model exhausts exactly three overloads high medium low without profile fallback', async () => {
  const value = fixture();
  const prepareCalls = [];
  const completionCalls = [];
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => (
        assistantMessage('Our servers are currently overloaded.', {
          stopReason: 'error',
          errorCode: 'server_is_overloaded',
          errorType: 'service_unavailable_error',
        })
      ), {
        onPrepare(options) { prepareCalls.push(options); },
        onCompletion(options) { completionCalls.push(options); },
      }),
    }), (error) => {
      assert.equal(error.message, 'codex_openclaw_managed_transient_provider_response');
      assert.deepEqual(error.usage, {
        input: 30, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 60,
      });
      const evidence = buildOpenClawManagedFailureEvidence(error);
      const configuration = readCodexOpenClawManagedConfiguration({
        environment: value.environment,
      });
      assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
        failureCode: error.message,
        model: 'gpt-5.6-sol',
        expectedAuthProfileIdentityHash:
          configuration.openClawManagedAuthProfileIdentityHash,
        expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      }), true);
      const tampered = {
        ...evidence,
        usage: { ...evidence.usage, totalTokens: 59 },
      };
      assert.equal(verifyOpenClawManagedFailureEvidence({
        ...tampered,
        openClawManagedCodexFailureUsageEvidenceHash: hashRecord(
          'OpenClawManagedCodexFailureUsageEvidence',
          Object.fromEntries(Object.entries(tampered).filter(
            ([key]) => key !== 'openClawManagedCodexFailureUsageEvidenceHash',
          )),
        ),
      }, {
        failureCode: error.message,
        model: 'gpt-5.6-sol',
        expectedAuthProfileIdentityHash:
          configuration.openClawManagedAuthProfileIdentityHash,
        expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      }), false);
      const traceTampered = {
        ...evidence,
        attemptTraceHash: `sha256:${'0'.repeat(64)}`,
      };
      assert.equal(verifyOpenClawManagedFailureEvidence({
        ...traceTampered,
        openClawManagedCodexFailureUsageEvidenceHash: hashRecord(
          'OpenClawManagedCodexFailureUsageEvidence',
          Object.fromEntries(Object.entries(traceTampered).filter(
            ([key]) => key !== 'openClawManagedCodexFailureUsageEvidenceHash',
          )),
        ),
      }, {
        failureCode: error.message,
        model: 'gpt-5.6-sol',
        expectedAuthProfileIdentityHash:
          configuration.openClawManagedAuthProfileIdentityHash,
        expectedRuntimeProvenanceHash: EXPECTED_RUNTIME_PROVENANCE_HASH,
      }), false);
      return true;
    });
    assert.equal(prepareCalls.length, 1);
    assert.equal(completionCalls.length, 3);
    assert.deepEqual(
      prepareCalls[0].externalCliProfileIds,
      [AUTH_PROFILE_ID],
    );
    assert.deepEqual(
      completionCalls.map((call) => call.provider),
      Array(3).fill('openai'),
    );
    assert.deepEqual(
      completionCalls.map((call) => call.thinking),
      ['high', 'medium', 'low'],
    );
    assert.equal(
      new Set(completionCalls.map((call) => call.sessionId)).size,
      3,
    );
    assertManagedRuntimeClean(value);
    assert.equal(
      [...prepareCalls, ...completionCalls].some(
        (call) => JSON.stringify(call).includes('openai:other'),
      ),
      false,
    );
  } finally {
    value.cleanup();
  }
});

test('managed login verifies the configured profile in the bound OpenClaw source without invoking agent command', async () => {
  const value = fixture();
  const prepareCalls = [];
  let completionCalls = 0;
  let disposeCalls = 0;
  try {
    const result = await verifyCodexOpenClawManagedLogin({
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => {
        completionCalls += 1;
        return assistantMessage('completion must not run');
      }, {
        onPrepare(options) { prepareCalls.push(options); },
        onDispose() { disposeCalls += 1; },
      }),
    });
    assert.equal(result.agentId, 'hepta-paper-worker');
    assert.equal(prepareCalls.length, 1);
    assert.deepEqual(
      prepareCalls[0].externalCliProfileIds,
      [AUTH_PROFILE_ID],
    );
    assert.equal(prepareCalls[0].requestedAgentDir, value.agentDir);
    assert.equal(prepareCalls[0].readOnly, true);
    assert.equal(prepareCalls[0].syncExternalCli, false);
    assert.equal(completionCalls, 0);
    assert.equal(disposeCalls, 1);
  } finally {
    value.cleanup();
  }
});

test('managed login disposes its runtime without masking a primary profile-binding failure', async () => {
  const value = fixture();
  let disposeCalls = 0;
  try {
    await assert.rejects(
      () => verifyCodexOpenClawManagedLogin({
        environment: value.environment,
        modelRuntimeLoader: injectedModelRuntime(
          async () => assistantMessage('completion must not run'),
          {
            omitAvailableProfile: true,
            onDispose() {
              disposeCalls += 1;
              throw new Error('fixture disposal failure');
            },
          },
        ),
      }),
      (error) => {
        assert.equal(
          error.message,
          'codex_openclaw_managed_auth_profile_binding_failed',
        );
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(disposeCalls, 1);
  } finally {
    value.cleanup();
  }
});

test('managed login reports a standalone runtime disposal failure precisely', async () => {
  const value = fixture();
  let disposeCalls = 0;
  try {
    await assert.rejects(
      () => verifyCodexOpenClawManagedLogin({
        environment: value.environment,
        modelRuntimeLoader: injectedModelRuntime(
          async () => assistantMessage('completion must not run'),
          {
            onDispose() {
              disposeCalls += 1;
              throw new Error('fixture disposal failure');
            },
          },
        ),
      }),
      (error) => {
        assert.equal(
          error.message,
          'codex_openclaw_managed_agent_runtime_disposal_failed',
        );
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.equal(disposeCalls, 1);
  } finally {
    value.cleanup();
  }
});
