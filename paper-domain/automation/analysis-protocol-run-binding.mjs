import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from './system-benchmark-harness-identity.mjs';
import {
  buildAnalysisProtocolReplayBinding,
  buildRepositoryAnalysisObservationAuthority,
  evaluateAnalysisProtocol,
  verifyAnalysisProtocolEvaluation,
  verifyAnalysisProtocolReplayBinding,
} from './analysis-protocol-evaluator.mjs';
import { evaluateSystemBenchmarkArmRawObservation } from './system-benchmark-arm-protocol.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function rawObservationAuthorityFacts(receipt) {
  const cells = receipt?.cells || [];
  const rawEventManifest = cells.map((cell) => ({
    cellId: cell.cellId,
    rawEventArtifactHash: cell.rawEventArtifactHash,
    rawEventCount: cell.rawEventCount,
    systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
    systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
  }));
  const propertyOracleVerified = receipt?.systemBenchmarkHarnessImplementationHash
      === SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash
    && cells.length === receipt?.scheduleCellCount
    && cells.every((cell) => SHA256.test(String(cell.systemBenchmarkCellChallengeHash || ''))
      && SHA256.test(String(cell.systemBenchmarkCellOracleHash || ''))
      && cell.metricComputation === cell.armProtocol?.evaluatorId
      && cell.systemBenchmarkArmProtocolHash === cell.armProtocol?.systemBenchmarkArmProtocolHash);
  const recomputation = receipt?.rawEventRecomputationManifest || null;
  const recomputationPayload = recomputation ? { ...recomputation } : null;
  if (recomputationPayload) delete recomputationPayload.rawEventRecomputationManifestHash;
  const rawObservationRecomputationVerified = propertyOracleVerified
    && receipt.rawEventManifestHash === hashRecord('SystemBenchmarkRawEventManifest', rawEventManifest)
    && recomputation?.status === 'raw_event_recomputation_verified'
    && SHA256.test(String(recomputation?.rawEventRecomputationManifestHash || ''))
    && hashRecord('RawEventRecomputationManifest', recomputationPayload) === recomputation.rawEventRecomputationManifestHash
    && recomputation.cells?.length === cells.length
    && cells.every((cell) => {
      const recomputed = recomputation.cells.find((candidate) => candidate.cellId === cell.cellId);
      const expected = hashRecord('SystemBenchmarkArmProtocolExecutionReceipt', {
        cellId: cell.cellId,
        systemBenchmarkArmProtocolHash: cell.systemBenchmarkArmProtocolHash,
        systemBenchmarkArmAdapterHash: cell.armAdapter?.sourceHash || null,
        armBatchExecutionReceiptHash: cell.armBatchExecutionReceiptHash,
        systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
        rawEventArtifactHash: cell.rawEventArtifactHash,
        rawEventCount: cell.rawEventCount,
        metrics: cell.metrics,
      });
      return SHA256.test(String(cell.rawEventArtifactHash || ''))
        && Number.isSafeInteger(cell.rawEventCount) && cell.rawEventCount >= 2
        && recomputed?.rawEventArtifactHash === cell.rawEventArtifactHash
        && recomputed?.rawEventCount === cell.rawEventCount
        && hashRecord('RawEventRecomputedMetricsExpected', recomputed?.metrics)
          === hashRecord('RawEventRecomputedMetricsExpected', cell.metrics)
        && cell.systemBenchmarkArmProtocolExecutionReceiptHash === expected;
    });
  return {
    propertyOracleVerified,
    rawObservationRecomputationVerified,
    rawEventRecomputationManifestHash: recomputation?.rawEventRecomputationManifestHash || null,
    aggregateResidual: Number(recomputation?.maximumAbsoluteResidual),
    toleranceSatisfied: rawObservationRecomputationVerified && Number(recomputation?.maximumAbsoluteResidual) === 0,
  };
}

