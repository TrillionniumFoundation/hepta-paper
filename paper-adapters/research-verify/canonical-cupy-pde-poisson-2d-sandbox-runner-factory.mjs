import { fileURLToPath } from 'node:url';

import { AUTOMATION_RUNTIME_IMAGES } from '../automation/runtime-image-registry.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';

const WORKER_ROOT = fileURLToPath(
  new URL('./pde-poisson-2d-gpu-worker/', import.meta.url),
);
const LIMITS = Object.freeze({
  timeoutMs: 30 * 60 * 1_000,
  memoryBytes: 4 * 1024 ** 3,
  cpuSeconds: 1_800,
  maximumProcesses: 32,
  maximumOutputBytes: 16 * 1024 ** 2,
});

function bounded(value, minimum, maximum, blocker) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(blocker);
  }
  return number;
}

export function createCanonicalCupyPdePoisson2dSandboxRunner({
  outputRoot,
  timeoutMs,
  memoryBytes,
  cpuSeconds,
  maximumProcesses,
  maximumOutputBytes,
} = {}) {
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable],
    allowedRoots: [WORKER_ROOT],
    allowedOutputRoots: [outputRoot],
    allowedContainerImages: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.image],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    allowGpu: true,
    maximumTimeoutMs: bounded(timeoutMs, 1, LIMITS.timeoutMs,
      'pde_gpu_timeout_invalid'),
    maximumMemoryBytes: bounded(memoryBytes, 64 * 1024 ** 2, LIMITS.memoryBytes,
      'pde_gpu_memory_budget_invalid'),
    maximumCpuSeconds: bounded(cpuSeconds, 1, LIMITS.cpuSeconds,
      'pde_gpu_cpu_budget_invalid'),
    maximumPids: bounded(maximumProcesses, 8, LIMITS.maximumProcesses,
      'pde_gpu_process_budget_invalid'),
    maximumOutputBytes: bounded(maximumOutputBytes, 1, LIMITS.maximumOutputBytes,
      'pde_gpu_output_budget_invalid'),
    maximumInputBytes: 1024 * 1024,
  });
}

export const CANONICAL_CUPY_PDE_POISSON_2D_RESOURCE_LIMITS = LIMITS;
