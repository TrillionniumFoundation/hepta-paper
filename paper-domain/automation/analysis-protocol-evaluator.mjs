import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { validateAnalysisProtocol, verifyAnalysisProtocol } from './analysis-protocol-contract.mjs';
import {
  isSeedClusterInferenceProfile,
  verifyAcademicAnalysisInferenceProfile,
} from './academic-analysis-inference-profile.mjs';
import {
  arithmeticMean,
  deterministicPairedBootstrap,
  deterministicSignFlipInference,
  holmBonferroni,
  requiredPairedObservations,
  sampleStandardDeviation,
  sampleStandardError,
  winsorizedValues,
} from './analysis-statistics.mjs';
import {
  ANALYSIS_SCIENTIFIC_VERDICTS as SCIENTIFIC_VERDICTS,
  deriveAnalysisScientificOutcome as scientificOutcome,
} from './analysis-scientific-outcome.mjs';
import {
  analysisObservationManifestHash,
  buildRepositoryAnalysisObservationAuthority,
  verifyRepositoryAnalysisObservationAuthority,
} from './analysis-observation-authority.mjs';

export { buildRepositoryAnalysisObservationAuthority };

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);

function unique(values) {
  return [...new Set(values)];
}

function protocolResolution(protocol, context) {
  if (!protocol || !SHA256.test(String(protocol.analysisProtocolHash || ''))) return null;
  const { analysisProtocolHash, ...document } = protocol;
  try {
    const validated = validateAnalysisProtocol(document, context);
    return validated.analysisProtocolHash === analysisProtocolHash ? validated : null;
  } catch { return null; }
}

function normalizedObservations(observations, protocol, blockers) {
  const normalized = [];
  const seen = new Set();
  for (const observation of Array.isArray(observations) ? observations : []) {
    const seed = Number(observation?.seed);
    const repetition = Number(observation?.repetition);
    const arm = String(observation?.arm || '');
    const key = `${seed}\0${repetition}\0${arm}`;
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(repetition) || repetition < 1
      || !ARMS.includes(arm) || seen.has(key)) {
      blockers.push('analysis_observation_identity_invalid');
      continue;
    }
    seen.add(key);
    const suppliedMetrics = observation?.metrics;
    if (!suppliedMetrics || typeof suppliedMetrics !== 'object' || Array.isArray(suppliedMetrics)
      || Object.keys(suppliedMetrics).sort().join('\0') !== [...protocol.requiredMetrics].sort().join('\0')) {
      blockers.push(`analysis_observation_metric_set_invalid:${seed}:${repetition}:${arm}`);
      continue;
    }
    const metrics = {};
    for (const metric of protocol.requiredMetrics) {
      const value = Number(suppliedMetrics[metric]);
      const spec = protocol.metricSpecs[metric];
      if (!Number.isFinite(value) || value < spec.minimum || value > spec.maximum) {
        blockers.push(`analysis_observation_metric_out_of_range:${seed}:${repetition}:${arm}:${metric}`);
      }
      metrics[metric] = value;
    }
    normalized.push(Object.freeze({ seed, repetition, arm, metrics: Object.freeze(metrics) }));
  }
  if (!normalized.length) blockers.push('analysis_observations_required');
  normalized.sort((left, right) => (
    left.seed - right.seed || left.repetition - right.repetition || ARMS.indexOf(left.arm) - ARMS.indexOf(right.arm)
  ));
  return Object.freeze(normalized);
}

function pairedCells(observations, blockers) {
  const cells = new Map();
  for (const observation of observations) {
    const key = `${observation.seed}\0${observation.repetition}`;
    const cell = cells.get(key) || { seed: observation.seed, repetition: observation.repetition };
    if (cell[observation.arm]) blockers.push(`analysis_duplicate_paired_arm:${observation.seed}:${observation.repetition}:${observation.arm}`);
    cell[observation.arm] = observation;
    cells.set(key, cell);
  }
  for (const cell of cells.values()) {
    for (const arm of ARMS) {
      if (!cell[arm]) blockers.push(`analysis_missing_paired_arm:${cell.seed}:${cell.repetition}:${arm}`);
    }
  }
  return [...cells.values()].sort((left, right) => left.seed - right.seed || left.repetition - right.repetition);
}

