import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildRawEventRecomputationManifest } from '../../paper-domain/automation/analysis-protocol-run-binding.mjs';
import {
  rawEventRecomputationResourceBudgetsEqual,
} from '../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs';
import {
  PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
  RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
  runProcessIsolatedRawEventRecomputation,
  verifyProcessIsolatedRawEventRecomputationAssurance,
} from '../research-verify/process-isolated-system-benchmark-recomputation.mjs';
import { systemBenchmarkNowEpochMs } from './system-benchmark-wall-clock.mjs';

const RAW_EVENT_RECOMPUTATION_DEADLINE_RESERVE_MS = 90_000;

export function allocateRawEventRecomputationCpuSeconds(
  aggregateCpuSeconds,
  executionUnitCount,
) {
  return Math.min(
    RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS,
    Number(aggregateCpuSeconds) - Number(executionUnitCount),
  );
}

export function runDeadlineBoundedIndependentRecomputationAssurance({
  cells,
  rawEventRows,
  requiredMetrics,
  metricSpecs,
  versionedExperimentIrHash,
  absoluteDeadlineEpochMs,
  cpuSeconds,
  memoryBytes,
  maximumProcesses,
  producerImplementationHash,
} = {}) {
  const normalizedRawEventRows = rawEventRows.map((row) => ({
    cellId: row.document.cellId,
    document: row.document,
    line: row.line,
  }));
  const producerManifest = buildRawEventRecomputationManifest({
    cells,
    rawEventRows: normalizedRawEventRows,
    requiredMetrics,
    metricSpecs,
    versionedExperimentIrHash,
  });
  const recomputationInput = Object.freeze({
    cells,
    rawEventRows: normalizedRawEventRows,
    requiredMetrics,
    metricSpecs,
    versionedExperimentIrHash,
  });
  const remainingWallTimeMs = Math.floor(
    Number(absoluteDeadlineEpochMs) - Number(systemBenchmarkNowEpochMs()),
  );
  const timeoutMs = Math.min(
    RAW_EVENT_RECOMPUTATION_MAXIMUM_WALL_TIME_MS,
    remainingWallTimeMs - RAW_EVENT_RECOMPUTATION_DEADLINE_RESERVE_MS,
  );
  const deadlineBlockers = !Number.isFinite(remainingWallTimeMs) || timeoutMs < 1
    ? ['benchmark_raw_event_recomputation_deadline_exhausted']
    : [];
  const resourceBlockers = [cpuSeconds, memoryBytes, maximumProcesses]
    .every((value) => Number.isSafeInteger(Number(value)) && Number(value) >= 1)
    ? [] : ['benchmark_raw_event_recomputation_resource_budget_exhausted'];
  const boundedResourceBudget = Object.freeze({
    cpuSeconds: Math.min(RAW_EVENT_RECOMPUTATION_MAXIMUM_CPU_SECONDS, Number(cpuSeconds)),
    memoryBytes: Math.min(RAW_EVENT_RECOMPUTATION_MAXIMUM_MEMORY_BYTES, Number(memoryBytes)),
    maximumProcesses: Math.min(
      RAW_EVENT_RECOMPUTATION_MAXIMUM_PROCESSES,
      Number(maximumProcesses),
    ),
  });
  const requestedResourceBudget = Object.freeze({
    timeoutMs,
    ...boundedResourceBudget,
  });
  const recomputationDispatched = deadlineBlockers.length === 0
    && resourceBlockers.length === 0;
  const processAssurance = recomputationDispatched
    ? runProcessIsolatedRawEventRecomputation(
      recomputationInput,
      requestedResourceBudget,
    )
    : null;
  const settledBeforeReserve = recomputationDispatched
    ? Number(systemBenchmarkNowEpochMs()) <= Number(absoluteDeadlineEpochMs)
      - RAW_EVENT_RECOMPUTATION_DEADLINE_RESERVE_MS
    : true;
  const independentAssurance = buildIndependentRecomputationAssurance({
    producerManifest,
    processAssurance: settledBeforeReserve ? processAssurance : null,
    producerImplementationHash,
    recomputationInput,
    versionedExperimentIrHash,
    expectedResourceBudget: recomputationDispatched ? requestedResourceBudget : null,
  });
  return Object.freeze({
    rawEventRecomputationManifest: producerManifest,
    independentRecomputationInput: recomputationInput,
    independentRawEventRecomputationAssurance: independentAssurance,
    blockers: Object.freeze([
      ...producerManifest.blockers,
      ...deadlineBlockers,
      ...resourceBlockers,
      ...(!settledBeforeReserve
        ? ['benchmark_raw_event_recomputation_deadline_exhausted'] : []),
      ...independentAssurance.blockers,
    ]),
  });
}

