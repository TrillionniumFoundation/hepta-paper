import {
  createOsSandboxedWorkerRunner,
} from '../runtime/os-sandboxed-worker-runner.mjs';

export function createDynamicFormalSandboxProbeRunner(options = {}) {
  return createOsSandboxedWorkerRunner(options);
}