function analysisUnitTopology(cells, protocol, blockers) {
  const bySeed = new Map();
  for (const cell of cells) {
    const cluster = bySeed.get(cell.seed) || [];
    cluster.push(cell);
    bySeed.set(cell.seed, cluster);
  }
  const clusters = [...bySeed.entries()].sort(([left], [right]) => left - right).map(([seed, seedCells]) => {
    const ordered = [...seedCells].sort((left, right) => left.repetition - right.repetition);
    const repetitions = ordered.map((cell) => cell.repetition);
    const armCounts = Object.fromEntries(ARMS.map((arm) => [arm, ordered.filter((cell) => cell[arm]).length]));
    return Object.freeze({
      seed,
      repetitions: Object.freeze(repetitions),
      rawCellCount: ordered.length,
      armCounts: Object.freeze(armCounts),
    });
  });
  const repetitionSchedules = new Set(clusters.map((cluster) => JSON.stringify(cluster.repetitions)));
  const clusterSizes = new Set(clusters.map((cluster) => cluster.rawCellCount));
  const armBalanced = clusters.every((cluster) => ARMS.every((arm) => (
    cluster.armCounts[arm] === cluster.rawCellCount
  )));
  const repetitionScheduleBalanced = repetitionSchedules.size <= 1;
  const clusterSizeBalanced = clusterSizes.size <= 1;
  if (!armBalanced) blockers.push('analysis_cluster_arm_imbalanced');
  if (!repetitionScheduleBalanced) blockers.push('analysis_cluster_repetition_schedule_imbalanced');
  if (!clusterSizeBalanced) blockers.push('analysis_cluster_size_imbalanced');

  const completeCells = cells.filter((cell) => ARMS.every((arm) => cell[arm]));
  const clustered = isSeedClusterInferenceProfile(protocol.inferenceProfile);
  const independentUnits = clustered
    ? [...bySeed.entries()].sort(([left], [right]) => left - right).map(([seed, seedCells]) => Object.freeze({
      seed,
      repetition: null,
      ...Object.fromEntries(ARMS.map((arm) => [arm, Object.freeze({
        metrics: Object.freeze(Object.fromEntries(protocol.requiredMetrics.map((metric) => [
          metric,
          arithmeticMean(seedCells.filter((cell) => cell[arm]).map((cell) => cell[arm]?.metrics?.[metric])),
        ]))),
      })])),
    }))
    : completeCells;
  const diagnosticsPayload = {
    version: 1,
    kind: 'AcademicAnalysisClusterDiagnostics',
    inferenceProfileHash: protocol.inferenceProfileHash,
    independentUnit: protocol.inferenceProfile.independentUnit,
    withinSeedAggregation: protocol.inferenceProfile.withinSeedAggregation,
    clusterCount: clusters.length,
    rawCellCount: cells.length,
    independentUnitCount: independentUnits.length,
    clusterSizeBalanced,
    armBalanced,
    repetitionScheduleBalanced,
    clusters: Object.freeze(clusters),
  };
  const clusterDiagnostics = Object.freeze({
    ...diagnosticsPayload,
    academicAnalysisClusterDiagnosticsHash: hashRecord('AcademicAnalysisClusterDiagnostics', diagnosticsPayload),
  });
  return Object.freeze({ independentUnits: Object.freeze(independentUnits), clusterDiagnostics });
}

function armSummaries(units, protocol) {
  return Object.freeze(Object.fromEntries(ARMS.map((arm) => [arm, Object.freeze(Object.fromEntries(
    protocol.requiredMetrics.map((metric) => {
      const values = units.map((item) => item[arm].metrics[metric]);
      return [metric, Object.freeze({
        count: values.length,
        mean: arithmeticMean(values),
        standardDeviation: sampleStandardDeviation(values),
        standardError: sampleStandardError(values),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
      })];
    }),
  ))])));
}

function sampleSkewness(values) {
  if (values.length < 3) return Number.NaN;
  const mean = arithmeticMean(values);
  const deviation = sampleStandardDeviation(values);
  if (deviation === 0) return 0;
  const n = values.length;
  const cubic = values.reduce((sum, value) => sum + (((value - mean) / deviation) ** 3), 0);
  return (n / ((n - 1) * (n - 2))) * cubic;
}

