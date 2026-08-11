import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildCanonicalAnalysisProtocol,
  validateAnalysisProtocol,
  verifyAnalysisProtocol,
} from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  buildAcademicAnalysisInferenceProfile,
  verifyAcademicAnalysisInferenceProfile,
} from '../../paper-domain/automation/academic-analysis-inference-profile.mjs';
import {
  academicAnalysisPromotionBlockers,
  buildAnalysisProtocolReplayBinding,
  buildRepositoryAnalysisObservationAuthority,
  evaluateAnalysisProtocol,
  verifyAnalysisProtocolEvaluation,
  verifyAnalysisProtocolReplayBinding,
} from '../../paper-domain/automation/analysis-protocol-evaluator.mjs';
import {
  evaluateSystemBenchmarkStatisticalPolicy,
  SYSTEM_BENCHMARK_STATISTICAL_COMPATIBILITY_ROLE,
  verifySystemBenchmarkStatisticalCompatibilityEvidence,
} from '../../paper-domain/automation/system-benchmark-arm-protocol.mjs';
import {
  buildHarnessAnalysisObservationAuthority,
  verifyHarnessAnalysisProtocolBinding,
  verifyHarnessOperatorAnalysisProtocolAuthority,
} from '../../paper-domain/automation/analysis-protocol-run-binding.mjs';
import { validateOperatorDatasetHarnessDefinition } from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildTypedNumericOracleCertificate,
  buildTypedNumericOracleCertificateSet,
} from '../../paper-domain/research/typed-numeric-oracle-certificate.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';

const FAMILIES = Object.freeze([
  'rl_stochastic_control_benchmark',
  'ml_algorithm_benchmark',
  'econometrics_panel_benchmark',
  'finance_asset_pricing_benchmark',
  'operations_optimization_benchmark',
]);

function protocolFixture(family, { hypotheses = null } = {}) {
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: family, datasetMounts: [] });
  const design = selector.experimentDesign;
  const protocol = buildCanonicalAnalysisProtocol({
    benchmarkId: family,
    benchmarkFamily: family,
    requiredMetrics: design.requiredMetrics,
    metricSpecs: design.metricSpecs,
    hypotheses,
  });
  return { selector, design, protocol };
}

function metricValues(spec, pair) {
  const jitter = (pair % 5) * 0.001;
  if (spec.direction === 'maximize') {
    return { treatment: 0.85 + jitter, baseline: 0.2 + jitter, ablation: 0.35 + jitter };
  }
  return { treatment: 0.1 + jitter, baseline: 0.7 + jitter, ablation: 0.6 + jitter };
}

function observationsFor(protocol, pairCount = 35) {
  return Array.from({ length: pairCount }, (_, pair) => {
    const values = Object.fromEntries(protocol.requiredMetrics.map((metric) => [
      metric, metricValues(protocol.metricSpecs[metric], pair),
    ]));
    return ['treatment', 'baseline', 'ablation'].map((arm) => ({
      seed: 1000 + pair,
      repetition: 1,
      arm,
      metrics: Object.fromEntries(protocol.requiredMetrics.map((metric) => [metric, values[metric][arm]])),
    }));
  }).flat();
}

function observationsForSchedule(protocol, { seedCount, repetitionCount, seedOffset = 2000 } = {}) {
  let pair = 0;
  return Array.from({ length: seedCount }, (_, seedIndex) => Array.from(
    { length: repetitionCount },
    (_, repetitionIndex) => {
      const values = Object.fromEntries(protocol.requiredMetrics.map((metric) => [
        metric, metricValues(protocol.metricSpecs[metric], pair++),
      ]));
      return ['treatment', 'baseline', 'ablation'].map((arm) => ({
        seed: seedOffset + seedIndex,
        repetition: repetitionIndex + 1,
        arm,
        metrics: Object.fromEntries(protocol.requiredMetrics.map((metric) => [metric, values[metric][arm]])),
      }));
    },
  )).flat(2);
}

const authorityFixtureMetadata = new WeakMap();

function authorityFor(observations, run = 'original', overrides = {}) {
  const authority = buildRepositoryAnalysisObservationAuthority({
    observations,
    rawEventManifestHash: hashRecord('AnalysisProtocolTestRawEventManifest', { run }),
    rawEventArtifactHash: hashRecord('AnalysisProtocolTestRawEventArtifact', { run }),
    rawEventRecomputationManifestHash: hashRecord('AnalysisProtocolTestRawEventRecomputationManifest', { run }),
    experimentAttemptId: `attempt-${run}`,
    sourceLineageHash: hashRecord('AnalysisProtocolTestSourceLineage', { fixture: true }),
    allowLegacyNonProduction: true,
    ...overrides,
  });
  authorityFixtureMetadata.set(authority, { run, overrides });
  return authority;
}

