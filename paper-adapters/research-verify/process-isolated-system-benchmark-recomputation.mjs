import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { verifyOsSandboxWorkerReceipt } from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
} from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';
import {
  INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION,
} from './independent-system-benchmark-recomputation.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 24 * 1024 * 1024;
export const RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS = 300_000;
export const RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS = 120;
const WORKER_RECEIPT_KEYS = Object.freeze([
  'assuranceScope', 'blockers', 'externalActionPerformed',
  'independentImplementationHash', 'kind', 'manifest',
  'networkActionPerformed', 'parentPid', 'processIndependent',
  'processIsolatedRawEventRecomputationWorkerReceiptHash',
  'rawEventRecomputationManifestHash', 'requestHash', 'status', 'version',
  'workerImplementationHash', 'workerImplementationSourceHash', 'workerPid',
]);

export const PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE =
  'os-sandboxed-process-independent-implementation-v1';
const PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_WORKER_SCOPE =
  'process-isolated-independent-implementation-v1';

const workerPath = fileURLToPath(new URL(
  './independent-system-benchmark-recomputation-worker.mjs',
  import.meta.url,
));
const repositoryRoot = path.resolve(path.dirname(workerPath), '..', '..');

export const RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE =
  `${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.image}`
  + `@${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest}`;

function validateRawEventRecomputationTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isSafeInteger(value)
    || value < 1
    || value > RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS) {
    throw new TypeError('process_isolated_recomputation_timeout_invalid');
  }
  return value;
}

export function createRawEventRecomputationSandboxRunner({
  timeoutMs = RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
} = {}) {
  const boundedTimeoutMs = validateRawEventRecomputationTimeout(timeoutMs);
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [repositoryRoot],
    dockerImage: RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
    maximumTimeoutMs: boundedTimeoutMs,
    maximumMemoryBytes: 1024 * 1024 * 1024,
    maximumCpuSeconds: RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
    maximumPids: 32,
    maximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
    maximumCapturedBytes: MAXIMUM_RESPONSE_BYTES,
    maximumInputBytes: MAXIMUM_REQUEST_BYTES,
  });
}

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

function workerProcessIdentityMatchesSandbox(workerReceipt, sandboxReceipt) {
  return sandboxReceipt?.backend !== 'docker'
    || (workerReceipt?.workerPid === 1 && workerReceipt?.parentPid === 0);
}

