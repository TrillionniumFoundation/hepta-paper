import { AsyncLocalStorage } from 'node:async_hooks';
export {
  PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
} from '../../../paper-adapters/research-verify/pde-poisson-2d-cpu-oracle-sandbox-runner-factory.mjs';
const runnerContext = new AsyncLocalStorage();
export function createPdePoisson2dCpuOracleSandboxRunner() {
  const runner = runnerContext.getStore();
  if (!runner) throw new Error('pde_cpu_oracle_test_runner_context_required');
  return runner;
}
export function withPdePoisson2dCpuOracleSandboxRunnerForTest(runner, operation) {
  if (!runner || typeof operation !== 'function') throw new Error('pde_cpu_oracle_test_context_invalid');
  return runnerContext.run(runner, operation);
}
