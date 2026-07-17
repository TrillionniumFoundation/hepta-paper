import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyCampaignBenchmarkSelector } from './campaign-benchmark-selector.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from './system-benchmark-harness-identity.mjs';
import { evaluateSystemBenchmarkStatisticalPolicy, verifySystemBenchmarkArmAdapterSet, verifySystemBenchmarkArmProtocolSet, verifySystemBenchmarkStatisticalCompatibilityEvidence } from './system-benchmark-arm-protocol.mjs';
import { buildSystemBenchmarkArmBatchChallenge, buildSystemBenchmarkCellChallenge, decodeSystemBenchmarkArmBatchChallengeEnvironment } from './system-benchmark-challenge.mjs';
import { verifyOperatorDatasetHarnessAuthorityReceiptStructure } from './operator-dataset-harness-contract.mjs';
import { analysisProtocolResultDocumentFields, buildExperimentReplayAnalysisProtocolBinding, buildExperimentRunAnalysisProtocolBinding, verifyExperimentReplayAnalysisProtocolBinding, verifyExperimentRunAnalysisProtocolBinding, verifyHarnessAnalysisProtocolBinding } from './analysis-protocol-run-binding.mjs';
import { verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt } from './dataset-runtime-access-contract.mjs';
import { buildDatasetAuthorizationSet, parseExperimentObservationCsv, verifyExperimentRawArtifactWriteReceipt } from './experiment-run-artifact-contract.mjs';
import { verifyOsSandboxWorkerReceipt } from './os-sandbox-worker-receipt-contract.mjs';
import { buildCampaignBenchmarkSchedule, REQUIRED_SYSTEM_BENCHMARK_ARMS as REQUIRED_ARMS } from './system-benchmark-schedule.mjs';
import { verifyWorkerProcessExecutionIdentity } from './worker-process-execution-contract.mjs';
import { buildExperimentRunEnvironmentBomBinding, experimentReplayEnvironmentBomFields, verifyExperimentReplayEnvironmentBomBinding, verifyExperimentRunEnvironmentBomBinding, verifyHarnessEnvironmentBomBinding } from './experiment-environment-bom-binding.mjs';
import { verifySystemBenchmarkArmBatchResourceBudget, verifySystemBenchmarkHarnessResourceBudget } from './system-benchmark-resource-budget-contract.mjs';
import { verifyEmpiricalPreDataAccessFreeze } from './empirical-pre-data-access-freeze.mjs';
import { aggregateExperimentObservations as aggregateObservations, canonicalExperimentObservation as canonicalObservation, csvExperimentObservation as csvObservation, experimentObservationKey as observationKey, finiteExperimentMetrics as finiteMetrics } from './experiment-observation-contract.mjs';
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;

export {
  buildCampaignBenchmarkSchedule,
  buildDatasetAuthorizationSet,
  verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt,
  verifyOsSandboxWorkerReceipt,
};

