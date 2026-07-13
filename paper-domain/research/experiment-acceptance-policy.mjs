import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const COMPARATORS = Object.freeze({
  '>=': (actual, threshold) => actual >= threshold,
  '<=': (actual, threshold) => actual <= threshold,
  '>': (actual, threshold) => actual > threshold,
  '<': (actual, threshold) => actual < threshold,
  '==': (actual, threshold) => actual === threshold,
});

function metricValues(experiment) {
  const values = new Map();
  const sources = [experiment.metrics, experiment.metricValues];
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const row of source) {
        const name = row?.metric ?? row?.name;
        if (name) values.set(String(name), row?.value ?? row?.observedValue ?? row?.observedMetric);
      }
    } else if (source && typeof source === 'object') {
      for (const [name, value] of Object.entries(source)) values.set(name, value?.value ?? value);
    }
  }
  if (Array.isArray(experiment.metricRows)) {
    for (const row of experiment.metricRows) if (row?.name) values.set(String(row.name), row.value);
  }
  return values;
}

function evaluateMetricPredicates(experiment, contract, blockers) {
  const values = metricValues(experiment);
  const predicates = Array.isArray(contract.metricPredicates) ? contract.metricPredicates : [];
  return predicates.map((predicate, index) => {
    const metric = String(predicate?.metric || predicate?.name || '');
    const comparator = predicate?.comparator || predicate?.operator || null;
    const threshold = Number(predicate?.threshold);
    const actual = Number(values.get(metric));
    let met = false;
    let blocker = null;
    if (!metric) blocker = `experiment_metric_predicate_invalid:${index}`;
    else if (!COMPARATORS[comparator]) blocker = `experiment_metric_comparator_invalid:${metric}`;
    else if (!values.has(metric)) blocker = `experiment_metric_missing:${metric}`;
    else if (!Number.isFinite(threshold) || !Number.isFinite(actual)) blocker = `experiment_metric_value_invalid:${metric}`;
    else if (!(met = COMPARATORS[comparator](actual, threshold))) blocker = `experiment_metric_predicate_not_met:${metric}`;
    if (blocker) blockers.push(blocker);
    return Object.freeze({ metric: metric || null, comparator, threshold: Number.isFinite(threshold) ? threshold : null, observedValue: Number.isFinite(actual) ? actual : null, met, blocker });
  });
}

export function evaluateExperimentAcceptance({ experiment = {}, contract = {} } = {}) {
  const blockers = [];
  if (experiment.promotionRequested === true && !contract.profileId) blockers.push('experiment_promotion_profile_required');
  if (experiment.evidenceBinding?.status !== 'experiment_evidence_binding_verified') blockers.push('experiment_evidence_binding_required');
  const requiredOutputs = Array.isArray(contract.requiredOutputs) ? contract.requiredOutputs.map(String) : [];
  const availableOutputs = new Set(Array.isArray(experiment.availableOutputs) ? experiment.availableOutputs.map(String) : []);
  for (const output of requiredOutputs) if (!availableOutputs.has(output)) blockers.push(`experiment_required_output_missing:${output}`);
  if (contract.deterministicSeedRequired !== false && (experiment.seed === null || experiment.seed === undefined || experiment.seed === '')) blockers.push('experiment_deterministic_seed_missing');
  const predicateResults = evaluateMetricPredicates(experiment, contract, blockers);
  const comparator = contract.comparator || null;
  const threshold = Number(contract.threshold);
  const actual = Number(experiment.observedMetric ?? experiment.metricValue);
  let thresholdMet = null;
  if (comparator || Object.prototype.hasOwnProperty.call(contract, 'threshold')) {
    if (!COMPARATORS[comparator]) blockers.push('experiment_metric_comparator_invalid');
    else if (!Number.isFinite(threshold) || !Number.isFinite(actual)) blockers.push('experiment_metric_value_invalid');
    else thresholdMet = COMPARATORS[comparator](actual, threshold);
  }
  const predicatesMet = predicateResults.length ? predicateResults.every((item) => item.met) : null;
  const acceptanceMet = predicatesMet === null ? thresholdMet : predicatesMet && (thresholdMet === null || thresholdMet === true);
  const resultClass = experiment.resultClass || (acceptanceMet === true ? 'positive' : acceptanceMet === false ? 'negative' : 'unclassified');
  const allowedPromotionClasses = new Set(contract.allowedPromotionResultClasses || ['positive']);
  if (experiment.promotionRequested === true && contract.promotionAllowed === false) blockers.push('experiment_profile_nonpromotional');
  if (experiment.promotionRequested === true && acceptanceMet !== true) blockers.push('experiment_declared_threshold_not_met');
  if (experiment.promotionRequested === true && !allowedPromotionClasses.has(resultClass)) blockers.push(`experiment_result_class_not_promotable:${resultClass}`);
  const promotionEligible = blockers.length === 0 && contract.promotionAllowed !== false && experiment.promotionRequested === true && acceptanceMet === true && allowedPromotionClasses.has(resultClass);
  const payload = {
    version: 1,
    kind: 'ExperimentAcceptancePolicyReport',
    experimentId: experiment.experimentId || null,
    status: blockers.length ? 'experiment_acceptance_blocked' : promotionEligible ? 'experiment_promotion_eligible' : 'experiment_result_recorded_non_promotable',
    comparator,
    threshold: Number.isFinite(threshold) ? threshold : null,
    observedMetric: Number.isFinite(actual) ? actual : null,
    thresholdMet,
    profileId: contract.profileId || null,
    metricPredicateResults: predicateResults,
    metricPredicatesMet: predicatesMet,
    acceptanceMet,
    resultClass,
    promotionRequested: experiment.promotionRequested === true,
    promotionAllowed: contract.promotionAllowed !== false,
    promotionEligible,
    experimentEvidenceBindingHash: experiment.evidenceBinding?.experimentEvidenceBindingHash || null,
    negativeResultPreserved: ['negative', 'inconclusive'].includes(resultClass),
    blockers,
  };
  return Object.freeze({ ...payload, experimentAcceptancePolicyHash: hashRecord('ExperimentAcceptancePolicyReport', payload) });
}
