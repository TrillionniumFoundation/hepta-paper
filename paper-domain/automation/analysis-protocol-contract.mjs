import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { requiredPairedObservations } from './analysis-statistics.mjs';
import {
  buildAcademicAnalysisInferenceProfile,
  isSeedClusterInferenceProfile,
  validateAcademicAnalysisInferenceProfile,
} from './academic-analysis-inference-profile.mjs';
import {
  empiricalClaimBindingsFromUniverse,
  verifyEmpiricalClaimUniverse,
} from '../research/empirical-claim-contract.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
} from './autonomous-empirical-family-plugin-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export const ANALYSIS_PROTOCOL_FAMILY_PROFILES = Object.freeze(Object.fromEntries(
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles.map((profile) => [
    profile.benchmarkFamily,
    Object.freeze({
      primaryMetric: profile.primaryMetric,
      secondaryMetric: profile.secondaryMetric,
    }),
  ]),
));

const SUPPORTED_METHODS = Object.freeze({
  estimator: new Set([
    'paired-arithmetic-mean-difference-v1',
    'seed-cluster-aggregate-arithmetic-mean-difference-v1',
  ]),
  uncertainty: new Set([
    'deterministic-paired-percentile-bootstrap-v1',
    'deterministic-seed-cluster-percentile-bootstrap-v1',
  ]),
  test: new Set([
    'deterministic-paired-sign-flip-v1',
    'deterministic-seed-cluster-sign-flip-v1',
  ]),
  multiplicity: new Set(['holm-bonferroni-v1']),
  power: new Set(['predeclared-standardized-effect-normal-design-v1']),
  missingness: new Set(['fail-closed-complete-paired-cells-v1']),
  outlier: new Set(['winsorized-and-leave-one-out-sensitivity-v1']),
  residual: new Set(['authority-recomputed-aggregate-residual-v1']),
  convergence: new Set(['not-observable-no-candidate-convergence-claim-v1']),
  condition: new Set(['not-observable-no-candidate-condition-claim-v1']),
  propertyOracle: new Set(['repository-hidden-oracle-event-recomputation-v1']),
});