export function verifySystemBenchmarkHarnessExecutionReceipt(receipt) {
  if (!receipt || receipt.version !== 3 || receipt.kind !== 'SystemBenchmarkHarnessExecutionReceipt') return false;
  const { systemBenchmarkHarnessExecutionReceiptHash, ...payload } = receipt;
  const selector = verifyCampaignBenchmarkSelector(receipt.benchmarkSelector, {
    benchmarkId: receipt.benchmarkId,
    datasetMounts: receipt.datasetAuthorizations,
  });
  if (!selector.valid) return false;
  const expected = buildCampaignBenchmarkSchedule(selector.expected);
  if (expected.length !== receipt.cells?.length) return false;
  if (receipt.campaignBenchmarkSelectorHash !== selector.expected.campaignBenchmarkSelectorHash
    || receipt.experimentDesignHash !== selector.expected.experimentDesignHash
    || receipt.benchmarkHarnessHash !== selector.expected.experimentDesign.benchmarkHarnessHash
    || receipt.systemBenchmarkHarnessImplementationHash !== SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash
    || receipt.systemBenchmarkHarnessImplementationHash !== selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkHarnessImplementationHash
    || JSON.stringify(receipt.requiredMetrics) !== JSON.stringify(selector.expected.experimentDesign.requiredMetrics)) return false;
  if (!verifySystemBenchmarkArmProtocolSet(receipt.armProtocolSet, {
    benchmarkId: receipt.benchmarkId,
    datasetBacked: selector.expected.selectorType === 'authorized_dataset_mount',
    benchmarkFamily: selector.expected.experimentDesign.benchmarkFamily,
  }) || receipt.systemBenchmarkArmProtocolSetHash !== receipt.armProtocolSet?.systemBenchmarkArmProtocolSetHash
    || receipt.systemBenchmarkArmProtocolSetHash !== selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash) return false;
  if (!verifySystemBenchmarkArmAdapterSet(receipt.armAdapterSet, receipt.armProtocolSet)
    || receipt.systemBenchmarkArmAdapterSetHash !== receipt.armAdapterSet?.systemBenchmarkArmAdapterSetHash) return false;
  const authorizationSet = buildDatasetAuthorizationSet(receipt.datasetAuthorizations);
  if (receipt.datasetAuthorizationSetHash !== authorizationSet.datasetAuthorizationSetHash) return false;
  const datasetBacked = selector.expected.selectorType === 'authorized_dataset_mount';
  const datasetAuthorization = datasetBacked
    ? authorizationSet.datasets.find((dataset) => dataset.name === selector.expected.datasetMountName) || null
    : null;
  const operatorDatasetHarnessAuthority = receipt.operatorDatasetHarnessAuthority || null;
  if (datasetBacked
    ? !verifyOperatorDatasetHarnessAuthorityReceiptStructure(operatorDatasetHarnessAuthority, {
      dataset: datasetAuthorization,
      selector: selector.expected,
    })
    : operatorDatasetHarnessAuthority !== null) return false;
  const executionIsolationMode = datasetBacked ? 'academic-per-cell-process-v1' : 'synthetic-per-arm-batch-process-v1';
  const executionUnits = datasetBacked
    ? expected.map((cell) => [cell])
    : REQUIRED_ARMS.map((arm) => expected.filter((cell) => cell.arm === arm));
  if (receipt.executionIsolationMode !== executionIsolationMode
    || receipt.expectedProcessExecutionCount !== executionUnits.length
    || receipt.processExecutionCount !== executionUnits.length
    || receipt.armBatchExecutionCount !== executionUnits.length
    || receipt.armBatchExecutions?.length !== executionUnits.length) return false;
  const batchByHash = new Map();
  const runtimeIdentityHashes = [];
  const sourceMerkleHashes = [];
  const sourceManifestHashes = [];
  const environmentBindingHashes = [];
  const processIdentityHashes = [];
  const launcherPids = [];
  const executionAttemptIds = [];
  const datasetAccessSupervisorIdentityHashes = [];
  for (const [index, batchReceipt] of receipt.armBatchExecutions.entries()) {
    const scheduledCells = executionUnits[index];
    const arm = scheduledCells[0]?.arm;
    const protocol = scheduledCells[0]?.armProtocol || null;
    const expectedAdapter = receipt.armAdapterSet.adapters.find((candidate) => candidate.arm === arm);
    let fixture = null;
    if (!datasetBacked) {
      try { fixture = buildSystemBenchmarkArmBatchChallenge({ protocol, cells: scheduledCells }); }
      catch { return false; }
    }
    const boundChallenge = decodeSystemBenchmarkArmBatchChallengeEnvironment(batchReceipt?.runnerReceipt?.executionBindings || {});
    const expectedBatchChallengeHash = datasetBacked ? boundChallenge?.systemBenchmarkArmBatchChallengeHash : fixture?.challenge?.systemBenchmarkArmBatchChallengeHash;
    const executionAttemptId = datasetBacked
      ? `${receipt.experimentAttemptId}:arm:${arm}:cell:${scheduledCells[0].cellId}`
      : `${receipt.experimentAttemptId}:arm:${arm}`;
    if (!batchReceipt || batchReceipt.version !== 1 || batchReceipt.kind !== 'SystemBenchmarkArmBatchExecutionReceipt'
      || batchReceipt.arm !== arm || batchReceipt.systemBenchmarkArmProtocolHash !== protocol?.systemBenchmarkArmProtocolHash
      || batchReceipt.executionMode !== executionIsolationMode
      || batchReceipt.executionAttemptId !== executionAttemptId
      || (batchReceipt.executionProcessIdentityHash || null) !== (batchReceipt.runnerReceipt?.executionProcessIdentityHash || null)
      || !verifySystemBenchmarkArmBatchResourceBudget(batchReceipt, receipt)
      || batchReceipt.scheduleCellCount !== scheduledCells.length
      || JSON.stringify(batchReceipt.cellIds) !== JSON.stringify(scheduledCells.map((cell) => cell.cellId))
      || hashRecord('SystemBenchmarkArmAdapterIdentityExpected', batchReceipt.armAdapter)
        !== hashRecord('SystemBenchmarkArmAdapterIdentityExpected', expectedAdapter)
      || !boundChallenge
      || boundChallenge.scheduleCellCount !== scheduledCells.length
      || JSON.stringify(boundChallenge.cells.map((cell) => cell.cellId)) !== JSON.stringify(scheduledCells.map((cell) => cell.cellId))
      || batchReceipt.systemBenchmarkArmBatchChallengeHash !== expectedBatchChallengeHash
      || !verifyOsSandboxWorkerReceipt(batchReceipt.runnerReceipt)
      || (datasetBacked && !verifyWorkerProcessExecutionIdentity(batchReceipt.runnerReceipt, { requireObservedProcess: true }))
      || batchReceipt.runnerReceiptHash !== batchReceipt.runnerReceipt.receiptHash
      || batchReceipt.observationArtifactHash !== (batchReceipt.runnerReceipt.artifacts || []).find((item) => item.path === 'observation.json')?.sha256) return false;
    const { systemBenchmarkArmBatchExecutionReceiptHash, ...batchPayload } = batchReceipt;
    if (!SHA256.test(String(systemBenchmarkArmBatchExecutionReceiptHash || ''))
      || hashRecord('SystemBenchmarkArmBatchExecutionReceipt', batchPayload) !== systemBenchmarkArmBatchExecutionReceiptHash
      || batchByHash.has(systemBenchmarkArmBatchExecutionReceiptHash)) return false;
    const bindings = batchReceipt.runnerReceipt.executionBindings || {};
    if (!boundChallenge || hashRecord('SystemBenchmarkArmBatchChallengeExpected', boundChallenge)
        !== hashRecord('SystemBenchmarkArmBatchChallengeExpected', datasetBacked ? boundChallenge : fixture.challenge)
      || bindings.HEPTA_EXPERIMENT_ATTEMPT_ID !== executionAttemptId
      || bindings.HEPTA_EXPERIMENT_RUN_ID !== receipt.experimentAttemptId
      || (datasetBacked && (bindings.HEPTA_EXPERIMENT_SEED !== String(scheduledCells[0].seed)
        || bindings.HEPTA_EXPERIMENT_REPETITION !== String(scheduledCells[0].repetition)
        || bindings.HEPTA_HARNESS_CELL_ID !== scheduledCells[0].cellId
        || bindings.HEPTA_SEED !== String(scheduledCells[0].seed)
        || bindings.PYTHONHASHSEED !== String(scheduledCells[0].seed)))
      || bindings.HEPTA_EXPERIMENT_ARM !== arm
      || bindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_ID !== protocol?.protocolId
      || bindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH !== protocol?.systemBenchmarkArmProtocolHash
      || bindings.HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH !== receipt.systemBenchmarkArmProtocolSetHash
      || bindings.HEPTA_EXPERIMENT_ARM_ADAPTER_PATH !== expectedAdapter?.relativePath
      || bindings.HEPTA_EXPERIMENT_ARM_ADAPTER_HASH !== expectedAdapter?.sourceHash
      || bindings.HEPTA_EXPERIMENT_ARM_ADAPTER_SET_HASH !== receipt.systemBenchmarkArmAdapterSetHash
      || bindings.HEPTA_PRE_DATA_ACCESS_FREEZE_HASH !== receipt.empiricalPreDataAccessFreezeHash
      || bindings.HEPTA_BENCHMARK_ID !== receipt.benchmarkId
      || bindings.HEPTA_BENCHMARK_SELECTOR_HASH !== receipt.campaignBenchmarkSelectorHash
      || bindings.HEPTA_EXPERIMENT_DESIGN_HASH !== receipt.experimentDesignHash
      || bindings.HEPTA_BENCHMARK_HARNESS_HASH !== receipt.benchmarkHarnessHash
      || bindings.HEPTA_DATASET_AUTHORIZATION_SET_HASH !== receipt.datasetAuthorizationSetHash) return false;
    const batchAuthorizations = buildDatasetAuthorizationSet(batchReceipt.runnerReceipt.datasetMounts || []);
    if (batchAuthorizations.datasetAuthorizationSetHash !== receipt.datasetAuthorizationSetHash
      || batchReceipt.runnerReceipt.datasetAuthorizationSetHash !== receipt.datasetAuthorizationSetHash) return false;
    if (receipt.datasetAuthorizations.length && (!verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt(
      batchReceipt.runnerReceipt.datasetAccessReceipt,
      batchReceipt.runnerReceipt,
    )
      || batchReceipt.runnerReceipt.datasetAccessReceipt.datasets.some((item) => item.readObserved !== true
        || item.hostOnlyHarnessMounted !== false || item.forbiddenReadObserved !== false))) return false;
    batchByHash.set(systemBenchmarkArmBatchExecutionReceiptHash, batchReceipt);
    runtimeIdentityHashes.push(batchReceipt.runnerReceipt.runtimeIdentityHash);
    sourceMerkleHashes.push(batchReceipt.runnerReceipt.workSourceMerkleHash);
    sourceManifestHashes.push(batchReceipt.runnerReceipt.workWorkspaceManifestHash);
    environmentBindingHashes.push(batchReceipt.runnerReceipt.environmentBindingHash);
    processIdentityHashes.push(batchReceipt.executionProcessIdentityHash);
    launcherPids.push(batchReceipt.runnerReceipt.executionProcessIdentity?.launcherPid);
    executionAttemptIds.push(batchReceipt.executionAttemptId);
    if (batchReceipt.runnerReceipt.datasetAccessSupervisorIdentityHash) {
      datasetAccessSupervisorIdentityHashes.push(batchReceipt.runnerReceipt.datasetAccessSupervisorIdentityHash);
    }
  }
  if (!verifySystemBenchmarkHarnessResourceBudget(receipt, {
    executionUnitCount: executionUnits.length,
    requireDistinctProcesses: datasetBacked,
    processIdentityHashes,
    launcherPids,
    executionAttemptIds,
    environmentBindingHashes,
  })) return false;
  const expectedById = new Map(expected.map((cell) => [cell.cellId, cell]));
  const observedIds = new Set();
  for (const [index, cellReceipt] of (receipt.cells || []).entries()) {
    const cell = expectedById.get(cellReceipt.cellId);
    if (!cell || expected[index]?.cellId !== cell.cellId || observedIds.has(cell.cellId)
      || Object.hasOwn(cellReceipt, 'runnerReceipt') || Object.hasOwn(cellReceipt, 'runnerReceiptHash')
      || !SHA256.test(String(cellReceipt.armBatchExecutionReceiptHash || ''))) return false;
    observedIds.add(cell.cellId);
    if (cellReceipt.seed !== cell.seed || cellReceipt.repetition !== cell.repetition || cellReceipt.arm !== cell.arm) return false;
    const batchReceipt = batchByHash.get(cellReceipt.armBatchExecutionReceiptHash);
    if (!batchReceipt || batchReceipt.arm !== cell.arm || !batchReceipt.cellIds.includes(cell.cellId)) return false;
    let fixture = null;
    if (!datasetBacked) {
      try { fixture = buildSystemBenchmarkCellChallenge({ protocol: cell.armProtocol, seed: cell.seed, repetition: cell.repetition }); }
      catch { return false; }
    }
    const boundBatchChallenge = decodeSystemBenchmarkArmBatchChallengeEnvironment(batchReceipt.runnerReceipt.executionBindings || {});
    const boundCellChallenge = boundBatchChallenge?.cells?.find((candidate) => candidate.cellId === cell.cellId)?.challenge || null;
    const expectedChallengeHash = datasetBacked
      ? boundCellChallenge?.systemBenchmarkCellChallengeHash : fixture?.challenge?.systemBenchmarkCellChallengeHash;
    const expectedOracleHash = datasetBacked ? cellReceipt.systemBenchmarkCellOracleHash : fixture?.oracle?.systemBenchmarkCellOracleHash;
    const expectedArmProtocolExecutionReceiptHash = hashRecord('SystemBenchmarkArmProtocolExecutionReceipt', {
      cellId: cell.cellId,
      systemBenchmarkArmProtocolHash: cell.systemBenchmarkArmProtocolHash,
      systemBenchmarkArmAdapterHash: cellReceipt.armAdapter?.sourceHash || null,
      armBatchExecutionReceiptHash: cellReceipt.armBatchExecutionReceiptHash,
      systemBenchmarkCellChallengeHash: expectedChallengeHash,
      systemBenchmarkCellOracleHash: expectedOracleHash,
      rawEventArtifactHash: cellReceipt.rawEventArtifactHash,
      rawEventCount: cellReceipt.rawEventCount,
      metrics: cellReceipt.metrics,
    });
    if (cellReceipt.systemBenchmarkArmProtocolHash !== cell.systemBenchmarkArmProtocolHash
      || !boundCellChallenge
      || cellReceipt.systemBenchmarkCellChallengeHash !== expectedChallengeHash
      || !SHA256.test(String(expectedOracleHash || ''))
      || !SHA256.test(String(cellReceipt.rawEventArtifactHash || ''))
      || !Number.isSafeInteger(cellReceipt.rawEventCount) || cellReceipt.rawEventCount < 2 || cellReceipt.rawEventCount > 64
      || cellReceipt.systemBenchmarkArmProtocolExecutionReceiptHash !== expectedArmProtocolExecutionReceiptHash) return false;
    const expectedAdapter = receipt.armAdapterSet.adapters.find((candidate) => candidate.arm === cell.arm);
    if (!expectedAdapter || hashRecord('SystemBenchmarkArmAdapterIdentityExpected', cellReceipt.armAdapter)
      !== hashRecord('SystemBenchmarkArmAdapterIdentityExpected', expectedAdapter)) return false;
    if (cellReceipt.metricComputation !== cell.armProtocol.evaluatorId
      || !finiteMetrics(cellReceipt.metrics, receipt.requiredMetrics)) return false;
  }
  if (!SHA256.test(String(receipt.runtimeIdentityHash || '')) || !SHA256.test(String(receipt.sourceMerkleHash || ''))
    || !SHA256.test(String(receipt.sourceWorkspaceManifestHash || '')) || !SHA256.test(String(receipt.environmentBindingHash || ''))
    || !verifyHarnessEnvironmentBomBinding(receipt)
    || runtimeIdentityHashes.some((value) => value !== receipt.runtimeIdentityHash)
    || sourceMerkleHashes.some((value) => value !== receipt.sourceMerkleHash)
    || sourceManifestHashes.some((value) => value !== receipt.sourceWorkspaceManifestHash)
    || new Set(datasetAccessSupervisorIdentityHashes).size > 1
    || (receipt.datasetAccessSupervisorIdentityHash || null) !== (datasetAccessSupervisorIdentityHashes[0] || null)
    || receipt.environmentBindingHash !== hashRecord('SystemBenchmarkHarnessEnvironmentBindings', environmentBindingHashes)) return false;
  if (!verifyEmpiricalPreDataAccessFreeze(receipt.preDataAccessFreeze)
    || receipt.empiricalPreDataAccessFreezeHash !== receipt.preDataAccessFreeze.empiricalPreDataAccessFreezeHash
    || receipt.preDataAccessFreeze.experimentAttemptId !== receipt.experimentAttemptId
    || receipt.preDataAccessFreeze.campaignBenchmarkSelectorHash !== receipt.campaignBenchmarkSelectorHash
    || receipt.preDataAccessFreeze.experimentDesignHash !== receipt.experimentDesignHash
    || receipt.preDataAccessFreeze.analysisProtocolHash !== receipt.analysisProtocolHash
    || receipt.preDataAccessFreeze.systemBenchmarkArmProtocolSetHash !== receipt.systemBenchmarkArmProtocolSetHash
    || receipt.preDataAccessFreeze.systemBenchmarkArmAdapterSetHash !== receipt.systemBenchmarkArmAdapterSetHash
    || receipt.preDataAccessFreeze.sourceMerkleHash !== receipt.sourceMerkleHash
    || receipt.preDataAccessFreeze.sourceWorkspaceManifestHash !== receipt.sourceWorkspaceManifestHash
    || receipt.preDataAccessFreeze.sourceLineageHash !== receipt.sourceLineageHash) return false;
  const observations = receipt.cells.map((cell) => ({ seed: cell.seed, repetition: cell.repetition, arm: cell.arm, metrics: cell.metrics }));
  const rawEventManifest = receipt.cells.map((cell) => ({
    cellId: cell.cellId,
    rawEventArtifactHash: cell.rawEventArtifactHash,
    rawEventCount: cell.rawEventCount,
    systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
    systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
  }));
  if (receipt.rawEventManifestHash !== hashRecord('SystemBenchmarkRawEventManifest', rawEventManifest)
    || !SHA256.test(String(receipt.rawEventArtifactHash || ''))
    || !Number.isSafeInteger(receipt.rawEventArtifactBytes) || receipt.rawEventArtifactBytes < 1 || receipt.rawEventArtifactBytes > 16 * 1024 * 1024
    || hashRecord('SystemBenchmarkRawEventArtifactDescriptorExpected', receipt.rawEventArtifact) !== hashRecord('SystemBenchmarkRawEventArtifactDescriptorExpected', {
      relativePath: 'raw-events.ndjson', role: 'system-benchmark-raw-primitives-v2', sha256: receipt.rawEventArtifactHash,
      bytes: receipt.rawEventArtifactBytes, manifestHash: receipt.rawEventManifestHash,
    })) return false;
  const statisticalEvaluation = evaluateSystemBenchmarkStatisticalPolicy({ observations, experimentDesign: selector.expected.experimentDesign });
  if (!verifySystemBenchmarkStatisticalCompatibilityEvidence(receipt.statisticalEvaluation)
    || hashRecord('SystemBenchmarkStatisticalEvaluationExpected', statisticalEvaluation)
      !== hashRecord('SystemBenchmarkStatisticalEvaluationExpected', receipt.statisticalEvaluation)) return false;
  const expectedResultDocument = {
    version: 4, kind: 'SystemBenchmarkRunObservations',
    executionStatus: 'system_benchmark_execution_completed',
    integrityStatus: 'system_benchmark_integrity_verified',
    scientificVerdict: receipt.analysisProtocolEvaluation.scientificVerdict,
    scientificFindings: receipt.analysisProtocolEvaluation.scientificFindings,
    preDataAccessFreeze: receipt.preDataAccessFreeze,
    empiricalPreDataAccessFreezeHash: receipt.empiricalPreDataAccessFreezeHash,
    experimentDesignHash: selector.expected.experimentDesignHash,
    benchmarkHarnessHash: selector.expected.experimentDesign.benchmarkHarnessHash,
    armProtocolSet: selector.expected.experimentDesign.benchmarkHarness.armProtocolSet,
    systemBenchmarkArmProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
    armAdapterSet: receipt.armAdapterSet,
    systemBenchmarkArmAdapterSetHash: receipt.systemBenchmarkArmAdapterSetHash,
    systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
    datasetAuthorizationSetHash: authorizationSet.datasetAuthorizationSetHash,
    operatorDatasetHarnessAuthority,
    assuranceScope: selector.expected.assuranceScope,
    academicPromotionEligible: selector.expected.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
    rawEventManifestHash: receipt.rawEventManifestHash,
    rawEventArtifactHash: receipt.rawEventArtifactHash,
    rawEventArtifactBytes: receipt.rawEventArtifactBytes,
    rawEventArtifact: receipt.rawEventArtifact,
    rawEventRecomputationManifest: receipt.rawEventRecomputationManifest,
    statisticalEvaluation,
    ...analysisProtocolResultDocumentFields(receipt),
    observations,
  };
  const csvHeader = ['seed', 'repetition', 'arm', ...receipt.requiredMetrics];
  const expectedCsvDocument = `${[csvHeader.join(','), ...observations.map((item) => [item.seed, item.repetition, item.arm, ...receipt.requiredMetrics.map((metric) => item.metrics[metric])].join(','))].join('\n')}\n`;
  const expectedJsonDocument = `${JSON.stringify(expectedResultDocument, null, 2)}\n`;
  const expectedArtifacts = [
    { path: 'results.json', sha256: hashBytes(expectedJsonDocument), bytes: utf8Bytes(expectedJsonDocument) },
    { path: 'results.csv', sha256: hashBytes(expectedCsvDocument), bytes: utf8Bytes(expectedCsvDocument) },
    { path: 'raw-events.ndjson', sha256: receipt.rawEventArtifactHash, bytes: receipt.rawEventArtifactBytes },
  ];
  return receipt.status === 'system_benchmark_harness_verified'
    && receipt.executionStatus === 'system_benchmark_execution_completed'
    && receipt.integrityStatus === 'system_benchmark_integrity_verified'
    && receipt.scientificVerdict === receipt.analysisProtocolEvaluation.scientificVerdict
    && JSON.stringify(receipt.scientificFindings) === JSON.stringify(receipt.analysisProtocolEvaluation.scientificFindings)
    && Array.isArray(receipt.blockers) && receipt.blockers.length === 0
    && receipt.scheduleCellCount === expected.length
    && receipt.observationManifestHash === hashRecord('ExperimentObservationManifest', observations)
    && JSON.stringify(receipt.resultDocument) === JSON.stringify(expectedResultDocument)
    && receipt.csvDocument === expectedCsvDocument
    && receipt.resultJsonHash === expectedArtifacts[0].sha256 && receipt.resultCsvHash === expectedArtifacts[1].sha256
    && JSON.stringify(receipt.artifacts) === JSON.stringify(expectedArtifacts)
    && SHA256.test(String(receipt.sourceLineageHash || ''))
    && verifyHarnessAnalysisProtocolBinding(receipt, selector.expected.experimentDesign)
    && hashRecord('SystemBenchmarkHarnessExecutionReceipt', payload) === systemBenchmarkHarnessExecutionReceiptHash;
}

