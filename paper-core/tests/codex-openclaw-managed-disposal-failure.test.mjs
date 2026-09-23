import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenClawManagedFailureEvidence,
  executeCodexOpenClawManaged,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  assertIncompleteManagedFailureUsage,
  assertManagedRuntimeClean,
  fixture,
  injectedModelRuntime,
} from './support/codex-openclaw-managed-runtime-fixture.mjs';

test('managed disposal failure cannot be reported as a verified quota failure', async () => {
  const value = fixture();
  const disposalFailureCode =
    'codex_openclaw_managed_agent_runtime_disposal_failed';
  let disposeCalls = 0;
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin:
        'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => {
        const error = new Error('token quota exceeded with private detail');
        error.code = 'provider_error';
        throw error;
      }, {
        onDispose() {
          disposeCalls += 1;
          throw new Error(
            'dispose credential=sk-private path=/private/runtime',
          );
        },
      }),
    }), (error) => {
      assertIncompleteManagedFailureUsage(
        error,
        value.environment,
        disposalFailureCode,
        { errorClass: 'runtime_disposal_failed' },
      );
      const evidence = buildOpenClawManagedFailureEvidence(error);
      assert.equal(evidence.failureCode, disposalFailureCode);
      assert.notEqual(
        evidence.failureCode,
        'codex_openclaw_managed_profile_quota_exhausted',
      );
      const serialized = JSON.stringify({
        message: error.message,
        ...error,
        evidence,
      });
      assert.equal(serialized.includes('sk-private'), false);
      assert.equal(serialized.includes('/private/runtime'), false);
      assert.equal(serialized.includes('token quota exceeded'), false);
      return true;
    });
    assert.equal(disposeCalls, 1);
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});