function hypothesisEvaluation(hypothesis, cells, protocol) {
  const differences = cells.map((cell) => {
    const treatment = cell.treatment.metrics[hypothesis.metric];
    const control = cell[hypothesis.comparator].metrics[hypothesis.metric];
    return hypothesis.alternative === 'greater' ? treatment - control : control - treatment;
  });
  const mean = arithmeticMean(differences);
  const standardDeviation = sampleStandardDeviation(differences);
  const standardizedEffect = standardDeviation === 0
    ? (mean > 0 ? Number.MAX_VALUE : 0)
    : mean / standardDeviation;
  const bootstrap = deterministicPairedBootstrap(differences, {
    ...protocol.uncertainty,
    method: protocol.uncertainty.method,
    salt: `${protocol.analysisProtocolHash}:${hypothesis.hypothesisId}:bootstrap`,
  });
  const signFlip = deterministicSignFlipInference(differences, {
    draws: protocol.uncertainty.testDraws,
    seed: protocol.uncertainty.seed,
    salt: `${protocol.analysisProtocolHash}:${hypothesis.hypothesisId}:sign-flip`,
  });
  const pValue = signFlip.pValue;
  const winsorizedMean = arithmeticMean(winsorizedValues(
    differences,
    protocol.outlierSensitivity.lowerQuantile,
    protocol.outlierSensitivity.upperQuantile,
  ));
  const leaveOneOutMeans = differences.map((_, excluded) => arithmeticMean(differences.filter((__, index) => index !== excluded)));
  const minimumLeaveOneOutMean = Math.min(...leaveOneOutMeans);
  const skewness = sampleSkewness(differences);
  const assumptionAccepted = Number.isFinite(skewness)
    && Math.abs(skewness) <= protocol.assumptions.maximumAbsoluteSkewness;
  const sensitivityAccepted = winsorizedMean > hypothesis.minimumEffect
    && minimumLeaveOneOutMean > hypothesis.minimumEffect;
  const uncertaintyAccepted = bootstrap.lower > hypothesis.minimumEffect;
  return Object.freeze({
    hypothesisId: hypothesis.hypothesisId,
    metric: hypothesis.metric,
    comparator: hypothesis.comparator,
    alternative: hypothesis.alternative,
    minimumEffect: hypothesis.minimumEffect,
    acceptanceRequired: hypothesis.acceptanceRequired,
    count: differences.length,
    estimate: mean,
    standardDeviation,
    standardError: sampleStandardError(differences),
    standardizedEffect,
    bootstrap,
    signFlip,
    pValue,
    skewness,
    assumptionAccepted,
    winsorizedMean,
    minimumLeaveOneOutMean,
    sensitivityAccepted,
    uncertaintyAccepted,
  });
}

