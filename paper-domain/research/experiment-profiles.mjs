const REQUIRED_OUTPUTS = Object.freeze([
  'agent-compute-manifest.json',
  'metrics.json',
  'experiment-summary.md',
  'experiment-reproducibility.json',
]);

const BASE_METRIC_PREDICATES = Object.freeze([
  Object.freeze({ metric: 'local_execution', comparator: '==', threshold: 1 }),
  Object.freeze({ metric: 'source_mutation_performed', comparator: '==', threshold: 0 }),
  Object.freeze({ metric: 'external_action_performed', comparator: '==', threshold: 0 }),
]);

function profile(profileId, domain, metricPredicates = [], { promotionAllowed = true } = {}) {
  return Object.freeze({
    version: 1,
    kind: 'ExperimentAcceptanceProfile',
    profileId,
    domain,
    requiredOutputs: REQUIRED_OUTPUTS,
    deterministicSeedRequired: true,
    promotionAllowed,
    metricPredicates: Object.freeze([...BASE_METRIC_PREDICATES, ...metricPredicates.map((item) => Object.freeze(item))]),
    allowedPromotionResultClasses: Object.freeze(['positive']),
  });
}

export const EXPERIMENT_ACCEPTANCE_PROFILES = Object.freeze({
  local_reproducibility_smoke: profile('local_reproducibility_smoke', 'generic'),
  dql_value_policy_smoke: profile('dql_value_policy_smoke', 'deep_reinforcement_learning', [
    { metric: 'bellman_residual_max', comparator: '<=', threshold: 0.01 },
    { metric: 'value_policy_improvement', comparator: '>=', threshold: 0 },
  ], { promotionAllowed: false }),
  fbsde_solver_residual_smoke: profile('fbsde_solver_residual_smoke', 'stochastic_control', [
    { metric: 'terminal_residual_max', comparator: '<=', threshold: 0.02 },
    { metric: 'pathwise_seed_reused', comparator: '==', threshold: 1 },
  ]),
  dynamic_contracting_counterfactual_smoke: profile('dynamic_contracting_counterfactual_smoke', 'economic_contracting', [
    { metric: 'incentive_constraint_violation_max', comparator: '<=', threshold: 0 },
    { metric: 'counterfactual_grid_count', comparator: '>=', threshold: 1 },
  ]),
  robust_control_stability_smoke: profile('robust_control_stability_smoke', 'robust_control', [
    { metric: 'lyapunov_margin_min', comparator: '>=', threshold: 0 },
    { metric: 'disturbance_scenario_count', comparator: '>=', threshold: 1 },
  ]),
});

export function experimentAcceptanceProfile(profileId) {
  return EXPERIMENT_ACCEPTANCE_PROFILES[String(profileId || '')] || null;
}

export function buildExperimentAcceptanceContract({ profileId, overrides = {} } = {}) {
  const selected = experimentAcceptanceProfile(profileId);
  if (!selected) throw new Error(`experiment_acceptance_profile_unknown:${profileId || ''}`);
  const requiredOutputs = [...new Set([...selected.requiredOutputs, ...(overrides.requiredOutputs || [])].map(String))];
  const metricPredicates = [...selected.metricPredicates];
  const existingPredicates = new Set(metricPredicates.map((item) => `${item.metric}\0${item.comparator}\0${item.threshold}`));
  for (const item of overrides.metricPredicates || []) {
    const normalized = { ...item };
    const identity = `${normalized.metric || normalized.name}\0${normalized.comparator || normalized.operator}\0${normalized.threshold}`;
    if (!existingPredicates.has(identity)) metricPredicates.push(Object.freeze(normalized));
  }
  return Object.freeze({
    ...selected,
    ...overrides,
    profileId: selected.profileId,
    deterministicSeedRequired: true,
    promotionAllowed: selected.promotionAllowed,
    allowedPromotionResultClasses: selected.allowedPromotionResultClasses,
    domain: selected.domain,
    kind: selected.kind,
    version: selected.version,
    requiredOutputs: Object.freeze(requiredOutputs),
    metricPredicates: Object.freeze(metricPredicates),
  });
}
