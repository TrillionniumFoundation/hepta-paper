import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTOMATION_RUNTIME_IMAGES } from '../automation/runtime-image-registry.mjs';
import { inspectWorkspaceExecutionSnapshot } from '../runtime/execution-snapshot.mjs';
import { readTrustedWallClockEpochMs } from '../runtime/trusted-wall-clock.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
  buildPdePoisson2dGpuArtifactManifest,
  buildPdePoisson2dGpuProducerSpecification,
  verifyPdePoisson2dGpuArtifactManifest,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  inspectScopedPathSync,
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  createCanonicalCupyPdePoisson2dSandboxRunner,
} from './canonical-cupy-pde-poisson-2d-sandbox-runner-factory.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EXECUTOR_OPTION_KEYS = new Set([
  'cpuSeconds', 'maximumOutputBytes', 'maximumProcesses', 'memoryBytes',
  'outputRoot', 'runtimeRoot', 'timeoutMs',
]);
const OUTPUT_PATHS = Object.freeze([
  'solutions/n31.f64le',
  'solutions/n63.f64le',
  'solutions/n127.f64le',
  'producer-diagnostics.json',
]);
const MAXIMUM_REQUEST_BYTES = 1024 * 1024;
const DIAGNOSTIC_KEYS = Object.freeze([
  'kind', 'observations', 'requestHash', 'scientificAuthority',
  'version', 'visibleGpuUuid',
]);
const DIAGNOSTIC_OBSERVATION_KEYS = Object.freeze([
  'gridSize', 'iterations', 'relativeContinuousL2Error',
  'relativeDiscreteResidual',
]);
const DIAGNOSTIC_GRID_SIZES = Object.freeze([31, 63, 127]);

export const CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT = fileURLToPath(
  new URL('./pde-poisson-2d-gpu-worker/', import.meta.url),
);
export const CANONICAL_CUPY_PDE_POISSON_2D_WORKER_PATH = fileURLToPath(
  new URL('./pde-poisson-2d-gpu-worker/canonical_cupy_poisson_2d_solver.py', import.meta.url),
);
const sourceIdentity = inspectWorkspaceExecutionSnapshot(
  CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT,
);
if (sourceIdentity.blockers.length) {
  throw new Error('canonical_cupy_pde_poisson_2d_source_invalid');
}
export const CANONICAL_CUPY_PDE_POISSON_2D_SOURCE_IDENTITY = Object.freeze({
  merkleHash: sourceIdentity.merkleHash,
  workspaceManifestHash: sourceIdentity.manifestHash,
});
const CANONICAL_PDE_SOLVER_SANDBOX_PATH = `/work/${path.relative(
  CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT,
  CANONICAL_CUPY_PDE_POISSON_2D_WORKER_PATH,
).split(path.sep).join('/')}`;
const CANONICAL_PDE_SOLVER_ARGUMENTS = Object.freeze([
  CANONICAL_PDE_SOLVER_SANDBOX_PATH,
]);

function blocked(blockers, workerReceipt = null) {
  return Object.freeze({
    version: 1,
    kind: 'CanonicalCupyPdePoisson2dBlockedReceipt',
    status: 'canonical_cupy_pde_poisson_2d_blocked',
    productionPromotionEligible: false,
    workerReceipt,
    blockers: Object.freeze([...new Set(blockers.map(String))]),
  });
}

function removeOwnedRunDirectory(outputRoot, outputDirectory) {
  if (isPathWithin(outputRoot, outputDirectory)) {
    try { fs.rmSync(outputDirectory, { recursive: true, force: true }); } catch { /* blocked */ }
  }
}

