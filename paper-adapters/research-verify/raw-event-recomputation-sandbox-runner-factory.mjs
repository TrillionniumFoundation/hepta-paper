import { fileURLToPath } from 'node:url';

import {
  RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS,
} from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
} from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';

const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 24 * 1024 * 1024;
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export const RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE =
  `${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.image}`
  + `@${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest}`;

function bounded(value, maximum, blocker) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new TypeError(blocker);
  }
  return number;
}

export function createRawEventRecomputationSandboxRunner({
  timeoutMs = RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs,
  memoryBytes = RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes,
  cpuSeconds = RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds,
  maximumProcesses = RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses,
} = {}) {
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [repositoryRoot],
    dockerImage: RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
    maximumTimeoutMs: bounded(
      timeoutMs,
      RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs,
      'process_isolated_recomputation_timeout_invalid',
    ),
    maximumMemoryBytes: bounded(
      memoryBytes,
      RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes,
      'process_isolated_recomputation_resource_budget_invalid',
    ),
    maximumCpuSeconds: bounded(
      cpuSeconds,
      RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds,
      'process_isolated_recomputation_resource_budget_invalid',
    ),
    maximumPids: bounded(
      maximumProcesses,
      RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses,
      'process_isolated_recomputation_resource_budget_invalid',
    ),
    maximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
    maximumCapturedBytes: MAXIMUM_RESPONSE_BYTES,
    maximumInputBytes: MAXIMUM_REQUEST_BYTES,
  });
}
