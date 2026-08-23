import { fileURLToPath } from 'node:url';

import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../automation/runtime-image-registry.mjs';
import {
  DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS,
  verifyDeepLearningCpuOracleResourceBudget,
} from '../../paper-domain/research/process-isolated-deep-learning-independent-cpu-oracle-contract.mjs';
import {
  createOsSandboxedWorkerRunner,
} from '../runtime/os-sandboxed-worker-runner.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAXIMUM_REQUEST_BYTES = 64 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 16 * 1024 * 1024;

export const DEEP_LEARNING_CPU_ORACLE_DOCKER_IMAGE =
  `${AUTOMATION_RUNTIME_IMAGES.python.image}`
  + `@${AUTOMATION_RUNTIME_IMAGES.python.imageDigest}`;

export function createDeepLearningCpuOracleSandboxRunner(
  resourceBudget = DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS,
) {
  if (!verifyDeepLearningCpuOracleResourceBudget(resourceBudget)) {
    throw new TypeError('deep_learning_cpu_oracle_resource_budget_invalid');
  }
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [REPOSITORY_ROOT],
    dockerImage: DEEP_LEARNING_CPU_ORACLE_DOCKER_IMAGE,
    maximumTimeoutMs: resourceBudget.timeoutMs,
    maximumMemoryBytes: resourceBudget.memoryBytes,
    maximumCpuSeconds: resourceBudget.cpuSeconds,
    maximumPids: resourceBudget.maximumProcesses,
    maximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
    maximumCapturedBytes: MAXIMUM_RESPONSE_BYTES,
    maximumInputBytes: MAXIMUM_REQUEST_BYTES,
  });
}

export const DEEP_LEARNING_CPU_ORACLE_MAXIMUM_REQUEST_BYTES = MAXIMUM_REQUEST_BYTES;
export const DEEP_LEARNING_CPU_ORACLE_MAXIMUM_RESPONSE_BYTES = MAXIMUM_RESPONSE_BYTES;