function boundedFinite(value, minimum, maximum) {
  return Number.isFinite(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
}

function normalizedHypothesis(value, metricSpecs, seen, { claimAuthorityRequired = false, claimIds = null } = {}) {
  const keys = [
    'hypothesisId', 'metric', 'comparator', 'alternative', 'minimumEffect', 'acceptanceRequired',
    ...(claimAuthorityRequired ? ['claimId', 'manuscriptClaimHash', 'proposalClaimRecordHash'] : []),
  ];
  if (!exactKeys(value, keys)) throw new Error('analysis_protocol_hypothesis_shape_invalid');
  const hypothesisId = String(value.hypothesisId || '');
  const claimId = claimAuthorityRequired ? String(value.claimId || '') : null;
  const metric = String(value.metric || '');
  const comparator = String(value.comparator || '');
  const alternative = String(value.alternative || '');
  if (!IDENTIFIER.test(hypothesisId) || seen.has(hypothesisId) || !Object.hasOwn(metricSpecs, metric)
    || !['baseline', 'ablation'].includes(comparator)
    || !['greater', 'less'].includes(alternative)
    || (metricSpecs[metric].direction === 'maximize' ? alternative !== 'greater' : alternative !== 'less')
    || !boundedFinite(value.minimumEffect, 0, 1e12)
    || typeof value.acceptanceRequired !== 'boolean'
    || (claimAuthorityRequired && (!IDENTIFIER.test(claimId) || claimIds.has(claimId)
      || !SHA256.test(String(value.manuscriptClaimHash || ''))
      || (value.proposalClaimRecordHash !== null && !SHA256.test(String(value.proposalClaimRecordHash || '')))))) {
    throw new Error('analysis_protocol_hypothesis_invalid');
  }
  seen.add(hypothesisId);
  if (claimAuthorityRequired) claimIds.add(claimId);
  return Object.freeze({
    hypothesisId,
    ...(claimAuthorityRequired ? {
      claimId,
      manuscriptClaimHash: String(value.manuscriptClaimHash).toLowerCase(),
      proposalClaimRecordHash: value.proposalClaimRecordHash === null
        ? null : String(value.proposalClaimRecordHash).toLowerCase(),
    } : {}),
    metric,
    comparator,
    alternative,
    minimumEffect: Number(value.minimumEffect),
    acceptanceRequired: value.acceptanceRequired,
  });
}

function normalizedMetricSpecs(metricSpecs, requiredMetrics) {
  if (!metricSpecs || typeof metricSpecs !== 'object' || Array.isArray(metricSpecs)
    || Object.keys(metricSpecs).sort().join('\0') !== [...requiredMetrics].sort().join('\0')) {
    throw new Error('analysis_protocol_metric_specs_invalid');
  }
  return Object.freeze(Object.fromEntries([...requiredMetrics].sort().map((metric) => {
    const spec = metricSpecs[metric];
    if (!exactKeys(spec, ['unit', 'direction', 'minimum', 'maximum'])
      || !String(spec.unit || '') || !['maximize', 'minimize'].includes(spec.direction)
      || !boundedFinite(spec.minimum, -1e12, 1e12) || !boundedFinite(spec.maximum, -1e12, 1e12)
      || Number(spec.minimum) > Number(spec.maximum)) throw new Error('analysis_protocol_metric_spec_invalid');
    return [metric, Object.freeze({
      unit: String(spec.unit), direction: spec.direction,
      minimum: Number(spec.minimum), maximum: Number(spec.maximum),
    })];
  })));
}

export function validateAnalysisProtocol(value, {
  benchmarkId = null,
  benchmarkFamily = null,
  requiredMetrics = null,
  metricSpecs = null,
} = {}) {
  const claimAuthorityRequired = value?.version === 2;
  const topLevelKeys = [
    'version', 'kind', 'protocolId', 'benchmarkId', 'benchmarkFamily', 'requiredMetrics', 'metricSpecs',
    'inferenceProfile', 'inferenceProfileHash',
    'estimator', 'assumptions', 'pairedUnit', 'missingness', 'outlierSensitivity', 'uncertainty',
    'hypotheses', 'multiplicity', 'power', 'numericValidation', 'assuranceScope',
    ...(claimAuthorityRequired ? ['empiricalClaimUniverseHash', 'manuscriptCorpusHash'] : []),
  ];
  if (!exactKeys(value, topLevelKeys) || ![1, 2].includes(value.version) || value.kind !== 'AcademicAnalysisProtocol') {
    throw new Error('analysis_protocol_shape_invalid');
  }
  if (claimAuthorityRequired && (!SHA256.test(String(value.empiricalClaimUniverseHash || ''))
    || !SHA256.test(String(value.manuscriptCorpusHash || '')))) {
    throw new Error('analysis_protocol_empirical_claim_authority_invalid');
  }
  const id = String(value.benchmarkId || '');
  const family = String(value.benchmarkFamily || '');
  if (!IDENTIFIER.test(String(value.protocolId || '')) || !IDENTIFIER.test(id)
    || (benchmarkId && id !== benchmarkId) || !Object.hasOwn(ANALYSIS_PROTOCOL_FAMILY_PROFILES, family)
    || (benchmarkFamily && family !== benchmarkFamily)) throw new Error('analysis_protocol_identity_invalid');
  let inference = null;
  try {
    inference = validateAcademicAnalysisInferenceProfile(value.inferenceProfile, { benchmarkFamily: family });
  } catch { throw new Error('analysis_protocol_inference_profile_invalid'); }
  if (!SHA256.test(String(value.inferenceProfileHash || ''))
    || inference.inferenceProfileHash !== String(value.inferenceProfileHash).toLowerCase()) {
    throw new Error('analysis_protocol_inference_profile_hash_invalid');
  }
  const clusterInference = isSeedClusterInferenceProfile(inference.inferenceProfile);
  const metrics = (Array.isArray(value.requiredMetrics) ? value.requiredMetrics : []).map(String);
  if (metrics.length < 1 || metrics.length > 32 || new Set(metrics).size !== metrics.length
    || metrics.some((metric) => !IDENTIFIER.test(metric))
    || (requiredMetrics && JSON.stringify(metrics) !== JSON.stringify(requiredMetrics))) {
    throw new Error('analysis_protocol_required_metrics_invalid');
  }
  const normalizedSpecs = normalizedMetricSpecs(value.metricSpecs, metrics);
  if (metricSpecs && JSON.stringify(normalizedSpecs) !== JSON.stringify(normalizedMetricSpecs(metricSpecs, metrics))) {
    throw new Error('analysis_protocol_metric_specs_mismatch');
  }
  if (!exactKeys(value.estimator, ['method', 'treatmentArm', 'controlArms', 'directionNormalization'])
    || !SUPPORTED_METHODS.estimator.has(value.estimator.method)
    || value.estimator.method !== (clusterInference
      ? 'seed-cluster-aggregate-arithmetic-mean-difference-v1'
      : 'paired-arithmetic-mean-difference-v1')
    || value.estimator.treatmentArm !== 'treatment'
    || JSON.stringify(value.estimator.controlArms) !== JSON.stringify(['baseline', 'ablation'])
    || value.estimator.directionNormalization !== 'positive-is-treatment-improvement-v1') {
    throw new Error('analysis_protocol_estimator_invalid');
  }
  if (!exactKeys(value.assumptions, [
    'distribution', 'exchangeability', 'independenceScope', 'finiteObservationsRequired',
    'symmetryDiagnostic', 'maximumAbsoluteSkewness',
  ])
    || value.assumptions.distribution !== (clusterInference
      ? 'seed-cluster-mean-sign-symmetry-and-bootstrap-exchangeability-v1'
      : 'paired-sign-symmetry-and-bootstrap-exchangeability-v1')
    || value.assumptions.exchangeability !== (clusterInference
      ? 'operator-predeclared-fixed-seed-cluster-schedule-v1'
      : 'operator-predeclared-fixed-cell-schedule-v1')
    || value.assumptions.independenceScope !== (clusterInference
      ? 'independent-seed-clusters-dependent-within-seed-repetitions-v1'
      : 'paired-schedule-unit-only-no-independent-machine-claim-v1')
    || value.assumptions.finiteObservationsRequired !== true
    || value.assumptions.symmetryDiagnostic !== 'sample-skewness-bound-v1'
    || !boundedFinite(value.assumptions.maximumAbsoluteSkewness, 0.5, 20)
    || value.pairedUnit !== (clusterInference
      ? 'seed-after-within-seed-repetition-aggregation-v1'
      : 'seed-and-repetition-v1')) throw new Error('analysis_protocol_assumptions_invalid');
  if (!exactKeys(value.missingness, ['method', 'maximumMissingFraction'])
    || !SUPPORTED_METHODS.missingness.has(value.missingness.method)
    || value.missingness.maximumMissingFraction !== 0) throw new Error('analysis_protocol_missingness_invalid');
  if (!exactKeys(value.outlierSensitivity, [
    'method', 'lowerQuantile', 'upperQuantile', 'requireWinsorizedDirection', 'requireLeaveOneOutDirection',
  ]) || !SUPPORTED_METHODS.outlier.has(value.outlierSensitivity.method)
    || !boundedFinite(value.outlierSensitivity.lowerQuantile, 0, 0.25)
    || !boundedFinite(value.outlierSensitivity.upperQuantile, 0.75, 1)
    || Number(value.outlierSensitivity.lowerQuantile) >= Number(value.outlierSensitivity.upperQuantile)
    || value.outlierSensitivity.requireWinsorizedDirection !== true
    || value.outlierSensitivity.requireLeaveOneOutDirection !== true) {
    throw new Error('analysis_protocol_outlier_sensitivity_invalid');
  }
  if (!exactKeys(value.uncertainty, ['method', 'confidenceLevel', 'resamples', 'seed', 'testMethod', 'testDraws'])
    || !SUPPORTED_METHODS.uncertainty.has(value.uncertainty.method)
    || !SUPPORTED_METHODS.test.has(value.uncertainty.testMethod)
    || value.uncertainty.method !== (clusterInference
      ? 'deterministic-seed-cluster-percentile-bootstrap-v1'
      : 'deterministic-paired-percentile-bootstrap-v1')
    || value.uncertainty.testMethod !== (clusterInference
      ? 'deterministic-seed-cluster-sign-flip-v1'
      : 'deterministic-paired-sign-flip-v1')
    || !boundedFinite(value.uncertainty.confidenceLevel, 0.8, 0.999)
    || !Number.isSafeInteger(Number(value.uncertainty.resamples)) || Number(value.uncertainty.resamples) < 1000
    || Number(value.uncertainty.resamples) > 100_000
    || !Number.isSafeInteger(Number(value.uncertainty.testDraws)) || Number(value.uncertainty.testDraws) < 1000
    || Number(value.uncertainty.testDraws) > 100_000
    || !Number.isSafeInteger(Number(value.uncertainty.seed))) throw new Error('analysis_protocol_uncertainty_invalid');
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length < 1 || value.hypotheses.length > 32) {
    throw new Error('analysis_protocol_hypotheses_invalid');
  }
  const seen = new Set();
  const claimIds = new Set();
  const hypotheses = Object.freeze(value.hypotheses.map((item) => normalizedHypothesis(
    item, normalizedSpecs, seen, { claimAuthorityRequired, claimIds },
  )));
  if (!hypotheses.some((item) => item.acceptanceRequired)) throw new Error('analysis_protocol_confirmatory_hypothesis_required');
  if (!exactKeys(value.multiplicity, ['method', 'familyAlpha', 'family'])
    || !SUPPORTED_METHODS.multiplicity.has(value.multiplicity.method)
    || !boundedFinite(value.multiplicity.familyAlpha, 0.0001, 0.2)
    || value.multiplicity.family !== 'all-predeclared-hypotheses-v1') throw new Error('analysis_protocol_multiplicity_invalid');
  if (!exactKeys(value.power, ['method', 'targetPower', 'minimumStandardizedEffect', 'requiredPairedObservations'])
    || !SUPPORTED_METHODS.power.has(value.power.method)
    || !boundedFinite(value.power.targetPower, 0.5, 0.999)
    || !boundedFinite(value.power.minimumStandardizedEffect, 0.05, 10)
    || !Number.isSafeInteger(Number(value.power.requiredPairedObservations))
    || Number(value.power.requiredPairedObservations) < 2 || Number(value.power.requiredPairedObservations) > 100_000) {
    throw new Error('analysis_protocol_power_invalid');
  }
  const computedRequiredPairedObservations = requiredPairedObservations({
    alpha: Number(value.multiplicity.familyAlpha),
    targetPower: Number(value.power.targetPower),
    standardizedEffect: Number(value.power.minimumStandardizedEffect),
    hypothesisCount: hypotheses.length,
  });
  if (!Number.isSafeInteger(computedRequiredPairedObservations)
    || Number(value.power.requiredPairedObservations) !== computedRequiredPairedObservations) {
    throw new Error('analysis_protocol_power_design_mismatch');
  }
  if (!exactKeys(value.numericValidation, [
    'residual', 'convergence', 'condition', 'tolerances', 'propertyOracle', 'agentAggregatesAccepted',
  ]) || !exactKeys(value.numericValidation.residual, ['method', 'maximumAbsoluteResidual'])
    || !SUPPORTED_METHODS.residual.has(value.numericValidation.residual.method)
    || !boundedFinite(value.numericValidation.residual.maximumAbsoluteResidual, 0, 1)
    || !exactKeys(value.numericValidation.convergence, ['method', 'candidateClaimAccepted'])
    || !SUPPORTED_METHODS.convergence.has(value.numericValidation.convergence.method)
    || value.numericValidation.convergence.candidateClaimAccepted !== false
    || !exactKeys(value.numericValidation.condition, ['method', 'candidateClaimAccepted'])
    || !SUPPORTED_METHODS.condition.has(value.numericValidation.condition.method)
    || value.numericValidation.condition.candidateClaimAccepted !== false
    || !exactKeys(value.numericValidation.tolerances, ['absolute', 'relative'])
    || !boundedFinite(value.numericValidation.tolerances.absolute, 0, 1)
    || !boundedFinite(value.numericValidation.tolerances.relative, 0, 1)
    || !exactKeys(value.numericValidation.propertyOracle, ['method', 'required'])
    || !SUPPORTED_METHODS.propertyOracle.has(value.numericValidation.propertyOracle.method)
    || value.numericValidation.propertyOracle.required !== true
    || value.numericValidation.agentAggregatesAccepted !== false) throw new Error('analysis_protocol_numeric_validation_invalid');
  if (value.assuranceScope !== 'operator-signed-preregistered-analysis-protocol-v1') {
    throw new Error('analysis_protocol_assurance_scope_invalid');
  }
  const normalized = Object.freeze({
    version: value.version,
    kind: 'AcademicAnalysisProtocol',
    protocolId: String(value.protocolId),
    benchmarkId: id,
    benchmarkFamily: family,
    ...(claimAuthorityRequired ? {
      empiricalClaimUniverseHash: String(value.empiricalClaimUniverseHash).toLowerCase(),
      manuscriptCorpusHash: String(value.manuscriptCorpusHash).toLowerCase(),
    } : {}),
    requiredMetrics: Object.freeze(metrics),
    metricSpecs: normalizedSpecs,
    inferenceProfile: inference.inferenceProfile,
    inferenceProfileHash: inference.inferenceProfileHash,
    estimator: Object.freeze({
      method: value.estimator.method,
      treatmentArm: value.estimator.treatmentArm,
      controlArms: Object.freeze([...value.estimator.controlArms]),
      directionNormalization: value.estimator.directionNormalization,
    }),
    assumptions: Object.freeze({
      ...value.assumptions,
      maximumAbsoluteSkewness: Number(value.assumptions.maximumAbsoluteSkewness),
    }),
    pairedUnit: value.pairedUnit,
    missingness: Object.freeze({ method: value.missingness.method, maximumMissingFraction: 0 }),
    outlierSensitivity: Object.freeze({
      method: value.outlierSensitivity.method,
      lowerQuantile: Number(value.outlierSensitivity.lowerQuantile),
      upperQuantile: Number(value.outlierSensitivity.upperQuantile),
      requireWinsorizedDirection: true,
      requireLeaveOneOutDirection: true,
    }),
    uncertainty: Object.freeze({
      method: value.uncertainty.method,
      confidenceLevel: Number(value.uncertainty.confidenceLevel),
      resamples: Number(value.uncertainty.resamples),
      seed: Number(value.uncertainty.seed),
      testMethod: value.uncertainty.testMethod,
      testDraws: Number(value.uncertainty.testDraws),
    }),
    hypotheses,
    multiplicity: Object.freeze({
      method: value.multiplicity.method,
      familyAlpha: Number(value.multiplicity.familyAlpha),
      family: value.multiplicity.family,
    }),
    power: Object.freeze({
      method: value.power.method,
      targetPower: Number(value.power.targetPower),
      minimumStandardizedEffect: Number(value.power.minimumStandardizedEffect),
      requiredPairedObservations: Number(value.power.requiredPairedObservations),
    }),
    numericValidation: Object.freeze({
      residual: Object.freeze({
        method: value.numericValidation.residual.method,
        maximumAbsoluteResidual: Number(value.numericValidation.residual.maximumAbsoluteResidual),
      }),
      convergence: Object.freeze({ ...value.numericValidation.convergence }),
      condition: Object.freeze({ ...value.numericValidation.condition }),
      tolerances: Object.freeze({
        absolute: Number(value.numericValidation.tolerances.absolute),
        relative: Number(value.numericValidation.tolerances.relative),
      }),
      propertyOracle: Object.freeze({ ...value.numericValidation.propertyOracle }),
      agentAggregatesAccepted: false,
    }),
    assuranceScope: value.assuranceScope,
  });
  return Object.freeze({
    analysisProtocol: normalized,
    analysisProtocolHash: hashRecord('AcademicAnalysisProtocol', normalized),
  });
}