function canonicalAuthorityFor(fixture, observations, authority) {
  if (authority?.version !== 1) return authority;
  const { run = 'canonical', overrides = {} } = authorityFixtureMetadata.get(authority) || {};
  const profile = autonomousEmpiricalFamilyPluginProfileFor(fixture.protocol.benchmarkFamily);
  const producer = hashRecord('AnalysisProtocolTestProducer', { run });
  const verifier = hashRecord('AnalysisProtocolTestVerifier', { run });
  const assurance = hashRecord('AnalysisProtocolTestAssurance', { run });
  const certificates = profile.typedOracleKinds.map((oracleType) => (
    buildTypedNumericOracleCertificate({
      certificateId: `${oracleType}:${run}`,
      oracleType,
      subjectHash: oracleType === 'property-oracle-v1'
        ? authority.rawEventManifestHash : authority.rawEventRecomputationManifestHash,
      quantity: oracleType === 'property-oracle-v1'
        ? 'property_oracle_verified' : 'maximum_absolute_residual',
      observedValue: oracleType === 'property-oracle-v1' ? 1 : 0,
      relation: oracleType === 'property-oracle-v1' ? 'interval' : 'less-than-or-equal',
      lowerBound: oracleType === 'property-oracle-v1' ? 1 : null,
      upperBound: oracleType === 'property-oracle-v1' ? 1 : 0,
      unit: oracleType === 'property-oracle-v1'
        ? 'boolean-indicator' : 'absolute-metric-unit',
      verifierId: `analysis-protocol-test-${oracleType}`,
      producerImplementationHash: producer,
      verifierImplementationHash: oracleType === 'property-oracle-v1' ? producer : verifier,
      verificationReceiptHash: assurance,
      evidenceHashes: [assurance],
      assuranceScope: oracleType === 'property-oracle-v1'
        ? 'producer-bound-self-check-v1' : 'process-isolated-independent-implementation-v1',
    })
  ));
  const certificateSet = buildTypedNumericOracleCertificateSet({
    analysisProtocolHash: fixture.protocol.analysisProtocolHash,
    experimentAttemptId: authority.experimentAttemptId,
    sourceLineageHash: authority.sourceLineageHash,
    requiredOracleTypes: profile.typedOracleKinds,
    certificates,
  });
  return buildRepositoryAnalysisObservationAuthority({
    observations,
    rawEventManifestHash: authority.rawEventManifestHash,
    rawEventArtifactHash: authority.rawEventArtifactHash,
    rawEventRecomputationManifestHash: authority.rawEventRecomputationManifestHash,
    propertyOracleVerified: overrides.propertyOracleVerified ?? true,
    rawObservationRecomputationVerified:
      overrides.rawObservationRecomputationVerified ?? true,
    aggregateResidual: overrides.aggregateResidual ?? 0,
    toleranceSatisfied: overrides.toleranceSatisfied ?? true,
    candidateConvergenceClaim: overrides.candidateConvergenceClaim ?? null,
    candidateConditionNumber: overrides.candidateConditionNumber ?? null,
    independentResidualRecomputationVerified: true,
    independentRecomputationAssuranceHash: assurance,
    independentVerifierImplementationHash: verifier,
    typedNumericOracleCertificateSet: certificateSet,
    experimentAttemptId: authority.experimentAttemptId,
    sourceLineageHash: authority.sourceLineageHash,
    analysisProtocol: fixture.protocol,
  });
}

function operatorHarnessDefinition(benchmarkFamily, { seedCount, repetitionCount } = {}) {
  const seedSchedule = Array.from({ length: seedCount }, (_, index) => 10_000 + index);
  const oracle = benchmarkFamily === 'rl_stochastic_control_benchmark'
    ? { constraintLimit: 0, disturbance: 0, target: 0 }
    : { label: 0, robustLabel: 0 };
  return {
    version: 1,
    kind: 'OperatorAuthorizedDatasetBenchmarkHarness',
    benchmarkId: `operator-${benchmarkFamily}`,
    benchmarkFamily,
    seedSchedule,
    minimumRepetitions: repetitionCount,
    cells: seedSchedule.flatMap((seed) => Array.from({ length: repetitionCount }, (_, repetition) => ({
      seed,
      repetition: repetition + 1,
      cases: Array.from({ length: 8 }, (__, caseIndex) => ({
        caseId: hashRecord('AnalysisProtocolOperatorHarnessCase', {
          benchmarkFamily, seed, repetition, caseIndex,
        }),
        input: { value: caseIndex },
        ablationInput: { value: 0 },
        referenceResponse: 0,
        oracle,
      })),
    }))),
  };
}

function evaluationInputs(fixture, observations, authority = authorityFor(observations)) {
  return Object.freeze({
    analysisProtocol: fixture.protocol,
    observations,
    observationAuthority: canonicalAuthorityFor(fixture, observations, authority),
    benchmarkId: fixture.protocol.benchmarkId,
    benchmarkFamily: fixture.protocol.benchmarkFamily,
    requiredMetrics: fixture.protocol.requiredMetrics,
    metricSpecs: fixture.protocol.metricSpecs,
  });
}

function evaluateFixture(fixture, observations, authority = authorityFor(observations)) {
  return evaluateAnalysisProtocol(evaluationInputs(fixture, observations, authority));
}

function rehashAnalysisEvaluation(evaluation) {
  const value = structuredClone(evaluation);
  const diagnostics = value.clusterDiagnostics;
  delete diagnostics.academicAnalysisClusterDiagnosticsHash;
  diagnostics.academicAnalysisClusterDiagnosticsHash = hashRecord(
    'AcademicAnalysisClusterDiagnostics', diagnostics,
  );
  value.clusterDiagnosticsHash = diagnostics.academicAnalysisClusterDiagnosticsHash;
  delete value.academicAnalysisProtocolEvaluationHash;
  value.academicAnalysisProtocolEvaluationHash = hashRecord('AcademicAnalysisProtocolEvaluation', value);
  return value;
}