function exactWorkerReceipt(receipt, expected = {}) {
  const expectedLimits = expected.workerResourceLimits;
  try {
    return verifyProductionOsSandboxWorkerReceipt(receipt)
      && receipt.backend === 'docker'
      && receipt.containerImage === AUTOMATION_RUNTIME_IMAGES.pythonGpu.image
      && receipt.containerImageDigest === AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest
      && receipt.gpuDeviceRequest?.required === true
      && receipt.gpuDeviceRequest?.requestedDeviceCount === 1
      && receipt.gpuDeviceRequest?.deviceSelector === expected.gpuDeviceSelector
      && receipt.executionProcessInvocation?.executableTarget
        === AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable
      && JSON.stringify(receipt.executionProcessInvocation?.arguments)
        === JSON.stringify(CANONICAL_PDE_SOLVER_ARGUMENTS)
      && receipt.executionProcessInvocation?.workingDirectory === '/work'
      && receipt.executionProcessInvocation?.standardInput?.present === true
      && receipt.executionProcessInvocation?.standardInput?.sha256
        === expected.standardInputHash
      && receipt.executionProcessInvocation?.standardInput?.byteLength
        === expected.standardInputByteLength
      && receipt.expectedSourceMerkleHash
        === CANONICAL_CUPY_PDE_POISSON_2D_SOURCE_IDENTITY.merkleHash
      && receipt.expectedSourceWorkspaceManifestHash
        === CANONICAL_CUPY_PDE_POISSON_2D_SOURCE_IDENTITY.workspaceManifestHash
      && JSON.stringify(receipt.declaredOutputPaths) === JSON.stringify(OUTPUT_PATHS)
      && receipt.limits?.timeoutMs === expectedLimits?.timeoutMs
      && receipt.limits?.memoryBytes === expectedLimits?.memoryBytes
      && receipt.limits?.cpuSeconds === expectedLimits?.cpuSeconds
      && receipt.limits?.maximumPids === expectedLimits?.maximumProcesses
      && receipt.limits?.maximumOutputBytes === expectedLimits?.maximumOutputBytes
      && receipt.artifacts?.length === OUTPUT_PATHS.length
      && OUTPUT_PATHS.every((selected) => (
        receipt.artifacts.filter((artifact) => artifact.path === selected).length === 1
      ));
  } catch { return false; }
}

function artifact(receipt, relativePath) {
  return receipt.artifacts.find((candidate) => candidate.path === relativePath);
}