function parseWorkerReceipt(sandboxReceipt, { request, workerSourceHash } = {}) {
  if (!verifyOsSandboxWorkerReceipt(sandboxReceipt)
    || !Number.isSafeInteger(sandboxReceipt.executionProcessIdentity?.launcherPid)
    || sandboxReceipt.executionProcessIdentity.launcherPid < 1) return null;
  let receipt = null;
  try { receipt = JSON.parse(String(sandboxReceipt.stdout || '').trim()); }
  catch { return null; }
  if (!hasExactObjectKeys(receipt, WORKER_RECEIPT_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'ProcessIsolatedRawEventRecomputationWorkerReceipt'
    || receipt.status !== 'process_isolated_raw_event_recomputation_verified'
    || receipt.assuranceScope !== PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_WORKER_SCOPE
    || receipt.processIndependent !== true
    || receipt.networkActionPerformed !== false
    || receipt.externalActionPerformed !== false
    || receipt.requestHash !== request.requestHash
    || receipt.workerImplementationSourceHash !== workerSourceHash
    || receipt.independentImplementationHash
      !== INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION
        .independentSystemBenchmarkRecomputationImplementationHash
    || !Number.isSafeInteger(receipt.workerPid) || receipt.workerPid < 1
    || !Number.isSafeInteger(receipt.parentPid) || receipt.parentPid < 0
    || receipt.workerPid === receipt.parentPid
    || !workerProcessIdentityMatchesSandbox(receipt, sandboxReceipt)
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
  timeoutMs = RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
  sandboxWorkerRunner = null,
  environment = process.env,
} = {}) {
  const request = requestDocument(input);
  const encoded = `${JSON.stringify(request)}\n`;
  const blockers = [];
  if (Buffer.byteLength(encoded) > MAXIMUM_REQUEST_BYTES) {
    blockers.push('process_isolated_recomputation_request_too_large');
  }
  let boundedTimeoutMs = null;
  try {
    boundedTimeoutMs = validateRawEventRecomputationTimeout(timeoutMs);
  } catch (error) {
    blockers.push(String(error?.message || 'process_isolated_recomputation_timeout_invalid'));
  }
  let sandboxReceipt = null;
  if (environment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE
    || environment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE) {
    blockers.push('raw_event_recomputation_external_plugin_configuration_not_sandbox_mounted');
  }
  if (!blockers.length) {
    const runner = sandboxWorkerRunner
      || createRawEventRecomputationSandboxRunner({ timeoutMs: boundedTimeoutMs });
    try {
      sandboxReceipt = runner?.run?.({
        executable: process.execPath,
        args: [workerPath],
        cwd: repositoryRoot,
        sourceRoot: repositoryRoot,
        timeoutMs: boundedTimeoutMs,
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
        memoryBytes: 1024 * 1024 * 1024,
        cpuSeconds: RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
        maximumProcesses: 32,
        requestedMaximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
      }) || null;
    } catch {
      sandboxReceipt = null;
    }
    if (!verifyOsSandboxWorkerReceipt(sandboxReceipt)) {
      blockers.push('raw_event_recomputation_os_sandbox_invalid');
      blockers.push(...(sandboxReceipt?.blockers || [])
        .map((blocker) => `raw_event_recomputation_os_sandbox:${blocker}`));
    }
  }
  const workerSourceHash = hashBytes(fs.readFileSync(workerPath));
  const receipt = blockers.length ? null : parseWorkerReceipt(sandboxReceipt, {
    request,
    workerSourceHash,
  });
  if (!receipt) blockers.push('process_isolated_recomputation_receipt_invalid');
  const payload = {
    version: 2,
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
    parentPid: receipt?.parentPid ?? null,
    workerPid: receipt?.workerPid ?? null,
    processIndependent: blockers.length === 0,
    osSandboxed: blockers.length === 0,
    osSandboxBackend: sandboxReceipt?.backend || null,
    osSandboxWorkerReceiptHash: sandboxReceipt?.receiptHash || null,
    osSandboxEnvironmentBomHash: sandboxReceipt?.environmentBomHash || null,
    osSandboxWorkerReceipt: sandboxReceipt,
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
    || assurance.version !== 2
    || assurance.kind !== 'ProcessIsolatedRawEventRecomputationAssurance'
    || assurance.status !== 'process_isolated_raw_event_recomputation_verified'
    || assurance.assuranceScope !== PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE
    || assurance.processIndependent !== true
    || assurance.osSandboxed !== true
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
    || assurance.parentPid !== assurance.workerReceipt?.parentPid
    || assurance.workerPid !== assurance.workerReceipt?.workerPid
    || !verifyOsSandboxWorkerReceipt(assurance.osSandboxWorkerReceipt)
    || assurance.osSandboxWorkerReceiptHash
      !== assurance.osSandboxWorkerReceipt?.receiptHash
    || assurance.osSandboxEnvironmentBomHash
      !== assurance.osSandboxWorkerReceipt?.environmentBomHash
    || assurance.osSandboxBackend !== assurance.osSandboxWorkerReceipt?.backend
    || !workerProcessIdentityMatchesSandbox(
      assurance.workerReceipt,
      assurance.osSandboxWorkerReceipt,
    )
    || JSON.stringify(assurance.workerReceipt)
      !== String(assurance.osSandboxWorkerReceipt?.stdout || '').trim()
    || !SHA256.test(String(assurance.processIsolatedRawEventRecomputationAssuranceHash || ''))) {
    return false;
  }
  const { processIsolatedRawEventRecomputationAssuranceHash, ...payload } = assurance;
  return hashRecord('ProcessIsolatedRawEventRecomputationAssurance', payload)
    === processIsolatedRawEventRecomputationAssuranceHash;
}
