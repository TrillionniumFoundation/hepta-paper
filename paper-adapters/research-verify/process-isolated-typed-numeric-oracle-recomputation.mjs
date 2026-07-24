import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildProcessIsolatedTypedNumericOracleRecomputationReceipt,
  buildProcessIsolatedTypedNumericOracleRequest,
  buildTypedNumericOracleWorkerImplementation,
  verifyProcessIsolatedTypedNumericOracleWorkerReceipt,
} from '../../paper-domain/research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs';
import {
  INDEPENDENT_TYPED_NUMERIC_ORACLE_IMPLEMENTATION,
  verifyIndependentTypedNumericOracleRecomputation,
} from '../../paper-domain/research/independent-typed-numeric-oracle-recomputation.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 24 * 1024 * 1024;
const workerPath = fileURLToPath(new URL(
  './independent-typed-numeric-oracle-recomputation-worker.mjs',
  import.meta.url,
));
const sourcePaths = Object.freeze({
  workerImplementationSourceHash: workerPath,
  recomputationImplementationSourceHash: fileURLToPath(new URL(
    '../../paper-domain/research/independent-typed-numeric-oracle-recomputation.mjs',
    import.meta.url,
  )),
  processContractSourceHash: fileURLToPath(new URL(
    '../../paper-domain/research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs',
    import.meta.url,
  )),
  producerAlgorithmRegistrySourceHash: fileURLToPath(new URL(
    '../../paper-domain/research/typed-numeric-oracle-production.mjs',
    import.meta.url,
  )),
});

function currentWorkerImplementation(
  readSource = (sourcePath) => fs.readFileSync(sourcePath),
) {
  const sourceHashes = Object.fromEntries(Object.entries(sourcePaths).map(
    ([field, sourcePath]) => [field, hashBytes(readSource(sourcePath))],
  ));
  return buildTypedNumericOracleWorkerImplementation({
    ...sourceHashes,
    independentAlgorithmImplementationHash:
      INDEPENDENT_TYPED_NUMERIC_ORACLE_IMPLEMENTATION
        .independentTypedNumericOracleImplementationHash,
  });
}

function parseWorkerReceipt(result, {
  request,
  inputs,
  workerImplementation,
} = {}) {
  let receipt = null;
  try { receipt = JSON.parse(String(result?.stdout || '').trim()); }
  catch { return null; }
  if (receipt?.workerPid !== result?.pid
    || receipt?.parentPid !== process.pid
    || !verifyProcessIsolatedTypedNumericOracleWorkerReceipt(receipt, {
      request,
      workerImplementation,
      verifyRecomputation: (candidate) => (
        verifyIndependentTypedNumericOracleRecomputation(candidate, inputs)
      ),
    })) return null;
  return Object.freeze(receipt);
}

export function runProcessIsolatedTypedNumericOracleRecomputation(input = {}, {
  timeoutMs = 120_000,
  spawnSyncImpl = spawnSync,
  environment = process.env,
  readSource,
} = {}) {
  const request = buildProcessIsolatedTypedNumericOracleRequest(input);
  const encoded = `${JSON.stringify(request)}\n`;
  const implementation = currentWorkerImplementation(readSource);
  const blockers = [];
  if (Buffer.byteLength(encoded) > MAXIMUM_REQUEST_BYTES) {
    blockers.push('process_isolated_typed_numeric_request_too_large');
  }
  let result = null;
  if (!blockers.length) {
    result = spawnSyncImpl(process.execPath, [workerPath], {
      cwd: path.dirname(workerPath),
      env: {
        PATH: String(environment.PATH || ''),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
      },
      input: encoded,
      encoding: 'utf8',
      timeout: Number(timeoutMs),
      maxBuffer: MAXIMUM_RESPONSE_BYTES,
      windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
      blockers.push(result.error?.code === 'ETIMEDOUT'
        ? 'process_isolated_typed_numeric_recomputation_timed_out'
        : 'process_isolated_typed_numeric_recomputation_worker_failed');
    }
  }
  const receipt = blockers.length ? null : parseWorkerReceipt(result, {
    request,
    inputs: input,
    workerImplementation: implementation,
  });
  if (!receipt) blockers.push('process_isolated_typed_numeric_recomputation_receipt_invalid');
  return buildProcessIsolatedTypedNumericOracleRecomputationReceipt({
    request,
    workerImplementation: implementation,
    workerReceipt: receipt,
    parentPid: process.pid,
    workerPid: receipt?.workerPid || null,
    blockers,
  });
}

export function verifyProcessIsolatedTypedNumericOracleRecomputation(receipt, inputs = {}, {
  readSource,
} = {}) {
  try {
    const implementation = currentWorkerImplementation(readSource);
    return JSON.stringify(receipt?.workerImplementation) === JSON.stringify(implementation)
      && receipt?.workerImplementationSourceHash
        === implementation.workerImplementationSourceHash
      && receipt?.workerSourceClosureHash === implementation.workerSourceClosureHash
      && verifyIndependentTypedNumericOracleRecomputation(receipt, inputs);
  } catch { return false; }
}