export function buildExperimentRunReceipt({
  resultDocument,
  csvDocument,
  benchmarkSelector,
  datasetMounts = [],
  executionReceiptHash = null,
  runtimeIdentityHash = null,
  sourceMerkleHash = null,
  sourceWorkspaceManifestHash = null,
  cacheHit = false,
  datasetConsumptionContractReceiptHash = null,
  resultJsonHash = null,
  resultCsvHash = null,
  runnerReceipt = null,
  experimentAttemptId = null,
  harnessExecutionReceipt = null,
  sourceLineageHash = null,
  rawArtifactWriteReceipt = null,
} = {}) {
  const blockers = [];
  const selectorVerification = verifyCampaignBenchmarkSelector(benchmarkSelector, {
    benchmarkId: benchmarkSelector?.benchmarkId,
    datasetMounts,
  });
  if (!selectorVerification.valid) blockers.push(...selectorVerification.blockers);
  const design = selectorVerification.expected?.experimentDesign || benchmarkSelector?.experimentDesign || null;
  const requiredMetrics = [...new Set((design?.requiredMetrics || []).map(String))].sort();
  if (!requiredMetrics.length) blockers.push('experiment_run_required_metrics_missing');
  const datasetAuthorizationSet = buildDatasetAuthorizationSet(datasetMounts);
  let document = null;
  try { document = typeof resultDocument === 'string' ? JSON.parse(resultDocument) : resultDocument; } catch { blockers.push('empirical_results_json_invalid'); }
  if (!document || typeof document !== 'object') blockers.push('empirical_results_json_invalid');
  if (document?.experimentDesignHash !== design?.experimentDesignHash) blockers.push('empirical_experiment_design_not_executed');
  if (document?.benchmarkHarnessHash !== design?.benchmarkHarnessHash) blockers.push('empirical_benchmark_harness_not_executed');
  if (document?.datasetAuthorizationSetHash !== datasetAuthorizationSet.datasetAuthorizationSetHash) blockers.push('empirical_dataset_authorization_not_bound');
  if (!SHA256.test(String(executionReceiptHash || ''))) blockers.push('experiment_run_execution_receipt_missing');
  if (!SHA256.test(String(runtimeIdentityHash || ''))) blockers.push('experiment_run_runtime_identity_missing');
  if (!SHA256.test(String(sourceMerkleHash || ''))) blockers.push('experiment_run_source_merkle_hash_missing');
  if (!SHA256.test(String(sourceWorkspaceManifestHash || ''))) blockers.push('experiment_run_source_manifest_hash_missing');
  if (!SHA256.test(String(sourceLineageHash || ''))) blockers.push('experiment_run_source_lineage_hash_missing');
  if (!SHA256.test(String(resultJsonHash || '')) || !SHA256.test(String(resultCsvHash || ''))) blockers.push('experiment_run_result_artifact_hash_missing');
  if (cacheHit) blockers.push('experiment_run_cache_hit_not_independent');
  if (!harnessExecutionReceipt) blockers.push('experiment_run_system_harness_required');
  if (harnessExecutionReceipt) {
    if (!verifySystemBenchmarkHarnessExecutionReceipt(harnessExecutionReceipt)
      || harnessExecutionReceipt.systemBenchmarkHarnessExecutionReceiptHash !== executionReceiptHash) blockers.push('experiment_run_system_harness_receipt_invalid');
    if (harnessExecutionReceipt.experimentAttemptId !== experimentAttemptId
      || harnessExecutionReceipt.sourceLineageHash !== sourceLineageHash) blockers.push('experiment_run_harness_lineage_invalid');
    if (harnessExecutionReceipt.runtimeIdentityHash !== runtimeIdentityHash
      || harnessExecutionReceipt.sourceMerkleHash !== sourceMerkleHash
      || harnessExecutionReceipt.sourceWorkspaceManifestHash !== sourceWorkspaceManifestHash) blockers.push('experiment_run_harness_runtime_identity_invalid');
    if (harnessExecutionReceipt.resultJsonHash !== resultJsonHash
      || harnessExecutionReceipt.resultCsvHash !== resultCsvHash) blockers.push('experiment_run_harness_artifact_binding_invalid');
    if (document?.rawEventManifestHash !== harnessExecutionReceipt.rawEventManifestHash
      || document?.rawEventArtifactHash !== harnessExecutionReceipt.rawEventArtifactHash
      || document?.rawEventArtifactBytes !== harnessExecutionReceipt.rawEventArtifactBytes
      || hashRecord('SystemBenchmarkRawEventArtifactDescriptorExpected', document?.rawEventArtifact)
        !== hashRecord('SystemBenchmarkRawEventArtifactDescriptorExpected', harnessExecutionReceipt.rawEventArtifact)) blockers.push('experiment_run_raw_event_artifact_binding_invalid');
  } else {
    if (!verifyOsSandboxWorkerReceipt(runnerReceipt) || runnerReceipt?.receiptHash !== executionReceiptHash) blockers.push('experiment_run_runner_receipt_invalid');
    if (!experimentAttemptId || runnerReceipt?.executionBindings?.HEPTA_EXPERIMENT_ATTEMPT_ID !== experimentAttemptId) blockers.push('experiment_run_attempt_identity_invalid');
    if (runnerReceipt?.executionBindings?.HEPTA_BENCHMARK_SELECTOR_HASH !== benchmarkSelector?.campaignBenchmarkSelectorHash
      || runnerReceipt?.executionBindings?.HEPTA_EXPERIMENT_DESIGN_HASH !== design?.experimentDesignHash
      || runnerReceipt?.executionBindings?.HEPTA_BENCHMARK_HARNESS_HASH !== design?.benchmarkHarnessHash
      || runnerReceipt?.executionBindings?.HEPTA_DATASET_AUTHORIZATION_SET_HASH !== datasetAuthorizationSet.datasetAuthorizationSetHash) blockers.push('experiment_run_runner_design_binding_invalid');
    const runnerArtifacts = new Map((runnerReceipt?.artifacts || []).map((artifact) => [artifact.path, artifact.sha256]));
    if (runnerArtifacts.get('results.json') !== resultJsonHash || runnerArtifacts.get('results.csv') !== resultCsvHash) blockers.push('experiment_run_runner_artifact_binding_invalid');
    if (datasetMounts.length && (runnerReceipt?.datasetAccessReceipt?.status !== 'dataset_runtime_access_verified'
      || runnerReceipt.datasetAccessReceipt.datasets.some((item) => item.readObserved !== true))) blockers.push('experiment_run_dataset_runtime_access_unverified');
  }
  if (!verifyExperimentRawArtifactWriteReceipt(rawArtifactWriteReceipt, {
    contentHash: harnessExecutionReceipt?.rawEventArtifactHash,
    bytes: harnessExecutionReceipt?.rawEventArtifactBytes,
  })) blockers.push('experiment_run_raw_artifact_write_receipt_invalid');
  const environmentBomBinding = buildExperimentRunEnvironmentBomBinding({ harnessExecutionReceipt, runnerReceipt });
  blockers.push(...environmentBomBinding.blockers);

  const observations = [];
  const seen = new Set();
  for (const [index, value] of (Array.isArray(document?.observations) ? document.observations : []).entries()) {
    const observation = canonicalObservation(value, requiredMetrics);
    if (!observation) { blockers.push(`experiment_observation_invalid:${index}`); continue; }
    const key = observationKey(observation);
    if (seen.has(key)) blockers.push(`experiment_observation_duplicate:${key.replaceAll('\0', ':')}`);
    else { seen.add(key); observations.push(observation); }
  }
  if (!observations.length) blockers.push('experiment_raw_observations_missing');
  const seeds = (design?.seedSchedule || []).map(Number);
  const repetitions = Number(design?.minimumRepetitions || 0);
  for (const seed of seeds) for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const arm of REQUIRED_ARMS) {
      const key = `${seed}\0${repetition}\0${arm}`;
      if (!seen.has(key)) blockers.push(`experiment_observation_schedule_missing:${seed}:${repetition}:${arm}`);
    }
  }
  if (observations.some((item) => !seeds.includes(item.seed) || item.repetition > repetitions)) blockers.push('experiment_observation_outside_schedule');

  let csvObservations = [];
  try {
    const rows = parseExperimentObservationCsv(csvDocument);
    csvObservations = rows.map((row, index) => {
      const observation = csvObservation(row, requiredMetrics);
      if (!observation) throw new Error(`empirical_results_csv_observation_invalid:${index + 2}`);
      return observation;
    });
  } catch (error) { blockers.push(String(error?.message || 'empirical_results_csv_invalid')); }
  const observationManifestHash = hashRecord('ExperimentObservationManifest', observations);
  const csvObservationManifestHash = hashRecord('ExperimentObservationManifest', csvObservations);
  if (observationManifestHash !== csvObservationManifestHash) blockers.push('experiment_json_csv_observations_mismatch');

  const aggregateMetrics = observations.length && requiredMetrics.length
    ? aggregateObservations(observations, requiredMetrics)
    : {};
  const statisticalEvaluation = evaluateSystemBenchmarkStatisticalPolicy({ observations, experimentDesign: design });
  if (hashRecord('SystemBenchmarkStatisticalEvaluationExpected', document?.statisticalEvaluation)
    !== hashRecord('SystemBenchmarkStatisticalEvaluationExpected', statisticalEvaluation)) blockers.push('experiment_statistical_evaluation_binding_invalid');
  const analysisBinding = buildExperimentRunAnalysisProtocolBinding({ harnessExecutionReceipt, design, resultDocument: document });
  blockers.push(...analysisBinding.blockers);
  const payload = {
    version: 1,
    kind: 'ExperimentRunReceipt',
    assuranceProfile: harnessExecutionReceipt ? 'system-orchestrated-cells-plus-immutable-raw-primitives-v4' : 'campaign-raw-observations-v1',
    status: blockers.length ? 'experiment_run_receipt_blocked' : 'experiment_run_receipt_verified',
    executionStatus: harnessExecutionReceipt?.executionStatus || (blockers.length
      ? 'experiment_execution_failed' : 'experiment_execution_completed'),
    integrityStatus: blockers.length ? 'experiment_integrity_blocked' : 'experiment_integrity_verified',
    scientificVerdict: blockers.length ? 'not_evaluable'
      : harnessExecutionReceipt?.scientificVerdict || 'not_evaluable',
    scientificFindings: blockers.length ? [] : harnessExecutionReceipt?.scientificFindings || [],
    preDataAccessFreeze: harnessExecutionReceipt?.preDataAccessFreeze || null,
    empiricalPreDataAccessFreezeHash: harnessExecutionReceipt?.empiricalPreDataAccessFreezeHash || null,
    benchmarkId: benchmarkSelector?.benchmarkId || null,
    campaignBenchmarkSelectorHash: benchmarkSelector?.campaignBenchmarkSelectorHash || null,
    experimentDesignHash: design?.experimentDesignHash || null,
    benchmarkHarnessHash: design?.benchmarkHarnessHash || null,
    assuranceScope: benchmarkSelector?.assuranceScope || null,
    academicPromotionEligible: benchmarkSelector?.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
    evidenceClass: benchmarkSelector?.assuranceScope === 'operator-authorized-hidden-evaluation-v1'
      ? 'academic-experiment-evidence' : 'software-conformance-evidence',
    promotionScope: benchmarkSelector?.assuranceScope === 'operator-authorized-hidden-evaluation-v1'
      ? 'academic-research-promotion' : 'software-conformance-only',
    systemBenchmarkHarnessImplementationHash: design?.benchmarkHarness?.systemBenchmarkHarnessImplementationHash || null,
    datasetAuthorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
    datasetAuthorizations: datasetAuthorizationSet.datasets,
    executionReceiptHash,
    runtimeIdentityHash,
    datasetAccessSupervisorIdentityHash: harnessExecutionReceipt?.datasetAccessSupervisorIdentityHash
      || runnerReceipt?.datasetAccessSupervisorIdentityHash || null,
    sourceMerkleHash,
    sourceWorkspaceManifestHash,
    ...environmentBomBinding.fields,
    datasetConsumptionContractReceiptHash,
    resultJsonHash,
    resultCsvHash,
    rawEventManifestHash: harnessExecutionReceipt?.rawEventManifestHash || null,
    rawEventArtifactHash: harnessExecutionReceipt?.rawEventArtifactHash || null,
    rawEventArtifactBytes: harnessExecutionReceipt?.rawEventArtifactBytes || null,
    rawEventArtifact: harnessExecutionReceipt?.rawEventArtifact || null,
    rawArtifactWriteReceipt,
    cacheHit: Boolean(cacheHit),
    experimentAttemptId,
    sourceLineageHash,
    benchmarkSelector,
    runnerReceipt,
    harnessExecutionReceipt,
    rawObservationCount: observations.length,
    observations,
    observationManifestHash,
    csvObservationManifestHash,
    aggregateMetrics,
    statisticalEvaluation,
    ...analysisBinding.fields,
    requiredMetrics,
    seedSchedule: seeds,
    minimumRepetitions: repetitions,
    arms: REQUIRED_ARMS,
    blockers: [...new Set(blockers)].slice(0, 2048),
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, experimentRunReceiptHash: hashRecord('ExperimentRunReceipt', payload) });
}