export function verifyAnalysisProtocol(value, context = {}) {
  if (!value || !SHA256.test(String(value.analysisProtocolHash || ''))) return false;
  const { analysisProtocolHash, ...document } = value;
  try {
    const validated = validateAnalysisProtocol(document, context);
    return validated.analysisProtocolHash === analysisProtocolHash
      && hashRecord('AcademicAnalysisProtocolExpected', validated.analysisProtocol)
        === hashRecord('AcademicAnalysisProtocolExpected', document);
  } catch { return false; }
}

function protocolContext(protocol) {
  return Object.freeze({
    benchmarkId: protocol?.benchmarkId,
    benchmarkFamily: protocol?.benchmarkFamily,
    requiredMetrics: protocol?.requiredMetrics,
    metricSpecs: protocol?.metricSpecs,
  });
}

function deterministicEmpiricalClaimId(analysisProtocolHash, hypothesisId) {
  return `empirical:${hashRecord('EmpiricalClaimId', {
    analysisProtocolHash,
    hypothesisId,
  }).slice('sha256:'.length)}`;
}

export function empiricalClaimDeclarationsFromAnalysisProtocol(protocol) {
  if (!verifyAnalysisProtocol(protocol, protocolContext(protocol))) {
    throw new Error('analysis_protocol_template_invalid');
  }
  return Object.freeze(protocol.hypotheses.map((hypothesis) => Object.freeze({
    claimId: protocol.version === 2
      ? hypothesis.claimId
      : deterministicEmpiricalClaimId(protocol.analysisProtocolHash, hypothesis.hypothesisId),
    metric: hypothesis.metric,
    comparator: hypothesis.comparator,
    alternative: hypothesis.alternative,
    minimumEffect: hypothesis.minimumEffect,
    acceptanceRequired: hypothesis.acceptanceRequired,
    proposalClaimRecordHash: protocol.version === 2 ? hypothesis.proposalClaimRecordHash : null,
  })));
}