test('all five canonical families have exact fail-closed protocols and authority-recomputed evaluations', () => {
  for (const family of FAMILIES) {
    const fixture = protocolFixture(family);
    assert.equal(verifyAnalysisProtocol(fixture.protocol, {
      benchmarkId: family,
      benchmarkFamily: family,
      requiredMetrics: fixture.design.requiredMetrics,
      metricSpecs: fixture.design.metricSpecs,
    }), true, family);
    const clustered = ['rl_stochastic_control_benchmark', 'econometrics_panel_benchmark',
      'finance_asset_pricing_benchmark'].includes(family);
    const observations = observationsForSchedule(fixture.protocol, clustered
      ? { seedCount: 32, repetitionCount: 2 }
      : { seedCount: 4, repetitionCount: 8 });
    const authority = authorityFor(observations, family);
    const evaluated = evaluateFixture(fixture, observations, authority);
    assert.equal(evaluated.status, 'academic_analysis_protocol_verified', `${family}:${JSON.stringify(evaluated.blockers)}`);
    assert.equal(evaluated.executionStatus, 'analysis_execution_completed');
    assert.equal(evaluated.integrityStatus, 'analysis_integrity_verified');
    assert.equal(evaluated.scientificVerdict, 'positive');
    assert.equal(evaluated.agentAggregatesAccepted, false);
    assert.equal(evaluated.hypotheses.length, 2);
    assert.equal(evaluated.hypotheses.every((row) => row.accepted), true);
    assert.equal(evaluated.rawCellCount, clustered ? 64 : 32);
    assert.equal(evaluated.independentUnitCount, 32);
    assert.equal(evaluated.clusterDiagnostics.clusterCount, clustered ? 32 : 4);
    assert.equal(evaluated.clusterDiagnostics.armBalanced, true);
    assert.equal(evaluated.clusterDiagnostics.repetitionScheduleBalanced, true);
    assert.equal(evaluated.clusterDiagnostics.clusterSizeBalanced, true);
    assert.equal(evaluated.inferenceProfileHash, fixture.protocol.inferenceProfileHash);
    assert.equal(evaluated.hypotheses.every((row) => row.count === 32), true);
    assert.equal(evaluated.hypotheses.every((row) => row.bootstrap.method === (clustered
      ? 'deterministic-seed-cluster-percentile-bootstrap-v1'
      : 'deterministic-paired-percentile-bootstrap-v1')), true);
    assert.equal(verifyAnalysisProtocolEvaluation(evaluated, {
      analysisProtocol: fixture.protocol,
      observations,
      observationAuthority: canonicalAuthorityFor(fixture, observations, authority),
      benchmarkId: family,
      benchmarkFamily: family,
      requiredMetrics: fixture.protocol.requiredMetrics,
      metricSpecs: fixture.protocol.metricSpecs,
    }), true);
  }
});

test('inference profiles are family-locked, versioned, hash-bound, and assumption tamper resistant', () => {
  for (const family of FAMILIES) {
    const profile = buildAcademicAnalysisInferenceProfile({ benchmarkFamily: family });
    assert.equal(profile.version, 1);
    assert.equal(profile.kind, 'AcademicAnalysisInferenceProfile');
    assert.equal(verifyAcademicAnalysisInferenceProfile(profile, { benchmarkFamily: family }), true);
    const tampered = structuredClone(profile);
    tampered.assumptions.independentAcross = 'repetitions-are-independent';
    assert.equal(verifyAcademicAnalysisInferenceProfile(tampered, { benchmarkFamily: family }), false);
  }

  const rl = protocolFixture('rl_stochastic_control_benchmark').protocol;
  const ml = protocolFixture('ml_algorithm_benchmark').protocol;
  const substitution = structuredClone(rl);
  delete substitution.analysisProtocolHash;
  substitution.inferenceProfile = structuredClone(ml.inferenceProfile);
  substitution.inferenceProfileHash = ml.inferenceProfileHash;
  assert.throws(() => validateAnalysisProtocol(substitution), /analysis_protocol_inference_profile_invalid/);

  const hashTamper = structuredClone(rl);
  delete hashTamper.analysisProtocolHash;
  hashTamper.inferenceProfileHash = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateAnalysisProtocol(hashTamper), /analysis_protocol_inference_profile_hash_invalid/);

  const assumptionTamper = structuredClone(rl);
  delete assumptionTamper.analysisProtocolHash;
  assumptionTamper.assumptions.independenceScope = 'seed-repetitions-are-independent';
  assert.throws(() => validateAnalysisProtocol(assumptionTamper), /analysis_protocol_assumptions_invalid/);
});

test('cluster families cannot manufacture power by increasing within-seed repetitions', () => {
  const clustered = protocolFixture('rl_stochastic_control_benchmark');
  const pseudoReplicated = observationsForSchedule(clustered.protocol, { seedCount: 1, repetitionCount: 40 });
  const clusteredEvaluation = evaluateFixture(clustered, pseudoReplicated, authorityFor(pseudoReplicated, 'pseudo'));
  assert.equal(clusteredEvaluation.status, 'academic_analysis_protocol_verified');
  assert.equal(clusteredEvaluation.integrityStatus, 'analysis_integrity_verified');
  assert.equal(clusteredEvaluation.scientificVerdict, 'inconclusive');
  assert.equal(clusteredEvaluation.rawCellCount, 40);
  assert.equal(clusteredEvaluation.independentUnitCount, 1);
  assert.deepEqual(clusteredEvaluation.blockers, []);
  assert.ok(clusteredEvaluation.scientificFindings.includes('analysis_independent_unit_count_insufficient'));

  const cellPaired = protocolFixture('ml_algorithm_benchmark');
  const completeCells = observationsForSchedule(cellPaired.protocol, { seedCount: 1, repetitionCount: 32 });
  const cellEvaluation = evaluateFixture(cellPaired, completeCells, authorityFor(completeCells, 'cell-paired'));
  assert.equal(cellEvaluation.status, 'academic_analysis_protocol_verified', JSON.stringify(cellEvaluation.blockers));
  assert.equal(cellEvaluation.rawCellCount, 32);
  assert.equal(cellEvaluation.independentUnitCount, 32);
});

