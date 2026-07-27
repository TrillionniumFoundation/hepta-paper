import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { verifyCampaignBenchmarkSelector } from './campaign-benchmark-selector.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from './system-benchmark-harness-identity.mjs';
import {
  evaluateSystemBenchmarkStatisticalPolicy,
  verifySystemBenchmarkStatisticalCompatibilityEvidence,
} from './system-benchmark-arm-protocol.mjs';
import {
  buildExperimentRunAnalysisProtocolBinding,
  verifyExperimentRunAnalysisProtocolBinding,
} from './analysis-protocol-run-binding.mjs';
import { verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt } from './dataset-runtime-access-contract.mjs';
import {
  buildDatasetAuthorizationSet,
  parseExperimentObservationCsv,
  verifyExperimentRawArtifactWriteReceipt,
} from './experiment-run-artifact-contract.mjs';
import { verifyOsSandboxWorkerReceipt } from './os-sandbox-worker-receipt-contract.mjs';
import {
  buildCampaignBenchmarkSchedule,
  REQUIRED_SYSTEM_BENCHMARK_ARMS as REQUIRED_ARMS,
} from './system-benchmark-schedule.mjs';
import {
  buildExperimentRunEnvironmentBomBinding,
  verifyExperimentRunEnvironmentBomBinding,
} from './experiment-environment-bom-binding.mjs';
import { verifyEmpiricalPreDataAccessFreeze } from './empirical-pre-data-access-freeze.mjs';
import {
  aggregateExperimentObservations as aggregateObservations,
  canonicalExperimentObservation as canonicalObservation,
  csvExperimentObservation as csvObservation,
  experimentObservationKey as observationKey,
} from './experiment-observation-contract.mjs';
import { createExperimentReplayReceiptContract } from './experiment-replay-receipt-contract.mjs';
import {
  experimentRunObservationScheduleComplete,
  verifiedExperimentRunReceiptHashes,
  verifiedReceiptPreflight,
} from './experiment-run-receipt-verification-helpers.mjs';
import { verifySystemBenchmarkHarnessExecutionReceipt } from './system-benchmark-harness-execution-receipt-verifier.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export {
  buildCampaignBenchmarkSchedule,
  buildDatasetAuthorizationSet,
  verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt,
  verifyOsSandboxWorkerReceipt,
  verifySystemBenchmarkHarnessExecutionReceipt,
};
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
  return deepFreezeJsonValue({
    ...payload,
    experimentRunReceiptHash: hashRecord('ExperimentRunReceipt', payload),
  });
}

export function verifyExperimentRunReceipt(receipt) {
  if (!receipt || receipt.kind !== 'ExperimentRunReceipt' || receipt.version !== 1) return false;
  const preflight = verifiedReceiptPreflight(receipt, 'ExperimentRunReceipt', 'experimentRunReceiptHash', verifiedExperimentRunReceiptHashes);
  if (!preflight || preflight.cached) return preflight?.cached === true;
  const selectorVerification = verifyCampaignBenchmarkSelector(receipt.benchmarkSelector, {
    benchmarkId: receipt.benchmarkId,
    datasetMounts: receipt.datasetAuthorizations,
  });
  const recomputedObservationHash = hashRecord('ExperimentObservationManifest', receipt.observations || []);
  const recomputedAggregates = aggregateObservations(receipt.observations || [], receipt.requiredMetrics || []);
  const recomputedAuthorizationSet = buildDatasetAuthorizationSet(receipt.datasetAuthorizations || []);
  const design = selectorVerification.expected?.experimentDesign || null;
  const recomputedStatisticalEvaluation = evaluateSystemBenchmarkStatisticalPolicy({ observations: receipt.observations || [], experimentDesign: design });
  const scheduleComplete = experimentRunObservationScheduleComplete({
    observations: receipt.observations,
    requiredMetrics: receipt.requiredMetrics,
    design,
  });
  const systemHarnessVerified = receipt.harnessExecutionReceipt
    ? verifySystemBenchmarkHarnessExecutionReceipt(receipt.harnessExecutionReceipt)
    : false;
  const runnerArtifacts = new Map((receipt.runnerReceipt?.artifacts || []).map((artifact) => [artifact.path, artifact.sha256]));
  const valid = receipt.status === 'experiment_run_receipt_verified'
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
    && receipt.rawObservationCount === (receipt.observations || []).length;
  preflight.rememberIf(valid);
  return valid;
}

export const {
  buildExperimentReplayReceipt,
  verifyExperimentReplayReceipt,
} = createExperimentReplayReceiptContract({ verifyExperimentRunReceipt });
