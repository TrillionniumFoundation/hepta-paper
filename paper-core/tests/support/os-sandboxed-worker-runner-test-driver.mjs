import {
  createOsSandboxedWorkerRunnerEngine,
} from '../../../paper-adapters/runtime/os-sandboxed-worker-runner-engine.mjs';
import {
  createGpuSelectorExecutionLeaseRepository,
  gpuSelectorExecutionLeaseRootForRuntime,
} from '../../../paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs';

const TEST_DEPENDENCY_KEYS = Object.freeze([
  'datasetSnapshotObserver',
  'dockerContainerRecoveryExecutor',
  'executor',
  'environmentBomSpawnSync',
  'gpuDeviceCapacityObserver',
  'gpuDevicePathObserver',
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

export function withGpuSelectorExecutionLeaseForTest({
  runtimeRoot,
  gpuDeviceSelector,
  ownerAuthorityHash,
  absoluteDeadlineEpochMs,
} = {}, operation) {
  const repository = createGpuSelectorExecutionLeaseRepository({
    root: gpuSelectorExecutionLeaseRootForRuntime(runtimeRoot),
  });
  return repository.withLease({
    gpuDeviceSelector,
    ownerAuthorityHash,
    absoluteDeadlineEpochMs,
  }, operation);
}