test('builtin and operator harness schedules count power in profile-defined independent units', () => {
  for (const family of FAMILIES) {
    const selector = buildCampaignBenchmarkSelector({ benchmarkId: family, datasetMounts: [] });
    const design = selector.experimentDesign;
    const clustered = design.analysisProtocol.inferenceProfile.independentUnit === 'seed-cluster-v1';
    const independentUnits = clustered
      ? design.seedSchedule.length
      : design.seedSchedule.length * design.minimumRepetitions;
    assert.ok(independentUnits >= design.analysisProtocol.power.requiredPairedObservations, family);
    if (clustered) {
      assert.equal(design.seedSchedule.length, design.analysisProtocol.power.requiredPairedObservations, family);
      assert.equal(design.minimumRepetitions, 2, family);
    }
  }

  const pseudoPoweredClusterHarness = operatorHarnessDefinition('rl_stochastic_control_benchmark', {
    seedCount: 5, repetitionCount: 7,
  });
  assert.throws(
    () => validateOperatorDatasetHarnessDefinition(pseudoPoweredClusterHarness),
    /operator_dataset_harness_schedule_invalid/,
  );
  const independentlyPoweredClusterHarness = operatorHarnessDefinition('rl_stochastic_control_benchmark', {
    seedCount: 32, repetitionCount: 1,
  });
  assert.equal(validateOperatorDatasetHarnessDefinition(independentlyPoweredClusterHarness)
    .definition.seedSchedule.length, 32);
  const cellPairedHarness = operatorHarnessDefinition('ml_algorithm_benchmark', {
    seedCount: 5, repetitionCount: 7,
  });
  assert.equal(validateOperatorDatasetHarnessDefinition(cellPairedHarness)
    .definition.cells.length, 35);
});

test('cluster arm, repetition schedule, and size imbalance fail closed', () => {
  const fixture = protocolFixture('econometrics_panel_benchmark');
  const complete = observationsForSchedule(fixture.protocol, { seedCount: 32, repetitionCount: 2 });

  const armImbalanced = complete.filter((item) => !(
    item.seed === 2000 && item.repetition === 2 && item.arm === 'ablation'
  ));
  const armEvaluation = evaluateFixture(fixture, armImbalanced, authorityFor(armImbalanced, 'arm-imbalanced'));
  assert.equal(armEvaluation.status, 'academic_analysis_protocol_blocked');
  assert.ok(armEvaluation.blockers.includes('analysis_cluster_arm_imbalanced'));

  const sizeImbalanced = complete.filter((item) => !(item.seed === 2000 && item.repetition === 2));
  const sizeEvaluation = evaluateFixture(fixture, sizeImbalanced, authorityFor(sizeImbalanced, 'size-imbalanced'));
  assert.equal(sizeEvaluation.status, 'academic_analysis_protocol_blocked');
  assert.ok(sizeEvaluation.blockers.includes('analysis_cluster_size_imbalanced'));
  assert.ok(sizeEvaluation.blockers.includes('analysis_cluster_repetition_schedule_imbalanced'));

  const repetitionImbalanced = structuredClone(complete);
  for (const item of repetitionImbalanced) {
    if (item.seed === 2000 && item.repetition === 2) item.repetition = 3;
  }
  const repetitionEvaluation = evaluateFixture(
    fixture, repetitionImbalanced, authorityFor(repetitionImbalanced, 'repetition-imbalanced'),
  );
  assert.equal(repetitionEvaluation.status, 'academic_analysis_protocol_blocked');
  assert.ok(repetitionEvaluation.blockers.includes('analysis_cluster_repetition_schedule_imbalanced'));
});

test('protocol absence, payload tamper, unknown methods, and false power claims fail closed', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const observations = observationsFor(fixture.protocol);
  assert.ok(evaluateAnalysisProtocol({ observations, observationAuthority: authorityFor(observations) }).blockers.includes('analysis_protocol_invalid'));

  const tampered = structuredClone(fixture.protocol);
  tampered.uncertainty.confidenceLevel = 0.9;
  assert.equal(verifyAnalysisProtocol(tampered, {
    benchmarkId: fixture.protocol.benchmarkId,
    benchmarkFamily: fixture.protocol.benchmarkFamily,
    requiredMetrics: fixture.protocol.requiredMetrics,
    metricSpecs: fixture.protocol.metricSpecs,
  }), false);

  const unknown = structuredClone(fixture.protocol);
  delete unknown.analysisProtocolHash;
  unknown.uncertainty.method = 'agent-selected-confidence-interval';
  assert.throws(() => validateAnalysisProtocol(unknown), /analysis_protocol_uncertainty_invalid/);

  const falsePower = structuredClone(fixture.protocol);
  delete falsePower.analysisProtocolHash;
  falsePower.power.requiredPairedObservations = 2;
  assert.throws(() => validateAnalysisProtocol(falsePower), /analysis_protocol_power_design_mismatch/);
});