export function bindAnalysisProtocolToEmpiricalClaimUniverse(protocol, empiricalClaimUniverse) {
  if (!verifyAnalysisProtocol(protocol, protocolContext(protocol))) {
    throw new Error('analysis_protocol_template_invalid');
  }
  if (!verifyEmpiricalClaimUniverse(empiricalClaimUniverse)) {
    throw new Error('analysis_protocol_empirical_claim_universe_invalid');
  }
  if (protocol.version === 2) {
    if (!analysisProtocolMatchesEmpiricalClaimUniverse(protocol, empiricalClaimUniverse)) {
      throw new Error('analysis_protocol_empirical_claim_universe_mismatch');
    }
    return protocol;
  }
  const declarations = empiricalClaimDeclarationsFromAnalysisProtocol(protocol);
  const bindings = empiricalClaimBindingsFromUniverse(empiricalClaimUniverse);
  const declarationFacts = declarations.map((declaration) => ({
    claimId: declaration.claimId,
    metric: declaration.metric,
    comparator: declaration.comparator,
    alternative: declaration.alternative,
    minimumEffect: declaration.minimumEffect,
    acceptanceRequired: declaration.acceptanceRequired,
  }));
  const bindingFacts = bindings.map((binding) => ({
    claimId: binding.claimId,
    metric: binding.metric,
    comparator: binding.comparator,
    alternative: binding.alternative,
    minimumEffect: binding.minimumEffect,
    acceptanceRequired: binding.acceptanceRequired,
  }));
  if (hashRecord('EmpiricalClaimDeclarationsExpected', declarationFacts)
    !== hashRecord('EmpiricalClaimDeclarationsExpected', bindingFacts)) {
    throw new Error('analysis_protocol_empirical_claim_declarations_mismatch');
  }
  const { analysisProtocolHash: _templateHash, ...template } = protocol;
  const document = {
    ...template,
    version: 2,
    empiricalClaimUniverseHash: empiricalClaimUniverse.empiricalClaimUniverseHash,
    manuscriptCorpusHash: empiricalClaimUniverse.manuscriptCorpusHash,
    hypotheses: protocol.hypotheses.map((hypothesis, index) => ({
      ...hypothesis,
      claimId: bindings[index].claimId,
      manuscriptClaimHash: bindings[index].manuscriptClaimHash,
      proposalClaimRecordHash: bindings[index].proposalClaimRecordHash,
    })),
  };
  const validated = validateAnalysisProtocol(document, protocolContext(protocol));
  return Object.freeze({
    ...validated.analysisProtocol,
    analysisProtocolHash: validated.analysisProtocolHash,
  });
}

