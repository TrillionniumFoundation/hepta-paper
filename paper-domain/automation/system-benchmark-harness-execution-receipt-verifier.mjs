import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyCampaignBenchmarkSelector } from './campaign-benchmark-selector.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from './system-benchmark-harness-identity.mjs';
import {
  evaluateSystemBenchmarkStatisticalPolicy,
  verifySystemBenchmarkArmAdapterSet,
  verifySystemBenchmarkArmProtocolSet,
  verifySystemBenchmarkStatisticalCompatibilityEvidence,
} from './system-benchmark-arm-protocol.mjs';
import {
  buildSystemBenchmarkArmBatchChallenge,
  buildSystemBenchmarkCellChallenge,
  decodeSystemBenchmarkArmBatchChallengeEnvironment,
} from './system-benchmark-challenge.mjs';
import {
  LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
  LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
  verifyOperatorDatasetHarnessAuthorityReceiptStructure,
} from './operator-dataset-harness-contract.mjs';
import {
  analysisProtocolResultDocumentFields,
  verifyHarnessAnalysisProtocolBinding,
} from './analysis-protocol-run-binding.mjs';
import { verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt } from './dataset-runtime-access-contract.mjs';
import { buildDatasetAuthorizationSet } from './experiment-run-artifact-contract.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from './os-sandbox-worker-receipt-contract.mjs';
import {
  buildCampaignBenchmarkSchedule,
  REQUIRED_SYSTEM_BENCHMARK_ARMS as REQUIRED_ARMS,
} from './system-benchmark-schedule.mjs';
import { verifyWorkerProcessExecutionIdentity } from './worker-process-execution-contract.mjs';
import { verifyHarnessEnvironmentBomBinding } from './experiment-environment-bom-binding.mjs';
import {
  verifySystemBenchmarkArmBatchResourceBudget,
  verifySystemBenchmarkHarnessResourceBudget,
} from './system-benchmark-resource-budget-contract.mjs';
import { verifyEmpiricalPreDataAccessFreeze } from './empirical-pre-data-access-freeze.mjs';
import { finiteExperimentMetrics as finiteMetrics } from './experiment-observation-contract.mjs';
import { verifyDatasetEvaluationDependencyReceipt } from './dataset-evaluation-dependency-contract.mjs';
import {
  inspectSystemBenchmarkExperimentIrBinding,
  verifiedHarnessReceiptHashes,
  verifiedReceiptPreflight,
} from './experiment-run-receipt-verification-helpers.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;