export function evaluateAnalysisProtocol({
  analysisProtocol,
  observations = [],
  observationAuthority = null,
  benchmarkId = null,
  benchmarkFamily = null,
  requiredMetrics = null,
  metricSpecs = null,
} = {}) {
  const blockers = [];
  const resolved = protocolResolution(analysisProtocol, { benchmarkId, benchmarkFamily, requiredMetrics, metricSpecs });
  if (!resolved) blockers.push('analysis_protocol_invalid');
  const protocol = resolved ? Object.freeze({ ...resolved.analysisProtocol, analysisProtocolHash: resolved.analysisProtocolHash }) : null;
  const normalized = protocol ? normalizedObservations(observations, protocol, blockers) : Object.freeze([]);
  if (protocol) {
    verifyRepositoryAnalysisObservationAuthority(
      observationAuthority,
      normalized,
      protocol,
      blockers,
    );
  }
  const cells = protocol ? pairedCells(normalized, blockers) : [];
  const topology = protocol
    ? analysisUnitTopology(cells, protocol, blockers)
    : Object.freeze({ independentUnits: Object.freeze([]), clusterDiagnostics: null });
  const independentUnits = topology.independentUnits;
  const computedPowerRequirement = protocol ? requiredPairedObservations({
    alpha: protocol.multiplicity.familyAlpha,
    targetPower: protocol.power.targetPower,
    standardizedEffect: protocol.power.minimumStandardizedEffect,
    hypothesisCount: protocol.hypotheses.length,
  }) : null;
  const powerSatisfied = Boolean(protocol
    && computedPowerRequirement === protocol.power.requiredPairedObservations
    && independentUnits.length >= computedPowerRequirement);
  const canEvaluate = protocol && normalized.length && !blockers.some((blocker) => (
    blocker.startsWith('analysis_observation_') || blocker.startsWith('analysis_missing_')
      || blocker.startsWith('analysis_duplicate_') || blocker.startsWith('analysis_cluster_')
  ));
  const summaries = canEvaluate ? armSummaries(independentUnits, protocol) : {};
  const baseHypotheses = canEvaluate
    ? protocol.hypotheses.map((hypothesis) => hypothesisEvaluation(hypothesis, independentUnits, protocol))
    : [];
  const adjusted = canEvaluate
    ? holmBonferroni(baseHypotheses.map((row) => ({ hypothesisId: row.hypothesisId, pValue: row.pValue })), protocol.multiplicity.familyAlpha)
    : [];
  const adjustedById = new Map(adjusted.map((row) => [row.hypothesisId, row]));
  const acceptedHypotheses = baseHypotheses.map((row) => {
    const multiplicity = adjustedById.get(row.hypothesisId);
    const accepted = multiplicity.multiplicityAccepted && row.assumptionAccepted
      && row.sensitivityAccepted && row.uncertaintyAccepted && independentUnits.length >= computedPowerRequirement;
    return Object.freeze({ ...row, ...multiplicity, accepted });
  });
  const scientific = scientificOutcome(acceptedHypotheses, { powerSatisfied });
  const integrityVerified = blockers.length === 0;
  const payload = {
    version: 1,
    kind: 'AcademicAnalysisProtocolEvaluation',
    evidenceRole: 'academic-inferential-promotion-authority-v1',
    inferentialAuthority: true,
    promotionBlocking: true,
    status: integrityVerified ? 'academic_analysis_protocol_verified' : 'academic_analysis_protocol_blocked',
    executionStatus: canEvaluate ? 'analysis_execution_completed' : 'analysis_execution_blocked',
    integrityStatus: integrityVerified ? 'analysis_integrity_verified' : 'analysis_integrity_blocked',
    scientificVerdict: integrityVerified ? scientific.verdict : 'not_evaluable',
    scientificFindings: integrityVerified ? scientific.findings : Object.freeze([]),
    scientificReportingEligible: integrityVerified,
    outcomeDrivenRepairForbidden: true,
    analysisProtocol: protocol,
    analysisProtocolHash: protocol?.analysisProtocolHash || null,
    inferenceProfileHash: protocol?.inferenceProfileHash || null,
    analysisObservationAuthorityHash: observationAuthority?.analysisObservationAuthorityHash || null,
    observationManifestHash: normalized.length ? analysisObservationManifestHash(normalized) : null,
    observationCount: normalized.length,
    pairedUnitCount: cells.length,
    rawCellCount: cells.length,
    independentUnitCount: independentUnits.length,
    clusterDiagnostics: topology.clusterDiagnostics,
    clusterDiagnosticsHash: topology.clusterDiagnostics?.academicAnalysisClusterDiagnosticsHash || null,
    agentAggregatesAccepted: false,
    summaries,
    hypotheses: scientific.hypotheses,
    multiplicity: protocol?.multiplicity || null,
    power: protocol ? Object.freeze({
      ...protocol.power,
      computedRequiredPairedObservations: computedPowerRequirement,
      computedRequiredIndependentUnits: computedPowerRequirement,
      independentUnitCount: independentUnits.length,
      countingUnit: protocol.inferenceProfile.powerCountingUnit,
      designSatisfied: powerSatisfied,
    }) : null,
    numericValidation: protocol ? Object.freeze({
      protocol: protocol.numericValidation,
      propertyOracleVerified: observationAuthority?.propertyOracleVerified === true,
      rawObservationRecomputationVerified: observationAuthority?.rawObservationRecomputationVerified === true,
      aggregateResidual: Number.isFinite(Number(observationAuthority?.aggregateResidual))
        ? Number(observationAuthority.aggregateResidual) : null,
      toleranceSatisfied: observationAuthority?.toleranceSatisfied === true,
      candidateConvergenceClaimAccepted: false,
      candidateConditionClaimAccepted: false,
      typedNumericOracleCertificateSetHash:
        observationAuthority?.typedNumericOracleCertificateSet
          ?.typedNumericOracleCertificateSetHash || null,
      typedNumericOracleTypes: Object.freeze(
        observationAuthority?.typedNumericOracleCertificateSet?.verifiedOracleTypes || [],
      ),
    }) : null,
    blockers: unique(blockers),
  };
  return Object.freeze({
    ...payload,
    academicAnalysisProtocolEvaluationHash: hashRecord('AcademicAnalysisProtocolEvaluation', payload),
  });
}