export function buildRawEventRecomputationManifest({ cells = [], rawEventRows = [], requiredMetrics = [], metricSpecs = {} } = {}) {
  const rows = new Map(rawEventRows.map((row) => [row?.cellId, row]));
  const blockers = [];
  let maximumAbsoluteResidual = 0;
  const recomputedCells = cells.map((cell) => {
    const row = rows.get(cell.cellId);
    const line = String(row?.line || '');
    const evaluated = evaluateSystemBenchmarkArmRawObservation({
      protocol: cell.armProtocol,
      document: row?.document ? { version: 1, kind: 'CampaignBenchmarkCellRawEvents', events: row.document.events } : null,
      requiredMetrics,
      metricSpecs,
    });
    const rowHash = line ? hashBytes(line) : null;
    if (rowHash !== cell.rawEventArtifactHash) blockers.push(`raw_event_recomputation_artifact_mismatch:${cell.cellId}`);
    if (evaluated.status !== 'system_benchmark_arm_observation_computed') blockers.push(...evaluated.blockers.map((item) => `${item}:${cell.cellId}`));
    for (const metric of requiredMetrics) {
      const residual = Math.abs(Number(evaluated.metrics?.[metric]) - Number(cell.metrics?.[metric]));
      if (Number.isFinite(residual)) maximumAbsoluteResidual = Math.max(maximumAbsoluteResidual, residual);
      else blockers.push(`raw_event_recomputation_metric_invalid:${cell.cellId}:${metric}`);
    }
    if (evaluated.eventCount !== cell.rawEventCount) blockers.push(`raw_event_recomputation_count_mismatch:${cell.cellId}`);
    return Object.freeze({
      cellId: cell.cellId,
      rawEventArtifactHash: rowHash,
      rawEventCount: evaluated.eventCount,
      metrics: evaluated.metrics,
    });
  });
  if (rows.size !== cells.length) blockers.push('raw_event_recomputation_row_bijection_invalid');
  if (maximumAbsoluteResidual !== 0) blockers.push('raw_event_recomputation_residual_nonzero');
  const payload = {
    version: 1,
    kind: 'RawEventRecomputationManifest',
    status: blockers.length ? 'raw_event_recomputation_blocked' : 'raw_event_recomputation_verified',
    cells: Object.freeze(recomputedCells),
    maximumAbsoluteResidual,
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({ ...payload, rawEventRecomputationManifestHash: hashRecord('RawEventRecomputationManifest', payload) });
}

export function buildHarnessAnalysisObservationAuthority(receipt) {
  const observations = (receipt?.cells || []).map((cell) => ({
    seed: cell.seed, repetition: cell.repetition, arm: cell.arm, metrics: cell.metrics,
  }));
  return buildRepositoryAnalysisObservationAuthority({
    observations,
    rawEventManifestHash: receipt?.rawEventManifestHash,
    rawEventArtifactHash: receipt?.rawEventArtifactHash,
    ...rawObservationAuthorityFacts(receipt),
    experimentAttemptId: receipt?.experimentAttemptId,
    sourceLineageHash: receipt?.sourceLineageHash,
  });
}

function expectedInputs(receipt, design) {
  const observations = (receipt?.cells || []).map((cell) => ({
    seed: cell.seed,
    repetition: cell.repetition,
    arm: cell.arm,
    metrics: cell.metrics,
  }));
  const analysisProtocol = {
    ...design.analysisProtocol,
    analysisProtocolHash: design.analysisProtocolHash,
  };
  const observationAuthority = buildHarnessAnalysisObservationAuthority(receipt);
  return {
    analysisProtocol,
    observations,
    observationAuthority,
    benchmarkId: receipt?.benchmarkId,
    benchmarkFamily: design.benchmarkFamily,
    requiredMetrics: design.requiredMetrics,
    metricSpecs: design.metricSpecs,
  };
}

function same(left, right) {
  return hashRecord('AnalysisProtocolBindingExpected', left)
    === hashRecord('AnalysisProtocolBindingExpected', right);
}

export function verifyHarnessAnalysisProtocolBinding(receipt, design) {
  if (!receipt || !design?.analysisProtocol || !design.analysisProtocolHash) return false;
  const inputs = expectedInputs(receipt, design);
  const expected = evaluateAnalysisProtocol(inputs);
  if (expected.status !== 'academic_analysis_protocol_verified'
    || !verifyAnalysisProtocolEvaluation(receipt.analysisProtocolEvaluation, inputs)
    || !same(receipt.analysisProtocol, inputs.analysisProtocol)
    || receipt.analysisProtocolHash !== design.analysisProtocolHash
    || !same(receipt.analysisObservationAuthority, inputs.observationAuthority)
    || !same(receipt.analysisProtocolEvaluation, expected)) return false;
  const academic = receipt.assuranceScope === 'operator-authorized-hidden-evaluation-v1';
  const operatorAuthority = receipt.operatorDatasetHarnessAuthority;
  const operatorTemplateHash = design.analysisProtocolTemplateHash || design.analysisProtocolHash;
  const operatorTemplate = design.analysisProtocolTemplate || design.analysisProtocol;
  if (academic && (operatorAuthority?.analysisProtocolHash !== operatorTemplateHash
    || !same(operatorAuthority?.analysisProtocol, operatorTemplate))) return false;
  if (!academic && operatorAuthority !== null) return false;
  return true;
}

export function analysisProtocolResultDocumentFields(receipt) {
  return Object.freeze({
    analysisProtocol: receipt?.analysisProtocol || null,
    analysisProtocolHash: receipt?.analysisProtocolHash || null,
    analysisObservationAuthority: receipt?.analysisObservationAuthority || null,
    analysisProtocolEvaluation: receipt?.analysisProtocolEvaluation || null,
  });
}

export function buildExperimentRunAnalysisProtocolBinding({
  harnessExecutionReceipt,
  design,
  resultDocument,
} = {}) {
  const blockers = [];
  if (!verifyHarnessAnalysisProtocolBinding(harnessExecutionReceipt, design)) {
    blockers.push('experiment_analysis_protocol_harness_binding_invalid');
  }
  const fields = analysisProtocolResultDocumentFields(harnessExecutionReceipt);
  if (!same(fields, analysisProtocolResultDocumentFields(resultDocument))) {
    blockers.push('experiment_analysis_protocol_result_document_binding_invalid');
  }
  return Object.freeze({ blockers, fields });
}

export function verifyExperimentRunAnalysisProtocolBinding(receipt, design) {
  if (!verifyHarnessAnalysisProtocolBinding(receipt?.harnessExecutionReceipt, design)) return false;
  const expected = analysisProtocolResultDocumentFields(receipt.harnessExecutionReceipt);
  const actual = Object.freeze({
    analysisProtocol: receipt.analysisProtocol,
    analysisProtocolHash: receipt.analysisProtocolHash,
    analysisObservationAuthority: receipt.analysisObservationAuthority,
    analysisProtocolEvaluation: receipt.analysisProtocolEvaluation,
  });
  return same(actual, expected)
    && receipt.analysisProtocolHash === design.analysisProtocolHash
    && receipt.analysisProtocolEvaluation?.status === 'academic_analysis_protocol_verified';
}

export function buildExperimentReplayAnalysisProtocolBinding({ originalRunReceipt, replayRunReceipt } = {}) {
  return buildAnalysisProtocolReplayBinding({
    originalEvaluation: originalRunReceipt?.analysisProtocolEvaluation,
    replayEvaluation: replayRunReceipt?.analysisProtocolEvaluation,
  });
}

export function verifyExperimentReplayAnalysisProtocolBinding(receipt) {
  const rebuilt = buildExperimentReplayAnalysisProtocolBinding({
    originalRunReceipt: receipt?.originalRunReceipt,
    replayRunReceipt: receipt?.replayRunReceipt,
  });
  return verifyAnalysisProtocolReplayBinding(receipt?.analysisProtocolReplayBinding)
    && rebuilt.status === 'academic_analysis_protocol_replay_verified'
    && rebuilt.academicAnalysisProtocolReplayBindingHash
      === receipt.analysisProtocolReplayBinding.academicAnalysisProtocolReplayBindingHash;
}
