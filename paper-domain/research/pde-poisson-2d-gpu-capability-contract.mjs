import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
} from '../automation/dataset-access-supervisor-policy.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../automation/os-sandbox-worker-receipt-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GRID_SIZES = Object.freeze([31, 63, 127]);
const ARTIFACT_PATHS = Object.freeze(GRID_SIZES.map((gridSize) => (
  `solutions/n${gridSize}.f64le`
)));
const SPECIFICATION_KEYS = Object.freeze([
  'acceptance', 'analysisFamily', 'artifacts', 'discretization', 'equation',
  'kind', 'numeric', 'pdePoisson2dGpuProducerSpecificationHash', 'profileId',
  'runtime', 'version',
]);
const MANIFEST_KEYS = Object.freeze([
  'artifacts', 'gpuDeviceIdentityHash', 'kind',
  'pdePoisson2dGpuArtifactManifestHash', 'producerDiagnosticsHash',
  'producerSpecificationHash', 'profileId', 'promotionEligible', 'requestHash',
  'runtimeImageDigest', 'runtimePackageClosureHash', 'scientificAuthority',
  'status', 'version', 'workerReceiptHash',
]);
const PRODUCTION_MANIFEST_KEYS = Object.freeze([
  ...MANIFEST_KEYS,
  'osSandboxWorkerReceipt', 'producerImplementationMerkleHash',
  'producerImplementationWorkspaceManifestHash',
  'requestStandardInputByteLength', 'requestStandardInputHash',
  'workerResourceLimits',
]);
const ARTIFACT_KEYS = Object.freeze([
  'bytes', 'elements', 'encoding', 'gridSize', 'relativePath', 'sha256',
]);
const WORKER_RESOURCE_LIMIT_KEYS = Object.freeze([
  'cpuSeconds', 'maximumOutputBytes', 'maximumProcesses', 'memoryBytes',
  'timeoutMs',
]);

export const PDE_POISSON_2D_GPU_PROFILE_ID =
  'pde_poisson_2d_manufactured_solution_v1';
export const PDE_POISSON_2D_GPU_ARTIFACT_ENCODING =
  'float64-le-row-major-interior-v1';

