import {
  createOsSandboxedWorkerRunnerEngine,
} from './os-sandboxed-worker-runner-engine.mjs';

export { probeOsSandbox } from './sandbox-backend-probe.mjs';
export {
  directoryMerkleHash,
  fileSha256Hash,
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from './execution-snapshot.mjs';

const FORBIDDEN_DEPENDENCY_INJECTION_KEYS = Object.freeze([
  'datasetSnapshotObserver',
  'dockerContainerRecoveryExecutor',
  'executor',
  'gpuDeviceCapacityObserver',
  'imageDigestResolver',
  'probe',
  'runtimeExecutableSnapshotObserver',
  'workspaceSnapshotObserver',
]);

export function createOsSandboxedWorkerRunner(options = {}) {
  const forbidden = FORBIDDEN_DEPENDENCY_INJECTION_KEYS.filter((key) => (
    Object.prototype.hasOwnProperty.call(options, key)
  ));
  if (forbidden.length) {
    throw new Error(`os_sandbox_worker_dependency_injection_forbidden:${forbidden.join(',')}`);
  }
  return createOsSandboxedWorkerRunnerEngine(options);
}
