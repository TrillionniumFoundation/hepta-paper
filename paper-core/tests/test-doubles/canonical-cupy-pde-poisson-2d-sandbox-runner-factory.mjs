import { AsyncLocalStorage } from 'node:async_hooks';

export {
  CANONICAL_CUPY_PDE_POISSON_2D_RESOURCE_LIMITS,
} from '../../../paper-adapters/research-verify/canonical-cupy-pde-poisson-2d-sandbox-runner-factory.mjs';

const runnerContext = new AsyncLocalStorage();

export function createCanonicalCupyPdePoisson2dSandboxRunner() {
  const runner = runnerContext.getStore();
  if (!runner) throw new Error('pde_gpu_sandbox_test_runner_context_required');
  return runner;
}

export function withCanonicalCupyPdePoisson2dSandboxRunnerForTest(runner, operation) {
  if (!runner || typeof operation !== 'function') {
    throw new Error('pde_gpu_sandbox_test_context_invalid');
  }
  return runnerContext.run(runner, operation);
}
