import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modelFailureClass,
} from '../../paper-adapters/automation/codex-openclaw-managed-model-support.mjs';

test('managed failure classification keeps quota and credential signals distinct', () => {
  const cases = [
    ['token quota exceeded', { errorMessage: 'token quota exceeded' }, 'quota'],
    ['token usage limit reached', { errorMessage: 'token usage limit reached' }, 'quota'],
    ['insufficient quota code', { errorCode: 'insufficient_quota' }, 'quota'],
    ['credits exhausted error', { errorMessage: 'Provider credits exhausted.' }, 'quota'],
    ['quota beats token authentication wording', {
      errorCode: 'insufficient_quota',
      errorMessage: 'invalid API token',
    }, 'quota'],
    ['invalid token', { errorMessage: 'invalid token' }, 'authentication'],
    ['expired token suffix', { errorMessage: 'token expired' }, 'authentication'],
    ['access token', { errorMessage: 'access token rejected' }, 'authentication'],
    ['API token code', { errorCode: 'invalid_api_token' }, 'authentication'],
    ['invalid API key', { errorMessage: 'invalid API key' }, 'authentication'],
    ['expired API key suffix', { errorMessage: 'API key expired' }, 'authentication'],
    ['error payload quota', { errorText: 'Provider credits exhausted.' }, 'quota'],
    ['error payload authentication', { errorText: 'invalid API key' }, 'authentication'],
    ['HTTP 401', { errorMessage: 'HTTP 401' }, 'authentication'],
    ['HTTP 403', { errorMessage: 'HTTP 403 forbidden' }, 'authentication'],
    ['unsupported model remains ahead of quota', {
      errorMessage: 'model gpt-future not supported; token quota exceeded',
    }, 'unsupported_model'],
    ['token rate limit is not authentication', {
      errorText: 'API token rate limit reached',
    }, 'rate_limited'],
    ['response prose cannot mask an authentication error', {
      errorMessage: 'invalid API token',
      text: 'The rate limit literature motivates the next robustness check.',
    }, 'authentication'],
    ['error payload overload', { errorText: 'server_is_overloaded' }, 'overloaded'],
    ['error payload context overflow', { errorText: 'context window overflow' }, 'context'],
    ['error payload cancellation', { errorText: 'request cancelled' }, 'aborted'],
    ['unrecognized error payload', {
      stopReason: 'error',
      errorText: 'Agent could not generate a response.',
    }, 'transport'],
    ['unrecognized thrown error metadata', {
      errorMessage: 'The provider connection closed unexpectedly.',
    }, 'transport'],
    ['unqualified token prose is transport', {
      text: 'token accounting mismatch',
    }, 'transport'],
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(modelFailureClass(input), expected, name);
  }
});

test('managed failure classification prioritizes typed stop reasons', () => {
  assert.equal(modelFailureClass({
    stopReason: 'cancelled',
    errorText: 'token quota exceeded',
  }), 'aborted');
  assert.equal(modelFailureClass({
    stopReason: 'length',
    errorText: 'request cancelled; invalid API key',
  }), 'length');
  assert.equal(modelFailureClass({
    stopReason: 'toolUse',
    errorText: 'token quota exceeded',
  }), 'tool_use');
});

test('managed failure classification does not treat response prose as quota or auth', () => {
  const lengthCases = [
    'credit risk premium',
    '401(k)',
    'API key rotation',
  ];
  for (const text of lengthCases) {
    assert.equal(
      modelFailureClass({ stopReason: 'length', text }),
      'length',
      text,
    );
  }

  const proseCases = [
    'Provider credits exhausted is an example of an operational alert.',
    'A 401(k) account is distinct from HTTP authentication status.',
    'API key rotation reduces long-run credential exposure.',
    'Credit card authorization affects the purchase completion rate.',
  ];
  for (const text of proseCases) {
    assert.equal(modelFailureClass({ text }), 'transport', text);
  }

  const transientFailureProse = [
    'API token rate limit policies affect throughput.',
    'The overloaded estimator has a context-dependent bias.',
    'Context overflow is discussed before we cancel the ablation.',
    'The unknown model in Section 4 is not supported by the data.',
  ];
  for (const text of transientFailureProse) {
    assert.equal(
      modelFailureClass({ stopReason: 'error', text }),
      'transport',
      text,
    );
  }

  assert.equal(modelFailureClass({
    errorMessage: 'credit card authorization failed',
    text: 'Credit quotas are an ambiguous payment-system construct.',
  }), 'transport');
});
