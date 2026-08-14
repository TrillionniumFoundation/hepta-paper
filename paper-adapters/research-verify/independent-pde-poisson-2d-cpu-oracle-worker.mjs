import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPdePoisson2dIndependentCpuOracleReceipt,
} from '../../paper-domain/research/pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import {
  buildPdePoisson2dCpuOracleWorkerImplementation,
  buildPdePoisson2dCpuOracleWorkerReceipt,
  verifyProcessIsolatedPdePoisson2dCpuOracleRequest,
} from '../../paper-domain/research/process-isolated-pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  PDE_POISSON_2D_INDEPENDENT_CPU_ALGORITHM_IMPLEMENTATION,
  recomputePdePoisson2dMetricsFromArtifactBytes,
} from './pde-poisson-2d-independent-cpu-oracle-algorithm.mjs';

const MAXIMUM_REQUEST_BYTES = 4 * 1024 * 1024;
const REQUEST_READ_CHUNK_BYTES = 64 * 1024;
const workerPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(workerPath), '..', '..');
const rootSourcePaths = Object.freeze([
  Object.freeze({
    role: 'oracle-algorithm',
    path: fileURLToPath(new URL(
      './pde-poisson-2d-independent-cpu-oracle-algorithm.mjs',
      import.meta.url,
    )),
  }),
  Object.freeze({
    role: 'process-assurance-contract',
    path: fileURLToPath(new URL(
      '../../paper-domain/research/process-isolated-pde-poisson-2d-independent-cpu-oracle-contract.mjs',
      import.meta.url,
    )),
  }),
  Object.freeze({
    role: 'producer-artifact-contract',
    path: fileURLToPath(new URL(
      '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs',
      import.meta.url,
    )),
  }),
  Object.freeze({
    role: 'scientific-receipt-contract',
    path: fileURLToPath(new URL(
      '../../paper-domain/research/pde-poisson-2d-independent-cpu-oracle-contract.mjs',
      import.meta.url,
    )),
  }),
  Object.freeze({ role: 'worker-entry', path: workerPath }),
]);
const LOCAL_IMPORT_PATTERN =
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function repositoryRelative(sourcePath) {
  const relative = path.relative(repositoryRoot, sourcePath);
  if (!relative || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('pde_cpu_oracle_worker_source_outside_repository');
  }
  return relative.split(path.sep).join('/');
}

function localImports(sourcePath, sourceBytes) {
  const imported = [];
  const source = Buffer.isBuffer(sourceBytes)
    ? sourceBytes.toString('utf8') : String(sourceBytes);
  for (const match of source.matchAll(LOCAL_IMPORT_PATTERN)) {
    if (!match[1].startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(sourcePath), match[1]);
    const candidate = path.extname(resolved) ? resolved : `${resolved}.mjs`;
    repositoryRelative(candidate);
    imported.push(candidate);
  }
  return imported;
}

function transitiveSourcePaths(readSource) {
  const pending = rootSourcePaths.map(({ path: sourcePath }) => sourcePath);
  const sources = new Map();
  while (pending.length) {
    const sourcePath = pending.pop();
    const relative = repositoryRelative(sourcePath);
    if (sources.has(relative)) continue;
    const bytes = readSource(sourcePath);
    if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') {
      throw new Error('pde_cpu_oracle_worker_source_read_invalid');
    }
    sources.set(relative, bytes);
    pending.push(...localImports(sourcePath, bytes));
  }
  return sources;
}

function isMain(moduleUrl) {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

function readBoundedRequestBytes() {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= MAXIMUM_REQUEST_BYTES) {
    const remaining = (MAXIMUM_REQUEST_BYTES + 1) - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(REQUEST_READ_CHUNK_BYTES, remaining));
    const bytesRead = fs.readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  return Buffer.concat(chunks, totalBytes);
}

export function currentPdePoisson2dCpuOracleWorkerImplementation({
  readSource = (sourcePath) => fs.readFileSync(sourcePath),
} = {}) {
  const sources = transitiveSourcePaths(readSource);
  const rootRelatives = new Set(rootSourcePaths.map(
    ({ path: sourcePath }) => repositoryRelative(sourcePath),
  ));
  return buildPdePoisson2dCpuOracleWorkerImplementation({
    sourceRecords: [
      ...rootSourcePaths.map(({ role, path: sourcePath }) => Object.freeze({
        role,
        sha256: hashBytes(sources.get(repositoryRelative(sourcePath))),
      })),
      ...[...sources.entries()]
        .filter(([relative]) => !rootRelatives.has(relative))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([relative, bytes]) => Object.freeze({
          role: `transitive:${relative}`,
          sha256: hashBytes(bytes),
        })),
    ],
  });
}

export function runIndependentPdePoisson2dCpuOracleWorker({
  readRequestBytes = readBoundedRequestBytes,
  writeReceipt = (receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`),
  workerPid = process.pid,
  parentPid = process.ppid,
  readSource,
} = {}) {
  const blockers = [];
  let request = null;
  let workerImplementation = null;
  let oracleReceipt = null;
  try {
    workerImplementation = currentPdePoisson2dCpuOracleWorkerImplementation({
      readSource,
    });
  } catch {
    blockers.push('pde_cpu_oracle_worker_implementation_invalid');
  }
  try {
    const bytes = readRequestBytes();
    if (!Buffer.isBuffer(bytes) || bytes.length < 2
      || bytes.length > MAXIMUM_REQUEST_BYTES) {
      throw new Error('pde_cpu_oracle_request_size_invalid');
    }
    request = JSON.parse(bytes.toString('utf8'));
    if (!verifyProcessIsolatedPdePoisson2dCpuOracleRequest(request, {
      workerImplementation,
    })) throw new Error('pde_cpu_oracle_request_invalid');
  } catch (error) {
    blockers.push(String(error?.message || 'pde_cpu_oracle_request_invalid'));
  }
  if (!blockers.length) {
    try {
      const metrics = recomputePdePoisson2dMetricsFromArtifactBytes({
        producerSpecification: request.producerSpecification,
        artifactManifest: request.artifactManifest,
        artifactBytes: request.artifactPayloads.map((artifact) => (
          Buffer.from(artifact.contentBase64, 'base64')
        )),
      });
      oracleReceipt = buildPdePoisson2dIndependentCpuOracleReceipt({
        producerSpecification: request.producerSpecification,
        artifactManifest: request.artifactManifest,
        oracleImplementationHash:
          PDE_POISSON_2D_INDEPENDENT_CPU_ALGORITHM_IMPLEMENTATION
            .implementationHash,
        oracleRuntimeIdentityHash: request.oracleRuntimeIdentityHash,
        artifactReadReceiptHashes: request.artifactReadReceiptHashes,
        observations: metrics.observations,
        convergenceOrders: metrics.convergenceOrders,
      });
    } catch (error) {
      blockers.push(String(error?.message || 'pde_cpu_oracle_recomputation_failed'));
    }
  }
  const receipt = buildPdePoisson2dCpuOracleWorkerReceipt({
    request,
    workerImplementation,
    oracleReceipt,
    workerPid,
    parentPid,
    blockers,
  });
  writeReceipt(receipt);
  return receipt;
}

if (isMain(import.meta.url)) {
  const receipt = runIndependentPdePoisson2dCpuOracleWorker();
  process.exitCode = receipt.blockers.length ? 2 : 0;
}