export function verifyAnalysisProtocolEvaluation(evaluation, inputs = {}) {
  if (!evaluation || evaluation.kind !== 'AcademicAnalysisProtocolEvaluation'
    || !SHA256.test(String(evaluation.academicAnalysisProtocolEvaluationHash || ''))) return false;
  const expected = evaluateAnalysisProtocol(inputs);
  return expected.status === 'academic_analysis_protocol_verified'
    && evaluation.status === expected.status
    && hashRecord('AcademicAnalysisProtocolEvaluationExpected', evaluation)
      === hashRecord('AcademicAnalysisProtocolEvaluationExpected', expected);
}

export function academicAnalysisPromotionBlockers(evaluation, inputs = null) {
  if (!evaluation || evaluation.version !== 1 || evaluation.kind !== 'AcademicAnalysisProtocolEvaluation'
    || evaluation.evidenceRole !== 'academic-inferential-promotion-authority-v1'
    || evaluation.inferentialAuthority !== true || evaluation.promotionBlocking !== true
    || !Array.isArray(evaluation.blockers) || !Array.isArray(evaluation.scientificFindings)
    || evaluation.status !== (evaluation.blockers.length
      ? 'academic_analysis_protocol_blocked' : 'academic_analysis_protocol_verified')
    || evaluation.integrityStatus !== (evaluation.blockers.length
      ? 'analysis_integrity_blocked' : 'analysis_integrity_verified')
    || evaluation.scientificVerdict !== (evaluation.blockers.length
      ? 'not_evaluable' : evaluation.scientificVerdict)
    || (evaluation.blockers.length === 0 && !SCIENTIFIC_VERDICTS.includes(evaluation.scientificVerdict))
    || evaluation.scientificReportingEligible !== (evaluation.blockers.length === 0)
    || evaluation.outcomeDrivenRepairForbidden !== true) {
    return Object.freeze(['academic_analysis_protocol_evaluation_invalid']);
  }
  const { academicAnalysisProtocolEvaluationHash, ...payload } = evaluation;
  if (!SHA256.test(String(academicAnalysisProtocolEvaluationHash || ''))
    || hashRecord('AcademicAnalysisProtocolEvaluation', payload) !== academicAnalysisProtocolEvaluationHash) {
    return Object.freeze(['academic_analysis_protocol_evaluation_invalid']);
  }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return Object.freeze(['academic_analysis_protocol_evaluation_authority_required']);
  }
  const recomputed = evaluateAnalysisProtocol(inputs);
  if (hashRecord('AcademicAnalysisProtocolEvaluationExpected', evaluation)
    !== hashRecord('AcademicAnalysisProtocolEvaluationExpected', recomputed)) {
    return Object.freeze(['academic_analysis_protocol_evaluation_invalid']);
  }
  if (evaluation.status === 'academic_analysis_protocol_verified') {
    return verifyAnalysisProtocolEvaluation(evaluation, inputs)
      ? Object.freeze([])
      : Object.freeze(['academic_analysis_protocol_evaluation_invalid']);
  }
  return Object.freeze(unique(recomputed.blockers.length
    ? recomputed.blockers : ['academic_analysis_protocol_evaluation_invalid']));
}

