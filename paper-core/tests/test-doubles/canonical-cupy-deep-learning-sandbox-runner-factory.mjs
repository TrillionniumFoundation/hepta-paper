import { AsyncLocalStorage } from 'node:async_hooks';

export {
  CANONICAL_CUPY_DEEP_LEARNING_RESOURCE_LIMITS,
} from '../../../paper-adapters/research-verify/canonical-cupy-deep-learning-sandbox-runner-factory.mjs';

const runnerContext = new AsyncLocalStorage();

export function createCanonicalCupyDeepLearningSandboxRunner() {
  const runner = runnerContext.getStore();
  if (!runner) throw new Error('deep_learning_sandbox_test_runner_context_required');
  return runner;
}

export function withCanonicalCupyDeepLearningSandboxRunnerForTest(
  runner,
  operation,
) {
  if (!runner || typeof operation !== 'function') {
    throw new Error('deep_learning_sandbox_test_context_invalid');
  }
  return runnerContext.run(runner, operation);
}