test('canonical core profile rejects legacy v1 observation authority', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const observations = observationsFor(fixture.protocol);
  const legacy = authorityFor(observations, 'canonical-core-v1');
  const evaluated = evaluateAnalysisProtocol({
    ...evaluationInputs(fixture, observations, legacy),
    observationAuthority: legacy,
  });
  assert.ok(evaluated.blockers.includes('analysis_canonical_numeric_authority_v3_required'));
  assert.throws(() => buildRepositoryAnalysisObservationAuthority({
    observations,
    experimentAttemptId: 'canonical-core-omission',
    sourceLineageHash: hashRecord('CanonicalCoreOmission', {}),
    analysisProtocol: fixture.protocol,
  }), /analysis_observation_canonical_numeric_evidence_required/);
});

test('Holm correction supports more than two predeclared hypotheses and is recomputed by authority', () => {
  const base = protocolFixture('ml_algorithm_benchmark');
  const hypotheses = ['baseline', 'ablation'].flatMap((comparator) => [
    {
      hypothesisId: `primary-treatment-vs-${comparator}`,
      metric: 'mean_score', comparator, alternative: 'greater', minimumEffect: 0, acceptanceRequired: true,
    },
    {
      hypothesisId: `robustness-treatment-vs-${comparator}`,
      metric: 'robustness_gap', comparator, alternative: 'greater', minimumEffect: 0, acceptanceRequired: true,
    },
  ]);
  const fixture = protocolFixture('ml_algorithm_benchmark', { hypotheses });
  assert.equal(fixture.protocol.hypotheses.length, 4);
  assert.equal(fixture.protocol.power.requiredPairedObservations > base.protocol.power.requiredPairedObservations, true);
  const observations = observationsFor(fixture.protocol, fixture.protocol.power.requiredPairedObservations);
  const evaluated = evaluateFixture(fixture, observations, authorityFor(observations));
  assert.equal(evaluated.status, 'academic_analysis_protocol_verified', JSON.stringify(evaluated.blockers));
  assert.deepEqual(evaluated.hypotheses.map((row) => row.holmRank).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(evaluated.hypotheses.every((row) => row.adjustedPValue <= 0.05 && row.accepted), true);
});

test('missing pairs block integrity while distribution and sensitivity uncertainty remains reportable', () => {
  const missingFixture = protocolFixture('ml_algorithm_benchmark');
  const complete = observationsFor(missingFixture.protocol);
  const missing = complete.slice(1);
  const missingEvaluation = evaluateFixture(missingFixture, missing, authorityFor(missing));
  assert.equal(missingEvaluation.status, 'academic_analysis_protocol_blocked');
  assert.ok(missingEvaluation.blockers.some((blocker) => blocker.startsWith('analysis_missing_paired_arm:')));

  const outlierFixture = protocolFixture('econometrics_panel_benchmark');
  const observations = observationsFor(outlierFixture.protocol);
  for (const observation of observations) {
    if (observation.arm === 'treatment') observation.metrics.mean_effect = -1;
    else observation.metrics.mean_effect = 0;
  }
  observations.find((item) => item.arm === 'treatment').metrics.mean_effect = 100;
  const outlierEvaluation = evaluateFixture(outlierFixture, observations, authorityFor(observations));
  assert.equal(outlierEvaluation.status, 'academic_analysis_protocol_verified');
  assert.equal(outlierEvaluation.integrityStatus, 'analysis_integrity_verified');
  assert.equal(outlierEvaluation.scientificVerdict, 'inconclusive');
  assert.deepEqual(outlierEvaluation.blockers, []);
  assert.ok(outlierEvaluation.scientificFindings.some((finding) => finding.startsWith('analysis_assumption_diagnostic_failed:')));
  assert.ok(outlierEvaluation.scientificFindings.some((finding) => finding.startsWith('analysis_outlier_sensitivity_failed:')));
});

test('non-significant confirmatory outcomes complete with negative verdict and promotion/replay authority', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const observations = observationsFor(fixture.protocol);
  for (const observation of observations) {
    for (const metric of fixture.protocol.requiredMetrics) observation.metrics[metric] = 0.5;
  }
  const authority = authorityFor(observations, 'negative');
  const inputs = evaluationInputs(fixture, observations, authority);
  const evaluated = evaluateAnalysisProtocol(inputs);
  assert.equal(evaluated.status, 'academic_analysis_protocol_verified');
  assert.equal(evaluated.executionStatus, 'analysis_execution_completed');
  assert.equal(evaluated.integrityStatus, 'analysis_integrity_verified');
  assert.equal(evaluated.scientificVerdict, 'negative');
  assert.deepEqual(evaluated.blockers, []);
  assert.equal(evaluated.hypotheses.every((row) => row.scientificVerdict === 'negative'), true);
  assert.ok(evaluated.scientificFindings.some((finding) => finding.startsWith('analysis_confirmatory_hypothesis_not_supported:')));
  assert.equal(verifyAnalysisProtocolEvaluation(evaluated, inputs), true);
  assert.deepEqual(academicAnalysisPromotionBlockers(evaluated, inputs), []);

  const replay = evaluateAnalysisProtocol(evaluationInputs(
    fixture, observations, authorityFor(observations, 'negative-replay'),
  ));
  const binding = buildAnalysisProtocolReplayBinding({ originalEvaluation: evaluated, replayEvaluation: replay });
  assert.equal(binding.status, 'academic_analysis_protocol_replay_verified');
  assert.equal(binding.originalScientificVerdict, 'negative');
  assert.equal(verifyAnalysisProtocolReplayBinding(binding), true);
});

