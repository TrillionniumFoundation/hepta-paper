import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  buildIndependentRawEventRecomputationManifest,
  INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION,
} from './independent-system-benchmark-recomputation.mjs';

const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const REQUEST_KEYS = Object.freeze([
  'cells', 'kind', 'metricSpecs', 'rawEventRows', 'requestHash',
  'requiredMetrics', 'version',
]);
const REQUEST_KEYS_V2 = Object.freeze([
  ...REQUEST_KEYS, 'versionedExperimentIrHash',
]);
const REQUEST_READ_CHUNK_BYTES = 64 * 1024;

function isMain(moduleUrl) {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

function withReceiptHash(payload) {
  return Object.freeze({
    ...payload,
    processIsolatedRawEventRecomputationWorkerReceiptHash: hashRecord(
      'ProcessIsolatedRawEventRecomputationWorkerReceipt',
      payload,
    ),
  });
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

export function runIndependentSystemBenchmarkRecomputationWorker({
  readRequestBytes = readBoundedRequestBytes,
  writeReceipt = (receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`),
  workerPid = process.pid,
  parentPid = process.ppid,
  sourceBytes = () => fs.readFileSync(fileURLToPath(import.meta.url)),
} = {}) {
  const workerSourceHash = hashBytes(sourceBytes());
  const workerImplementationPayload = Object.freeze({
    version: 1,
    kind: 'ProcessIsolatedRawEventRecomputationWorkerImplementation',
    sourceHash: workerSourceHash,
    independentImplementationHash:
      INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION
        .independentSystemBenchmarkRecomputationImplementationHash,
    assuranceScope: 'process-isolated-independent-implementation-v1',
    networkActionPerformed: false,
    externalActionPerformed: false,
  });
  const workerImplementationHash = hashRecord(
    'ProcessIsolatedRawEventRecomputationWorkerImplementation',
    workerImplementationPayload,
  );

  let request = null;
  const blockers = [];
  try {
    const bytes = readRequestBytes();
    if (!Buffer.isBuffer(bytes)
      || bytes.length < 2
      || bytes.length > MAXIMUM_REQUEST_BYTES) {
      throw new Error('process_isolated_recomputation_request_size_invalid');
    }
    request = JSON.parse(bytes.toString('utf8'));
    const requestKeys = request?.version === 2 ? REQUEST_KEYS_V2 : REQUEST_KEYS;
    if (!hasExactObjectKeys(request, requestKeys)
      || ![1, 2].includes(request.version)
      || request.kind !== 'ProcessIsolatedRawEventRecomputationRequest') {
      throw new Error('process_isolated_recomputation_request_shape_invalid');
    }
    const { requestHash, ...requestPayload } = request;
    if (hashRecord('ProcessIsolatedRawEventRecomputationRequest', requestPayload)
      !== requestHash) {
      throw new Error('process_isolated_recomputation_request_hash_invalid');
    }
  } catch (error) {
    blockers.push(String(error?.message || 'process_isolated_recomputation_request_invalid'));
  }

  let manifest = null;
  if (!blockers.length) {
    try {
      manifest = buildIndependentRawEventRecomputationManifest({
        cells: request.cells,
        rawEventRows: request.rawEventRows,
        requiredMetrics: request.requiredMetrics,
        metricSpecs: request.metricSpecs,
        versionedExperimentIrHash: request.versionedExperimentIrHash || null,
      });
      blockers.push(...manifest.blockers);
    } catch (error) {
      blockers.push(String(error?.message || 'process_isolated_recomputation_failed'));
    }
  }

  const receipt = withReceiptHash({
    version: 1,
    kind: 'ProcessIsolatedRawEventRecomputationWorkerReceipt',
    status: blockers.length
      ? 'process_isolated_raw_event_recomputation_blocked'
      : 'process_isolated_raw_event_recomputation_verified',
    requestHash: request?.requestHash || null,
    manifest,
    rawEventRecomputationManifestHash:
      manifest?.rawEventRecomputationManifestHash || null,
    workerPid,
    parentPid,
    workerImplementationSourceHash: workerSourceHash,
    workerImplementationHash,
    independentImplementationHash:
      INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION
        .independentSystemBenchmarkRecomputationImplementationHash,
    assuranceScope: 'process-isolated-independent-implementation-v1',
    processIndependent: true,
    networkActionPerformed: false,
    externalActionPerformed: false,
    blockers: Object.freeze([...new Set(blockers)]),
  });
  writeReceipt(receipt);
  return receipt;
}

if (isMain(import.meta.url)) {
  const receipt = runIndependentSystemBenchmarkRecomputationWorker();
  process.exitCode = receipt.blockers.length ? 2 : 0;
}
