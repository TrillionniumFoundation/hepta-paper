import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { arithmeticMean, requiredPairedObservations as calculateRequiredPairedObservations, sampleStandardError } from './analysis-statistics.mjs';
import { systemBenchmarkEvaluatorDescriptorFor } from './system-benchmark-evaluator-abi.mjs';

const REQUIRED_ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);

export const SYSTEM_BENCHMARK_STATISTICAL_COMPATIBILITY_ROLE = Object.freeze({
  evidenceRole: 'descriptive-compatibility-only-v1',
  inferentialAuthority: false,
  promotionBlocking: false,
  authoritativeEvaluationKind: 'AcademicAnalysisProtocolEvaluation',
});

function protocolOperations(benchmarkId, datasetBacked, benchmarkFamily) {
  return systemBenchmarkEvaluatorDescriptorFor(datasetBacked ? benchmarkFamily : benchmarkId)?.armOperations || null;
}

export function buildSystemBenchmarkArmProtocolSet({ benchmarkId, datasetBacked = false, benchmarkFamily = null } = {}) {
  const normalizedBenchmarkId = String(benchmarkId || '');
  const normalizedBenchmarkFamily = String(benchmarkFamily || (datasetBacked ? '' : normalizedBenchmarkId));
  const evaluatorDescriptor = systemBenchmarkEvaluatorDescriptorFor(normalizedBenchmarkFamily);
  const operations = protocolOperations(normalizedBenchmarkId, datasetBacked, normalizedBenchmarkFamily);
  if (!operations || !evaluatorDescriptor) {
    throw new Error(`system_benchmark_arm_protocol_unsupported:${normalizedBenchmarkId || '<empty>'}`);
  }
  const protocols = REQUIRED_ARMS.map((arm) => {
    const payload = {
      version: 1,
      kind: 'SystemBenchmarkArmProtocol',
      benchmarkId: normalizedBenchmarkId,
      benchmarkFamily: normalizedBenchmarkFamily,
      arm,
      protocolId: `${datasetBacked ? 'authorized-dataset' : normalizedBenchmarkId}:${operations[arm]}:v1`,
      operation: operations[arm],
      evaluatorId: `repository-owned-${normalizedBenchmarkId}-event-evaluator-v1`,
      rawEventFields: evaluatorDescriptor.rawEventFields,
      executionAuthority: 'repository-owned-evaluator-over-untrusted-candidate-arm-adapter-v1',
      observationAuthority: 'raw-event-artifact-plus-sandbox-worker-receipt-v1',
    };
    return Object.freeze({ ...payload, systemBenchmarkArmProtocolHash: hashRecord('SystemBenchmarkArmProtocol', payload) });
  });
  const payload = {
    version: 1,
    kind: 'SystemBenchmarkArmProtocolSet',
    benchmarkId: normalizedBenchmarkId,
    benchmarkFamily: normalizedBenchmarkFamily,
    protocols,
  };
  return Object.freeze({ ...payload, systemBenchmarkArmProtocolSetHash: hashRecord('SystemBenchmarkArmProtocolSet', payload) });
}

export function verifySystemBenchmarkArmProtocolSet(protocolSet, { benchmarkId, datasetBacked = false, benchmarkFamily = null } = {}) {
  let expected = null;
  try { expected = buildSystemBenchmarkArmProtocolSet({ benchmarkId, datasetBacked, benchmarkFamily }); } catch { return false; }
  return protocolSet?.systemBenchmarkArmProtocolSetHash === expected.systemBenchmarkArmProtocolSetHash
    && hashRecord('SystemBenchmarkArmProtocolSetExpected', protocolSet)
      === hashRecord('SystemBenchmarkArmProtocolSetExpected', expected);
}

export function armProtocolFor(protocolSet, arm) {
  return protocolSet?.protocols?.find((protocol) => protocol.arm === arm) || null;
}

function evaluateMetricExpression(events, expression) {
  const [left, right] = expression.operands;
  if (expression.operator === 'arithmetic_mean') {
    return arithmeticMean(events.map((event) => event[left]));
  }
  if (expression.operator === 'sample_standard_error') {
    return sampleStandardError(events.map((event) => event[left]));
  }
  if (expression.operator === 'arithmetic_mean_difference') {
    return arithmeticMean(events.map((event) => event[left] - event[right]));
  }
  return Number.NaN;
}

