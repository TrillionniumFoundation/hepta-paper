import { AsyncLocalStorage } from 'node:async_hooks';

import {
  TYPED_NUMERIC_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
} from '../../../paper-adapters/research-verify/typed-numeric-oracle-sandbox-runner-factory.mjs';

const runnerContext = new AsyncLocalStorage();

export { TYPED_NUMERIC_RECOMPUTATION_DOCKER_FALLBACK_IMAGE };

export function createTypedNumericOracleSandboxRunner() {
  const runner = runnerContext.getStore();
  if (!runner) throw new Error('typed_numeric_oracle_test_runner_context_required');
  return runner;
}

export function withTypedNumericOracleSandboxRunnerForTest(runner, operation) {
  if (typeof runner?.run !== 'function' || typeof operation !== 'function') {
    throw new TypeError('typed_numeric_oracle_test_runner_invalid');
  }
  return runnerContext.run(runner, operation);
}