function structurallyVerifiedClusterDiagnostics(evaluation) {
  const diagnostics = evaluation?.clusterDiagnostics;
  const profile = evaluation?.analysisProtocol?.inferenceProfile;
  if (!exactKeys(diagnostics, [
    'version', 'kind', 'inferenceProfileHash', 'independentUnit', 'withinSeedAggregation',
    'clusterCount', 'rawCellCount', 'independentUnitCount', 'clusterSizeBalanced',
    'armBalanced', 'repetitionScheduleBalanced', 'clusters',
    'academicAnalysisClusterDiagnosticsHash',
  ]) || diagnostics.version !== 1 || diagnostics.kind !== 'AcademicAnalysisClusterDiagnostics'
    || diagnostics.inferenceProfileHash !== evaluation.inferenceProfileHash
    || diagnostics.independentUnit !== profile?.independentUnit
    || diagnostics.withinSeedAggregation !== profile?.withinSeedAggregation
    || !Array.isArray(diagnostics.clusters) || diagnostics.clusters.length < 1) return false;

  let previousSeed = null;
  const clustersValid = diagnostics.clusters.every((cluster) => {
    if (!exactKeys(cluster, ['seed', 'repetitions', 'rawCellCount', 'armCounts'])
      || !Number.isSafeInteger(cluster.seed)
      || (previousSeed !== null && cluster.seed <= previousSeed)
      || !Array.isArray(cluster.repetitions) || cluster.repetitions.length < 1
      || cluster.rawCellCount !== cluster.repetitions.length
      || !exactKeys(cluster.armCounts, ARMS)
      || ARMS.some((arm) => cluster.armCounts[arm] !== cluster.rawCellCount)) return false;
    previousSeed = cluster.seed;
    return cluster.repetitions.every((repetition, index) => (
      Number.isSafeInteger(repetition) && repetition >= 1
      && (index === 0 || repetition > cluster.repetitions[index - 1])
    ));
  });
  if (!clustersValid) return false;

  const rawCellCount = diagnostics.clusters.reduce((sum, cluster) => sum + cluster.rawCellCount, 0);
  const clusterSizeBalanced = new Set(diagnostics.clusters.map((cluster) => cluster.rawCellCount)).size === 1;
  const repetitionScheduleBalanced = new Set(diagnostics.clusters.map((cluster) => (
    JSON.stringify(cluster.repetitions)
  ))).size === 1;
  const armBalanced = diagnostics.clusters.every((cluster) => ARMS.every((arm) => (
    cluster.armCounts[arm] === cluster.rawCellCount
  )));
  const independentUnitCount = isSeedClusterInferenceProfile(profile)
    ? diagnostics.clusters.length
    : rawCellCount;
  const { academicAnalysisClusterDiagnosticsHash, ...diagnosticsPayload } = diagnostics;
  return diagnostics.clusterCount === diagnostics.clusters.length
    && diagnostics.rawCellCount === rawCellCount
    && diagnostics.independentUnitCount === independentUnitCount
    && diagnostics.clusterSizeBalanced === clusterSizeBalanced
    && diagnostics.armBalanced === armBalanced
    && diagnostics.repetitionScheduleBalanced === repetitionScheduleBalanced
    && clusterSizeBalanced && armBalanced && repetitionScheduleBalanced
    && evaluation.rawCellCount === rawCellCount
    && evaluation.pairedUnitCount === rawCellCount
    && evaluation.independentUnitCount === independentUnitCount
    && evaluation.clusterDiagnosticsHash === academicAnalysisClusterDiagnosticsHash
    && hashRecord('AcademicAnalysisClusterDiagnostics', diagnosticsPayload)
      === academicAnalysisClusterDiagnosticsHash;
}

