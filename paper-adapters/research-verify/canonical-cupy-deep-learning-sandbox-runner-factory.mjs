import { fileURLToPath } from 'node:url';

import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../automation/runtime-image-registry.mjs';
import {
  createOsSandboxedWorkerRunner,
} from '../runtime/os-sandboxed-worker-runner.mjs';

const TRAINER_ROOT = fileURLToPath(
  new URL('./deep-learning-training-worker/', import.meta.url),
);
const LIMITS = Object.freeze({
  timeoutMs: 6 * 60 * 60 * 1_000,
  memoryBytes: 16 * 1024 ** 3,
  cpuSeconds: 6 * 60 * 60,
  maximumProcesses: 64,
  maximumOutputBytes: 2 * 1024 ** 3,
});

function bounded(value, minimum, maximum, blocker) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(blocker);
  }
  return number;
}

export function createCanonicalCupyDeepLearningSandboxRunner({
  outputRoot,
  timeoutMs,
  memoryBytes,
  cpuSeconds,
  maximumProcesses,
  maximumOutputBytes,
} = {}) {
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable],
    allowedRoots: [TRAINER_ROOT],
    allowedOutputRoots: [outputRoot],
    allowedContainerImages: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.image],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    allowGpu: true,
    maximumTimeoutMs: bounded(
      timeoutMs, 1, LIMITS.timeoutMs, 'deep_learning_training_timeout_invalid',
    ),
    maximumMemoryBytes: bounded(
      memoryBytes, 64 * 1024 ** 2, LIMITS.memoryBytes,
      'deep_learning_training_memory_budget_invalid',
    ),
    maximumCpuSeconds: bounded(
      cpuSeconds, 1, LIMITS.cpuSeconds, 'deep_learning_training_cpu_budget_invalid',
    ),
    maximumPids: bounded(
      maximumProcesses, 8, LIMITS.maximumProcesses,
      'deep_learning_training_process_budget_invalid',
    ),
    maximumOutputBytes: bounded(
      maximumOutputBytes, 1, LIMITS.maximumOutputBytes,
      'deep_learning_training_output_budget_invalid',
    ),
    maximumInputBytes: 64 * 1024 * 1024,
  });
}

export const CANONICAL_CUPY_DEEP_LEARNING_RESOURCE_LIMITS = LIMITS;