export function verifyExperimentRunReceipt(receipt) {
  if (!receipt || receipt.kind !== 'ExperimentRunReceipt' || receipt.version !== 1) return false;
  const { experimentRunReceiptHash, ...payload } = receipt;
  const selectorVerification = verifyCampaignBenchmarkSelector(receipt.benchmarkSelector, {
    benchmarkId: receipt.benchmarkId,
    datasetMounts: receipt.datasetAuthorizations,
  });
  const recomputedObservationHash = hashRecord('ExperimentObservationManifest', receipt.observations || []);
  const recomputedAggregates = aggregateObservations(receipt.observations || [], receipt.requiredMetrics || []);
  const recomputedAuthorizationSet = buildDatasetAuthorizationSet(receipt.datasetAuthorizations || []);
  const design = selectorVerification.expected?.experimentDesign || null;
  const recomputedStatisticalEvaluation = evaluateSystemBenchmarkStatisticalPolicy({ observations: receipt.observations || [], experimentDesign: design });
  const expectedSchedule = new Set();
  for (const seed of design?.seedSchedule || []) for (let repetition = 1; repetition <= Number(design?.minimumRepetitions || 0); repetition += 1) {
    for (const arm of REQUIRED_ARMS) expectedSchedule.add(`${seed}\0${repetition}\0${arm}`);
  }
  const observedSchedule = new Set();
  const observationsValid = Array.isArray(receipt.observations)
    && receipt.observations.every((item) => {
      const canonical = canonicalObservation(item, receipt.requiredMetrics || []);
      if (!canonical) return false;
      const key = observationKey(canonical);
      if (observedSchedule.has(key)) return false;
      observedSchedule.add(key);
      return expectedSchedule.has(key);
    });
  const scheduleComplete = observationsValid
    && observedSchedule.size === expectedSchedule.size
    && [...expectedSchedule].every((key) => observedSchedule.has(key));
  const systemHarnessVerified = receipt.harnessExecutionReceipt
    ? verifySystemBenchmarkHarnessExecutionReceipt(receipt.harnessExecutionReceipt)
    : false;
  const runnerArtifacts = new Map((receipt.runnerReceipt?.artifacts || []).map((artifact) => [artifact.path, artifact.sha256]));
  return receipt.status === 'experiment_run_receipt_verified'
    && receipt.executionStatus === 'system_benchmark_execution_completed'
    && receipt.integrityStatus === 'experiment_integrity_verified'
    && receipt.scientificVerdict === receipt.analysisProtocolEvaluation?.scientificVerdict
    && JSON.stringify(receipt.scientificFindings) === JSON.stringify(receipt.analysisProtocolEvaluation?.scientificFindings)
    && verifyEmpiricalPreDataAccessFreeze(receipt.preDataAccessFreeze)
    && receipt.empiricalPreDataAccessFreezeHash === receipt.preDataAccessFreeze.empiricalPreDataAccessFreezeHash
    && Array.isArray(receipt.blockers) && receipt.blockers.length === 0
    && SHA256.test(String(receipt.executionReceiptHash || ''))
    && SHA256.test(String(receipt.runtimeIdentityHash || ''))
    && SHA256.test(String(receipt.sourceMerkleHash || ''))
    && SHA256.test(String(receipt.sourceWorkspaceManifestHash || ''))
    && SHA256.test(String(receipt.sourceLineageHash || ''))
    && verifyExperimentRunEnvironmentBomBinding(receipt)
    && selectorVerification.valid
    && Boolean(receipt.harnessExecutionReceipt)
    && receipt.experimentDesignHash === design?.experimentDesignHash
    && receipt.benchmarkHarnessHash === design?.benchmarkHarnessHash
    && receipt.assuranceScope === selectorVerification.expected?.assuranceScope
    && receipt.academicPromotionEligible === (receipt.assuranceScope === 'operator-authorized-hidden-evaluation-v1')
    && receipt.evidenceClass === (receipt.academicPromotionEligible ? 'academic-experiment-evidence' : 'software-conformance-evidence')
    && receipt.promotionScope === (receipt.academicPromotionEligible ? 'academic-research-promotion' : 'software-conformance-only')
    && verifyExperimentRawArtifactWriteReceipt(receipt.rawArtifactWriteReceipt, {
      contentHash: receipt.rawEventArtifactHash,
      bytes: receipt.rawEventArtifactBytes,
    })
    && receipt.systemBenchmarkHarnessImplementationHash === SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash
    && receipt.systemBenchmarkHarnessImplementationHash === design?.benchmarkHarness?.systemBenchmarkHarnessImplementationHash
    && (receipt.harnessExecutionReceipt ? (
      systemHarnessVerified
      && receipt.assuranceProfile === 'system-orchestrated-cells-plus-immutable-raw-primitives-v4'
      && receipt.harnessExecutionReceipt.systemBenchmarkHarnessExecutionReceiptHash === receipt.executionReceiptHash
      && receipt.harnessExecutionReceipt.experimentAttemptId === receipt.experimentAttemptId
      && receipt.harnessExecutionReceipt.sourceLineageHash === receipt.sourceLineageHash
      && receipt.harnessExecutionReceipt.runtimeIdentityHash === receipt.runtimeIdentityHash
      && (receipt.harnessExecutionReceipt.datasetAccessSupervisorIdentityHash || null)
        === (receipt.datasetAccessSupervisorIdentityHash || null)
      && receipt.harnessExecutionReceipt.sourceMerkleHash === receipt.sourceMerkleHash
      && receipt.harnessExecutionReceipt.sourceWorkspaceManifestHash === receipt.sourceWorkspaceManifestHash
      && receipt.harnessExecutionReceipt.resultJsonHash === receipt.resultJsonHash
      && receipt.harnessExecutionReceipt.resultCsvHash === receipt.resultCsvHash
      && receipt.harnessExecutionReceipt.rawEventManifestHash === receipt.rawEventManifestHash
      && receipt.harnessExecutionReceipt.rawEventArtifactHash === receipt.rawEventArtifactHash
      && receipt.harnessExecutionReceipt.rawEventArtifactBytes === receipt.rawEventArtifactBytes
      && hashRecord('SystemBenchmarkRawEventArtifactDescriptorExpected', receipt.harnessExecutionReceipt.rawEventArtifact)
        === hashRecord('SystemBenchmarkRawEventArtifactDescriptorExpected', receipt.rawEventArtifact)
    ) : (
      verifyOsSandboxWorkerReceipt(receipt.runnerReceipt)
      && receipt.runnerReceipt.receiptHash === receipt.executionReceiptHash
      && receipt.runnerReceipt.executionBindings?.HEPTA_EXPERIMENT_ATTEMPT_ID === receipt.experimentAttemptId
      && receipt.runnerReceipt.executionBindings?.HEPTA_BENCHMARK_SELECTOR_HASH === receipt.campaignBenchmarkSelectorHash
      && receipt.runnerReceipt.executionBindings?.HEPTA_EXPERIMENT_DESIGN_HASH === receipt.experimentDesignHash
      && receipt.runnerReceipt.executionBindings?.HEPTA_BENCHMARK_HARNESS_HASH === receipt.benchmarkHarnessHash
      && receipt.runnerReceipt.executionBindings?.HEPTA_DATASET_AUTHORIZATION_SET_HASH === receipt.datasetAuthorizationSetHash
      && runnerArtifacts.get('results.json') === receipt.resultJsonHash
      && runnerArtifacts.get('results.csv') === receipt.resultCsvHash
    ))
    && scheduleComplete
    && recomputedObservationHash === receipt.observationManifestHash
    && receipt.csvObservationManifestHash === receipt.observationManifestHash
    && JSON.stringify(recomputedAggregates) === JSON.stringify(receipt.aggregateMetrics)
    && verifySystemBenchmarkStatisticalCompatibilityEvidence(receipt.statisticalEvaluation)
    && hashRecord('SystemBenchmarkStatisticalEvaluationExpected', recomputedStatisticalEvaluation)
      === hashRecord('SystemBenchmarkStatisticalEvaluationExpected', receipt.statisticalEvaluation)
    && verifyExperimentRunAnalysisProtocolBinding(receipt, design)
    && recomputedAuthorizationSet.datasetAuthorizationSetHash === receipt.datasetAuthorizationSetHash
    && receipt.rawObservationCount === (receipt.observations || []).length
    && hashRecord('ExperimentRunReceipt', payload) === experimentRunReceiptHash;
}

