import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTOMATION_RUNTIME_IMAGES } from '../automation/runtime-image-registry.mjs';
import {
  buildProcessIsolatedPdePoisson2dCpuOracleAssurance,
  buildProcessIsolatedPdePoisson2dCpuOracleRequest,
  PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
  verifyPdePoisson2dCpuOracleWorkerReceipt,
  verifyPdePoisson2dCpuOracleResourceBudget,
  verifyProcessIsolatedPdePoisson2dCpuOracleAssurance,
} from '../../paper-domain/research/process-isolated-pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import {
  buildPdePoisson2dGpuProducerSpecification,
  verifyPdePoisson2dGpuArtifactManifest,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  PDE_POISSON_2D_CPU_ORACLE_EXECUTABLE_TARGET,
} from '../../paper-domain/research/pde-poisson-2d-cpu-oracle-runtime-attestation.mjs';
import {
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../runtime/execution-snapshot.mjs';
import {
  currentPdePoisson2dCpuOracleWorkerImplementation,
} from './independent-pde-poisson-2d-cpu-oracle-worker.mjs';
import {
  createPdePoisson2dCpuOracleSandboxRunner,
  PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
} from './pde-poisson-2d-cpu-oracle-sandbox-runner-factory.mjs';
import { readTrustedWallClockEpochMs } from '../runtime/trusted-wall-clock.mjs';

const MAXIMUM_REQUEST_BYTES = 4 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
const workerPath = fileURLToPath(new URL(
  './independent-pde-poisson-2d-cpu-oracle-worker.mjs',
  import.meta.url,
));
const repositoryRoot = path.resolve(path.dirname(workerPath), '..', '..');

export { PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE };

function snapshotJsonObject(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = JSON.parse(JSON.stringify(value));
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? snapshot : null;
  } catch { return null; }
}