function structurallyVerifiedEvaluation(evaluation) {
  if (!evaluation || evaluation.version !== 1 || evaluation.kind !== 'AcademicAnalysisProtocolEvaluation'
    || evaluation.status !== 'academic_analysis_protocol_verified'
    || evaluation.evidenceRole !== 'academic-inferential-promotion-authority-v1'
    || evaluation.inferentialAuthority !== true || evaluation.promotionBlocking !== true
    || !Array.isArray(evaluation.blockers) || evaluation.blockers.length
    || evaluation.executionStatus !== 'analysis_execution_completed'
    || evaluation.integrityStatus !== 'analysis_integrity_verified'
    || !SCIENTIFIC_VERDICTS.includes(evaluation.scientificVerdict)
    || !Array.isArray(evaluation.scientificFindings)
    || !Array.isArray(evaluation.hypotheses)
    || evaluation.scientificReportingEligible !== true
    || evaluation.outcomeDrivenRepairForbidden !== true
    || !SHA256.test(String(evaluation.academicAnalysisProtocolEvaluationHash || ''))
    || evaluation.analysisProtocolHash !== evaluation.analysisProtocol?.analysisProtocolHash
    || evaluation.inferenceProfileHash !== evaluation.analysisProtocol?.inferenceProfileHash
    || !verifyAcademicAnalysisInferenceProfile({
      ...evaluation.analysisProtocol?.inferenceProfile,
      inferenceProfileHash: evaluation.inferenceProfileHash,
    }, { benchmarkFamily: evaluation.analysisProtocol?.benchmarkFamily })
    || !verifyAnalysisProtocol(evaluation.analysisProtocol, {
      benchmarkId: evaluation.analysisProtocol?.benchmarkId,
      benchmarkFamily: evaluation.analysisProtocol?.benchmarkFamily,
      requiredMetrics: evaluation.analysisProtocol?.requiredMetrics,
      metricSpecs: evaluation.analysisProtocol?.metricSpecs,
    })) return false;
  if (!structurallyVerifiedClusterDiagnostics(evaluation)) return false;
  const { academicAnalysisProtocolEvaluationHash, ...payload } = evaluation;
  const scientific = scientificOutcome(evaluation.hypotheses, {
    powerSatisfied: evaluation.power?.designSatisfied === true,
  });
  return hashRecord('AcademicAnalysisProtocolEvaluation', payload) === academicAnalysisProtocolEvaluationHash
    && evaluation.observationCount === evaluation.rawCellCount * ARMS.length
    && evaluation.power?.computedRequiredPairedObservations
      === evaluation.analysisProtocol.power.requiredPairedObservations
    && evaluation.power?.computedRequiredIndependentUnits
      === evaluation.analysisProtocol.power.requiredPairedObservations
    && evaluation.power?.independentUnitCount === evaluation.independentUnitCount
    && evaluation.power?.countingUnit === evaluation.analysisProtocol.inferenceProfile.powerCountingUnit
    && evaluation.power?.designSatisfied
      === (evaluation.independentUnitCount >= evaluation.analysisProtocol.power.requiredPairedObservations)
    && evaluation.scientificVerdict === scientific.verdict
    && JSON.stringify(evaluation.scientificFindings) === JSON.stringify(scientific.findings)
    && evaluation.hypotheses.every((row) => row?.count === evaluation.independentUnitCount)
    && ARMS.every((arm) => evaluation.summaries?.[arm]
      && evaluation.analysisProtocol.requiredMetrics.every((metric) => (
        evaluation.summaries[arm]?.[metric]?.count === evaluation.independentUnitCount
      )));
}