export function buildExperimentReplayReceipt({ originalRunReceipt, replayRunReceipt, absoluteTolerance = 1e-9, relativeTolerance = 1e-6 } = {}) {
  const blockers = [];
  if (!verifyExperimentRunReceipt(originalRunReceipt)) blockers.push('experiment_original_run_receipt_invalid');
  if (!verifyExperimentRunReceipt(replayRunReceipt)) blockers.push('experiment_replay_run_receipt_invalid');
  for (const field of ['campaignBenchmarkSelectorHash', 'experimentDesignHash', 'benchmarkHarnessHash', 'systemBenchmarkHarnessImplementationHash', 'datasetAuthorizationSetHash', 'datasetAccessSupervisorIdentityHash', 'sourceMerkleHash', 'sourceWorkspaceManifestHash', 'sourceLineageHash', 'assuranceProfile', 'assuranceScope', 'evidenceClass', 'promotionScope', 'academicPromotionEligible']) {
    if (originalRunReceipt?.[field] !== replayRunReceipt?.[field]) blockers.push(`experiment_replay_identity_mismatch:${field}`);
  }
  if (originalRunReceipt?.executionReceiptHash === replayRunReceipt?.executionReceiptHash
    || originalRunReceipt?.experimentAttemptId === replayRunReceipt?.experimentAttemptId
    || (originalRunReceipt?.harnessExecutionReceipt?.environmentBindingHash || originalRunReceipt?.runnerReceipt?.environmentBindingHash)
      === (replayRunReceipt?.harnessExecutionReceipt?.environmentBindingHash || replayRunReceipt?.runnerReceipt?.environmentBindingHash)) blockers.push('experiment_replay_execution_not_independent');
  if (originalRunReceipt?.rawEventManifestHash !== replayRunReceipt?.rawEventManifestHash
    || originalRunReceipt?.rawEventArtifactHash !== replayRunReceipt?.rawEventArtifactHash
    || originalRunReceipt?.rawEventArtifactBytes !== replayRunReceipt?.rawEventArtifactBytes) {
    blockers.push('experiment_replay_raw_event_artifact_mismatch');
  }
  if (!originalRunReceipt?.rawArtifactWriteReceipt || !replayRunReceipt?.rawArtifactWriteReceipt
    || originalRunReceipt.rawArtifactWriteReceipt.writeReceiptHash === replayRunReceipt.rawArtifactWriteReceipt.writeReceiptHash
    || originalRunReceipt.rawArtifactWriteReceipt.ledgerReceiptId === replayRunReceipt.rawArtifactWriteReceipt.ledgerReceiptId
    || originalRunReceipt.rawArtifactWriteReceipt.role === replayRunReceipt.rawArtifactWriteReceipt.role) {
    blockers.push('experiment_replay_raw_artifact_authority_not_independent');
  }
  const analysisProtocolReplayBinding = buildExperimentReplayAnalysisProtocolBinding({ originalRunReceipt, replayRunReceipt });
  blockers.push(...analysisProtocolReplayBinding.blockers);
  const comparisons = [];
  const replayObservations = new Map((replayRunReceipt?.observations || []).map((item) => [observationKey(item), item]));
  for (const original of originalRunReceipt?.observations || []) for (const metric of originalRunReceipt?.requiredMetrics || []) {
    const replay = replayObservations.get(observationKey(original));
    const expected = Number(original.metrics?.[metric]);
    const observed = Number(replay?.metrics?.[metric]);
    const delta = Math.abs(expected - observed);
    const allowed = Math.max(Number(absoluteTolerance), Number(relativeTolerance) * Math.max(Math.abs(expected), Math.abs(observed)));
    const consistent = Number.isFinite(expected) && Number.isFinite(observed) && delta <= allowed;
    comparisons.push({ seed: original.seed, repetition: original.repetition, arm: original.arm, metric, expected, observed, delta, allowed, consistent });
    if (!consistent) blockers.push(`experiment_replay_observation_inconsistent:${original.seed}:${original.repetition}:${original.arm}:${metric}`);
  }
  const payload = {
    version: 1,
    kind: 'ExperimentReplayReceipt',
    status: blockers.length ? 'experiment_replay_blocked' : 'experiment_replay_verified',
    originalExperimentRunReceiptHash: originalRunReceipt?.experimentRunReceiptHash || null,
    replayExperimentRunReceiptHash: replayRunReceipt?.experimentRunReceiptHash || null,
    originalRunReceipt,
    replayRunReceipt,
    originalExecutionReceiptHash: originalRunReceipt?.executionReceiptHash || null,
    replayExecutionReceiptHash: replayRunReceipt?.executionReceiptHash || null,
    ...experimentReplayEnvironmentBomFields(originalRunReceipt, replayRunReceipt),
    absoluteTolerance: Number(absoluteTolerance),
    relativeTolerance: Number(relativeTolerance),
    comparisons,
    analysisProtocolReplayBinding,
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, experimentReplayReceiptHash: hashRecord('ExperimentReplayReceipt', payload) });
}