export { systemBenchmarkNowEpochMs };

export function buildIndependentRecomputationAssurance({
  producerManifest,
  processAssurance,
  producerImplementationHash,
  recomputationInput,
  versionedExperimentIrHash,
  expectedResourceBudget = null,
} = {}) {
  const resourceBudgetBound = expectedResourceBudget === null
    || rawEventRecomputationResourceBudgetsEqual(
      processAssurance?.resourceBudget,
      expectedResourceBudget,
    );
  const processAssuranceVerified = resourceBudgetBound
    && verifyProcessIsolatedRawEventRecomputationAssurance(processAssurance, recomputationInput);
  const independentManifest = processAssurance?.workerReceipt?.manifest || null;
  const sameManifest = producerManifest && independentManifest
    ? JSON.stringify(producerManifest) === JSON.stringify(independentManifest)
    : null;
  const processBlockers = Array.isArray(processAssurance?.blockers)
    ? processAssurance.blockers
    : [];
  const maximumAbsoluteResidual = Number(independentManifest?.maximumAbsoluteResidual);
  const blockers = Object.freeze([...new Set([
    ...(processAssuranceVerified
      && independentManifest?.status === 'raw_event_recomputation_verified'
      && Array.isArray(independentManifest.blockers)
      && independentManifest.blockers.length === 0
      ? [] : ['independent_raw_event_recomputation_blocked']),
    ...processBlockers.map((blocker) => (
      `independent_raw_event_recomputation_process:${blocker}`
    )),
    ...(sameManifest === false
      ? ['independent_raw_event_recomputation_manifest_mismatch']
      : []),
    ...(!resourceBudgetBound
      ? ['independent_raw_event_recomputation_resource_budget_mismatch']
      : []),
  ])]);
  const payload = {
    version: 2,
    kind: 'IndependentRawEventRecomputationAssurance',
    status: blockers.length
      ? 'independent_raw_event_recomputation_assurance_blocked'
      : 'independent_raw_event_recomputation_assurance_verified',
    assuranceScope: PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE,
    producerManifestHash: producerManifest?.rawEventRecomputationManifestHash || null,
    independentManifestHash:
      independentManifest?.rawEventRecomputationManifestHash || null,
    producerImplementationHash,
    verifierImplementationHash:
      processAssurance?.workerImplementationHash || null,
    independenceContractHash:
      processAssurance?.processIsolatedRawEventRecomputationAssuranceHash || null,
    maximumAbsoluteResidual: Number.isFinite(maximumAbsoluteResidual)
      ? maximumAbsoluteResidual
      : null,
    processIndependent: processAssuranceVerified,
    processIsolatedRawEventRecomputationAssurance: processAssurance || null,
    processIsolatedWorkerReceiptHash: processAssurance?.workerReceiptHash || null,
    processIsolatedWorkerImplementationSourceHash:
      processAssurance?.workerImplementationSourceHash || null,
    processIsolatedWorkerPid: processAssurance?.workerPid || null,
    versionedExperimentIrHash,
    blockers,
  };
  return Object.freeze({
    ...payload,
    independentRawEventRecomputationAssuranceHash: hashRecord(
      'IndependentRawEventRecomputationAssurance',
      payload,
    ),
  });
}
