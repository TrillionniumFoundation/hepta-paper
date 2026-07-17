import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { verifyCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from '../../paper-domain/automation/system-benchmark-harness-identity.mjs';
import {
  evaluateSystemBenchmarkArmRawObservation,
  evaluateSystemBenchmarkStatisticalPolicy,
  verifySystemBenchmarkArmAdapterSet,
} from '../../paper-domain/automation/system-benchmark-arm-protocol.mjs';
import {
  buildSystemBenchmarkArmBatchChallenge,
  decodeSystemBenchmarkArmBatchChallengeEnvironment,
  evaluateSystemBenchmarkArmBatchResponses,
} from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import {
  buildCampaignBenchmarkSchedule,
  buildDatasetAuthorizationSet,
  verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt,
  verifyOsSandboxWorkerReceipt,
  verifySystemBenchmarkHarnessExecutionReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import { writeSystemBenchmarkResults } from './system-benchmark-result-repository.mjs';
import { readOperatorDatasetHarness } from './operator-dataset-harness-reader.mjs';
import { academicAnalysisPromotionBlockers, evaluateAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-evaluator.mjs';
import { buildHarnessAnalysisObservationAuthority, buildRawEventRecomputationManifest } from '../../paper-domain/automation/analysis-protocol-run-binding.mjs';
import { verifyWorkerProcessExecutionIdentity } from '../../paper-domain/automation/worker-process-execution-contract.mjs';
import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { buildEmpiricalPreDataAccessFreeze } from '../../paper-domain/automation/empirical-pre-data-access-freeze.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);
const MAXIMUM_RAW_EVENT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_RAW_EVENTS_PER_CELL = 64;

function parseArmBatchObservation(content, requiredMetrics, metricSpecs, batch, operatorDatasetHarnessDefinition = null) {
  let document = null;
  try { document = JSON.parse(content.toString('utf8')); } catch { return { observations: null, blockers: ['benchmark_arm_batch_observation_json_invalid'] }; }
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
    if (evaluated.status !== 'system_benchmark_arm_observation_computed') blockers.push(...evaluated.blockers.map((blocker) => `${blocker}:${response.cellId}`));
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

function buildCsv(observations, requiredMetrics) {
  const header = ['seed', 'repetition', 'arm', ...requiredMetrics];
  return `${[header.join(','), ...observations.map((item) => [
    item.seed,
    item.repetition,
    item.arm,
    ...requiredMetrics.map((metric) => item.metrics[metric]),
  ].join(','))].join('\n')}\n`;
}

function verifiedArmBatch({ batch, runnerReceipt, datasetRequired }) {
  const blockers = [];
  if (!verifyOsSandboxWorkerReceipt(runnerReceipt)) blockers.push(`benchmark_arm_batch_runner_receipt_invalid:${batch.arm}`);
  blockers.push(...(runnerReceipt?.blockers || []).map((blocker) => `benchmark_arm_batch_runner:${batch.arm}:${blocker}`));
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
    || Boolean(runnerReceipt?.isolation?.gpuAccessRequested) !== Boolean(batch.resourceBudget?.requiresGpu)) {
    blockers.push(`benchmark_arm_batch_resource_budget_binding_invalid:${batch.arm}`);
  }
  const artifact = (runnerReceipt?.artifacts || []).find((item) => item.path === 'observation.json') || null;
  if (!artifact || !SHA256.test(String(artifact.sha256 || ''))) blockers.push(`benchmark_arm_batch_artifact_missing:${batch.arm}`);
  if (datasetRequired && (!verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt(runnerReceipt?.datasetAccessReceipt, runnerReceipt)
    || runnerReceipt.datasetAccessReceipt.datasets.some((item) => item.readObserved !== true
      || item.hostOnlyHarnessMounted !== false || item.forbiddenReadObserved !== false))) {
    blockers.push(`benchmark_arm_batch_dataset_access_unverified:${batch.arm}`);
  }
  return { blockers, artifact };
}

export function executeSystemBenchmarkHarness({
  benchmarkSelector,
  datasetMounts = [],
  experimentAttemptId,
  attemptVersion = 1,
  failedAttemptLineageHashes = [],
  sourceLineageHash,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
  outputDirectory,
  armAdapterSet,
  runArmBatch,
  operatorDatasetAuthorityTrustStore = null,
  runtimeRoot = null,
  absoluteDeadlineEpochMs = Date.now() + (6 * 60 * 60 * 1000),
  aggregateCpuSeconds = 3600,
  memoryBytes = 4 * 1024 * 1024 * 1024,
  maximumProcesses = 128,
  requiresGpu = false,
  nowEpochMs = () => Date.now(),
} = {}) {
  const selector = verifyCampaignBenchmarkSelector(benchmarkSelector, {
    benchmarkId: benchmarkSelector?.benchmarkId,
    datasetMounts,
  });
  const adapterSetVerified = verifySystemBenchmarkArmAdapterSet(
    armAdapterSet,
    selector.expected?.experimentDesign?.benchmarkHarness?.armProtocolSet,
  );
  if (!selector.valid || !adapterSetVerified || !experimentAttemptId || !SHA256.test(String(sourceLineageHash || ''))
    || !SHA256.test(String(sourceMerkleHash || '')) || !SHA256.test(String(sourceWorkspaceManifestHash || ''))
    || !Number.isSafeInteger(Number(attemptVersion)) || Number(attemptVersion) < 1
    || !Array.isArray(failedAttemptLineageHashes)
    || !outputDirectory || typeof runArmBatch !== 'function'
    || !Number.isFinite(Number(absoluteDeadlineEpochMs))
    || !Number.isSafeInteger(Number(aggregateCpuSeconds)) || Number(aggregateCpuSeconds) < 1
    || !Number.isSafeInteger(Number(memoryBytes)) || Number(memoryBytes) < 1
    || !Number.isSafeInteger(Number(maximumProcesses)) || Number(maximumProcesses) < 1
    || typeof nowEpochMs !== 'function') {
    return Object.freeze({
      status: 'system_benchmark_harness_blocked',
      blockers: [
        ...selector.blockers,
        ...(!adapterSetVerified ? ['benchmark_harness_arm_adapter_set_invalid'] : []),
        ...(!experimentAttemptId ? ['benchmark_harness_attempt_id_required'] : []),
        ...(!SHA256.test(String(sourceLineageHash || '')) ? ['benchmark_harness_source_lineage_required'] : []),
        ...(!SHA256.test(String(sourceMerkleHash || '')) ? ['benchmark_harness_source_merkle_hash_required'] : []),
        ...(!SHA256.test(String(sourceWorkspaceManifestHash || '')) ? ['benchmark_harness_source_manifest_hash_required'] : []),
        ...(!Number.isSafeInteger(Number(attemptVersion)) || Number(attemptVersion) < 1
          ? ['benchmark_harness_attempt_version_invalid'] : []),
        ...(!Array.isArray(failedAttemptLineageHashes) ? ['benchmark_harness_failed_attempt_lineage_invalid'] : []),
        ...(!outputDirectory ? ['benchmark_harness_output_directory_required'] : []),
        ...(typeof runArmBatch !== 'function' ? ['benchmark_harness_arm_batch_runner_required'] : []),
        ...(!Number.isFinite(Number(absoluteDeadlineEpochMs)) ? ['benchmark_harness_absolute_deadline_required'] : []),
        ...(!Number.isSafeInteger(Number(aggregateCpuSeconds)) || Number(aggregateCpuSeconds) < 1 ? ['benchmark_harness_aggregate_cpu_budget_invalid'] : []),
        ...(!Number.isSafeInteger(Number(memoryBytes)) || Number(memoryBytes) < 1 ? ['benchmark_harness_memory_budget_invalid'] : []),
        ...(!Number.isSafeInteger(Number(maximumProcesses)) || Number(maximumProcesses) < 1 ? ['benchmark_harness_process_budget_invalid'] : []),
      ],
    });
  }
  if (selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkHarnessImplementationHash
    !== SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash) {
    return Object.freeze({ status: 'system_benchmark_harness_blocked', blockers: ['benchmark_harness_implementation_identity_mismatch'] });
  }
  const schedule = buildCampaignBenchmarkSchedule(selector.expected);
  const requiredMetrics = [...selector.expected.experimentDesign.requiredMetrics];
  const metricSpecs = selector.expected.experimentDesign.metricSpecs;
  const authorizations = buildDatasetAuthorizationSet(datasetMounts);
  let preDataAccessFreeze;
  try {
    preDataAccessFreeze = buildEmpiricalPreDataAccessFreeze({
      experimentAttemptId,
      attemptVersion: Number(attemptVersion),
      failedAttemptLineageHashes,
      campaignBenchmarkSelectorHash: selector.expected.campaignBenchmarkSelectorHash,
      experimentDesignHash: selector.expected.experimentDesignHash,
      analysisProtocolHash: selector.expected.experimentDesign.analysisProtocolHash,
      systemBenchmarkArmProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
      systemBenchmarkArmAdapterSetHash: armAdapterSet.systemBenchmarkArmAdapterSetHash,
      sourceMerkleHash,
      sourceWorkspaceManifestHash,
      sourceLineageHash,
    });
  } catch (error) {
    return Object.freeze({
      status: 'system_benchmark_harness_blocked',
      executionStatus: 'system_benchmark_execution_not_started',
      integrityStatus: 'system_benchmark_integrity_blocked',
      scientificVerdict: 'not_evaluable',
      blockers: [String(error?.message || 'empirical_pre_data_access_freeze_invalid')],
    });
  }
  const operatorDatasetHarnessResolution = selector.expected.selectorType === 'authorized_dataset_mount'
    ? readOperatorDatasetHarness(datasetMounts.find((mount) => mount.name === selector.expected.datasetMountName), {
      authorityTrustStore: operatorDatasetAuthorityTrustStore,
      runtimeRoot,
    })
    : null;
  const operatorDatasetHarnessAuthority = operatorDatasetHarnessResolution?.receipt || null;
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const harnessRoot = fs.mkdtempSync(path.join(path.resolve(outputDirectory), '.hepta-system-harness-'));
  const cellsById = new Map();
  const rawEventRowsById = new Map();
  const armBatchExecutions = [];
  const blockers = [...(operatorDatasetHarnessAuthority?.blockers || [])];
  const operatorDatasetHarnessDefinition = operatorDatasetHarnessResolution?.privateDefinition || null;
  let totalRawEventBytes = 0;

  const consume = (batch, batchOutput, runnerReceipt) => {
    const blockerCountBeforeBatch = blockers.length;
    const checked = verifiedArmBatch({ batch, runnerReceipt, datasetRequired: datasetMounts.length > 0 });
    blockers.push(...checked.blockers);
    const read = readScopedFileSync({
      scopeRoot: batchOutput,
      candidate: path.join(batchOutput, 'observation.json'),
      maximumBytes: 4 * 1024 * 1024,
    });
    if (read.status !== 'scoped_file_read_verified') blockers.push(`benchmark_arm_batch_observation_unreadable:${batch.arm}`);
    const parsed = read.status === 'scoped_file_read_verified'
      ? parseArmBatchObservation(read.content, requiredMetrics, metricSpecs, batch, operatorDatasetHarnessDefinition)
      : { observations: null, blockers: [] };
    blockers.push(...parsed.blockers.map((blocker) => `${blocker}:${batch.arm}`));
    const observationHash = read.status === 'scoped_file_read_verified' ? hashBytes(read.content) : null;
    if (checked.artifact?.sha256 !== observationHash) blockers.push(`benchmark_arm_batch_observation_artifact_mismatch:${batch.arm}`);
    if (blockers.length !== blockerCountBeforeBatch || !parsed.observations) return;
    const batchPayload = {
      version: 1,
      kind: 'SystemBenchmarkArmBatchExecutionReceipt',
      arm: batch.arm,
      systemBenchmarkArmProtocolHash: batch.systemBenchmarkArmProtocolHash,
      armAdapter: batch.armAdapter,
      systemBenchmarkArmBatchChallengeHash: batch.challenge.systemBenchmarkArmBatchChallengeHash,
      executionMode: batch.executionMode,
      executionAttemptId: batch.executionAttemptId,
      executionProcessIdentityHash: runnerReceipt.executionProcessIdentityHash || null,
      resourceBudget: batch.resourceBudget,
      scheduleCellCount: batch.cells.length,
      cellIds: batch.cells.map((cell) => cell.cellId),
      observationArtifactHash: observationHash,
      runnerReceiptHash: runnerReceipt.receiptHash,
      runnerReceipt,
    };
    const batchExecution = Object.freeze({
      ...batchPayload,
      systemBenchmarkArmBatchExecutionReceiptHash: hashRecord('SystemBenchmarkArmBatchExecutionReceipt', batchPayload),
    });
    armBatchExecutions.push(batchExecution);
    for (const [index, observation] of parsed.observations.entries()) {
      const cell = batch.cells[index];
      const rawEventRow = Object.freeze({
        version: 2,
        kind: 'SystemBenchmarkCellRawPrimitiveArtifact',
        cellId: cell.cellId,
        seed: cell.seed,
        repetition: cell.repetition,
        arm: cell.arm,
        systemBenchmarkCellChallengeHash: observation.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: observation.systemBenchmarkCellOracleHash,
        responses: observation.candidateResponses,
        events: observation.rawEvents,
      });
      const rawEventLine = `${JSON.stringify(rawEventRow)}\n`;
      const rawEventBytes = Buffer.byteLength(rawEventLine);
      const rawEventArtifactHash = hashBytes(rawEventLine);
      totalRawEventBytes += rawEventBytes;
      if (observation.eventCount > MAXIMUM_RAW_EVENTS_PER_CELL) blockers.push(`benchmark_cell_raw_event_limit_exceeded:${cell.cellId}`);
      if (totalRawEventBytes > MAXIMUM_RAW_EVENT_BYTES) blockers.push('benchmark_raw_event_artifact_limit_exceeded');
      rawEventRowsById.set(cell.cellId, Object.freeze({ document: rawEventRow, line: rawEventLine, bytes: rawEventBytes, rawEventArtifactHash }));
      const armProtocolExecutionReceiptHash = hashRecord('SystemBenchmarkArmProtocolExecutionReceipt', {
        cellId: cell.cellId,
        systemBenchmarkArmProtocolHash: cell.systemBenchmarkArmProtocolHash,
        systemBenchmarkArmAdapterHash: batch.armAdapter.sourceHash,
        armBatchExecutionReceiptHash: batchExecution.systemBenchmarkArmBatchExecutionReceiptHash,
        systemBenchmarkCellChallengeHash: observation.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: observation.systemBenchmarkCellOracleHash,
        rawEventArtifactHash,
        rawEventCount: observation.eventCount,
        metrics: observation.metrics,
      });
      cellsById.set(cell.cellId, Object.freeze({
        ...cell,
        armAdapter: batch.armAdapter,
        metrics: observation.metrics,
        rawEventCount: observation.eventCount,
        rawEventArtifactHash,
        systemBenchmarkCellChallengeHash: observation.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: observation.systemBenchmarkCellOracleHash,
        metricComputation: observation.computation,
        armBatchExecutionReceiptHash: batchExecution.systemBenchmarkArmBatchExecutionReceiptHash,
        systemBenchmarkArmProtocolExecutionReceiptHash: armProtocolExecutionReceiptHash,
      }));
    }
  };

  const finalize = () => {
    try {
      const cells = schedule.map((cell) => cellsById.get(cell.cellId)).filter(Boolean);
      const rawEventRows = schedule.map((cell) => rawEventRowsById.get(cell.cellId)).filter(Boolean);
      const observations = cells.map((cell) => ({ seed: cell.seed, repetition: cell.repetition, arm: cell.arm, metrics: cell.metrics }));
      const academicPerCell = selector.expected.selectorType === 'authorized_dataset_mount';
      const executionMode = academicPerCell ? 'academic-per-cell-process-v1' : 'synthetic-per-arm-batch-process-v1';
      const expectedProcessExecutionCount = academicPerCell ? schedule.length : ARMS.length;
      if (armBatchExecutions.length !== expectedProcessExecutionCount) blockers.push('benchmark_harness_process_execution_incomplete');
      if (cells.length !== schedule.length) blockers.push('benchmark_harness_schedule_incomplete');
      const statisticalEvaluation = evaluateSystemBenchmarkStatisticalPolicy({ observations, experimentDesign: selector.expected.experimentDesign });
      const rawEventManifest = cells.map((cell) => ({
        cellId: cell.cellId,
        rawEventArtifactHash: cell.rawEventArtifactHash,
        rawEventCount: cell.rawEventCount,
        systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
      }));
      const rawEventManifestHash = hashRecord('SystemBenchmarkRawEventManifest', rawEventManifest);
      const rawEventDocument = rawEventRows.map((row) => row.line).join('');
      const rawEventArtifactHash = hashBytes(rawEventDocument);
      const rawEventArtifactBytes = Buffer.byteLength(rawEventDocument);
      const rawEventArtifact = Object.freeze({
        relativePath: 'raw-events.ndjson',
        role: 'system-benchmark-raw-primitives-v2',
        sha256: rawEventArtifactHash,
        bytes: rawEventArtifactBytes,
        manifestHash: rawEventManifestHash,
      });
      const analysisProtocol = Object.freeze({
        ...selector.expected.experimentDesign.analysisProtocol,
        analysisProtocolHash: selector.expected.experimentDesign.analysisProtocolHash,
      });
      const rawEventRecomputationManifest = buildRawEventRecomputationManifest({
        cells,
        rawEventRows: rawEventRows.map((row) => ({ cellId: row.document.cellId, document: row.document, line: row.line })),
        requiredMetrics,
        metricSpecs,
      });
      blockers.push(...rawEventRecomputationManifest.blockers);
      const analysisObservationAuthority = buildHarnessAnalysisObservationAuthority({
        cells,
        scheduleCellCount: schedule.length,
        rawEventManifestHash,
        rawEventArtifactHash,
        systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
        experimentAttemptId,
        sourceLineageHash,
        rawEventRecomputationManifest,
      });
      const analysisProtocolEvaluationInputs = Object.freeze({
        analysisProtocol,
        observations,
        observationAuthority: analysisObservationAuthority,
        benchmarkId: selector.expected.benchmarkId,
        benchmarkFamily: selector.expected.experimentDesign.benchmarkFamily,
        requiredMetrics,
        metricSpecs,
      });
      const analysisProtocolEvaluation = evaluateAnalysisProtocol(analysisProtocolEvaluationInputs);
      blockers.push(...academicAnalysisPromotionBlockers(
        analysisProtocolEvaluation,
        analysisProtocolEvaluationInputs,
      ));
      const resultDocument = {
        version: 4,
        kind: 'SystemBenchmarkRunObservations',
        executionStatus: 'system_benchmark_execution_completed',
        integrityStatus: blockers.length ? 'system_benchmark_integrity_blocked' : 'system_benchmark_integrity_verified',
        scientificVerdict: blockers.length ? 'not_evaluable' : analysisProtocolEvaluation.scientificVerdict,
        scientificFindings: blockers.length ? [] : analysisProtocolEvaluation.scientificFindings,
        preDataAccessFreeze,
        empiricalPreDataAccessFreezeHash: preDataAccessFreeze.empiricalPreDataAccessFreezeHash,
        experimentDesignHash: selector.expected.experimentDesignHash,
        benchmarkHarnessHash: selector.expected.experimentDesign.benchmarkHarnessHash,
        armProtocolSet: selector.expected.experimentDesign.benchmarkHarness.armProtocolSet,
        systemBenchmarkArmProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
        armAdapterSet,
        systemBenchmarkArmAdapterSetHash: armAdapterSet.systemBenchmarkArmAdapterSetHash,
        systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
        datasetAuthorizationSetHash: authorizations.datasetAuthorizationSetHash,
        operatorDatasetHarnessAuthority,
        assuranceScope: selector.expected.assuranceScope,
        academicPromotionEligible: selector.expected.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
        rawEventManifestHash,
        rawEventArtifactHash,
        rawEventArtifactBytes,
        rawEventArtifact,
        rawEventRecomputationManifest,
        statisticalEvaluation,
        analysisProtocol,
        analysisProtocolHash: analysisProtocol.analysisProtocolHash,
        analysisObservationAuthority,
        analysisProtocolEvaluation,
        observations,
      };
      const csvDocument = buildCsv(observations, requiredMetrics);
      let resultJsonHash = null;
      let resultCsvHash = null;
      let resultArtifacts = [];
      if (!blockers.length) {
        const persisted = writeSystemBenchmarkResults({ outputDirectory, resultDocument, csvDocument, rawEventDocument });
        ({ resultJsonHash, resultCsvHash, artifacts: resultArtifacts } = persisted);
        if (persisted.rawEventArtifactHash !== rawEventArtifactHash || persisted.rawEventArtifactBytes !== rawEventArtifactBytes) blockers.push('benchmark_raw_event_artifact_persistence_mismatch');
      }
      const runtimeIdentityHashes = [...new Set(armBatchExecutions.map((batch) => batch.runnerReceipt.runtimeIdentityHash))];
      const sourceMerkleHashes = [...new Set(armBatchExecutions.map((batch) => batch.runnerReceipt.workSourceMerkleHash))];
      const sourceManifestHashes = [...new Set(armBatchExecutions.map((batch) => batch.runnerReceipt.workWorkspaceManifestHash))];
      const datasetAccessSupervisorIdentityHashes = [...new Set(armBatchExecutions
        .map((batch) => batch.runnerReceipt.datasetAccessSupervisorIdentityHash)
        .filter(Boolean))];
      const environmentBoms = armBatchExecutions.map((batch) => batch.runnerReceipt.environmentBom);
      const environmentBomHashes = [...new Set(armBatchExecutions.map((batch) => batch.runnerReceipt.environmentBomHash))];
      const environmentBom = environmentBoms[0] || null;
      const environmentBomHash = environmentBomHashes[0] || null;
      const processExecutionManifest = armBatchExecutions.map((batch) => Object.freeze({
        executionAttemptId: batch.executionAttemptId,
        executionProcessIdentityHash: batch.executionProcessIdentityHash,
        launcherPid: batch.runnerReceipt.executionProcessIdentity?.launcherPid || null,
        environmentBindingHash: batch.runnerReceipt.environmentBindingHash,
        cellIds: batch.cellIds,
        resourceBudget: batch.resourceBudget,
      }));
      if (runtimeIdentityHashes.length !== 1) blockers.push('benchmark_harness_runtime_identity_inconsistent');
      if (sourceMerkleHashes.length !== 1 || sourceManifestHashes.length !== 1) blockers.push('benchmark_harness_source_identity_inconsistent');
      if (datasetAccessSupervisorIdentityHashes.length > 1) blockers.push('benchmark_harness_dataset_access_supervisor_identity_inconsistent');
      if (environmentBoms.length !== expectedProcessExecutionCount || environmentBomHashes.length !== 1
        || !verifyEmpiricalEnvironmentBom(environmentBom).valid || environmentBom?.environmentBomHash !== environmentBomHash
        || environmentBoms.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(environmentBom))) {
        blockers.push('benchmark_harness_environment_bom_inconsistent');
      }
      if (academicPerCell && (new Set(processExecutionManifest.map((item) => item.executionAttemptId)).size !== schedule.length
        || new Set(processExecutionManifest.map((item) => item.executionProcessIdentityHash)).size !== schedule.length
        || new Set(processExecutionManifest.map((item) => item.launcherPid)).size !== schedule.length
        || new Set(processExecutionManifest.map((item) => item.environmentBindingHash)).size !== schedule.length)) {
        blockers.push('benchmark_harness_per_cell_process_isolation_unverified');
      }
      const payload = {
        version: 3,
        kind: 'SystemBenchmarkHarnessExecutionReceipt',
        status: blockers.length ? 'system_benchmark_harness_blocked' : 'system_benchmark_harness_verified',
        executionStatus: armBatchExecutions.length === expectedProcessExecutionCount
          ? 'system_benchmark_execution_completed' : 'system_benchmark_execution_failed',
        integrityStatus: blockers.length ? 'system_benchmark_integrity_blocked' : 'system_benchmark_integrity_verified',
        scientificVerdict: blockers.length ? 'not_evaluable' : analysisProtocolEvaluation.scientificVerdict,
        scientificFindings: blockers.length ? [] : analysisProtocolEvaluation.scientificFindings,
        preDataAccessFreeze,
        empiricalPreDataAccessFreezeHash: preDataAccessFreeze.empiricalPreDataAccessFreezeHash,
        benchmarkId: selector.expected.benchmarkId,
        benchmarkSelector: selector.expected,
        campaignBenchmarkSelectorHash: selector.expected.campaignBenchmarkSelectorHash,
        experimentDesignHash: selector.expected.experimentDesignHash,
        benchmarkHarnessHash: selector.expected.experimentDesign.benchmarkHarnessHash,
        armProtocolSet: selector.expected.experimentDesign.benchmarkHarness.armProtocolSet,
        systemBenchmarkArmProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
        armAdapterSet,
        systemBenchmarkArmAdapterSetHash: armAdapterSet.systemBenchmarkArmAdapterSetHash,
        systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
        datasetAuthorizationSetHash: authorizations.datasetAuthorizationSetHash,
        operatorDatasetHarnessAuthority,
        assuranceScope: selector.expected.assuranceScope,
        academicPromotionEligible: selector.expected.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
        datasetAuthorizations: authorizations.datasets,
        experimentAttemptId,
        sourceLineageHash,
        runtimeIdentityHash: runtimeIdentityHashes[0] || null,
        datasetAccessSupervisorIdentityHash: datasetAccessSupervisorIdentityHashes[0] || null,
        sourceMerkleHash: sourceMerkleHashes[0] || null,
        sourceWorkspaceManifestHash: sourceManifestHashes[0] || null,
        environmentBom,
        environmentBomHash,
        environmentBindingHash: hashRecord('SystemBenchmarkHarnessEnvironmentBindings', armBatchExecutions.map((batch) => batch.runnerReceipt.environmentBindingHash)),
        requiredMetrics,
        executionIsolationMode: executionMode,
        expectedProcessExecutionCount,
        processExecutionCount: armBatchExecutions.length,
        processExecutionManifestHash: hashRecord('SystemBenchmarkProcessExecutionManifest', processExecutionManifest),
        absoluteDeadlineEpochMs: Number(absoluteDeadlineEpochMs),
        aggregateCpuSeconds: Number(aggregateCpuSeconds),
        allocatedCpuSeconds: armBatchExecutions.reduce((sum, batch) => sum + Number(batch.resourceBudget?.cpuSeconds || 0), 0),
        workerMemoryBytes: Number(memoryBytes),
        workerMaximumProcesses: Number(maximumProcesses),
        gpuRequired: Boolean(requiresGpu),
        scheduleCellCount: schedule.length,
        armBatchExecutionCount: armBatchExecutions.length,
        armBatchExecutions,
        cells,
        observationManifestHash: hashRecord('ExperimentObservationManifest', observations),
        rawEventManifestHash,
        rawEventArtifactHash,
        rawEventArtifactBytes,
        rawEventArtifact,
        rawEventRecomputationManifest,
        statisticalEvaluation,
        analysisProtocol,
        analysisProtocolHash: analysisProtocol.analysisProtocolHash,
        analysisObservationAuthority,
        analysisProtocolEvaluation,
        resultDocument,
        csvDocument,
        resultJsonHash,
        resultCsvHash,
        artifacts: blockers.length ? [] : resultArtifacts,
        blockers: [...new Set(blockers)],
        externalActionPerformed: false,
      };
      return Object.freeze({ ...payload, systemBenchmarkHarnessExecutionReceiptHash: hashRecord('SystemBenchmarkHarnessExecutionReceipt', payload) });
    } finally {
      fs.rmSync(harnessRoot, { recursive: true, force: true });
    }
  };

  const academicPerCell = selector.expected.selectorType === 'authorized_dataset_mount';
  const executionMode = academicPerCell ? 'academic-per-cell-process-v1' : 'synthetic-per-arm-batch-process-v1';
  const executionUnits = academicPerCell
    ? schedule.map((cell) => Object.freeze({ arm: cell.arm, cells: Object.freeze([cell]) }))
    : ARMS.map((arm) => Object.freeze({ arm, cells: Object.freeze(schedule.filter((cell) => cell.arm === arm)) }));
  const perUnitWallTimeMs = Math.floor((Number(absoluteDeadlineEpochMs) - Number(nowEpochMs())) / executionUnits.length);
  const advance = (index) => {
    if (index >= executionUnits.length || blockers.length) return finalize();
    const remainingWallTimeMs = Math.floor(Number(absoluteDeadlineEpochMs) - Number(nowEpochMs()));
    if (perUnitWallTimeMs < 1 || remainingWallTimeMs < perUnitWallTimeMs) {
      blockers.push('benchmark_harness_absolute_deadline_exhausted');
      return finalize();
    }
    const timeoutMs = perUnitWallTimeMs;
    const baseCpuSeconds = Math.floor(Number(aggregateCpuSeconds) / executionUnits.length);
    const cpuSeconds = baseCpuSeconds;
    if (cpuSeconds < 1) {
      blockers.push('benchmark_harness_aggregate_cpu_budget_exhausted');
      return finalize();
    }
    const { arm, cells: scheduledCells } = executionUnits[index];
    const armProtocol = scheduledCells[0]?.armProtocol || null;
    const armAdapter = armAdapterSet.adapters.find((candidate) => candidate.arm === arm);
    let fixture = null;
    try { fixture = buildSystemBenchmarkArmBatchChallenge({ protocol: armProtocol, cells: scheduledCells, operatorDatasetHarnessDefinition }); }
    catch (error) { blockers.push(`benchmark_repository_owned_arm_batch_unavailable:${arm}:${error?.message || 'unknown'}`); return finalize(); }
    const batch = Object.freeze({
      arm,
      armProtocol,
      systemBenchmarkArmProtocolHash: armProtocol.systemBenchmarkArmProtocolHash,
      armProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
      armAdapter,
      armAdapterSetHash: armAdapterSet.systemBenchmarkArmAdapterSetHash,
      empiricalPreDataAccessFreezeHash: preDataAccessFreeze.empiricalPreDataAccessFreezeHash,
      experimentAttemptId,
      executionMode,
      executionAttemptId: academicPerCell
        ? `${experimentAttemptId}:arm:${arm}:cell:${scheduledCells[0].cellId}`
        : `${experimentAttemptId}:arm:${arm}`,
      cells: Object.freeze(scheduledCells),
      resourceBudget: Object.freeze({
        absoluteDeadlineEpochMs: Number(absoluteDeadlineEpochMs),
        timeoutMs,
        cpuSeconds,
        memoryBytes: Number(memoryBytes),
        maximumProcesses: Number(maximumProcesses),
        requiresGpu: Boolean(requiresGpu),
      }),
      challenge: fixture.challenge,
      fixtures: fixture.fixtures,
    });
    const batchOutput = path.join(harnessRoot, arm, academicPerCell ? scheduledCells[0].cellId.slice('sha256:'.length) : 'batch');
    fs.mkdirSync(batchOutput, { recursive: true, mode: 0o700 });
    let pending = null;
    try { pending = runArmBatch({ batch, outputDirectory: batchOutput }); }
    catch (error) { blockers.push(`benchmark_arm_batch_execution_threw:${arm}:${error?.message || 'unknown'}`); return finalize(); }
    if (typeof pending?.then === 'function') {
      return pending.then(
        (receipt) => { consume(batch, batchOutput, receipt); return advance(index + 1); },
        (error) => { blockers.push(`benchmark_arm_batch_execution_threw:${arm}:${error?.message || 'unknown'}`); return finalize(); },
      );
    }
    consume(batch, batchOutput, pending);
    return advance(index + 1);
  };
  return advance(0);
}

export { verifySystemBenchmarkHarnessExecutionReceipt };
