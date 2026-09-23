import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS,
  SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
  verifyRawEventRecomputationResourceBudget,
} from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import {
  INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION,
} from '../../paper-domain/automation/independent-system-benchmark-recomputation-identity.mjs';
import {
  createRawEventRecomputationSandboxRunner,
  RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
} from './raw-event-recomputation-sandbox-runner-factory.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 24 * 1024 * 1024;
export const RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS =
  RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs;
export const RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS =
  RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds;
export const RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES =
  RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes;
export const RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES =
  RAW_EVENT_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses;
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

export { RAW_EVENT_RECOMPUTATION_DOCKER_FALLBACK_IMAGE };

function validateRawEventRecomputationTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isSafeInteger(value)
    || value < 1
    || value > RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS) {
    throw new TypeError('process_isolated_recomputation_timeout_invalid');
  }
  return value;
}

function validateRawEventRecomputationResource(value, maximum) {
  const bounded = Number(value);
  if (!Number.isSafeInteger(bounded) || bounded < 1 || bounded > maximum) {
    throw new TypeError('process_isolated_recomputation_resource_budget_invalid');
  }
  return bounded;
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

function expectedWorkerImplementationHash(workerSourceHash) {
  return hashRecord('ProcessIsolatedRawEventRecomputationWorkerImplementation', {
    version: 1,
    kind: 'ProcessIsolatedRawEventRecomputationWorkerImplementation',
    sourceHash: workerSourceHash,
    independentImplementationHash:
      INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION
        .independentSystemBenchmarkRecomputationImplementationHash,
    assuranceScope: PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_WORKER_SCOPE,
    networkActionPerformed: false,
    externalActionPerformed: false,
  });
}

function snapshotSandboxReceipt(receipt) {
  try {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
    const snapshot = JSON.parse(JSON.stringify(receipt));
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? snapshot : null;
  } catch { return null; }
}

function parseWorkerReceipt(sandboxReceipt, { request, workerSourceHash } = {}) {
  if (!verifyProductionOsSandboxWorkerReceipt(sandboxReceipt)
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
    || receipt.workerImplementationHash
      !== expectedWorkerImplementationHash(workerSourceHash)
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
  memoryBytes = RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES,
  cpuSeconds = RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
  maximumProcesses = RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
} = {}) {
  const blockers = [];
  let request = null;
  let encoded = '';
  try {
    request = requestDocument(input);
    encoded = `${JSON.stringify(request)}\n`;
  } catch {
    blockers.push('process_isolated_recomputation_request_invalid');
  }
  if (Buffer.byteLength(encoded) > MAXIMUM_REQUEST_BYTES) {
    blockers.push('process_isolated_recomputation_request_too_large');
  }
  let boundedTimeoutMs = null;
  let resourceBudget = null;
  try {
    boundedTimeoutMs = validateRawEventRecomputationTimeout(timeoutMs);
    resourceBudget = Object.freeze({
      timeoutMs: boundedTimeoutMs,
      memoryBytes: validateRawEventRecomputationResource(
        memoryBytes,
        RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES,
      ),
      cpuSeconds: validateRawEventRecomputationResource(
        cpuSeconds,
        RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
      ),
      maximumProcesses: validateRawEventRecomputationResource(
        maximumProcesses,
        RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
      ),
    });
  } catch (error) {
    blockers.push(String(error?.message || 'process_isolated_recomputation_resource_budget_invalid'));
  }
  let sandboxReceipt = null;
  if (process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE
    || process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE) {
    blockers.push('raw_event_recomputation_external_plugin_configuration_not_sandbox_mounted');
  }
  if (!blockers.length) {
    try {
      const runner = createRawEventRecomputationSandboxRunner(resourceBudget);
      sandboxReceipt = snapshotSandboxReceipt(runner?.run?.({
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
        memoryBytes: resourceBudget.memoryBytes,
        cpuSeconds: resourceBudget.cpuSeconds,
        maximumProcesses: resourceBudget.maximumProcesses,
        requestedMaximumOutputBytes: MAXIMUM_RESPONSE_BYTES,
      }) || null);
    } catch {
      sandboxReceipt = null;
    }
    let sandboxReceiptVerified = false;
    try {
      sandboxReceiptVerified = verifyProductionOsSandboxWorkerReceipt(sandboxReceipt);
    } catch { sandboxReceiptVerified = false; }
    if (!sandboxReceiptVerified) {
      blockers.push('raw_event_recomputation_os_sandbox_invalid');
      try {
        if (Array.isArray(sandboxReceipt?.blockers)) {
          blockers.push(...sandboxReceipt.blockers.map(
            (blocker) => `raw_event_recomputation_os_sandbox:${blocker}`,
          ));
        }
      } catch { /* malformed receipt remains blocked */ }
      sandboxReceipt = null;
    } else {
      try {
        if (sandboxReceipt.limits?.timeoutMs !== resourceBudget.timeoutMs
          || sandboxReceipt.limits?.memoryBytes !== resourceBudget.memoryBytes
          || sandboxReceipt.limits?.cpuSeconds !== resourceBudget.cpuSeconds
          || sandboxReceipt.limits?.maximumPids !== resourceBudget.maximumProcesses) {
          blockers.push('raw_event_recomputation_os_sandbox_resource_budget_mismatch');
        }
      } catch { blockers.push('raw_event_recomputation_os_sandbox_invalid'); }
    }
  }
  const workerSourceHash = hashBytes(fs.readFileSync(workerPath));
  const receipt = blockers.length || !request ? null : parseWorkerReceipt(sandboxReceipt, {
    request,
    workerSourceHash,
  });
  if (!receipt) blockers.push('process_isolated_recomputation_receipt_invalid');
  const payload = {
    version: 3,
    kind: 'ProcessIsolatedRawEventRecomputationAssurance',
    status: blockers.length
      ? 'process_isolated_raw_event_recomputation_blocked'
      : 'process_isolated_raw_event_recomputation_verified',
    assuranceScope: PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE,
    requestHash: request?.requestHash || null,
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
    resourceBudget,
    cpuBudgetSemantics: SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
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
  try {
    const request = requestDocument(input);
    const workerSourceHash = hashBytes(fs.readFileSync(workerPath));
    const verifiedWorkerReceipt = parseWorkerReceipt(
      assurance?.osSandboxWorkerReceipt,
      { request, workerSourceHash },
    );
    if (!assurance
    || assurance.version !== 3
    || assurance.kind !== 'ProcessIsolatedRawEventRecomputationAssurance'
    || assurance.status !== 'process_isolated_raw_event_recomputation_verified'
    || assurance.assuranceScope !== PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE
    || assurance.processIndependent !== true
    || assurance.osSandboxed !== true
    || assurance.networkActionPerformed !== false
    || assurance.externalActionPerformed !== false
    || assurance.independentImplementationHash
      !== INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION
        .independentSystemBenchmarkRecomputationImplementationHash
    || assurance.cpuBudgetSemantics !== SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
    || !verifyRawEventRecomputationResourceBudget(assurance.resourceBudget)
    || assurance.resourceBudget.timeoutMs
      !== assurance.osSandboxWorkerReceipt?.limits?.timeoutMs
    || assurance.resourceBudget.memoryBytes
      !== assurance.osSandboxWorkerReceipt?.limits?.memoryBytes
    || assurance.resourceBudget.cpuSeconds
      !== assurance.osSandboxWorkerReceipt?.limits?.cpuSeconds
    || assurance.resourceBudget.maximumProcesses
      !== assurance.osSandboxWorkerReceipt?.limits?.maximumPids
    || !Array.isArray(assurance.blockers) || assurance.blockers.length !== 0
    || assurance.requestHash !== request.requestHash
    || !verifiedWorkerReceipt
    || assurance.workerReceiptHash
      !== assurance.workerReceipt?.processIsolatedRawEventRecomputationWorkerReceiptHash
    || assurance.rawEventRecomputationManifestHash
      !== assurance.workerReceipt?.rawEventRecomputationManifestHash
    || assurance.workerImplementationSourceHash
      !== assurance.workerReceipt?.workerImplementationSourceHash
    || assurance.workerImplementationSourceHash !== workerSourceHash
    || assurance.workerImplementationHash
      !== assurance.workerReceipt?.workerImplementationHash
    || assurance.independentImplementationHash
      !== assurance.workerReceipt?.independentImplementationHash
    || assurance.parentPid !== assurance.workerReceipt?.parentPid
    || assurance.workerPid !== assurance.workerReceipt?.workerPid
    || !verifyProductionOsSandboxWorkerReceipt(assurance.osSandboxWorkerReceipt)
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
    || JSON.stringify(assurance.workerReceipt) !== JSON.stringify(verifiedWorkerReceipt)
    || !SHA256.test(String(assurance.processIsolatedRawEventRecomputationAssuranceHash || ''))) {
      return false;
    }
    const { processIsolatedRawEventRecomputationAssuranceHash, ...payload } = assurance;
    return hashRecord('ProcessIsolatedRawEventRecomputationAssurance', payload)
      === processIsolatedRawEventRecomputationAssuranceHash;
  } catch { return false; }
}