test('academic protocol is the sole inferential authority when compatibility statistics disagree', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const observations = observationsFor(fixture.protocol);
  const academicAuthority = authorityFor(observations);
  const academicInputs = evaluationInputs(fixture, observations, academicAuthority);
  const academicAccepted = evaluateAnalysisProtocol(academicInputs);
  const incompatibleLegacyDesign = structuredClone(fixture.design);
  incompatibleLegacyDesign.statisticalAnalysisPolicy.requiredPairedObservations -= 1;
  const legacyRejected = evaluateSystemBenchmarkStatisticalPolicy({
    observations,
    experimentDesign: incompatibleLegacyDesign,
  });
  assert.equal(legacyRejected.status, 'system_benchmark_statistical_policy_blocked');
  assert.equal(verifySystemBenchmarkStatisticalCompatibilityEvidence(legacyRejected), true);
  const tamperedLegacy = structuredClone(legacyRejected);
  tamperedLegacy.promotionBlocking = true;
  assert.equal(verifySystemBenchmarkStatisticalCompatibilityEvidence(tamperedLegacy), false);
  assert.deepEqual(SYSTEM_BENCHMARK_STATISTICAL_COMPATIBILITY_ROLE, {
    evidenceRole: 'descriptive-compatibility-only-v1', inferentialAuthority: false,
    promotionBlocking: false, authoritativeEvaluationKind: 'AcademicAnalysisProtocolEvaluation',
  });
  assert.equal(academicAccepted.inferentialAuthority, true);
  assert.equal(academicAccepted.promotionBlocking, true);
  assert.deepEqual(academicAnalysisPromotionBlockers(academicAccepted), [
    'academic_analysis_protocol_evaluation_authority_required',
  ]);
  assert.deepEqual(academicAnalysisPromotionBlockers(academicAccepted, academicInputs), []);

  const legacyAccepted = evaluateSystemBenchmarkStatisticalPolicy({ observations, experimentDesign: fixture.design });
  const rejectedAuthority = authorityFor(observations, 'rejected', {
    propertyOracleVerified: false,
  });
  const rejectedInputs = evaluationInputs(fixture, observations, rejectedAuthority);
  const academicRejected = evaluateAnalysisProtocol(rejectedInputs);
  assert.equal(legacyAccepted.status, 'system_benchmark_statistical_policy_verified');
  assert.ok(academicAnalysisPromotionBlockers(
    academicRejected,
    rejectedInputs,
  ).includes('analysis_property_oracle_unverified'));
  const tampered = structuredClone(academicAccepted);
  tampered.hypotheses[0].estimate += 1;
  assert.deepEqual(academicAnalysisPromotionBlockers(tampered, academicInputs), [
    'academic_analysis_protocol_evaluation_invalid',
  ]);
  const fullyRehashedHypothesisTamper = structuredClone(academicAccepted);
  fullyRehashedHypothesisTamper.hypotheses[0].estimate += 1;
  fullyRehashedHypothesisTamper.hypotheses[0].pValue = 0;
  const forgedPromotionEvaluation = rehashAnalysisEvaluation(fullyRehashedHypothesisTamper);
  assert.deepEqual(academicAnalysisPromotionBlockers(forgedPromotionEvaluation), [
    'academic_analysis_protocol_evaluation_authority_required',
  ]);
  assert.deepEqual(academicAnalysisPromotionBlockers(forgedPromotionEvaluation, academicInputs), [
    'academic_analysis_protocol_evaluation_invalid',
  ]);
});

test('numeric residual, tolerance, convergence, condition, and property-oracle claims fail closed', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const observations = observationsFor(fixture.protocol);
  const cases = [
    [{ aggregateResidual: 1 }, 'analysis_numeric_residual_tolerance_exceeded'],
    [{ toleranceSatisfied: false }, 'analysis_numeric_tolerance_unsatisfied'],
    [{ candidateConvergenceClaim: true }, 'analysis_candidate_convergence_claim_not_authoritative'],
    [{ candidateConditionNumber: 1e15 }, 'analysis_candidate_condition_claim_not_authoritative'],
    [{ propertyOracleVerified: false }, 'analysis_property_oracle_unverified'],
    [{ rawObservationRecomputationVerified: false }, 'analysis_raw_observation_recomputation_unverified'],
  ];
  for (const [overrides, blocker] of cases) {
    const evaluated = evaluateFixture(fixture, observations, authorityFor(observations, blocker, overrides));
    assert.equal(evaluated.status, 'academic_analysis_protocol_blocked', blocker);
    assert.ok(evaluated.blockers.includes(blocker), `${blocker}:${JSON.stringify(evaluated.blockers)}`);
  }
});

