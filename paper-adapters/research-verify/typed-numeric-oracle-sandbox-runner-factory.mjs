import { fileURLToPath } from 'node:url';

import {
  TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS,
} from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
} from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';

const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 24 * 1024 * 1024;
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export const TYPED_NUMERIC_RECOMPUTATION_DOCKER_FALLBACK_IMAGE =
  `${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.image}`
  + `@${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest}`;

function bounded(value, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new TypeError('process_isolated_typed_numeric_resource_budget_invalid');
  }
  return number;
}

export function createTypedNumericOracleSandboxRunner({
  timeoutMs = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs,
  memoryBytes = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes,
  cpuSeconds = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds,
  maximumProcesses = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses,
} = {}) {
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [repositoryRoot],
    dockerImage: TYPED_NUMERIC_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
    maximumTimeoutMs: bounded(
      timeoutMs,
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs,
    ),
    maximumMemoryBytes: bounded(
      memoryBytes,
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes,
    ),
    maximumCpuSeconds: bounded(
      cpuSeconds,
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds,
    ),
    maximumPids: bounded(
      maximumProcesses,
      TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses,
    ),
    maximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
    maximumCapturedBytes: MAXIMUM_RESPONSE_BYTES,
    maximumInputBytes: MAXIMUM_REQUEST_BYTES,
  });
}
