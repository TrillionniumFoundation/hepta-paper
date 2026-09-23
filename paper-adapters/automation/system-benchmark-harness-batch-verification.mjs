import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  evaluateSystemBenchmarkArmRawObservation,
} from '../../paper-domain/automation/system-benchmark-arm-protocol.mjs';
import {
  decodeSystemBenchmarkArmBatchChallengeEnvironment,
  evaluateSystemBenchmarkArmBatchResponses,
} from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import {
  verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import { verifyWorkerProcessExecutionIdentity } from '../../paper-domain/automation/worker-process-execution-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function parseSystemBenchmarkArmBatchObservation(
  content,
  requiredMetrics,
  metricSpecs,
  batch,
  operatorDatasetHarnessDefinition = null,
) {
  let document = null;
  try {
    document = JSON.parse(content.toString('utf8'));
  } catch {
    return { observations: null, blockers: ['benchmark_arm_batch_observation_json_invalid'] };
  }
  const responses = evaluateSystemBenchmarkArmBatchResponses({
    protocol: batch.armProtocol,
    batchChallenge: batch.challenge,
    fixtures: batch.fixtures,
    document,
    operatorDatasetHarnessDefinition,
  });
  if (responses.status !== 'system_benchmark_arm_batch_response_evaluated') {
    return { observations: null, blockers: responses.blockers };
  }
  const blockers = [];
  const observations = responses.evaluations.map((response, index) => {
    const evaluated = evaluateSystemBenchmarkArmRawObservation({
      protocol: batch.armProtocol,
      document: { version: 1, kind: 'CampaignBenchmarkCellRawEvents', events: response.events },
      requiredMetrics,
      metricSpecs,
    });
    if (evaluated.status !== 'system_benchmark_arm_observation_computed') {
      blockers.push(...evaluated.blockers.map((blocker) => `${blocker}:${response.cellId}`));
    }
    const fixture = batch.fixtures[index];
    return evaluated.status === 'system_benchmark_arm_observation_computed'
      ? Object.freeze({
        cellId: response.cellId,
        metrics: evaluated.metrics,
        eventCount: evaluated.eventCount,
        computation: evaluated.computation,
        rawEvents: response.events,
        candidateResponses: response.responses,
        systemBenchmarkCellChallengeHash: fixture.challenge.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: fixture.oracle.systemBenchmarkCellOracleHash,
      })
      : null;
  });
  return { observations: blockers.length ? null : Object.freeze(observations), blockers };
}

export function buildSystemBenchmarkObservationCsv(observations, requiredMetrics) {
  const header = ['seed', 'repetition', 'arm', ...requiredMetrics];
  return `${[header.join(','), ...observations.map((item) => [
    item.seed,
    item.repetition,
    item.arm,
    ...requiredMetrics.map((metric) => item.metrics[metric]),
  ].join(','))].join('\n')}\n`;
}

