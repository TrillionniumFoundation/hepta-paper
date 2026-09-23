import fs from 'node:fs';
import path from 'node:path';
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
import {
  TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS,
  verifyTypedNumericRecomputationResourceBudget,
} from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  createTypedNumericOracleSandboxRunner,
  TYPED_NUMERIC_RECOMPUTATION_DOCKER_FALLBACK_IMAGE,
} from './typed-numeric-oracle-sandbox-runner-factory.mjs';

const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 24 * 1024 * 1024;
const workerPath = fileURLToPath(new URL(
  './independent-typed-numeric-oracle-recomputation-worker.mjs',
  import.meta.url,
));
const repositoryRoot = path.resolve(path.dirname(workerPath), '..', '..');
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

export { TYPED_NUMERIC_RECOMPUTATION_DOCKER_FALLBACK_IMAGE };

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

function snapshotSandboxReceipt(receipt) {
  try {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
    const snapshot = JSON.parse(JSON.stringify(receipt));
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? snapshot : null;
  } catch { return null; }
}

function workerProcessIdentityMatchesSandbox(workerReceipt, sandboxReceipt) {
  return sandboxReceipt?.backend !== 'docker'
    || (workerReceipt?.workerPid === 1 && workerReceipt?.parentPid === 0);
}

function parseWorkerReceipt(sandboxReceipt, {
  request,
  inputs,
  workerImplementation,
} = {}) {
  if (!verifyProductionOsSandboxWorkerReceipt(sandboxReceipt)
    || !Array.isArray(sandboxReceipt.blockers) || sandboxReceipt.blockers.length !== 0
    || sandboxReceipt.externalActionPerformed !== false
    || !Number.isSafeInteger(sandboxReceipt.executionProcessIdentity?.launcherPid)
    || sandboxReceipt.executionProcessIdentity.launcherPid < 1) return null;
  let receipt = null;
  try { receipt = JSON.parse(String(sandboxReceipt.stdout || '').trim()); }
  catch { return null; }
  if (!workerProcessIdentityMatchesSandbox(receipt, sandboxReceipt)
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
  timeoutMs = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumWallTimeMs,
  memoryBytes = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumMemoryBytes,
  cpuSeconds = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumCpuSeconds,
  maximumProcesses = TYPED_NUMERIC_RECOMPUTATION_RESOURCE_LIMITS.maximumProcesses,
  readSource,
} = {}) {
  const blockers = [];
  let request = null;
  let encoded = '';
  try {
    request = buildProcessIsolatedTypedNumericOracleRequest(input);
    encoded = `${JSON.stringify(request)}\n`;
  } catch { blockers.push('process_isolated_typed_numeric_request_invalid'); }
  if (Buffer.byteLength(encoded) > MAXIMUM_REQUEST_BYTES) {
    blockers.push('process_isolated_typed_numeric_request_too_large');
  }
  const resourceBudget = Object.freeze({
    timeoutMs: Number(timeoutMs),
    memoryBytes: Number(memoryBytes),
    cpuSeconds: Number(cpuSeconds),
    maximumProcesses: Number(maximumProcesses),
  });
  if (!verifyTypedNumericRecomputationResourceBudget(resourceBudget)) {
    blockers.push('process_isolated_typed_numeric_resource_budget_invalid');
  }
  let implementation = null;
  try { implementation = currentWorkerImplementation(readSource); }
  catch { blockers.push('process_isolated_typed_numeric_worker_implementation_invalid'); }
  let sandboxReceipt = null;
  if (!blockers.length) {
    try {
      const runner = createTypedNumericOracleSandboxRunner(resourceBudget);
      sandboxReceipt = snapshotSandboxReceipt(runner?.run?.({
        executable: process.execPath,
        args: [workerPath],
        cwd: repositoryRoot,
        sourceRoot: repositoryRoot,
        timeoutMs: resourceBudget.timeoutMs,
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
    } catch { sandboxReceipt = null; }
    let sandboxVerified = false;
    try {
      sandboxVerified = verifyProductionOsSandboxWorkerReceipt(sandboxReceipt)
        && Array.isArray(sandboxReceipt.blockers) && sandboxReceipt.blockers.length === 0
        && sandboxReceipt.externalActionPerformed === false;
    }
    catch { sandboxVerified = false; }
    if (!sandboxVerified) {
      blockers.push('process_isolated_typed_numeric_os_sandbox_invalid');
      try {
        if (Array.isArray(sandboxReceipt?.blockers)) {
          blockers.push(...sandboxReceipt.blockers.map(
            (blocker) => `process_isolated_typed_numeric_os_sandbox:${blocker}`,
          ));
          if (sandboxReceipt.blockers.includes('os_sandbox_command_timed_out')) {
            blockers.push('process_isolated_typed_numeric_recomputation_timed_out');
          }
        }
      } catch { /* malformed receipt remains blocked */ }
    } else if (sandboxReceipt.limits?.timeoutMs !== resourceBudget.timeoutMs
      || sandboxReceipt.limits?.memoryBytes !== resourceBudget.memoryBytes
      || sandboxReceipt.limits?.cpuSeconds !== resourceBudget.cpuSeconds
      || sandboxReceipt.limits?.maximumPids !== resourceBudget.maximumProcesses) {
      blockers.push('process_isolated_typed_numeric_os_sandbox_resource_budget_mismatch');
    }
  }
  const workerReceipt = blockers.length ? null : parseWorkerReceipt(sandboxReceipt, {
    request,
    inputs: input,
    workerImplementation: implementation,
  });
  if (!workerReceipt) {
    blockers.push('process_isolated_typed_numeric_recomputation_receipt_invalid');
  }
  return buildProcessIsolatedTypedNumericOracleRecomputationReceipt({
    request,
    workerImplementation: implementation,
    workerReceipt,
    osSandboxWorkerReceipt: sandboxReceipt,
    resourceBudget,
    parentPid: workerReceipt?.parentPid || null,
    workerPid: workerReceipt?.workerPid || null,
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
