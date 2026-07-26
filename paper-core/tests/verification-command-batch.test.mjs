import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBoundedVerificationCommandExecutor,
  runVerificationCommandsUntilFailure,
} from '../src/verification-command-batch.mjs';
import {
  declaredTestSuite,
} from '../src/test-suite-manifest.mjs';

test('verification command batches stop at the first failure', () => {
  const calls = [];
  const failure = { status: 7, stdout: 'failed', stderr: '' };
  const result = runVerificationCommandsUntilFailure([
    ['first'],
    ['second'],
    ['must-not-run'],
  ], (args) => {
    calls.push(args[0]);
    return args[0] === 'second' ? failure : { status: 0 };
  });
  assert.equal(result, failure);
  assert.deepEqual(calls, ['first', 'second']);
});

test('verification command batches return null only after every command passes', () => {
  const calls = [];
  const result = runVerificationCommandsUntilFailure([
    ['first'],
    ['second'],
  ], (args) => {
    calls.push(args[0]);
    return { status: 0 };
  });
  assert.equal(result, null);
  assert.deepEqual(calls, ['first', 'second']);
});

test('verification command batches reject malformed execution contracts', () => {
  assert.throws(
    () => runVerificationCommandsUntilFailure(null, () => ({ status: 0 })),
    /verification_command_batch_invalid/,
  );
  assert.throws(
    () => runVerificationCommandsUntilFailure([null], () => ({ status: 0 })),
    /verification_command_arguments_invalid/,
  );
  for (const invalid of [
    undefined,
    null,
    Promise.resolve({ status: 0 }),
    Object.assign([], { status: 0 }),
    {},
    { status: null },
    { status: 0.5 },
    { status: Number.NaN },
    { status: '0' },
  ]) {
    assert.throws(
      () => runVerificationCommandsUntilFailure([['command']], () => invalid),
      /verification_command_result_invalid/,
    );
  }
});

test('bounded verification command executors apply a finite child timeout', () => {
  const calls = [];
  const execute = createBoundedVerificationCommandExecutor({
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0 };
    },
    executable: '/runtime/node',
    cwd: '/workspace',
    env: { NODE_V8_COVERAGE: '/coverage' },
    timeoutMs: 30 * 60 * 1_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.deepEqual(execute(['--test', 'fixture.test.mjs']), { status: 0 });
  assert.deepEqual(calls, [{
    executable: '/runtime/node',
    args: ['--test', 'fixture.test.mjs'],
    options: {
      cwd: '/workspace',
      env: { NODE_V8_COVERAGE: '/coverage' },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30 * 60 * 1_000,
      killSignal: 'SIGKILL',
    },
  }]);
  for (const timeoutMs of [undefined, null, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createBoundedVerificationCommandExecutor({
        spawnSyncImpl() {},
        executable: '/runtime/node',
        cwd: '/workspace',
        env: {},
        timeoutMs,
        maxBuffer: 1024,
      }),
      /verification_command_executor_configuration_invalid/,
    );
  }
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const timedExecutor = createBoundedVerificationCommandExecutor({
    spawnSyncImpl: () => ({ status: null, error: timeout }),
    executable: '/runtime/node',
    cwd: '/workspace',
    env: {},
    timeoutMs: 100,
    maxBuffer: 1024,
  });
  assert.throws(() => timedExecutor(['--test']), (error) => error === timeout);
});

test('critical coverage profile isolates the giant closure fixture from shared batches', () => {
  const giantFixture = 'paper-core/tests/production-research-closure-fixture.test.mjs';
  const normalSuite = declaredTestSuite('automation', 'deduplicated').tests;
  const criticalCoverageSuite = declaredTestSuite('automation', 'critical-coverage').tests;
  assert.equal(normalSuite.includes(giantFixture), true);
  assert.equal(criticalCoverageSuite.includes(giantFixture), false);
  assert.equal(
    normalSuite.includes('paper-core/tests/verification-command-batch.test.mjs'),
    true,
  );
});