function readArtifactPayloads({ artifactRoot, artifactManifest }) {
  const root = path.resolve(String(artifactRoot || ''));
  const reads = artifactManifest.artifacts.map((artifact) => readScopedFileSync({
    scopeRoot: root,
    candidate: path.join(root, artifact.relativePath),
    maximumBytes: artifact.bytes,
  }));
  const blockers = [];
  const artifactPayloads = [];
  for (let index = 0; index < reads.length; index += 1) {
    const read = reads[index];
    const artifact = artifactManifest.artifacts[index];
    blockers.push(...read.blockers.map(
      (blocker) => `pde_cpu_oracle_artifact_read:${blocker}`,
    ));
    if (read.status === 'scoped_file_read_verified'
      && read.hash !== artifact.sha256) {
      blockers.push(`pde_cpu_oracle_artifact_hash_mismatch:n${artifact.gridSize}`);
    }
    if (read.status === 'scoped_file_read_verified'
      && read.hash === artifact.sha256) {
      artifactPayloads.push(Object.freeze({
        gridSize: artifact.gridSize,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        contentBase64: read.content.toString('base64'),
      }));
    }
  }
  return Object.freeze({
    artifactPayloads: Object.freeze(artifactPayloads),
    artifactReadReceiptHashes: Object.freeze(
      reads.map((read) => read.scopedFileReadReceiptHash),
    ),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function parseWorkerReceipt(sandboxReceipt, { request, workerImplementation }) {
  if (!verifyProductionOsSandboxWorkerReceipt(sandboxReceipt)
    || sandboxReceipt.externalActionPerformed !== false
    || sandboxReceipt.isolation?.gpuAccessRequested !== false) return null;
  let receipt = null;
  try { receipt = JSON.parse(String(sandboxReceipt.stdout || '').trim()); }
  catch { return null; }
  if (!verifyPdePoisson2dCpuOracleWorkerReceipt(receipt, {
    request,
    workerImplementation,
  }) || (sandboxReceipt.backend === 'docker'
    && (receipt.workerPid !== 1 || receipt.parentPid !== 0))) return null;
  return Object.freeze(receipt);
}

function buildRequestFromArtifacts({
  artifactRoot,
  artifactManifest,
  producerSpecification,
  workerImplementation,
  oracleRuntimeIdentityHash,
  resourceBudget,
}) {
  const reads = readArtifactPayloads({ artifactRoot, artifactManifest });
  if (reads.blockers.length
    || reads.artifactPayloads.length !== artifactManifest.artifacts.length) {
    return Object.freeze({ request: null, reads });
  }
  const request = buildProcessIsolatedPdePoisson2dCpuOracleRequest({
    producerSpecification,
    artifactManifest,
    artifactPayloads: reads.artifactPayloads,
    artifactReadReceiptHashes: reads.artifactReadReceiptHashes,
    workerImplementation,
    oracleRuntimeIdentityHash,
    resourceBudget,
  });
  return Object.freeze({ request, reads });
}

export function runProcessIsolatedPdePoisson2dIndependentCpuOracle({
  artifactRoot,
  artifactManifest,
  producerSpecification = buildPdePoisson2dGpuProducerSpecification(),
  resourceBudget = PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
  absoluteDeadlineEpochMs,
} = {}) {
  const blockers = [];
  let workerImplementation = null;
  let runner = null;
  let executionIdentity = null;
  let request = null;
  let sandboxReceipt = null;
  const startedAt = readTrustedWallClockEpochMs();
  let effectiveResourceBudget = resourceBudget;
  if (!Number.isSafeInteger(absoluteDeadlineEpochMs)
    || absoluteDeadlineEpochMs <= startedAt) {
    blockers.push('pde_cpu_oracle_absolute_deadline_invalid');
  } else {
    effectiveResourceBudget = Object.freeze({
      ...resourceBudget,
      timeoutMs: Math.min(resourceBudget.timeoutMs, absoluteDeadlineEpochMs - startedAt),
    });
  }
  if (!verifyPdePoisson2dGpuArtifactManifest(artifactManifest, {
    producerSpecification,
  })) blockers.push('pde_cpu_oracle_gpu_artifact_manifest_invalid');
  if (!verifyPdePoisson2dCpuOracleResourceBudget(effectiveResourceBudget)) {
    blockers.push('pde_cpu_oracle_resource_budget_invalid');
  }
  try {
    workerImplementation = currentPdePoisson2dCpuOracleWorkerImplementation();
  } catch { blockers.push('pde_cpu_oracle_worker_implementation_invalid'); }
  if (!blockers.length) {
    try {
      runner = createPdePoisson2dCpuOracleSandboxRunner(effectiveResourceBudget);
      executionIdentity = runner.resolveExecutionRuntimeIdentity({
        executable: PDE_POISSON_2D_CPU_ORACLE_EXECUTABLE_TARGET,
      });
      if (!executionIdentity?.available || !executionIdentity?.allowlisted
        || executionIdentity.digest
          !== AUTOMATION_RUNTIME_IMAGES.python.imageDigest) {
        throw new Error('pde_cpu_oracle_runtime_identity_unavailable');
      }
      const prepared = buildRequestFromArtifacts({
        artifactRoot,
        artifactManifest,
        producerSpecification,
        workerImplementation,
        oracleRuntimeIdentityHash: executionIdentity.runtimeIdentityHash,
        resourceBudget: effectiveResourceBudget,
      });
      blockers.push(...prepared.reads.blockers);
      request = prepared.request;
    } catch (error) {
      blockers.push(String(error?.message || 'pde_cpu_oracle_request_invalid'));
    }
  }
  let encoded = '';
  if (request) {
    try { encoded = `${JSON.stringify(request)}\n`; }
    catch { blockers.push('pde_cpu_oracle_request_serialization_invalid'); }
    if (Buffer.byteLength(encoded) > MAXIMUM_REQUEST_BYTES) {
      blockers.push('pde_cpu_oracle_request_too_large');
    }
  }
  if (!blockers.length) {
    try {
      const remainingMs = absoluteDeadlineEpochMs - readTrustedWallClockEpochMs();
      if (remainingMs < 1) throw new Error('pde_cpu_oracle_deadline_exhausted');
      const sourceIdentity = inspectWorkspaceExecutionSnapshot(repositoryRoot, {
        excludeNames: sourceTreeExcludedNames(repositoryRoot),
      });
      if (sourceIdentity.blockers.length) {
        throw new Error('pde_cpu_oracle_source_closure_invalid');
      }
      sandboxReceipt = snapshotJsonObject(runner.run({
        executable: PDE_POISSON_2D_CPU_ORACLE_EXECUTABLE_TARGET,
        args: [workerPath],
        cwd: repositoryRoot,
        sourceRoot: repositoryRoot,
        expectedSourceMerkleHash: sourceIdentity.merkleHash,
        expectedSourceWorkspaceManifestHash: sourceIdentity.manifestHash,
        executionIdentity,
        timeoutMs: effectiveResourceBudget.timeoutMs,
        env: {
          OMP_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          NUMEXPR_NUM_THREADS: '1',
          BLIS_NUM_THREADS: '1',
          VECLIB_MAXIMUM_THREADS: '1',
          OMP_DYNAMIC: 'FALSE',
          MKL_DYNAMIC: 'FALSE',
        },
        standardInput: encoded,
        requireImmutableWorkRoot: true,
        language: 'node',
        determinismPolicy: 'explicit_deterministic_cpu',
        deterministicSeed: request.requestHash,
        memoryBytes: effectiveResourceBudget.memoryBytes,
        cpuSeconds: effectiveResourceBudget.cpuSeconds,
        maximumProcesses: effectiveResourceBudget.maximumProcesses,
        requestedMaximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
        runtimePackageClosure: Object.freeze({
          basis: 'container_image_digest',
          identityHash: AUTOMATION_RUNTIME_IMAGES.python.imageDigest,
          manifestHash: null,
          observedPackageCount: 0,
        }),
        runtimeBuildReproducibility:
          AUTOMATION_RUNTIME_IMAGES.python.buildReproducibility,
      }));
    } catch { sandboxReceipt = null; }
  }
  let sandboxVerified = false;
  try { sandboxVerified = verifyProductionOsSandboxWorkerReceipt(sandboxReceipt); }
  catch { sandboxVerified = false; }
  if (request && !sandboxVerified) {
    blockers.push('pde_cpu_oracle_production_os_sandbox_invalid');
    if (Array.isArray(sandboxReceipt?.blockers)) {
      blockers.push(...sandboxReceipt.blockers.map(
        (blocker) => `pde_cpu_oracle_os_sandbox:${blocker}`,
      ));
    }
  }
  const workerReceipt = request && sandboxVerified
    ? parseWorkerReceipt(sandboxReceipt, { request, workerImplementation }) : null;
  if (request && !workerReceipt) blockers.push('pde_cpu_oracle_worker_receipt_invalid');
  if (readTrustedWallClockEpochMs() >= absoluteDeadlineEpochMs) {
    blockers.push('pde_cpu_oracle_absolute_deadline_exceeded');
  }
  return buildProcessIsolatedPdePoisson2dCpuOracleAssurance({
    request,
    workerImplementation,
    workerReceipt,
    osSandboxWorkerReceipt: sandboxReceipt,
    absoluteDeadlineEpochMs,
    blockers,
  });
}

export function verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts(
  assurance,
  {
    artifactRoot,
    artifactManifest,
    producerSpecification = buildPdePoisson2dGpuProducerSpecification(),
  } = {},
) {
  try {
    const workerImplementation =
      currentPdePoisson2dCpuOracleWorkerImplementation();
    const sourceIdentity = inspectWorkspaceExecutionSnapshot(repositoryRoot, {
      excludeNames: sourceTreeExcludedNames(repositoryRoot),
    });
    if (sourceIdentity.blockers.length
      || assurance?.osSandboxWorkerReceipt?.expectedSourceMerkleHash
        !== sourceIdentity.merkleHash
      || assurance?.osSandboxWorkerReceipt?.expectedSourceWorkspaceManifestHash
        !== sourceIdentity.manifestHash) return false;
    const prepared = buildRequestFromArtifacts({
      artifactRoot,
      artifactManifest,
      producerSpecification,
      workerImplementation,
      oracleRuntimeIdentityHash: assurance?.oracleRuntimeIdentityHash,
      resourceBudget: assurance?.resourceBudget,
    });
    return prepared.reads.blockers.length === 0
      && verifyProcessIsolatedPdePoisson2dCpuOracleAssurance(assurance, {
        request: prepared.request,
        workerImplementation,
      });
  } catch { return false; }
}
