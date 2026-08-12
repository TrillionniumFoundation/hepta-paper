import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
  LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
  verifyCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildResolvedVersionedExperimentIr,
} from '../../paper-domain/automation/versioned-experiment-ir.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from '../../paper-domain/automation/system-benchmark-harness-identity.mjs';
import {
  evaluateSystemBenchmarkStatisticalPolicy,
  verifySystemBenchmarkArmAdapterSet,
} from '../../paper-domain/automation/system-benchmark-arm-protocol.mjs';
import {
  buildSystemBenchmarkArmBatchChallenge,
} from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import {
  buildCampaignBenchmarkSchedule,
  buildDatasetAuthorizationSet,
  verifySystemBenchmarkHarnessExecutionReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import { writeSystemBenchmarkResults } from './system-benchmark-result-repository.mjs';
import { readOperatorDatasetHarness } from './operator-dataset-harness-reader.mjs';
import { academicAnalysisPromotionBlockers, evaluateAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-evaluator.mjs';
import { buildHarnessAnalysisObservationAuthority, buildRawEventRecomputationManifest } from '../../paper-domain/automation/analysis-protocol-run-binding.mjs';
import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { buildEmpiricalPreDataAccessFreeze } from '../../paper-domain/automation/empirical-pre-data-access-freeze.mjs';
import {
  runProcessIsolatedRawEventRecomputation,
} from '../research-verify/process-isolated-system-benchmark-recomputation.mjs';
import {
  runSystemBenchmarkTypedNumericProcess,
} from './system-benchmark-typed-numeric-process.mjs';
import { buildDatasetEvaluationDependencyReceipt } from '../../paper-domain/automation/dataset-evaluation-dependency-contract.mjs';
import {
  buildSystemBenchmarkObservationCsv,
  parseSystemBenchmarkArmBatchObservation,
  verifySystemBenchmarkArmBatchExecution,
} from './system-benchmark-harness-batch-verification.mjs';
import {
  buildIndependentRecomputationAssurance,
} from './system-benchmark-independent-recomputation-assurance.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);
const MAXIMUM_RAW_EVENT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_RAW_EVENTS_PER_CELL = 64;
const ACADEMIC_PER_CELL_MINIMUM_TIMEOUT_MS = 60_000;
const ACADEMIC_PER_CELL_MAXIMUM_CONCURRENCY = 1;

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
  runRawEventRecomputation = runProcessIsolatedRawEventRecomputation,
  operatorDatasetAuthorityTrustStore = null,
  runtimeRoot = null,
  absoluteDeadlineEpochMs = Date.now() + (6 * 60 * 60 * 1000),
  aggregateCpuSeconds = 3600,
  memoryBytes = 4 * 1024 * 1024 * 1024,
  maximumProcesses = 128,
  requiresGpu = false,
  maximumWallTimeMs = null,
  cpuCount = 1,
  executionEnvironment = null,
  localOnly = false,
  researchContext = null,
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
  const localGoldenAuthority = selector.expected?.authorityScope
    === LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE;
  if (!selector.valid || !adapterSetVerified || !experimentAttemptId || !SHA256.test(String(sourceLineageHash || ''))
    || !SHA256.test(String(sourceMerkleHash || '')) || !SHA256.test(String(sourceWorkspaceManifestHash || ''))
    || !Number.isSafeInteger(Number(attemptVersion)) || Number(attemptVersion) < 1
    || !Array.isArray(failedAttemptLineageHashes)
    || !outputDirectory || typeof runArmBatch !== 'function'
    || typeof runRawEventRecomputation !== 'function'
    || !Number.isFinite(Number(absoluteDeadlineEpochMs))
    || !Number.isSafeInteger(Number(aggregateCpuSeconds)) || Number(aggregateCpuSeconds) < 1
    || !Number.isSafeInteger(Number(memoryBytes)) || Number(memoryBytes) < 1
    || !Number.isSafeInteger(Number(maximumProcesses)) || Number(maximumProcesses) < 1
    || typeof nowEpochMs !== 'function'
    || (localGoldenAuthority && localOnly !== true)
    || (researchContext !== null && (
      !Number.isSafeInteger(Number(maximumWallTimeMs)) || Number(maximumWallTimeMs) < 1
      || Number(absoluteDeadlineEpochMs) - Number(nowEpochMs()) > Number(maximumWallTimeMs)
      || Number(cpuCount) !== 1
      || !String(executionEnvironment || '')
    ))) {
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
        ...(typeof runRawEventRecomputation !== 'function'
          ? ['benchmark_harness_raw_event_recomputation_runner_required'] : []),
        ...(!Number.isFinite(Number(absoluteDeadlineEpochMs)) ? ['benchmark_harness_absolute_deadline_required'] : []),
        ...(!Number.isSafeInteger(Number(aggregateCpuSeconds)) || Number(aggregateCpuSeconds) < 1 ? ['benchmark_harness_aggregate_cpu_budget_invalid'] : []),
        ...(!Number.isSafeInteger(Number(memoryBytes)) || Number(memoryBytes) < 1 ? ['benchmark_harness_memory_budget_invalid'] : []),
        ...(localGoldenAuthority && localOnly !== true
          ? ['local_golden_dataset_authority_requires_local_only_execution'] : []),
        ...(!Number.isSafeInteger(Number(maximumProcesses)) || Number(maximumProcesses) < 1 ? ['benchmark_harness_process_budget_invalid'] : []),
        ...(researchContext !== null && (
          !Number.isSafeInteger(Number(maximumWallTimeMs)) || Number(maximumWallTimeMs) < 1
          || typeof nowEpochMs !== 'function'
          || Number(absoluteDeadlineEpochMs) - Number(nowEpochMs()) > Number(maximumWallTimeMs)
          || Number(cpuCount) !== 1 || !String(executionEnvironment || '')
        ) ? ['benchmark_harness_research_resource_budget_invalid'] : []),
      ],
    });
  }
  if (selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkHarnessImplementationHash
    !== SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash) {
    return Object.freeze({ status: 'system_benchmark_harness_blocked', blockers: ['benchmark_harness_implementation_identity_mismatch'] });
  }
  const requiredMetrics = [...selector.expected.experimentDesign.requiredMetrics];
  const metricSpecs = selector.expected.experimentDesign.metricSpecs;
  const authorizations = buildDatasetAuthorizationSet(datasetMounts);
  const analysisProtocol = Object.freeze({
    ...selector.expected.experimentDesign.analysisProtocol,
    analysisProtocolHash: selector.expected.experimentDesign.analysisProtocolHash,
  });
  let experimentIr;
  try {
    const pluginProfile = autonomousEmpiricalFamilyPluginProfileFor(
      selector.expected.experimentDesign.benchmarkFamily,
    );
    experimentIr = buildResolvedVersionedExperimentIr(pluginProfile, {
      selector: selector.expected,
      armAdapterSet,
      datasetAuthorizationSet: authorizations,
      experimentAttemptId,
      attemptVersion: Number(attemptVersion),
      failedAttemptLineageHashes,
      sourceLineageHash,
      sourceMerkleHash,
      sourceWorkspaceManifestHash,
      absoluteDeadlineEpochMs,
      aggregateCpuSeconds,
      memoryBytes,
      maximumProcesses,
      requiresGpu,
      maximumWallTimeMs,
      cpuCount,
      executionEnvironment,
      researchContext,
    });
  } catch (error) {
    return Object.freeze({
      status: 'system_benchmark_harness_blocked',
      executionStatus: 'system_benchmark_execution_not_started',
      integrityStatus: 'system_benchmark_integrity_blocked',
      scientificVerdict: 'not_evaluable',
      blockers: [`benchmark_experiment_ir:${String(error?.message || error)}`],
    });
  }
  // The resolved IR is fixed before schedule construction, any hidden dataset
  // harness is read, or the first arm-batch callback can be invoked.
  const schedule = buildCampaignBenchmarkSchedule(selector.expected);
  let preDataAccessFreeze;
  try {
    preDataAccessFreeze = buildEmpiricalPreDataAccessFreeze({
      experimentAttemptId,
      attemptVersion: Number(attemptVersion),
      failedAttemptLineageHashes,
      versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
      ...(experimentIr.version === 3 ? {
        experimentResearchBindingHash:
          experimentIr.researchBinding.experimentResearchBindingHash,
        datasetResearchCompatibilityHash:
          experimentIr.researchBinding.datasetResearchCompatibilityHash,
      } : {}),
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
    const checked = verifySystemBenchmarkArmBatchExecution({
      batch,
      runnerReceipt,
      datasetRequired: datasetMounts.length > 0,
    });
    blockers.push(...checked.blockers);
    const read = readScopedFileSync({
      scopeRoot: batchOutput,
      candidate: path.join(batchOutput, 'observation.json'),
      maximumBytes: 4 * 1024 * 1024,
    });
    if (read.status !== 'scoped_file_read_verified') blockers.push(`benchmark_arm_batch_observation_unreadable:${batch.arm}`);
    const parsed = read.status === 'scoped_file_read_verified'
      ? parseSystemBenchmarkArmBatchObservation(
        read.content,
        requiredMetrics,
        metricSpecs,
        batch,
        operatorDatasetHarnessDefinition,
      )
      : { observations: null, blockers: [] };
    blockers.push(...parsed.blockers.map((blocker) => `${blocker}:${batch.arm}`));
    const observationHash = read.status === 'scoped_file_read_verified' ? hashBytes(read.content) : null;
    if (checked.artifact?.sha256 !== observationHash) blockers.push(`benchmark_arm_batch_observation_artifact_mismatch:${batch.arm}`);
    if (blockers.length !== blockerCountBeforeBatch || !parsed.observations) return;
      const batchPayload = {
      version: 2,
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
      versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
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
        versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
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
        versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
      }));
    }
  };

  const finalize = () => {
    try {
      const cells = schedule.map((cell) => cellsById.get(cell.cellId)).filter(Boolean);
      const rawEventRows = schedule.map((cell) => rawEventRowsById.get(cell.cellId)).filter(Boolean);
      const observations = cells.map((cell) => ({ seed: cell.seed, repetition: cell.repetition, arm: cell.arm, metrics: cell.metrics }));
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
      const rawEventRecomputationManifest = buildRawEventRecomputationManifest({
        cells,
        rawEventRows: rawEventRows.map((row) => ({ cellId: row.document.cellId, document: row.document, line: row.line })),
        requiredMetrics,
        metricSpecs,
        versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
      });
      blockers.push(...rawEventRecomputationManifest.blockers);
      const independentRecomputationInput = Object.freeze({
        cells,
        rawEventRows: rawEventRows.map((row) => ({
          cellId: row.document.cellId,
          document: row.document,
          line: row.line,
        })),
        requiredMetrics,
        metricSpecs,
        versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
      });
      const processIsolatedRawEventRecomputationAssurance =
        runRawEventRecomputation(independentRecomputationInput);
      const independentRawEventRecomputationAssurance =
        buildIndependentRecomputationAssurance({
          producerManifest: rawEventRecomputationManifest,
          processAssurance: processIsolatedRawEventRecomputationAssurance,
          producerImplementationHash:
            SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
          recomputationInput: independentRecomputationInput,
          versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
        });
      blockers.push(...independentRawEventRecomputationAssurance.blockers);
      const typedNumericProcess = runSystemBenchmarkTypedNumericProcess({
        benchmarkFamily: selector.expected.experimentDesign.benchmarkFamily,
        observations,
        analysisProtocol,
        independentRawEventRecomputationAssurance,
        experimentIr,
      });
      blockers.push(...typedNumericProcess.blockers);
      let analysisObservationAuthority = null;
      try {
        analysisObservationAuthority = buildHarnessAnalysisObservationAuthority({
          cells,
          benchmarkFamily: selector.expected.experimentDesign.benchmarkFamily,
          analysisProtocolHash: analysisProtocol.analysisProtocolHash,
          analysisProtocol,
          numericResidualMaximum:
            analysisProtocol.numericValidation.residual.maximumAbsoluteResidual,
          scheduleCellCount: schedule.length,
          rawEventManifestHash,
          rawEventArtifactHash,
          systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
          versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
          experimentAttemptId,
          sourceLineageHash,
          rawEventRecomputationManifest,
          independentRawEventRecomputationAssurance,
          typedNumericOracleProduction: typedNumericProcess.typedNumericOracleProduction,
          typedNumericOracleRecomputationReceipt:
            typedNumericProcess.typedNumericOracleRecomputationReceipt,
          experimentIr,
        });
      } catch (error) {
        blockers.push(`benchmark_analysis_observation_authority:${String(
          error?.message || error,
        )}`);
      }
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
      const workerDatasetPositiveByteReadObserved = datasetBacked
        && armBatchExecutions.length === expectedProcessExecutionCount
        && armBatchExecutions.every((batch) => authorizations.datasets.every((dataset) => {
          const access = batch.runnerReceipt?.datasetAccessReceipt?.datasets
            ?.find((candidate) => candidate.name === dataset.name);
          return access?.readObserved === true
            && Number.isSafeInteger(access.positiveReadBytesObserved)
            && access.positiveReadBytesObserved > 0;
        }));
      const datasetEvaluationDependencyReceipt = datasetBacked
        ? buildDatasetEvaluationDependencyReceipt({
          operatorDatasetHarnessAuthority,
          preDataAccessFreeze,
          cells,
          rawEventManifestHash,
          rawEventArtifactHash,
          analysisObservationAuthority,
          analysisProtocolEvaluation,
          workerDatasetPositiveByteReadObserved,
        })
        : null;
      if (datasetBacked && datasetEvaluationDependencyReceipt.status
        !== 'dataset_evaluation_dependency_verified') {
        blockers.push(...datasetEvaluationDependencyReceipt.blockers);
      }
      const resultDocument = {
        version: 5,
        kind: 'SystemBenchmarkRunObservations',
        executionStatus: 'system_benchmark_execution_completed',
        integrityStatus: blockers.length ? 'system_benchmark_integrity_blocked' : 'system_benchmark_integrity_verified',
        scientificVerdict: blockers.length ? 'not_evaluable' : analysisProtocolEvaluation.scientificVerdict,
        scientificFindings: blockers.length ? [] : analysisProtocolEvaluation.scientificFindings,
        preDataAccessFreeze,
        empiricalPreDataAccessFreezeHash: preDataAccessFreeze.empiricalPreDataAccessFreezeHash,
        experimentIr,
        versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
        experimentDesignHash: selector.expected.experimentDesignHash,
        benchmarkHarnessHash: selector.expected.experimentDesign.benchmarkHarnessHash,
        armProtocolSet: selector.expected.experimentDesign.benchmarkHarness.armProtocolSet,
        systemBenchmarkArmProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
        armAdapterSet,
        systemBenchmarkArmAdapterSetHash: armAdapterSet.systemBenchmarkArmAdapterSetHash,
        systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
        datasetAuthorizationSetHash: authorizations.datasetAuthorizationSetHash,
        operatorDatasetHarnessAuthority,
        datasetEvaluationDependencyReceipt,
        assuranceScope: selector.expected.assuranceScope,
        executionAssuranceProfile,
        academicPromotionEligible: academicPerCell
          && selector.expected.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
        ...(localGoldenAuthority ? {
          evidenceClass: LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
          externalTrustClaimed: false,
        } : {}),
        rawEventManifestHash,
        rawEventArtifactHash,
        rawEventArtifactBytes,
        rawEventArtifact,
        rawEventRecomputationManifest,
        independentRawEventRecomputationAssurance,
        statisticalEvaluation,
        analysisProtocol,
        analysisProtocolHash: analysisProtocol.analysisProtocolHash,
        analysisObservationAuthority,
        analysisProtocolEvaluation,
        observations,
      };
      const csvDocument = buildSystemBenchmarkObservationCsv(observations, requiredMetrics);
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
        version: 4,
        kind: 'SystemBenchmarkHarnessExecutionReceipt',
        status: blockers.length ? 'system_benchmark_harness_blocked' : 'system_benchmark_harness_verified',
        executionStatus: armBatchExecutions.length === expectedProcessExecutionCount
          ? 'system_benchmark_execution_completed' : 'system_benchmark_execution_failed',
        integrityStatus: blockers.length ? 'system_benchmark_integrity_blocked' : 'system_benchmark_integrity_verified',
        scientificVerdict: blockers.length ? 'not_evaluable' : analysisProtocolEvaluation.scientificVerdict,
        scientificFindings: blockers.length ? [] : analysisProtocolEvaluation.scientificFindings,
        preDataAccessFreeze,
        empiricalPreDataAccessFreezeHash: preDataAccessFreeze.empiricalPreDataAccessFreezeHash,
        experimentIr,
        versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
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
        datasetEvaluationDependencyReceipt,
        assuranceScope: selector.expected.assuranceScope,
        executionAssuranceProfile,
        academicPromotionEligible: academicPerCell
          && selector.expected.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
        ...(localGoldenAuthority ? {
          evidenceClass: LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
          externalTrustClaimed: false,
        } : {}),
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
        independentRawEventRecomputationAssurance,
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

  const datasetBacked = selector.expected.selectorType === 'authorized_dataset_mount';
  const academicPerCell = datasetBacked && !localGoldenAuthority && localOnly !== true;
  const executionAssuranceProfile = academicPerCell
    ? 'academic-per-cell-isolation-v1'
    : (datasetBacked ? 'local-bounded-hidden-evaluation-v1' : 'synthetic-conformance-v1');
  const executionMode = academicPerCell
    ? 'academic-per-cell-process-v1'
    : (datasetBacked ? 'local-authorized-per-arm-batch-process-v1' : 'synthetic-per-arm-batch-process-v1');
  const executionUnits = academicPerCell
    ? schedule.map((cell) => Object.freeze({ arm: cell.arm, cells: Object.freeze([cell]) }))
    : ARMS.map((arm) => Object.freeze({ arm, cells: Object.freeze(schedule.filter((cell) => cell.arm === arm)) }));
  const expectedProcessExecutionCount = executionUnits.length;
  const nominalPerUnitWallTimeMs = Math.floor(
    (Number(absoluteDeadlineEpochMs) - Number(nowEpochMs())) / executionUnits.length,
  );
  const perUnitWallTimeMs = academicPerCell
    ? Math.max(ACADEMIC_PER_CELL_MINIMUM_TIMEOUT_MS, nominalPerUnitWallTimeMs)
    : nominalPerUnitWallTimeMs;
  const startUnit = (index) => {
    const remainingWallTimeMs = Math.floor(Number(absoluteDeadlineEpochMs) - Number(nowEpochMs()));
    if (perUnitWallTimeMs < 1 || remainingWallTimeMs < 1) {
      blockers.push('benchmark_harness_absolute_deadline_exhausted');
      return null;
    }
    const timeoutMs = Math.min(perUnitWallTimeMs, remainingWallTimeMs);
    const baseCpuSeconds = Math.floor(Number(aggregateCpuSeconds) / executionUnits.length);
    const cpuSeconds = baseCpuSeconds;
    if (cpuSeconds < 1) {
      blockers.push('benchmark_harness_aggregate_cpu_budget_exhausted');
      return null;
    }
    const { arm, cells: scheduledCells } = executionUnits[index];
    const armProtocol = scheduledCells[0]?.armProtocol || null;
    const armAdapter = armAdapterSet.adapters.find((candidate) => candidate.arm === arm);
    let fixture = null;
    try {
      fixture = buildSystemBenchmarkArmBatchChallenge({
        protocol: armProtocol,
        cells: scheduledCells,
        operatorDatasetHarnessDefinition,
        versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
      });
    }
    catch (error) { blockers.push(`benchmark_repository_owned_arm_batch_unavailable:${arm}:${error?.message || 'unknown'}`); return null; }
    const batch = Object.freeze({
      arm,
      armProtocol,
      systemBenchmarkArmProtocolHash: armProtocol.systemBenchmarkArmProtocolHash,
      armProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
      armAdapter,
      armAdapterSetHash: armAdapterSet.systemBenchmarkArmAdapterSetHash,
      empiricalPreDataAccessFreezeHash: preDataAccessFreeze.empiricalPreDataAccessFreezeHash,
      versionedExperimentIrHash: experimentIr.versionedExperimentIrHash,
      ...(experimentIr.version === 3 ? {
        experimentResearchBindingHash:
          experimentIr.researchBinding.experimentResearchBindingHash,
        datasetResearchCompatibilityHash:
          experimentIr.researchBinding.datasetResearchCompatibilityHash,
      } : {}),
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
    catch (error) { blockers.push(`benchmark_arm_batch_execution_threw:${arm}:${error?.message || 'unknown'}`); return null; }
    return Object.freeze({ arm, batch, batchOutput, pending });
  };
  const advance = (index) => {
    if (index >= executionUnits.length || blockers.length) return finalize();
    const width = academicPerCell
      ? Math.min(ACADEMIC_PER_CELL_MAXIMUM_CONCURRENCY, executionUnits.length - index)
      : 1;
    const started = [];
    for (let offset = 0; offset < width && !blockers.length; offset += 1) {
      const unit = startUnit(index + offset);
      if (unit) started.push(unit);
    }
    if (!started.length || blockers.length) return finalize();
    if (started.some((unit) => typeof unit.pending?.then === 'function')) {
      return Promise.all(started.map(async (unit) => {
        try { return { unit, receipt: await unit.pending, error: null }; }
        catch (error) { return { unit, receipt: null, error }; }
      })).then((settled) => {
        for (const { unit, receipt, error } of settled) {
          if (error) blockers.push(`benchmark_arm_batch_execution_threw:${unit.arm}:${error?.message || 'unknown'}`);
          else consume(unit.batch, unit.batchOutput, receipt);
        }
        return advance(index + started.length);
      });
    }
    for (const unit of started) consume(unit.batch, unit.batchOutput, unit.pending);
    return advance(index + started.length);
  };
  return advance(0);
}

export { verifySystemBenchmarkHarnessExecutionReceipt };
