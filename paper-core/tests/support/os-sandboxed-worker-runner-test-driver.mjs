import {
  createOsSandboxedWorkerRunnerEngine,
} from '../../../paper-adapters/runtime/os-sandboxed-worker-runner-engine.mjs';

const TEST_DEPENDENCY_KEYS = Object.freeze([
  'datasetSnapshotObserver',
  'dockerContainerRecoveryExecutor',
  'executor',
  'gpuDeviceCapacityObserver',
  'imageDigestResolver',
  'probe',
  'runtimeExecutableSnapshotObserver',
  'workspaceSnapshotObserver',
]);

export function createOsSandboxedWorkerRunnerForTest(options = {}) {
  const productionOptions = { ...options };
  const testDependencies = {};
  for (const key of TEST_DEPENDENCY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(productionOptions, key)) {
      testDependencies[key] = productionOptions[key];
      delete productionOptions[key];
    }
  }
  return createOsSandboxedWorkerRunnerEngine(productionOptions, testDependencies);
}