function validateDiagnostics({ outputDirectory, workerReceipt, requestHash, gpuDeviceSelector }) {
  const expected = artifact(workerReceipt, 'producer-diagnostics.json');
  const read = readScopedFileSync({
    scopeRoot: outputDirectory,
    candidate: path.join(outputDirectory, 'producer-diagnostics.json'),
    maximumBytes: 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified'
    || read.hash !== expected?.sha256 || read.bytes !== expected?.bytes) {
    throw new Error('pde_gpu_producer_diagnostics_file_invalid');
  }
  const value = JSON.parse(read.content.toString('utf8'));
  if (!hasExactObjectKeys(value, DIAGNOSTIC_KEYS)
    || value?.version !== 1
    || value?.kind !== 'CanonicalCupyPoisson2dProducerDiagnostics'
    || value?.requestHash !== requestHash
    || value?.visibleGpuUuid !== gpuDeviceSelector
    || value?.scientificAuthority !== 'non-authoritative-self-report-v1'
    || !Array.isArray(value.observations)
    || value.observations.length !== DIAGNOSTIC_GRID_SIZES.length
    || value.observations.some((observation, index) => (
      !hasExactObjectKeys(observation, DIAGNOSTIC_OBSERVATION_KEYS)
      || observation.gridSize !== DIAGNOSTIC_GRID_SIZES[index]
      || !Number.isSafeInteger(observation.iterations)
      || observation.iterations < 1
      || observation.iterations > 256
      || !Number.isFinite(observation.relativeContinuousL2Error)
      || observation.relativeContinuousL2Error < 0
      || !Number.isFinite(observation.relativeDiscreteResidual)
      || observation.relativeDiscreteResidual < 0
    ))) {
    throw new Error('pde_gpu_producer_diagnostics_contract_invalid');
  }
  return expected.sha256;
}

function solutionArtifacts(workerReceipt, producerSpecification) {
  return Object.freeze(producerSpecification.discretization.gridSizes.map((gridSize) => {
    const relativePath = `solutions/n${gridSize}.f64le`;
    const observed = artifact(workerReceipt, relativePath);
    const elements = gridSize * gridSize;
    const bytes = elements * Float64Array.BYTES_PER_ELEMENT;
    if (observed?.bytes !== bytes) throw new Error('pde_gpu_solution_size_invalid');
    return Object.freeze({
      gridSize,
      relativePath,
      encoding: PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
      elements,
      bytes,
      sha256: observed.sha256,
    });
  }));
}

export function createCanonicalCupyPdePoisson2dExecutor(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some((key) => !EXECUTOR_OPTION_KEYS.has(key))) {
    throw new Error('canonical_cupy_pde_poisson_2d_options_invalid');
  }
  const {
    outputRoot,
    runtimeRoot = null,
    timeoutMs = 15 * 60 * 1_000,
    memoryBytes = 2 * 1024 ** 3,
    cpuSeconds = 900,
    maximumProcesses = 16,
    maximumOutputBytes = 8 * 1024 ** 2,
  } = options;
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) {
    throw new Error('canonical_cupy_pde_poisson_2d_output_root_absolute_required');
  }
  const selectedOutputRoot = path.normalize(outputRoot);
  const rootIdentity = inspectScopedPathSync({
    scopeRoot: selectedOutputRoot,
    candidate: selectedOutputRoot,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (rootIdentity.blockers.length) {
    throw new Error('canonical_cupy_pde_poisson_2d_output_root_invalid');
  }
  const sandbox = createCanonicalCupyPdePoisson2dSandboxRunner({
    outputRoot: selectedOutputRoot,
    runtimeRoot,
    timeoutMs,
    memoryBytes,
    cpuSeconds,
    maximumProcesses,
    maximumOutputBytes,
  });
  const capabilities = sandbox.capabilities();
  if (!capabilities.sandboxModes?.includes('kernel-isolated')
    || capabilities.networkPolicy !== 'none'
    || capabilities.workspaceIsolation !== true
    || capabilities.externalActions !== false
    || capabilities.gpu !== true) {
    throw new Error('canonical_cupy_pde_poisson_2d_sandbox_capability_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'CanonicalCupyPdePoisson2dExecutor',
    capabilities: () => Object.freeze({
      version: 1,
      kind: 'CanonicalCupyPdePoisson2dExecutorCapabilities',
      profileId: 'pde_poisson_2d_manufactured_solution_v1',
      runtimeProfile: 'pythonGpu',
      singleGpuUuidRequired: true,
      independentCpuOracleRequired: true,
      selfAuthorizesScientificPromotion: false,
    }),
    async execute({
      runId,
      gpuDeviceSelector,
      absoluteDeadlineEpochMs,
      executionAuthorityHash = null,
      executionSignal = null,
      gpuSelectorExecutionLeaseDelegation = null,
    } = {}) {
      const startedAt = readTrustedWallClockEpochMs();
      if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(runId)
        || !GPU_UUID.test(String(gpuDeviceSelector || ''))
        || (executionAuthorityHash !== null
          && !SHA256.test(String(executionAuthorityHash || '')))
        || !Number.isSafeInteger(absoluteDeadlineEpochMs)
        || absoluteDeadlineEpochMs <= startedAt) {
        return blocked(['canonical_cupy_pde_poisson_2d_input_invalid']);
      }
      const producerSpecification = buildPdePoisson2dGpuProducerSpecification();
      const requestPayload = {
        version: 1,
        kind: 'CanonicalCupyPoisson2dRequest',
        runId,
        producerSpecification,
        ...(executionAuthorityHash ? { executionAuthorityHash } : {}),
      };
      const request = Object.freeze({
        ...requestPayload,
        requestHash: hashRecord('CanonicalCupyPoisson2dRequest', requestPayload),
      });
      const outputDirectory = path.join(
        selectedOutputRoot,
        `pde-${request.requestHash.slice('sha256:'.length)}`,
      );
      if (!isPathWithin(selectedOutputRoot, outputDirectory) || fs.existsSync(outputDirectory)) {
        return blocked(['canonical_cupy_pde_poisson_2d_output_preexists']);
      }
      try { fs.mkdirSync(outputDirectory, { mode: 0o700 }); } catch {
        return blocked(['canonical_cupy_pde_poisson_2d_output_create_failed']);
      }
      const executionIdentity = sandbox.resolveExecutionRuntimeIdentity({
        executable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
        containerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
        containerExecutable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
      });
      if (executionIdentity?.available !== true
        || executionIdentity?.allowlisted !== true
        || executionIdentity?.digest !== AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest) {
        removeOwnedRunDirectory(selectedOutputRoot, outputDirectory);
        return blocked(['canonical_cupy_pde_poisson_2d_runtime_identity_invalid']);
      }
      const standardInput = `${JSON.stringify(request)}\n`;
      const standardInputByteLength = Buffer.byteLength(standardInput);
      const standardInputHash = hashBytes(Buffer.from(standardInput, 'utf8'));
      if (standardInputByteLength > MAXIMUM_REQUEST_BYTES) {
        removeOwnedRunDirectory(selectedOutputRoot, outputDirectory);
        return blocked(['canonical_cupy_pde_poisson_2d_request_too_large']);
      }
      const remainingMs = absoluteDeadlineEpochMs - readTrustedWallClockEpochMs();
      if (remainingMs < 1) {
        removeOwnedRunDirectory(selectedOutputRoot, outputDirectory);
        return blocked(['canonical_cupy_pde_poisson_2d_deadline_exhausted']);
      }
      const selectedTimeoutMs = Math.min(timeoutMs, remainingMs);
      const workerResourceLimits = Object.freeze({
        timeoutMs: selectedTimeoutMs,
        memoryBytes,
        cpuSeconds,
        maximumProcesses,
        maximumOutputBytes,
      });
      const workerReceipt = await sandbox.run({
        executable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
        args: [CANONICAL_CUPY_PDE_POISSON_2D_WORKER_PATH],
        cwd: CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT,
        sourceRoot: CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT,
        outputDirectory,
        outputPaths: OUTPUT_PATHS,
        executionIdentity,
        expectedSourceMerkleHash:
          CANONICAL_CUPY_PDE_POISSON_2D_SOURCE_IDENTITY.merkleHash,
        expectedSourceWorkspaceManifestHash:
          CANONICAL_CUPY_PDE_POISSON_2D_SOURCE_IDENTITY.workspaceManifestHash,
        containerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
        containerExecutable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
        timeoutMs: selectedTimeoutMs,
        absoluteDeadlineEpochMs,
        memoryBytes,
        cpuSeconds,
        maximumProcesses,
        requestedMaximumOutputBytes: maximumOutputBytes,
        requiresGpu: true,
        gpuDeviceSelector,
        requireSeparateOutputRoot: true,
        requireImmutableWorkRoot: true,
        language: 'python',
        determinismPolicy: 'same-device-gpu-replay-required-v1',
        deterministicSeed: request.requestHash,
        runtimePackageClosure: Object.freeze({
          basis: 'container_image_digest',
          identityHash: AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest,
          manifestHash: null,
          observedPackageCount: 0,
        }),
        runtimeBuildReproducibility:
          AUTOMATION_RUNTIME_IMAGES.pythonGpu.buildReproducibility,
        env: {
          HEPTA_SEED: request.requestHash,
          HEPTA_OUTPUT_DIR: '/output',
          PYTHONHASHSEED: '0',
          OMP_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          NUMEXPR_NUM_THREADS: '1',
          BLIS_NUM_THREADS: '1',
          VECLIB_MAXIMUM_THREADS: '1',
          OMP_DYNAMIC: 'false',
          MKL_DYNAMIC: 'false',
        },
        standardInput,
        signal: executionSignal,
        ...(gpuSelectorExecutionLeaseDelegation ? {
          gpuSelectorExecutionLeaseDelegation,
          gpuSelectorExecutionLeaseDelegationAuthorityHash:
            executionAuthorityHash,
        } : {}),
      });
      if (!exactWorkerReceipt(workerReceipt, {
        gpuDeviceSelector,
        workerResourceLimits,
        standardInputHash,
        standardInputByteLength,
      })) {
        removeOwnedRunDirectory(selectedOutputRoot, outputDirectory);
        return blocked([
          'canonical_cupy_pde_poisson_2d_worker_invalid',
          ...(Array.isArray(workerReceipt?.blockers) ? workerReceipt.blockers : []),
        ], workerReceipt || null);
      }
      try {
        const producerDiagnosticsHash = validateDiagnostics({
          outputDirectory,
          workerReceipt,
          requestHash: request.requestHash,
          gpuDeviceSelector,
        });
        const manifest = buildPdePoisson2dGpuArtifactManifest({
          producerSpecification,
          requestHash: request.requestHash,
          workerReceiptHash: workerReceipt.receiptHash,
          runtimeImageDigest: workerReceipt.containerImageDigest,
          runtimePackageClosureHash:
            workerReceipt.environmentBom.runtime.packageClosure.identityHash,
          gpuDeviceIdentityHash: hashRecord('PdePoisson2dGpuDeviceUuid', {
            gpuDeviceSelector,
          }),
          producerDiagnosticsHash,
          requestStandardInputHash: standardInputHash,
          requestStandardInputByteLength: standardInputByteLength,
          workerResourceLimits,
          producerImplementationMerkleHash:
            CANONICAL_CUPY_PDE_POISSON_2D_SOURCE_IDENTITY.merkleHash,
          producerImplementationWorkspaceManifestHash:
            CANONICAL_CUPY_PDE_POISSON_2D_SOURCE_IDENTITY.workspaceManifestHash,
          osSandboxWorkerReceipt: workerReceipt,
          artifacts: solutionArtifacts(workerReceipt, producerSpecification),
        });
        if (!verifyPdePoisson2dGpuArtifactManifest(manifest, {
          producerSpecification,
        }) || readTrustedWallClockEpochMs() >= absoluteDeadlineEpochMs) {
          throw new Error('pde_gpu_manifest_or_deadline_invalid');
        }
        const payload = {
          version: 1,
          kind: 'CanonicalCupyPdePoisson2dExecutionReceipt',
          status: 'canonical_cupy_pde_poisson_2d_executed_pending_cpu_oracle',
          runId,
          executionAuthorityHash,
          requestHash: request.requestHash,
          outputDirectory,
          producerSpecification,
          artifactManifest: manifest,
          artifactManifestHash: manifest.pdePoisson2dGpuArtifactManifestHash,
          workerReceiptHash: workerReceipt.receiptHash,
          absoluteDeadlineEpochMs,
          productionPromotionEligible: false,
          blockers: Object.freeze(['pde_poisson_2d_independent_cpu_oracle_required']),
        };
        return Object.freeze({
          ...payload,
          canonicalCupyPdePoisson2dExecutionReceiptHash:
            hashRecord('CanonicalCupyPdePoisson2dExecutionReceipt', payload),
        });
      } catch (error) {
        removeOwnedRunDirectory(selectedOutputRoot, outputDirectory);
        return blocked([
          `canonical_cupy_pde_poisson_2d_artifact_invalid:${error?.message || 'unknown'}`,
        ], workerReceipt);
      }
    },
  });
}

export { OUTPUT_PATHS as CANONICAL_CUPY_PDE_POISSON_2D_OUTPUT_PATHS };