export function verifyExperimentReplayReceipt(receipt) {
  if (!receipt || receipt.kind !== 'ExperimentReplayReceipt' || receipt.version !== 1) return false;
  const rebuilt = buildExperimentReplayReceipt({
    originalRunReceipt: receipt.originalRunReceipt,
    replayRunReceipt: receipt.replayRunReceipt,
    absoluteTolerance: receipt.absoluteTolerance,
    relativeTolerance: receipt.relativeTolerance,
  });
  return receipt.status === 'experiment_replay_verified'
    && verifyExperimentRunReceipt(receipt.originalRunReceipt)
    && verifyExperimentRunReceipt(receipt.replayRunReceipt)
    && receipt.originalExperimentRunReceiptHash === receipt.originalRunReceipt.experimentRunReceiptHash
    && receipt.replayExperimentRunReceiptHash === receipt.replayRunReceipt.experimentRunReceiptHash
    && receipt.originalRunReceipt.experimentAttemptId !== receipt.replayRunReceipt.experimentAttemptId
    && receipt.originalRunReceipt.executionReceiptHash !== receipt.replayRunReceipt.executionReceiptHash
    && verifyExperimentReplayEnvironmentBomBinding(receipt)
    && (receipt.originalRunReceipt.harnessExecutionReceipt?.environmentBindingHash || receipt.originalRunReceipt.runnerReceipt?.environmentBindingHash)
      !== (receipt.replayRunReceipt.harnessExecutionReceipt?.environmentBindingHash || receipt.replayRunReceipt.runnerReceipt?.environmentBindingHash)
    && verifyExperimentReplayAnalysisProtocolBinding(receipt)
    && rebuilt.status === 'experiment_replay_verified'
    && rebuilt.experimentReplayReceiptHash === receipt.experimentReplayReceiptHash;
}