export function buildCanonicalAnalysisProtocol({
  benchmarkId,
  benchmarkFamily = benchmarkId,
  requiredMetrics,
  metricSpecs,
  hypotheses = null,
  empiricalClaimUniverse = null,
} = {}) {
  const profile = ANALYSIS_PROTOCOL_FAMILY_PROFILES[benchmarkFamily];
  if (!profile) throw new Error('analysis_protocol_family_unsupported');
  const builtInferenceProfile = buildAcademicAnalysisInferenceProfile({ benchmarkFamily });
  const { inferenceProfileHash, ...inferenceProfile } = builtInferenceProfile;
  const clusterInference = isSeedClusterInferenceProfile(builtInferenceProfile);
  const metrics = [...(requiredMetrics || [])];
  if (!metrics.includes(profile.primaryMetric)) throw new Error('analysis_protocol_primary_metric_missing');
  const primaryDirection = metricSpecs?.[profile.primaryMetric]?.direction;
  const defaultHypotheses = ['baseline', 'ablation'].map((comparator) => ({
    hypothesisId: `primary-treatment-vs-${comparator}`,
    metric: profile.primaryMetric,
    comparator,
    alternative: primaryDirection === 'minimize' ? 'less' : 'greater',
    minimumEffect: 0,
    acceptanceRequired: true,
  }));
  if (empiricalClaimUniverse && !verifyEmpiricalClaimUniverse(empiricalClaimUniverse)) {
    throw new Error('analysis_protocol_empirical_claim_universe_invalid');
  }
  const claimBindings = empiricalClaimUniverse
    ? empiricalClaimBindingsFromUniverse(empiricalClaimUniverse)
    : null;
  if (claimBindings && hypotheses) throw new Error('analysis_protocol_agent_hypotheses_forbidden_with_claim_universe');
  const protocolHypotheses = claimBindings
    ? claimBindings.map((binding) => ({
      hypothesisId: `claim:${binding.claimId}`,
      ...binding,
    }))
    : (hypotheses || defaultHypotheses);
  const requiredObservationCount = requiredPairedObservations({
    alpha: 0.05,
    targetPower: 0.8,
    standardizedEffect: 0.5,
    hypothesisCount: protocolHypotheses.length,
  });
  const document = {
    version: claimBindings ? 2 : 1,
    kind: 'AcademicAnalysisProtocol',
    protocolId: `${benchmarkFamily}:${clusterInference ? 'seed-cluster' : 'paired-cell'}-bootstrap-holm:v${claimBindings ? 2 : 1}`,
    benchmarkId: String(benchmarkId),
    benchmarkFamily: String(benchmarkFamily),
    ...(claimBindings ? {
      empiricalClaimUniverseHash: empiricalClaimUniverse.empiricalClaimUniverseHash,
      manuscriptCorpusHash: empiricalClaimUniverse.manuscriptCorpusHash,
    } : {}),
    requiredMetrics: metrics,
    metricSpecs,
    inferenceProfile,
    inferenceProfileHash,
    estimator: {
      method: clusterInference
        ? 'seed-cluster-aggregate-arithmetic-mean-difference-v1'
        : 'paired-arithmetic-mean-difference-v1',
      treatmentArm: 'treatment',
      controlArms: ['baseline', 'ablation'],
      directionNormalization: 'positive-is-treatment-improvement-v1',
    },
    assumptions: {
      distribution: clusterInference
        ? 'seed-cluster-mean-sign-symmetry-and-bootstrap-exchangeability-v1'
        : 'paired-sign-symmetry-and-bootstrap-exchangeability-v1',
      exchangeability: clusterInference
        ? 'operator-predeclared-fixed-seed-cluster-schedule-v1'
        : 'operator-predeclared-fixed-cell-schedule-v1',
      independenceScope: clusterInference
        ? 'independent-seed-clusters-dependent-within-seed-repetitions-v1'
        : 'paired-schedule-unit-only-no-independent-machine-claim-v1',
      finiteObservationsRequired: true,
      symmetryDiagnostic: 'sample-skewness-bound-v1',
      maximumAbsoluteSkewness: 2,
    },
    pairedUnit: clusterInference
      ? 'seed-after-within-seed-repetition-aggregation-v1'
      : 'seed-and-repetition-v1',
    missingness: { method: 'fail-closed-complete-paired-cells-v1', maximumMissingFraction: 0 },
    outlierSensitivity: {
      method: 'winsorized-and-leave-one-out-sensitivity-v1',
      lowerQuantile: 0.05,
      upperQuantile: 0.95,
      requireWinsorizedDirection: true,
      requireLeaveOneOutDirection: true,
    },
    uncertainty: {
      method: clusterInference
        ? 'deterministic-seed-cluster-percentile-bootstrap-v1'
        : 'deterministic-paired-percentile-bootstrap-v1',
      confidenceLevel: 0.95,
      resamples: 4096,
      seed: 1597463007,
      testMethod: clusterInference
        ? 'deterministic-seed-cluster-sign-flip-v1'
        : 'deterministic-paired-sign-flip-v1',
      testDraws: 8192,
    },
    hypotheses: protocolHypotheses,
    multiplicity: { method: 'holm-bonferroni-v1', familyAlpha: 0.05, family: 'all-predeclared-hypotheses-v1' },
    power: {
      method: 'predeclared-standardized-effect-normal-design-v1',
      targetPower: 0.8,
      minimumStandardizedEffect: 0.5,
      requiredPairedObservations: requiredObservationCount,
    },
    numericValidation: {
      residual: { method: 'authority-recomputed-aggregate-residual-v1', maximumAbsoluteResidual: 1e-10 },
      convergence: { method: 'not-observable-no-candidate-convergence-claim-v1', candidateClaimAccepted: false },
      condition: { method: 'not-observable-no-candidate-condition-claim-v1', candidateClaimAccepted: false },
      tolerances: { absolute: 1e-10, relative: 1e-9 },
      propertyOracle: { method: 'repository-hidden-oracle-event-recomputation-v1', required: true },
      agentAggregatesAccepted: false,
    },
    assuranceScope: 'operator-signed-preregistered-analysis-protocol-v1',
  };
  const validated = validateAnalysisProtocol(document, {
    benchmarkId, benchmarkFamily, requiredMetrics: metrics, metricSpecs,
  });
  return Object.freeze({ ...validated.analysisProtocol, analysisProtocolHash: validated.analysisProtocolHash });
}

