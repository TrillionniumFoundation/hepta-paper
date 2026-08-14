import { fileURLToPath } from 'node:url';

import {
  PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
  PDE_POISSON_2D_CPU_ORACLE_RUNTIME_IMAGE,
  verifyPdePoisson2dCpuOracleResourceBudget,
} from '../../paper-domain/research/process-isolated-pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';

const MAXIMUM_REQUEST_BYTES = 4 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export const PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE =
  `${PDE_POISSON_2D_CPU_ORACLE_RUNTIME_IMAGE.image}`
  + `@${PDE_POISSON_2D_CPU_ORACLE_RUNTIME_IMAGE.imageDigest}`;

export function createPdePoisson2dCpuOracleSandboxRunner(
  resourceBudget = PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
) {
  if (!verifyPdePoisson2dCpuOracleResourceBudget(resourceBudget)) {
    throw new TypeError('pde_poisson_2d_cpu_oracle_resource_budget_invalid');
  }
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [repositoryRoot],
    dockerImage: PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
    maximumTimeoutMs: resourceBudget.timeoutMs,
    maximumMemoryBytes: resourceBudget.memoryBytes,
    maximumCpuSeconds: resourceBudget.cpuSeconds,
    maximumPids: resourceBudget.maximumProcesses,
    maximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
    maximumCapturedBytes: MAXIMUM_RESPONSE_BYTES,
    maximumInputBytes: MAXIMUM_REQUEST_BYTES,
  });
}