test('dataset-backed local authority binds the operator analysis protocol without academic promotion', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const operatorAuthority = {
    analysisProtocol: fixture.design.analysisProtocol,
    analysisProtocolHash: fixture.design.analysisProtocolHash,
  };
  const localReceipt = {
    benchmarkSelector: {
      selectorType: 'authorized_dataset_mount',
      authorityScope: 'local-operator-golden-runtime-only-v1',
      academicPromotionEligible: false,
    },
    operatorDatasetHarnessAuthority: operatorAuthority,
  };
  assert.equal(verifyHarnessOperatorAnalysisProtocolAuthority(
    localReceipt, fixture.design,
  ), true);
  assert.equal(verifyHarnessOperatorAnalysisProtocolAuthority({
    ...localReceipt,
    operatorDatasetHarnessAuthority: {
      ...operatorAuthority,
      analysisProtocolHash: hashRecord('WrongOperatorProtocol', {}),
    },
  }, fixture.design), false);
  assert.equal(verifyHarnessOperatorAnalysisProtocolAuthority({
    benchmarkSelector: { selectorType: 'builtin_benchmark_suite' },
    operatorDatasetHarnessAuthority: operatorAuthority,
  }, fixture.design), false);
  assert.equal(verifyHarnessOperatorAnalysisProtocolAuthority({
    benchmarkSelector: { selectorType: 'builtin_benchmark_suite' },
    operatorDatasetHarnessAuthority: null,
  }, fixture.design), true);
});

test('self-minted property-oracle booleans cannot replace per-cell hidden-oracle recomputation evidence', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const observations = observationsFor(fixture.protocol);
  const protocols = new Map(fixture.design.benchmarkHarness.armProtocolSet.protocols.map((item) => [item.arm, item]));
  const cells = observations.map((observation, index) => ({
    ...observation,
    cellId: hashRecord('AnalysisProtocolUntrustedCell', { index }),
    armProtocol: protocols.get(observation.arm),
    systemBenchmarkArmProtocolHash: protocols.get(observation.arm).systemBenchmarkArmProtocolHash,
    armAdapter: { sourceHash: hashRecord('AnalysisProtocolUntrustedAdapter', { arm: observation.arm }) },
    armBatchExecutionReceiptHash: hashRecord('AnalysisProtocolUntrustedBatch', { arm: observation.arm }),
    systemBenchmarkCellChallengeHash: hashRecord('AnalysisProtocolUntrustedChallenge', { index }),
    systemBenchmarkCellOracleHash: hashRecord('AnalysisProtocolUntrustedOracle', { index }),
    rawEventArtifactHash: hashRecord('AnalysisProtocolUntrustedRawEvent', { index }),
    rawEventCount: 8,
    metricComputation: 'agent-self-reported-property-oracle',
    systemBenchmarkArmProtocolExecutionReceiptHash: hashRecord('AnalysisProtocolUntrustedExecution', { index }),
  }));
  const rawEventManifestHash = hashRecord('SystemBenchmarkRawEventManifest', cells.map((cell) => ({
    cellId: cell.cellId,
    rawEventArtifactHash: cell.rawEventArtifactHash,
    rawEventCount: cell.rawEventCount,
    systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
    systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
  })));
  const receipt = {
    cells,
    scheduleCellCount: cells.length,
    rawEventManifestHash,
    rawEventArtifactHash: hashRecord('AnalysisProtocolUntrustedRawArtifact', {}),
    systemBenchmarkHarnessImplementationHash: fixture.design.benchmarkHarness.systemBenchmarkHarnessImplementationHash,
    experimentAttemptId: 'untrusted-attempt',
    sourceLineageHash: hashRecord('AnalysisProtocolUntrustedSource', {}),
    benchmarkId: fixture.protocol.benchmarkId,
    assuranceScope: 'synthetic-conformance-only-not-academic-promotion-v1',
    operatorDatasetHarnessAuthority: null,
  };
  const systemAuthority = buildHarnessAnalysisObservationAuthority(receipt);
  assert.equal(systemAuthority.propertyOracleVerified, false);
  assert.equal(systemAuthority.rawObservationRecomputationVerified, false);

  const forgedAuthority = authorityFor(observations, 'self-minted');
  const forgedEvaluation = evaluateFixture(fixture, observations, forgedAuthority);
  assert.equal(forgedEvaluation.status, 'academic_analysis_protocol_verified');
  Object.assign(receipt, {
    analysisProtocol: fixture.protocol,
    analysisProtocolHash: fixture.protocol.analysisProtocolHash,
    analysisObservationAuthority: forgedAuthority,
    analysisProtocolEvaluation: forgedEvaluation,
  });
  assert.equal(verifyHarnessAnalysisProtocolBinding(receipt, fixture.design), false);
});