export function analysisProtocolHasEmpiricalClaimAuthority(protocol) {
  if (!protocol || protocol.version !== 2 || !SHA256.test(String(protocol.analysisProtocolHash || ''))) return false;
  if (!verifyAnalysisProtocol(protocol, {
    benchmarkId: protocol.benchmarkId,
    benchmarkFamily: protocol.benchmarkFamily,
    requiredMetrics: protocol.requiredMetrics,
    metricSpecs: protocol.metricSpecs,
  })) return false;
  const claimIds = (protocol.hypotheses || []).map((hypothesis) => hypothesis.claimId);
  return claimIds.length > 0 && new Set(claimIds).size === claimIds.length
    && protocol.hypotheses.every((hypothesis) => SHA256.test(String(hypothesis.manuscriptClaimHash || '')));
}

export function analysisProtocolMatchesEmpiricalClaimUniverse(protocol, universe) {
  if (!analysisProtocolHasEmpiricalClaimAuthority(protocol) || !verifyEmpiricalClaimUniverse(universe)
    || protocol.empiricalClaimUniverseHash !== universe.empiricalClaimUniverseHash
    || protocol.manuscriptCorpusHash !== universe.manuscriptCorpusHash) return false;
  const expected = empiricalClaimBindingsFromUniverse(universe);
  const actual = protocol.hypotheses.map((hypothesis) => ({
    claimId: hypothesis.claimId,
    manuscriptClaimHash: hypothesis.manuscriptClaimHash,
    proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
    metric: hypothesis.metric,
    comparator: hypothesis.comparator,
    alternative: hypothesis.alternative,
    minimumEffect: hypothesis.minimumEffect,
    acceptanceRequired: hypothesis.acceptanceRequired,
  }));
  return hashRecord('EmpiricalClaimProtocolBindingsExpected', actual)
    === hashRecord('EmpiricalClaimProtocolBindingsExpected', expected);
}
