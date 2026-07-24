import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION,
} from './independent-system-benchmark-recomputation.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 24 * 1024 * 1024;
const WORKER_RECEIPT_KEYS = Object.freeze([
  'assuranceScope', 'blockers', 'externalActionPerformed',
  'independentImplementationHash', 'kind', 'manifest',
  'networkActionPerformed', 'parentPid', 'processIndependent',
  'processIsolatedRawEventRecomputationWorkerReceiptHash',
  'rawEventRecomputationManifestHash', 'requestHash', 'status', 'version',
  'workerImplementationHash', 'workerImplementationSourceHash', 'workerPid',
]);

export const PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE =
  'process-isolated-independent-implementation-v1';

const workerPath = fileURLToPath(new URL(
  './independent-system-benchmark-recomputation-worker.mjs',
  import.meta.url,
));

function requestDocument(input = {}) {
  const versionedExperimentIrHash = SHA256.test(
    String(input.versionedExperimentIrHash || ''),
  ) ? String(input.versionedExperimentIrHash).toLowerCase() : null;
  const payload = {
    version: versionedExperimentIrHash ? 2 : 1,
    kind: 'ProcessIsolatedRawEventRecomputationRequest',
    cells: input.cells || [],
    rawEventRows: input.rawEventRows || [],
    requiredMetrics: input.requiredMetrics || [],
    metricSpecs: input.metricSpecs || {},
    ...(versionedExperimentIrHash ? { versionedExperimentIrHash } : {}),
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('ProcessIsolatedRawEventRecomputationRequest', payload),
  });
}

function parseWorkerReceipt(result, { request, workerSourceHash } = {}) {
  let receipt = null;
  try { receipt = JSON.parse(String(result?.stdout || '').trim()); }
  catch { return null; }
  if (!hasExactObjectKeys(receipt, WORKER_RECEIPT_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'ProcessIsolatedRawEventRecomputationWorkerReceipt'
    || receipt.status !== 'process_isolated_raw_event_recomputation_verified'
    || receipt.assuranceScope !== PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE
    || receipt.processIndependent !== true
    || receipt.networkActionPerformed !== false
    || receipt.externalActionPerformed !== false
    || receipt.requestHash !== request.requestHash
    || receipt.workerImplementationSourceHash !== workerSourceHash
    || receipt.independentImplementationHash
      !== INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION
        .independentSystemBenchmarkRecomputationImplementationHash
    || !Number.isSafeInteger(receipt.workerPid) || receipt.workerPid < 1
    || receipt.workerPid === process.pid || receipt.workerPid !== result.pid
    || receipt.parentPid !== process.pid
    || !Array.isArray(receipt.blockers) || receipt.blockers.length !== 0
    || receipt.manifest?.status !== 'raw_event_recomputation_verified'
    || receipt.rawEventRecomputationManifestHash
      !== receipt.manifest.rawEventRecomputationManifestHash
    || !SHA256.test(String(receipt.workerImplementationHash || ''))
    || !SHA256.test(String(receipt.processIsolatedRawEventRecomputationWorkerReceiptHash || ''))) {
    return null;
  }
  const {
    processIsolatedRawEventRecomputationWorkerReceiptHash: claimedHash,
    ...payload
  } = receipt;
  return hashRecord('ProcessIsolatedRawEventRecomputationWorkerReceipt', payload)
    === claimedHash ? Object.freeze(receipt) : null;
}

export function runProcessIsolatedRawEventRecomputation(input = {}, {
  timeoutMs = 120_000,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const request = requestDocument(input);
  const encoded = `${JSON.stringify(request)}\n`;
  const blockers = [];
  if (Buffer.byteLength(encoded) > MAXIMUM_REQUEST_BYTES) {
    blockers.push('process_isolated_recomputation_request_too_large');
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
        ...(environment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE ? {
          HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE:
            String(environment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE),
        } : {}),
        ...(environment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE ? {
          HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE:
            String(environment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE),
        } : {}),
      },
      input: encoded,
      encoding: 'utf8',
      timeout: Number(timeoutMs),
      maxBuffer: MAXIMUM_RESPONSE_BYTES,
      windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
      blockers.push(result.error?.code === 'ETIMEDOUT'
        ? 'process_isolated_recomputation_timed_out'
        : 'process_isolated_recomputation_worker_failed');
    }
  }
  const workerSourceHash = hashBytes(fs.readFileSync(workerPath));
  const receipt = blockers.length ? null : parseWorkerReceipt(result, {
    request,
    workerSourceHash,
  });
  if (!receipt) blockers.push('process_isolated_recomputation_receipt_invalid');
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedRawEventRecomputationAssurance',
    status: blockers.length
      ? 'process_isolated_raw_event_recomputation_blocked'
      : 'process_isolated_raw_event_recomputation_verified',
    assuranceScope: PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE,
    requestHash: request.requestHash,
    workerReceiptHash:
      receipt?.processIsolatedRawEventRecomputationWorkerReceiptHash || null,
    rawEventRecomputationManifestHash:
      receipt?.rawEventRecomputationManifestHash || null,
    workerImplementationSourceHash: workerSourceHash,
    workerImplementationHash: receipt?.workerImplementationHash || null,
    independentImplementationHash:
      INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION
        .independentSystemBenchmarkRecomputationImplementationHash,
    parentPid: process.pid,
    workerPid: receipt?.workerPid || null,
    processIndependent: blockers.length === 0,
    networkActionPerformed: false,
    externalActionPerformed: false,
    workerReceipt: receipt,
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    processIsolatedRawEventRecomputationAssuranceHash: hashRecord(
      'ProcessIsolatedRawEventRecomputationAssurance',
      payload,
    ),
  });
}

export function verifyProcessIsolatedRawEventRecomputationAssurance(
  assurance,
  input = {},
) {
  if (!assurance
    || assurance.version !== 1
    || assurance.kind !== 'ProcessIsolatedRawEventRecomputationAssurance'
    || assurance.status !== 'process_isolated_raw_event_recomputation_verified'
    || assurance.assuranceScope !== PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE
    || assurance.processIndependent !== true
    || assurance.networkActionPerformed !== false
    || assurance.externalActionPerformed !== false
    || !Array.isArray(assurance.blockers) || assurance.blockers.length !== 0
    || assurance.requestHash !== requestDocument(input).requestHash
    || assurance.workerReceiptHash
      !== assurance.workerReceipt?.processIsolatedRawEventRecomputationWorkerReceiptHash
    || assurance.rawEventRecomputationManifestHash
      !== assurance.workerReceipt?.rawEventRecomputationManifestHash
    || assurance.workerImplementationSourceHash
      !== assurance.workerReceipt?.workerImplementationSourceHash
    || assurance.workerImplementationHash
      !== assurance.workerReceipt?.workerImplementationHash
    || assurance.parentPid !== process.pid
    || assurance.workerPid !== assurance.workerReceipt?.workerPid
    || !SHA256.test(String(assurance.processIsolatedRawEventRecomputationAssuranceHash || ''))) {
    return false;
  }
  const { processIsolatedRawEventRecomputationAssuranceHash, ...payload } = assurance;
  return hashRecord('ProcessIsolatedRawEventRecomputationAssurance', payload)
    === processIsolatedRawEventRecomputationAssuranceHash;
}