export function evaluateSystemBenchmarkArmRawObservation({ protocol, document, requiredMetrics = [], metricSpecs = {} } = {}) {
  const blockers = [];
  const allowedKeys = ['events', 'kind', 'version'];
  if (!protocol || protocol.kind !== 'SystemBenchmarkArmProtocol') blockers.push('benchmark_arm_protocol_required');
  const evaluator = systemBenchmarkEvaluatorDescriptorFor(protocol?.benchmarkFamily || protocol?.benchmarkId);
  if (!evaluator || protocol?.evaluatorId !== `repository-owned-${protocol?.benchmarkId}-event-evaluator-v1`) {
    blockers.push('benchmark_repository_owned_evaluator_unavailable');
  }
  if (evaluator && (!Array.isArray(protocol?.rawEventFields)
    || protocol.rawEventFields.join('\0') !== evaluator.rawEventFields.join('\0'))) {
    blockers.push('benchmark_evaluator_event_field_set_drift');
  }
  if (!document || document.version !== 1 || document.kind !== 'CampaignBenchmarkCellRawEvents'
    || Object.keys(document || {}).sort().some((key, index) => key !== allowedKeys[index])) {
    blockers.push('benchmark_cell_raw_event_document_shape_invalid');
  }
  const metricNames = [...requiredMetrics].map(String).sort();
  if (Object.keys(metricSpecs || {}).sort().join('\0') !== metricNames.join('\0')) blockers.push('benchmark_metric_spec_set_invalid');
  if (evaluator && evaluator.metrics.map((metric) => metric.metric).sort().join('\0') !== metricNames.join('\0')) {
    blockers.push('benchmark_evaluator_metric_set_drift');
  }
  if (!Array.isArray(document?.events) || document.events.length < 2 || document.events.length > 100_000) {
    blockers.push('benchmark_cell_raw_events_invalid');
  } else if (evaluator && document.events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)
    || Object.keys(event).sort().join('\0') !== evaluator.rawEventFields.join('\0')
    || evaluator.rawEventFields.some((field) => typeof event[field] !== 'number' || !Number.isFinite(event[field])))) {
    blockers.push('benchmark_cell_raw_event_schema_invalid');
  }
  let metrics = null;
  if (!blockers.length) {
    const events = document.events.map((event) => Object.fromEntries(
      evaluator.rawEventFields.map((field) => [field, Number(event[field])]),
    ));
    metrics = Object.fromEntries(evaluator.metrics.map((metric) => [
      metric.metric,
      evaluateMetricExpression(events, metric.expression),
    ]));
    for (const metric of metricNames) {
      const spec = metricSpecs[metric];
      if (!spec || !['maximize', 'minimize'].includes(spec.direction) || !spec.unit
        || !Number.isFinite(Number(spec.minimum)) || !Number.isFinite(Number(spec.maximum))
        || Number(spec.minimum) > Number(spec.maximum) || !Number.isFinite(Number(metrics[metric]))
        || Number(metrics[metric]) < Number(spec.minimum) || Number(metrics[metric]) > Number(spec.maximum)) {
        blockers.push(`benchmark_metric_out_of_declared_range:${metric}`);
      }
    }
  }
  return Object.freeze({
    status: blockers.length ? 'system_benchmark_arm_observation_blocked' : 'system_benchmark_arm_observation_computed',
    blockers: [...new Set(blockers)],
    metrics: blockers.length ? null : Object.freeze(metrics),
    eventCount: blockers.length ? null : document.events.length,
    computation: protocol?.evaluatorId || null,
  });
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + (0.3275911 * x));
  const polynomial = (((((1.061405429 * t) - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - (polynomial * Math.exp(-(x ** 2))));
  return 0.5 * (1 + erf);
}

function requiredPairedObservations(policy) {
  return calculateRequiredPairedObservations({
    alpha: Number(policy?.alpha),
    targetPower: Number(policy?.minimumPower),
    standardizedEffect: Number(policy?.minimumStandardizedEffect),
    hypothesisCount: 2,
  });
}

function summarize(values, z = 1.96) {
  const mean = arithmeticMean(values);
  const se = sampleStandardError(values);
  return Object.freeze({ count: values.length, mean, standardError: se, ciLower: mean - (z * se), ciUpper: mean + (z * se) });
}

export function evaluateSystemBenchmarkStatisticalPolicy({ observations = [], experimentDesign } = {}) {
  const blockers = [];
  const policy = experimentDesign?.statisticalAnalysisPolicy || null;
  const primaryMetric = experimentDesign?.primaryMetric;
  const primarySpec = experimentDesign?.metricSpecs?.[primaryMetric];
  const computedRequiredPairedObservations = requiredPairedObservations(policy);
  if (!policy || policy.multipleComparisonPolicy !== 'holm-bonferroni-v1'
    || policy.aggregation !== 'system-arithmetic-mean-and-paired-normal-ci-v1'
    || policy.powerModel !== 'predeclared-standardized-effect-normal-approximation-v1'
    || policy.powerAlphaAdjustment !== 'holm-first-step-two-hypotheses-v1'
    || !Number.isSafeInteger(computedRequiredPairedObservations)
    || Number(policy.requiredPairedObservations) !== computedRequiredPairedObservations) blockers.push('benchmark_statistical_policy_invalid');
  if (!primaryMetric || !primarySpec) blockers.push('benchmark_primary_metric_spec_missing');
  const summaries = {};
  for (const arm of REQUIRED_ARMS) {
    summaries[arm] = {};
    for (const metric of experimentDesign?.requiredMetrics || []) {
      const values = observations.filter((observation) => observation.arm === arm).map((observation) => Number(observation.metrics?.[metric]));
      if (!values.length || values.some((value) => !Number.isFinite(value))) blockers.push(`benchmark_statistical_metric_missing:${arm}:${metric}`);
      else summaries[arm][metric] = summarize(values);
    }
  }
  const byCell = new Map();
  for (const observation of observations) {
    const key = `${observation.seed}\0${observation.repetition}`;
    const record = byCell.get(key) || {};
    record[observation.arm] = observation;
    byCell.set(key, record);
  }
  const effects = {};
  const hypothesisRows = [];
  if (!blockers.length) {
    for (const comparator of ['baseline', 'ablation']) {
      const signedDifferences = [...byCell.values()].map((record) => {
        const treatment = Number(record.treatment?.metrics?.[primaryMetric]);
        const control = Number(record[comparator]?.metrics?.[primaryMetric]);
        return primarySpec.direction === 'maximize' ? treatment - control : control - treatment;
      });
      if (signedDifferences.some((value) => !Number.isFinite(value))) {
        blockers.push(`benchmark_${comparator}_paired_observation_missing`);
        continue;
      }
      const effect = summarize(signedDifferences, 1.96);
      const zScore = effect.standardError === 0 ? (effect.mean > 0 ? Number.POSITIVE_INFINITY : 0) : effect.mean / effect.standardError;
      const oneSidedPValue = Number.isFinite(zScore) ? 1 - normalCdf(zScore) : 0;
      const designPowerSatisfied = effect.count >= computedRequiredPairedObservations;
      hypothesisRows.push({ comparator, oneSidedPValue });
      effects[comparator] = { ...effect, oneSidedPValue, designPowerSatisfied, holmAccepted: false, accepted: false };
    }
    const ordered = [...hypothesisRows].sort((left, right) => left.oneSidedPValue - right.oneSidedPValue);
    let precedingAccepted = true;
    ordered.forEach((row, index) => {
      const threshold = Number(policy.alpha) / (ordered.length - index);
      const holmAccepted = precedingAccepted && row.oneSidedPValue <= threshold;
      precedingAccepted = holmAccepted;
      const effect = effects[row.comparator];
      const accepted = holmAccepted && effect.designPowerSatisfied && effect.ciLower > Number(policy.minimumEffect);
      effects[row.comparator] = Object.freeze({ ...effect, holmRank: index + 1, holmThreshold: threshold, holmAccepted, accepted });
      if (!effect.designPowerSatisfied) blockers.push('benchmark_predeclared_power_design_unsatisfied');
      if (!accepted) blockers.push(`benchmark_${row.comparator}_acceptance_predicate_failed`);
    });
  }
  const payload = {
    version: 1,
    kind: 'SystemBenchmarkStatisticalEvaluation',
    ...SYSTEM_BENCHMARK_STATISTICAL_COMPATIBILITY_ROLE,
    status: blockers.length ? 'system_benchmark_statistical_policy_blocked' : 'system_benchmark_statistical_policy_verified',
    primaryMetric: primaryMetric || null,
    metricSpecs: experimentDesign?.metricSpecs || null,
    policy,
    computedRequiredPairedObservations: Number.isSafeInteger(computedRequiredPairedObservations) ? computedRequiredPairedObservations : null,
    summaries,
    pairedEffects: effects,
    datasetSplitPolicy: experimentDesign?.datasetSplitPolicy || null,
    datasetSplitIdentityHash: experimentDesign?.datasetSplitIdentityHash || null,
    datasetLeakagePolicy: experimentDesign?.datasetLeakagePolicy || null,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, systemBenchmarkStatisticalEvaluationHash: hashRecord('SystemBenchmarkStatisticalEvaluation', payload) });
}

export function verifySystemBenchmarkStatisticalCompatibilityEvidence(evaluation) {
  if (!evaluation || evaluation.version !== 1 || evaluation.kind !== 'SystemBenchmarkStatisticalEvaluation'
    || evaluation.evidenceRole !== SYSTEM_BENCHMARK_STATISTICAL_COMPATIBILITY_ROLE.evidenceRole
    || evaluation.inferentialAuthority !== false || evaluation.promotionBlocking !== false
    || evaluation.authoritativeEvaluationKind !== SYSTEM_BENCHMARK_STATISTICAL_COMPATIBILITY_ROLE.authoritativeEvaluationKind
    || !Array.isArray(evaluation.blockers)
    || evaluation.status !== (evaluation.blockers.length
      ? 'system_benchmark_statistical_policy_blocked' : 'system_benchmark_statistical_policy_verified')) return false;
  const { systemBenchmarkStatisticalEvaluationHash, ...payload } = evaluation;
  return /^sha256:[0-9a-f]{64}$/i.test(String(systemBenchmarkStatisticalEvaluationHash || ''))
    && hashRecord('SystemBenchmarkStatisticalEvaluation', payload) === systemBenchmarkStatisticalEvaluationHash;
}

export function verifySystemBenchmarkArmAdapterSet(adapterSet, protocolSet) {
  if (!adapterSet || adapterSet.version !== 1 || adapterSet.kind !== 'SystemBenchmarkArmAdapterSet') return false;
  const { systemBenchmarkArmAdapterSetHash, ...payload } = adapterSet;
  if (hashRecord('SystemBenchmarkArmAdapterSet', payload) !== systemBenchmarkArmAdapterSetHash) return false;
  if (!Array.isArray(adapterSet.adapters) || adapterSet.adapters.length !== REQUIRED_ARMS.length) return false;
  const paths = new Set();
  const hashes = new Set();
  for (const arm of REQUIRED_ARMS) {
    const adapter = adapterSet.adapters.find((candidate) => candidate.arm === arm);
    const protocol = armProtocolFor(protocolSet, arm);
    if (!adapter || adapter.kind !== 'SystemBenchmarkArmAdapterIdentity'
      || adapter.systemBenchmarkArmProtocolHash !== protocol?.systemBenchmarkArmProtocolHash
      || !/^[A-Za-z0-9_./-]+$/.test(String(adapter.relativePath || ''))
      || String(adapter.relativePath).split('/').includes('..')
      || !/^sha256:[0-9a-f]{64}$/.test(String(adapter.sourceHash || ''))) return false;
    paths.add(adapter.relativePath);
    hashes.add(adapter.sourceHash);
  }
  return paths.size === REQUIRED_ARMS.length && hashes.size === REQUIRED_ARMS.length;
}