export function buildAnalysisProtocolReplayBinding({ originalEvaluation, replayEvaluation } = {}) {
  const blockers = [];
  if (!structurallyVerifiedEvaluation(originalEvaluation)) blockers.push('analysis_original_evaluation_invalid');
  if (!structurallyVerifiedEvaluation(replayEvaluation)) blockers.push('analysis_replay_evaluation_invalid');
  if (originalEvaluation?.analysisProtocolHash !== replayEvaluation?.analysisProtocolHash) {
    blockers.push('analysis_replay_protocol_mismatch');
  }
  if (originalEvaluation?.inferenceProfileHash !== replayEvaluation?.inferenceProfileHash) {
    blockers.push('analysis_replay_inference_profile_mismatch');
  }
  if (originalEvaluation?.rawCellCount !== replayEvaluation?.rawCellCount) {
    blockers.push('analysis_replay_raw_cell_count_mismatch');
  }
  if (originalEvaluation?.independentUnitCount !== replayEvaluation?.independentUnitCount) {
    blockers.push('analysis_replay_independent_unit_count_mismatch');
  }
  if (originalEvaluation?.clusterDiagnosticsHash !== replayEvaluation?.clusterDiagnosticsHash) {
    blockers.push('analysis_replay_cluster_diagnostics_mismatch');
  }
  if (originalEvaluation?.analysisObservationAuthorityHash === replayEvaluation?.analysisObservationAuthorityHash) {
    blockers.push('analysis_replay_observation_authority_not_independent');
  }
  if (originalEvaluation?.scientificVerdict !== replayEvaluation?.scientificVerdict) {
    blockers.push('analysis_replay_scientific_verdict_mismatch');
  }
  const payload = {
    version: 1,
    kind: 'AcademicAnalysisProtocolReplayBinding',
    status: blockers.length ? 'academic_analysis_protocol_replay_blocked' : 'academic_analysis_protocol_replay_verified',
    analysisProtocolHash: originalEvaluation?.analysisProtocolHash || null,
    inferenceProfileHash: originalEvaluation?.inferenceProfileHash || null,
    originalEvaluationHash: originalEvaluation?.academicAnalysisProtocolEvaluationHash || null,
    replayEvaluationHash: replayEvaluation?.academicAnalysisProtocolEvaluationHash || null,
    originalObservationAuthorityHash: originalEvaluation?.analysisObservationAuthorityHash || null,
    replayObservationAuthorityHash: replayEvaluation?.analysisObservationAuthorityHash || null,
    originalScientificVerdict: originalEvaluation?.scientificVerdict || null,
    replayScientificVerdict: replayEvaluation?.scientificVerdict || null,
    originalRawCellCount: originalEvaluation?.rawCellCount ?? null,
    replayRawCellCount: replayEvaluation?.rawCellCount ?? null,
    originalIndependentUnitCount: originalEvaluation?.independentUnitCount ?? null,
    replayIndependentUnitCount: replayEvaluation?.independentUnitCount ?? null,
    originalClusterDiagnosticsHash: originalEvaluation?.clusterDiagnosticsHash || null,
    replayClusterDiagnosticsHash: replayEvaluation?.clusterDiagnosticsHash || null,
    blockers: unique(blockers),
  };
  return Object.freeze({
    ...payload,
    academicAnalysisProtocolReplayBindingHash: hashRecord('AcademicAnalysisProtocolReplayBinding', payload),
  });
}

export function verifyAnalysisProtocolReplayBinding(binding) {
  if (!binding || binding.version !== 1 || binding.kind !== 'AcademicAnalysisProtocolReplayBinding'
    || binding.status !== 'academic_analysis_protocol_replay_verified'
    || !Array.isArray(binding.blockers) || binding.blockers.length
    || !SHA256.test(String(binding.academicAnalysisProtocolReplayBindingHash || ''))) return false;
  const { academicAnalysisProtocolReplayBindingHash, ...payload } = binding;
  return hashRecord('AcademicAnalysisProtocolReplayBinding', payload) === academicAnalysisProtocolReplayBindingHash
    && SHA256.test(String(binding.analysisProtocolHash || ''))
    && SHA256.test(String(binding.inferenceProfileHash || ''))
    && SHA256.test(String(binding.originalEvaluationHash || ''))
    && SHA256.test(String(binding.replayEvaluationHash || ''))
    && SHA256.test(String(binding.originalObservationAuthorityHash || ''))
    && SHA256.test(String(binding.replayObservationAuthorityHash || ''))
    && SCIENTIFIC_VERDICTS.includes(binding.originalScientificVerdict)
    && binding.originalScientificVerdict === binding.replayScientificVerdict
    && Number.isSafeInteger(binding.originalRawCellCount) && binding.originalRawCellCount > 0
    && binding.originalRawCellCount === binding.replayRawCellCount
    && Number.isSafeInteger(binding.originalIndependentUnitCount) && binding.originalIndependentUnitCount > 0
    && binding.originalIndependentUnitCount === binding.replayIndependentUnitCount
    && SHA256.test(String(binding.originalClusterDiagnosticsHash || ''))
    && binding.originalClusterDiagnosticsHash === binding.replayClusterDiagnosticsHash
    && binding.originalObservationAuthorityHash !== binding.replayObservationAuthorityHash;
}