test('original/replay binding rejects protocol mismatch and shared observation authority', () => {
  const fixture = protocolFixture('ml_algorithm_benchmark');
  const observations = observationsFor(fixture.protocol);
  const originalAuthority = authorityFor(observations, 'original');
  const replayAuthority = authorityFor(observations, 'replay');
  const original = evaluateFixture(fixture, observations, originalAuthority);
  const replay = evaluateFixture(fixture, observations, replayAuthority);
  const binding = buildAnalysisProtocolReplayBinding({ originalEvaluation: original, replayEvaluation: replay });
  assert.equal(binding.status, 'academic_analysis_protocol_replay_verified');
  assert.equal(verifyAnalysisProtocolReplayBinding(binding), true);
  assert.equal(binding.inferenceProfileHash, fixture.protocol.inferenceProfileHash);
  assert.equal(binding.originalRawCellCount, original.rawCellCount);
  assert.equal(binding.replayRawCellCount, replay.rawCellCount);
  assert.equal(binding.originalIndependentUnitCount, original.independentUnitCount);
  assert.equal(binding.replayIndependentUnitCount, replay.independentUnitCount);
  assert.equal(binding.originalClusterDiagnosticsHash, original.clusterDiagnosticsHash);
  assert.equal(binding.replayClusterDiagnosticsHash, replay.clusterDiagnosticsHash);

  const otherFixture = protocolFixture('ml_algorithm_benchmark', {
    hypotheses: [{
      hypothesisId: 'only-baseline', metric: 'mean_score', comparator: 'baseline',
      alternative: 'greater', minimumEffect: 0, acceptanceRequired: true,
    }],
  });
  const otherObservations = observationsFor(otherFixture.protocol);
  const other = evaluateFixture(otherFixture, otherObservations, authorityFor(otherObservations, 'other'));
  const mismatch = buildAnalysisProtocolReplayBinding({ originalEvaluation: original, replayEvaluation: other });
  assert.equal(mismatch.status, 'academic_analysis_protocol_replay_blocked');
  assert.ok(mismatch.blockers.includes('analysis_replay_protocol_mismatch'));

  const shared = buildAnalysisProtocolReplayBinding({ originalEvaluation: original, replayEvaluation: original });
  assert.ok(shared.blockers.includes('analysis_replay_observation_authority_not_independent'));

  const structurallyForgedOriginal = structuredClone(original);
  structurallyForgedOriginal.rawCellCount = 999;
  structurallyForgedOriginal.pairedUnitCount = 999;
  structurallyForgedOriginal.independentUnitCount = 999;
  structurallyForgedOriginal.clusterDiagnostics.rawCellCount = 999;
  structurallyForgedOriginal.clusterDiagnostics.independentUnitCount = 999;
  structurallyForgedOriginal.clusterDiagnostics.independentUnit = 'attacker-controlled-unit';
  const structurallyForgedReplay = structuredClone(replay);
  structurallyForgedReplay.rawCellCount = 999;
  structurallyForgedReplay.pairedUnitCount = 999;
  structurallyForgedReplay.independentUnitCount = 999;
  structurallyForgedReplay.clusterDiagnostics.rawCellCount = 999;
  structurallyForgedReplay.clusterDiagnostics.independentUnitCount = 999;
  structurallyForgedReplay.clusterDiagnostics.independentUnit = 'attacker-controlled-unit';
  const fullyRehashedOriginal = rehashAnalysisEvaluation(structurallyForgedOriginal);
  const fullyRehashedReplay = rehashAnalysisEvaluation(structurallyForgedReplay);
  const fullyRehashedForgery = buildAnalysisProtocolReplayBinding({
    originalEvaluation: fullyRehashedOriginal,
    replayEvaluation: fullyRehashedReplay,
  });
  assert.ok(fullyRehashedForgery.blockers.includes('analysis_original_evaluation_invalid'));
  assert.ok(fullyRehashedForgery.blockers.includes('analysis_replay_evaluation_invalid'));
  assert.equal(verifyAnalysisProtocolReplayBinding(fullyRehashedForgery), false);
  assert.deepEqual(academicAnalysisPromotionBlockers(
    fullyRehashedOriginal,
    evaluationInputs(fixture, observations, originalAuthority),
  ), [
    'academic_analysis_protocol_evaluation_invalid',
  ]);

  const attackerProtocolHash = hashRecord('AttackerSubstitutedAnalysisProtocol', { forged: true });
  const protocolHashForgedOriginal = structuredClone(original);
  protocolHashForgedOriginal.analysisProtocolHash = attackerProtocolHash;
  const protocolHashForgedReplay = structuredClone(replay);
  protocolHashForgedReplay.analysisProtocolHash = attackerProtocolHash;
  const protocolHashForgery = buildAnalysisProtocolReplayBinding({
    originalEvaluation: rehashAnalysisEvaluation(protocolHashForgedOriginal),
    replayEvaluation: rehashAnalysisEvaluation(protocolHashForgedReplay),
  });
  assert.ok(protocolHashForgery.blockers.includes('analysis_original_evaluation_invalid'));
  assert.ok(protocolHashForgery.blockers.includes('analysis_replay_evaluation_invalid'));
  assert.equal(verifyAnalysisProtocolReplayBinding(protocolHashForgery), false);

  const rescheduledObservations = observations.map((observation) => ({
    ...observation,
    seed: observation.seed + 100_000,
  }));
  const rescheduled = evaluateFixture(
    fixture,
    rescheduledObservations,
    authorityFor(rescheduledObservations, 'rescheduled-replay'),
  );
  assert.equal(rescheduled.status, 'academic_analysis_protocol_verified');
  const rescheduledBinding = buildAnalysisProtocolReplayBinding({
    originalEvaluation: original,
    replayEvaluation: rescheduled,
  });
  assert.ok(rescheduledBinding.blockers.includes('analysis_replay_cluster_diagnostics_mismatch'));

  const tampered = structuredClone(original);
  tampered.hypotheses[0].estimate += 1;
  assert.equal(verifyAnalysisProtocolEvaluation(tampered, {
    analysisProtocol: fixture.protocol,
    observations,
    observationAuthority: originalAuthority,
    benchmarkId: fixture.protocol.benchmarkId,
    benchmarkFamily: fixture.protocol.benchmarkFamily,
    requiredMetrics: fixture.protocol.requiredMetrics,
    metricSpecs: fixture.protocol.metricSpecs,
  }), false);
});