export function verifySystemBenchmarkArmBatchExecution({ batch, runnerReceipt, datasetRequired }) {
  try {
  let snapshot = null;
  try { snapshot = JSON.parse(JSON.stringify(runnerReceipt)); }
  catch { /* invalid receipt stays null */ }
  runnerReceipt = snapshot;
  const blockers = [];
  if (!verifyProductionOsSandboxWorkerReceipt(runnerReceipt)) {
    blockers.push(`benchmark_arm_batch_runner_receipt_invalid:${batch.arm}`);
  }
  try {
    if (Array.isArray(runnerReceipt?.blockers)) blockers.push(
      ...runnerReceipt.blockers.map(
        (blocker) => `benchmark_arm_batch_runner:${batch.arm}:${blocker}`,
      ),
    );
  } catch { blockers.push(`benchmark_arm_batch_runner_receipt_invalid:${batch.arm}`); }
  const bindings = runnerReceipt?.executionBindings || {};
  const boundChallenge = decodeSystemBenchmarkArmBatchChallengeEnvironment(bindings);
  if (!boundChallenge || hashRecord('SystemBenchmarkArmBatchChallengeExpected', boundChallenge)
      !== hashRecord('SystemBenchmarkArmBatchChallengeExpected', batch.challenge)
    || bindings.HEPTA_EXPERIMENT_ARM !== batch.arm
    || bindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_ID !== batch.armProtocol?.protocolId
    || bindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH !== batch.systemBenchmarkArmProtocolHash
    || bindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH !== batch.armProtocolSetHash
    || bindings.HEPTA_EXPERIMENT_ARM_ADAPTER_PATH !== batch.armAdapter?.relativePath
    || bindings.HEPTA_EXPERIMENT_ARM_ADAPTER_HASH !== batch.armAdapter?.sourceHash
    || bindings.HEPTA_EXPERIMENT_ARM_ADAPTER_SET_HASH !== batch.armAdapterSetHash
    || bindings.HEPTA_PRE_DATA_ACCESS_FREEZE_HASH !== batch.empiricalPreDataAccessFreezeHash
    || bindings.HEPTA_EXPERIMENT_IR_HASH !== batch.versionedExperimentIrHash
    || batch.challenge?.versionedExperimentIrHash !== batch.versionedExperimentIrHash
    || bindings.HEPTA_EXPERIMENT_ATTEMPT_ID !== batch.executionAttemptId
    || bindings.HEPTA_EXPERIMENT_RUN_ID !== batch.experimentAttemptId) {
    blockers.push(`benchmark_arm_batch_identity_binding_invalid:${batch.arm}`);
  }
  if (batch.executionMode === 'academic-per-cell-process-v1'
    && !verifyWorkerProcessExecutionIdentity(runnerReceipt, { requireObservedProcess: true })) {
    blockers.push(`benchmark_cell_process_identity_invalid:${batch.cells[0]?.cellId || batch.arm}`);
  }
  if (Number(runnerReceipt?.limits?.timeoutMs) !== Number(batch.resourceBudget?.timeoutMs)
    || Number(runnerReceipt?.limits?.memoryBytes) !== Number(batch.resourceBudget?.memoryBytes)
    || Number(runnerReceipt?.limits?.cpuSeconds) !== Number(batch.resourceBudget?.cpuSeconds)
    || Number(runnerReceipt?.limits?.maximumPids) !== Number(batch.resourceBudget?.maximumProcesses)
    || runnerReceipt?.isolation?.cpuLimitVerified !== true
    || runnerReceipt?.isolation?.cpuLimitScope
      !== 'process-thread-group-not-descendant-tree-v1'
    || Boolean(runnerReceipt?.isolation?.gpuAccessRequested) !== Boolean(batch.resourceBudget?.requiresGpu)) {
    blockers.push(`benchmark_arm_batch_resource_budget_binding_invalid:${batch.arm}`);
  }
  const artifact = (Array.isArray(runnerReceipt?.artifacts)
    ? runnerReceipt.artifacts : []).find(
    (item) => item.path === 'observation.json',
  ) || null;
  if (!artifact || !SHA256.test(String(artifact.sha256 || ''))) {
    blockers.push(`benchmark_arm_batch_artifact_missing:${batch.arm}`);
  }
  if (datasetRequired && (!verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt(
    runnerReceipt?.datasetAccessReceipt,
    runnerReceipt,
  ) || runnerReceipt.datasetAccessReceipt.datasets.some((item) => item.readObserved !== true
      || item.hostOnlyHarnessMounted !== false || item.forbiddenReadObserved !== false))) {
    blockers.push(`benchmark_arm_batch_dataset_access_unverified:${batch.arm}`);
  }
  return { blockers, artifact };
  } catch {
    return {
      blockers: [`benchmark_arm_batch_runner_receipt_invalid:${batch?.arm}`],
      artifact: null,
    };
  }
}