export function verifySystemBenchmarkHarnessExecutionReceipt(receipt) {
  if (!receipt || receipt.version !== 5 || receipt.kind !== 'SystemBenchmarkHarnessExecutionReceipt') return false;
  const preflight = verifiedReceiptPreflight(receipt, 'SystemBenchmarkHarnessExecutionReceipt', 'systemBenchmarkHarnessExecutionReceiptHash', verifiedHarnessReceiptHashes);
  if (!preflight || preflight.cached) return preflight?.cached === true;
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
  const experimentIrBinding = inspectSystemBenchmarkExperimentIrBinding(
    receipt,
    { operatorDatasetHarnessAuthority },
  );
  if (!experimentIrBinding.valid) return false;
  if (!Number.isSafeInteger(receipt.resultPersistenceCompletedAtEpochMs)
    || receipt.resultPersistenceCompletedAtEpochMs < 0
    || !Number.isSafeInteger(receipt.receiptFinalizedAtEpochMs)
    || receipt.receiptFinalizedAtEpochMs < receipt.resultPersistenceCompletedAtEpochMs
    || !Number.isSafeInteger(receipt.absoluteDeadlineEpochMs)
    || receipt.receiptFinalizedAtEpochMs >= receipt.absoluteDeadlineEpochMs) return false;
  const { researchResolved } = experimentIrBinding;
  const localGoldenAuthority = selector.expected.authorityScope
    === LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE;
  const localDatasetBatch = datasetBacked
    && receipt.executionIsolationMode === 'local-authorized-per-arm-batch-process-v1'
    && receipt.executionAssuranceProfile === 'local-bounded-hidden-evaluation-v1'
    && receipt.academicPromotionEligible === false
    && (!localGoldenAuthority || (
      receipt.evidenceClass === LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS
      && receipt.externalTrustClaimed === false
    ));
  const academicDatasetExecution = datasetBacked
    && !localGoldenAuthority && !localDatasetBatch;
  const executionIsolationMode = academicDatasetExecution
    ? 'academic-per-cell-process-v1'
    : (datasetBacked ? 'local-authorized-per-arm-batch-process-v1' : 'synthetic-per-arm-batch-process-v1');
  const expectedExecutionAssuranceProfile = academicDatasetExecution
    ? 'academic-per-cell-isolation-v1'
    : (datasetBacked ? 'local-bounded-hidden-evaluation-v1' : 'synthetic-conformance-v1');
  const executionUnits = academicDatasetExecution
    ? expected.map((cell) => [cell])
    : REQUIRED_ARMS.map((arm) => expected.filter((cell) => cell.arm === arm));
  if (receipt.executionIsolationMode !== executionIsolationMode
    || receipt.executionAssuranceProfile !== expectedExecutionAssuranceProfile
    || receipt.academicPromotionEligible !== (researchResolved && academicDatasetExecution
      && receipt.assuranceScope === 'operator-authorized-hidden-evaluation-v1')
    || (localGoldenAuthority && (
      receipt.evidenceClass !== LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS
      || receipt.externalTrustClaimed !== false
      || !localDatasetBatch
    ))
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
      try {
        fixture = buildSystemBenchmarkArmBatchChallenge({
          protocol,
          cells: scheduledCells,
          versionedExperimentIrHash: receipt.versionedExperimentIrHash,
        });
      }
      catch { return false; }
    }
    const boundChallenge = decodeSystemBenchmarkArmBatchChallengeEnvironment(batchReceipt?.runnerReceipt?.executionBindings || {});
    const expectedBatchChallengeHash = datasetBacked ? boundChallenge?.systemBenchmarkArmBatchChallengeHash : fixture?.challenge?.systemBenchmarkArmBatchChallengeHash;
    const executionAttemptId = academicDatasetExecution
      ? `${receipt.experimentAttemptId}:arm:${arm}:cell:${scheduledCells[0].cellId}`
      : `${receipt.experimentAttemptId}:arm:${arm}`;
    if (!batchReceipt || batchReceipt.version !== 2 || batchReceipt.kind !== 'SystemBenchmarkArmBatchExecutionReceipt'
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
      || batchReceipt.versionedExperimentIrHash !== receipt.versionedExperimentIrHash
      || boundChallenge.versionedExperimentIrHash !== receipt.versionedExperimentIrHash
      || !verifyProductionOsSandboxWorkerReceipt(batchReceipt.runnerReceipt)
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
      || (academicDatasetExecution && (bindings.HEPTA_EXPERIMENT_SEED !== String(scheduledCells[0].seed)
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
      || bindings.HEPTA_EXPERIMENT_IR_HASH !== receipt.versionedExperimentIrHash
      || (researchResolved && (
        bindings.HEPTA_EXPERIMENT_RESEARCH_BINDING_HASH
          !== receipt.experimentIr.researchBinding.experimentResearchBindingHash
        || bindings.HEPTA_DATASET_RESEARCH_COMPATIBILITY_HASH
          !== receipt.experimentIr.researchBinding.datasetResearchCompatibilityHash
      ))
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
    requireDistinctProcesses: academicDatasetExecution,
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
      try {
        fixture = buildSystemBenchmarkCellChallenge({
          protocol: cell.armProtocol,
          seed: cell.seed,
          repetition: cell.repetition,
        });
      }
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
      versionedExperimentIrHash: receipt.versionedExperimentIrHash,
    });
    if (cellReceipt.systemBenchmarkArmProtocolHash !== cell.systemBenchmarkArmProtocolHash
      || !boundCellChallenge
      || cellReceipt.systemBenchmarkCellChallengeHash !== expectedChallengeHash
      || !SHA256.test(String(expectedOracleHash || ''))
      || !SHA256.test(String(cellReceipt.rawEventArtifactHash || ''))
      || cellReceipt.versionedExperimentIrHash !== receipt.versionedExperimentIrHash
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
    || receipt.preDataAccessFreeze.versionedExperimentIrHash
      !== receipt.versionedExperimentIrHash
    || receipt.preDataAccessFreeze.systemBenchmarkArmProtocolSetHash !== receipt.systemBenchmarkArmProtocolSetHash
    || receipt.preDataAccessFreeze.systemBenchmarkArmAdapterSetHash !== receipt.systemBenchmarkArmAdapterSetHash
    || receipt.preDataAccessFreeze.sourceMerkleHash !== receipt.sourceMerkleHash
    || receipt.preDataAccessFreeze.sourceWorkspaceManifestHash !== receipt.sourceWorkspaceManifestHash
    || receipt.preDataAccessFreeze.sourceLineageHash !== receipt.sourceLineageHash
    || (researchResolved && (
      receipt.preDataAccessFreeze.version !== 3
      || receipt.preDataAccessFreeze.experimentResearchBindingHash
        !== receipt.experimentIr.researchBinding.experimentResearchBindingHash
      || receipt.preDataAccessFreeze.datasetResearchCompatibilityHash
        !== receipt.experimentIr.researchBinding.datasetResearchCompatibilityHash
    ))) return false;
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
  const workerDatasetPositiveByteReadObserved = datasetBacked
    && receipt.armBatchExecutions.every((batch) => authorizationSet.datasets.every((dataset) => {
      const access = batch.runnerReceipt?.datasetAccessReceipt?.datasets
        ?.find((candidate) => candidate.name === dataset.name);
      return access?.readObserved === true
        && Number.isSafeInteger(access.positiveReadBytesObserved)
        && access.positiveReadBytesObserved > 0;
    }));
  if (datasetBacked
    ? !verifyDatasetEvaluationDependencyReceipt(
      receipt.datasetEvaluationDependencyReceipt,
      {
        operatorDatasetHarnessAuthority,
        preDataAccessFreeze: receipt.preDataAccessFreeze,
        cells: receipt.cells,
        rawEventManifestHash: receipt.rawEventManifestHash,
        rawEventArtifactHash: receipt.rawEventArtifactHash,
        analysisObservationAuthority: receipt.analysisObservationAuthority,
        analysisProtocolEvaluation: receipt.analysisProtocolEvaluation,
        workerDatasetPositiveByteReadObserved,
      },
    )
    : receipt.datasetEvaluationDependencyReceipt !== null) return false;
  const expectedResultDocument = {
    version: 5, kind: 'SystemBenchmarkRunObservations',
    executionStatus: 'system_benchmark_execution_completed',
    integrityStatus: 'system_benchmark_integrity_verified',
    scientificVerdict: receipt.analysisProtocolEvaluation.scientificVerdict,
    scientificFindings: receipt.analysisProtocolEvaluation.scientificFindings,
    preDataAccessFreeze: receipt.preDataAccessFreeze,
    empiricalPreDataAccessFreezeHash: receipt.empiricalPreDataAccessFreezeHash,
    experimentIr: receipt.experimentIr,
    versionedExperimentIrHash: receipt.versionedExperimentIrHash,
    experimentDesignHash: selector.expected.experimentDesignHash,
    benchmarkHarnessHash: selector.expected.experimentDesign.benchmarkHarnessHash,
    armProtocolSet: selector.expected.experimentDesign.benchmarkHarness.armProtocolSet,
    systemBenchmarkArmProtocolSetHash: selector.expected.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
    armAdapterSet: receipt.armAdapterSet,
    systemBenchmarkArmAdapterSetHash: receipt.systemBenchmarkArmAdapterSetHash,
    systemBenchmarkHarnessImplementationHash: SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
    datasetAuthorizationSetHash: authorizationSet.datasetAuthorizationSetHash,
    operatorDatasetHarnessAuthority,
    datasetEvaluationDependencyReceipt: receipt.datasetEvaluationDependencyReceipt,
    assuranceScope: selector.expected.assuranceScope,
    executionAssuranceProfile: expectedExecutionAssuranceProfile,
    academicPromotionEligible: researchResolved && academicDatasetExecution
      && selector.expected.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
    ...(localGoldenAuthority ? {
      evidenceClass: LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
      externalTrustClaimed: false,
    } : {}),
    rawEventManifestHash: receipt.rawEventManifestHash,
    rawEventArtifactHash: receipt.rawEventArtifactHash,
    rawEventArtifactBytes: receipt.rawEventArtifactBytes,
    rawEventArtifact: receipt.rawEventArtifact,
    rawEventRecomputationManifest: receipt.rawEventRecomputationManifest,
    independentRawEventRecomputationAssurance:
      receipt.independentRawEventRecomputationAssurance,
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
  const valid = receipt.status === 'system_benchmark_harness_verified'
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
    && verifyHarnessAnalysisProtocolBinding(receipt, selector.expected.experimentDesign);
  preflight.rememberIf(valid);
  return valid;
}