function sha(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function canonicalWorkerResourceLimits(value) {
  if (!hasExactObjectKeys(value, WORKER_RESOURCE_LIMIT_KEYS)
    || Object.values(value).some((item) => (
      !Number.isSafeInteger(item) || item < 1
    ))) {
    throw new Error('pde_poisson_2d_gpu_worker_resource_limits_invalid');
  }
  return Object.freeze({ ...value });
}

function canonicalSpecificationPayload() {
  return {
    version: 1,
    kind: 'PdePoisson2dGpuProducerSpecification',
    profileId: PDE_POISSON_2D_GPU_PROFILE_ID,
    analysisFamily: 'pde',
    equation: Object.freeze({
      operator: 'negative-laplacian-2d-v1',
      domain: 'unit-square-open-interior-v1',
      boundaryCondition: 'homogeneous-dirichlet-v1',
      manufacturedModes: Object.freeze([
        Object.freeze({ amplitude: 1, kx: 1, ky: 1 }),
        Object.freeze({ amplitude: 0.25, kx: 2, ky: 3 }),
      ]),
    }),
    discretization: Object.freeze({
      kind: 'five-point-central-difference-v1',
      gridSizes: GRID_SIZES,
      gridSpacing: 'one-over-grid-size-plus-one-v1',
      unknownLayout: 'row-major-open-interior-v1',
    }),
    numeric: Object.freeze({
      producerPrecision: 'ieee754-binary64',
      referencePrecision: 'ieee754-binary64',
      cpuGpuComparison: 'relative-l2-and-maximum-absolute-v1',
    }),
    runtime: Object.freeze({
      runtimeProfile: 'pythonGpu',
      framework: 'cupy',
      deviceApi: 'cuda',
      requiresGpu: true,
      cpuFallback: 'forbidden',
      deviceSelection: 'single-pinned-device-uuid-v1',
    }),
    artifacts: Object.freeze({
      kind: 'pde-poisson-2d-solution-set-v1',
      encoding: PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
      relativePaths: ARTIFACT_PATHS,
      producerDiagnosticAuthority: 'non-authoritative-self-report-v1',
    }),
    acceptance: Object.freeze({
      maximumRelativeDiscreteResidual: 1e-9,
      maximumRelativeContinuousL2ErrorAtFinestGrid: 0.002,
      minimumGridConvergenceOrder: 1.9,
      maximumCpuGpuRelativeL2: 1e-10,
      maximumCpuGpuAbsoluteError: 1e-10,
    }),
  };
}

export function buildPdePoisson2dGpuProducerSpecification() {
  const payload = canonicalSpecificationPayload();
  return Object.freeze({
    ...payload,
    pdePoisson2dGpuProducerSpecificationHash:
      hashRecord('PdePoisson2dGpuProducerSpecification', payload),
  });
}

export function verifyPdePoisson2dGpuProducerSpecification(value) {
  if (!hasExactObjectKeys(value, SPECIFICATION_KEYS)) return false;
  try {
    return JSON.stringify(value) === JSON.stringify(
      buildPdePoisson2dGpuProducerSpecification(),
    );
  } catch {
    return false;
  }
}

function canonicalArtifacts(value) {
  if (!Array.isArray(value) || value.length !== GRID_SIZES.length) {
    throw new Error('pde_poisson_2d_gpu_artifacts_invalid');
  }
  return Object.freeze(GRID_SIZES.map((gridSize, index) => {
    const artifact = value[index];
    const expectedBytes = gridSize * gridSize * Float64Array.BYTES_PER_ELEMENT;
    if (!hasExactObjectKeys(artifact, ARTIFACT_KEYS)
      || artifact.gridSize !== gridSize
      || artifact.relativePath !== ARTIFACT_PATHS[index]
      || artifact.encoding !== PDE_POISSON_2D_GPU_ARTIFACT_ENCODING
      || artifact.elements !== gridSize * gridSize
      || artifact.bytes !== expectedBytes
      || !sha(artifact.sha256)) {
      throw new Error('pde_poisson_2d_gpu_artifacts_invalid');
    }
    return Object.freeze({
      gridSize,
      relativePath: ARTIFACT_PATHS[index],
      encoding: PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
      elements: gridSize * gridSize,
      bytes: expectedBytes,
      sha256: sha(artifact.sha256),
    });
  }));
}

function productionWorkerReceiptValid(receipt, {
  requestHash,
  gpuDeviceIdentityHash,
  producerDiagnosticsHash,
  producerImplementationMerkleHash,
  producerImplementationWorkspaceManifestHash,
  requestStandardInputHash,
  requestStandardInputByteLength,
  workerResourceLimits,
  artifacts,
} = {}) {
  try {
    const expectedPaths = [
      ...ARTIFACT_PATHS,
      'producer-diagnostics.json',
    ];
    const artifactByPath = new Map((receipt?.artifacts || []).map(
      (artifact) => [artifact.path, artifact],
    ));
    const selector = receipt?.gpuDeviceRequest?.deviceSelector;
    return verifyProductionOsSandboxWorkerReceipt(receipt)
      && receipt.backend === 'docker'
      && receipt.containerImage === SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.image
      && receipt.containerImageDigest
        === SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.imageDigest
      && receipt.environmentBom?.runtime?.packageClosure?.basis
        === 'container_image_digest'
      && receipt.environmentBom?.runtime?.packageClosure?.identityHash
        === SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.imageDigest
      && receipt.gpuDeviceRequest?.required === true
      && receipt.gpuDeviceRequest?.requestedDeviceCount === 1
      && receipt.gpuDeviceRequest?.hostDeviceObserved === true
      && hashRecord('PdePoisson2dGpuDeviceUuid', {
        gpuDeviceSelector: selector,
      }) === gpuDeviceIdentityHash
      && receipt.executionBindings?.HEPTA_SEED === requestHash
      && receipt.executionProcessInvocation?.executableTarget
        === SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.containerExecutable
      && JSON.stringify(receipt.executionProcessInvocation?.arguments)
        === JSON.stringify(['/work/canonical_cupy_poisson_2d_solver.py'])
      && receipt.executionProcessInvocation?.workingDirectory === '/work'
      && receipt.executionProcessInvocation?.standardInput?.present === true
      && receipt.executionProcessInvocation?.standardInput?.sha256
        === requestStandardInputHash
      && receipt.executionProcessInvocation?.standardInput?.byteLength
        === requestStandardInputByteLength
      && receipt.limits?.timeoutMs === workerResourceLimits?.timeoutMs
      && receipt.limits?.memoryBytes === workerResourceLimits?.memoryBytes
      && receipt.limits?.cpuSeconds === workerResourceLimits?.cpuSeconds
      && receipt.limits?.maximumPids === workerResourceLimits?.maximumProcesses
      && receipt.limits?.maximumOutputBytes
        === workerResourceLimits?.maximumOutputBytes
      && receipt.expectedSourceMerkleHash === producerImplementationMerkleHash
      && receipt.expectedSourceWorkspaceManifestHash
        === producerImplementationWorkspaceManifestHash
      && JSON.stringify(receipt.declaredOutputPaths) === JSON.stringify(expectedPaths)
      && receipt.artifacts?.length === expectedPaths.length
      && expectedPaths.every((relativePath) => artifactByPath.has(relativePath))
      && artifacts.every((artifact) => (
        artifactByPath.get(artifact.relativePath)?.sha256 === artifact.sha256
        && artifactByPath.get(artifact.relativePath)?.bytes === artifact.bytes
      ))
      && artifactByPath.get('producer-diagnostics.json')?.sha256
        === producerDiagnosticsHash
      && receipt.externalActionPerformed === false;
  } catch {
    return false;
  }
}

export function buildPdePoisson2dGpuArtifactManifest({
  producerSpecification = buildPdePoisson2dGpuProducerSpecification(),
  requestHash,
  workerReceiptHash,
  runtimeImageDigest,
  runtimePackageClosureHash,
  gpuDeviceIdentityHash,
  producerDiagnosticsHash,
  producerImplementationMerkleHash = null,
  producerImplementationWorkspaceManifestHash = null,
  requestStandardInputHash = null,
  requestStandardInputByteLength = null,
  workerResourceLimits = null,
  osSandboxWorkerReceipt = null,
  artifacts,
} = {}) {
  const productionManifest = osSandboxWorkerReceipt !== null;
  if (!verifyPdePoisson2dGpuProducerSpecification(producerSpecification)
    || ![requestHash, workerReceiptHash, runtimeImageDigest,
      runtimePackageClosureHash, gpuDeviceIdentityHash, producerDiagnosticsHash]
      .every(sha)
    || (productionManifest && ![
      producerImplementationMerkleHash,
      producerImplementationWorkspaceManifestHash,
      requestStandardInputHash,
    ].every(sha))
    || (productionManifest && (!Number.isSafeInteger(requestStandardInputByteLength)
      || requestStandardInputByteLength < 1))) {
    throw new Error('pde_poisson_2d_gpu_artifact_manifest_invalid');
  }
  const selectedWorkerResourceLimits = productionManifest
    ? canonicalWorkerResourceLimits(workerResourceLimits) : null;
  const selectedArtifacts = canonicalArtifacts(artifacts);
  if (productionManifest && (workerReceiptHash !== osSandboxWorkerReceipt?.receiptHash
    || runtimeImageDigest !== SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.imageDigest
    || runtimePackageClosureHash
      !== SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.imageDigest
    || !productionWorkerReceiptValid(osSandboxWorkerReceipt, {
      requestHash,
      gpuDeviceIdentityHash,
      producerDiagnosticsHash,
      producerImplementationMerkleHash,
      producerImplementationWorkspaceManifestHash,
      requestStandardInputHash,
      requestStandardInputByteLength,
      workerResourceLimits: selectedWorkerResourceLimits,
      artifacts: selectedArtifacts,
    }))) {
    throw new Error('pde_poisson_2d_gpu_production_worker_receipt_invalid');
  }
  const payload = {
    version: productionManifest ? 3 : 1,
    kind: 'PdePoisson2dGpuArtifactManifest',
    status: 'pde_poisson_2d_gpu_artifacts_materialized',
    profileId: PDE_POISSON_2D_GPU_PROFILE_ID,
    producerSpecificationHash:
      producerSpecification.pdePoisson2dGpuProducerSpecificationHash,
    requestHash: sha(requestHash),
    workerReceiptHash: sha(workerReceiptHash),
    runtimeImageDigest: sha(runtimeImageDigest),
    runtimePackageClosureHash: sha(runtimePackageClosureHash),
    gpuDeviceIdentityHash: sha(gpuDeviceIdentityHash),
    producerDiagnosticsHash: sha(producerDiagnosticsHash),
    artifacts: selectedArtifacts,
    scientificAuthority: 'none-until-independent-cpu-oracle-v1',
    promotionEligible: false,
    ...(productionManifest ? {
      producerImplementationMerkleHash: sha(producerImplementationMerkleHash),
      producerImplementationWorkspaceManifestHash:
        sha(producerImplementationWorkspaceManifestHash),
      requestStandardInputHash: sha(requestStandardInputHash),
      requestStandardInputByteLength,
      workerResourceLimits: selectedWorkerResourceLimits,
      osSandboxWorkerReceipt,
    } : {}),
  };
  return Object.freeze({
    ...payload,
    pdePoisson2dGpuArtifactManifestHash:
      hashRecord('PdePoisson2dGpuArtifactManifest', payload),
  });
}

export function verifyPdePoisson2dGpuArtifactManifest(value, {
  producerSpecification = buildPdePoisson2dGpuProducerSpecification(),
} = {}) {
  if (!hasExactObjectKeys(
    value,
    value?.version === 3 ? PRODUCTION_MANIFEST_KEYS : MANIFEST_KEYS,
  )) return false;
  try {
    const rebuilt = buildPdePoisson2dGpuArtifactManifest({
      ...value,
      producerSpecification,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(value);
  } catch {
    return false;
  }
}
