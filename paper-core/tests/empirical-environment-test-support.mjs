import { createWorkerEnvironmentBomPreparer } from '../../paper-adapters/runtime/worker-environment-bom-binding.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const fixtureEnvironmentBomPreparer = createWorkerEnvironmentBomPreparer({
  maximumTimeoutMs: 120_000,
  maximumMemoryBytes: 1024 * 1024 * 1024,
  maximumCpuSeconds: 120,
  maximumPids: 128,
  maximumOutputBytes: 256 * 1024 * 1024,
  maximumCapturedBytes: 4 * 1024 * 1024,
});

const DETERMINISTIC_CACHE_ENVIRONMENT = Object.freeze({
  HEPTA_SEED: '42',
  PYTHONHASHSEED: '42',
  OMP_NUM_THREADS: '1',
  OPENBLAS_NUM_THREADS: '1',
  MKL_NUM_THREADS: '1',
  NUMEXPR_NUM_THREADS: '1',
  BLIS_NUM_THREADS: '1',
  VECLIB_MAXIMUM_THREADS: '1',
  OMP_DYNAMIC: 'FALSE',
  MKL_DYNAMIC: 'FALSE',
});

export function deterministicCacheSpec(spec) {
  return {
    ...spec,
    determinismPolicy: 'explicit_deterministic_cpu',
    deterministicSeed: 42,
    env: { ...DETERMINISTIC_CACHE_ENVIRONMENT, ...(spec.env || {}) },
  };
}

export function withFixtureEnvironmentBom(runner) {
  return {
    ...runner,
    prepareEnvironmentBom: fixtureEnvironmentBomPreparer,
    run(spec) {
      const result = runner.run(spec);
      const bind = (resolved) => {
        const binding = fixtureEnvironmentBomPreparer({
          ...spec,
          executionIdentity: spec.executionIdentity,
          executable: spec.containerExecutable || spec.executable,
        });
        return { ...resolved, environmentBom: binding.environmentBom, environmentBomHash: binding.environmentBomHash };
      };
      return typeof result?.then === 'function' ? result.then(bind) : bind(result);
    },
  };
}

export function fixtureContainerExecutionIdentity({
  image,
  digest,
  executable = 'python3',
  runnerId = 'fixture-runner',
  cacheable = true,
} = {}) {
  const payload = {
    version: 1,
    kind: 'WorkerExecutionRuntimeIdentity',
    runtimeType: 'container',
    runnerId,
    backend: 'docker',
    requestedImage: image,
    digest,
    containerExecutable: executable,
    available: Boolean(digest),
    allowlisted: true,
    cacheable,
  };
  return Object.freeze({ ...payload, runtimeIdentityHash: hashRecord('WorkerExecutionRuntimeIdentity', payload) });
}
