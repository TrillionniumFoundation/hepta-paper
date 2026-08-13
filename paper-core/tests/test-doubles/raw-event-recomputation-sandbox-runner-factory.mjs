import { AsyncLocalStorage } from 'node:async_hooks';

import {
  RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
} from '../../../paper-adapters/research-verify/raw-event-recomputation-sandbox-runner-factory.mjs';
const runnerContext = new AsyncLocalStorage();

export { RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE };

export function createRawEventRecomputationSandboxRunner() {
  const runner = runnerContext.getStore();
  if (!runner) throw new Error('raw_event_recomputation_test_runner_context_required');
  return runner;
}

export function withRawEventRecomputationSandboxRunnerForTest(runner, operation) {
  if (typeof runner?.run !== 'function' || typeof operation !== 'function') {
    throw new TypeError('raw_event_recomputation_test_runner_invalid');
  }
  return runnerContext.run(runner, operation);
}
