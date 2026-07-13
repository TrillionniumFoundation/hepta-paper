import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateExperimentAcceptance } from '../../paper-domain/research/experiment-acceptance-policy.mjs';
import { buildExperimentAcceptanceContract, EXPERIMENT_ACCEPTANCE_PROFILES } from '../../paper-domain/research/experiment-profiles.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { trustedExperimentFixture } from './trusted-evidence-test-support.mjs';

const h = (c) => `sha256:${c.repeat(64)}`;
const evidenceBinding = { status: 'experiment_evidence_binding_verified', experimentEvidenceBindingHash: h('e') };

test('experiment policy applies declared comparator and preserves negative results without promotion', () => {
  const contract = { profileId: 'fixture_profile', comparator: '>=', threshold: 0.9, requiredOutputs: ['metrics', 'manifest'], deterministicSeedRequired: true };
  const negative = evaluateExperimentAcceptance({ experiment: { experimentId: 'e', evidenceBinding, seed: 7, observedMetric: 0.8, availableOutputs: ['metrics', 'manifest'], resultClass: 'negative', promotionRequested: true }, contract });
  assert.equal(negative.promotionEligible, false);
  assert.equal(negative.negativeResultPreserved, true);
  assert.ok(negative.blockers.includes('experiment_declared_threshold_not_met'));
  const positive = evaluateExperimentAcceptance({ experiment: { experimentId: 'e2', evidenceBinding, seed: 7, observedMetric: 0.91, availableOutputs: ['metrics', 'manifest'], resultClass: 'positive', promotionRequested: true }, contract });
  assert.equal(positive.status, 'experiment_promotion_eligible');
});

test('domain experiment profiles require every base and domain metric predicate', () => {
  const contract = buildExperimentAcceptanceContract({ profileId: 'dql_value_policy_smoke' });
  const metrics = {
    local_execution: 1,
    source_mutation_performed: 0,
    external_action_performed: 0,
    bellman_residual_max: 0.009,
    value_policy_improvement: 0.01,
  };
  const accepted = evaluateExperimentAcceptance({ experiment: { experimentId: 'dql', evidenceBinding, seed: 0, metrics, availableOutputs: contract.requiredOutputs, promotionRequested: false }, contract });
  assert.equal(accepted.status, 'experiment_result_recorded_non_promotable');
  assert.equal(accepted.acceptanceMet, true);
  assert.equal(accepted.metricPredicateResults.length, 5);
  const rejected = evaluateExperimentAcceptance({ experiment: { experimentId: 'dql-bad', evidenceBinding, seed: 0, metrics: { ...metrics, bellman_residual_max: 0.02 }, availableOutputs: contract.requiredOutputs, promotionRequested: true }, contract });
  assert.ok(rejected.blockers.includes('experiment_metric_predicate_not_met:bellman_residual_max'));
  assert.equal(rejected.promotionEligible, false);
  const overclaim = evaluateExperimentAcceptance({ experiment: { experimentId: 'dql-overclaim', evidenceBinding, seed: 0, metrics, availableOutputs: contract.requiredOutputs, promotionRequested: true }, contract });
  assert.ok(overclaim.blockers.includes('experiment_profile_nonpromotional'));
});

test('all salvaged experiment profiles expose explicit multi-metric contracts', () => {
  assert.deepEqual(Object.keys(EXPERIMENT_ACCEPTANCE_PROFILES).sort(), [
    'dql_value_policy_smoke',
    'dynamic_contracting_counterfactual_smoke',
    'fbsde_solver_residual_smoke',
    'local_reproducibility_smoke',
    'robust_control_stability_smoke',
  ]);
  for (const profile of Object.values(EXPERIMENT_ACCEPTANCE_PROFILES)) {
    assert.ok(profile.metricPredicates.length >= 3);
    assert.equal(profile.requiredOutputs.length, 4);
  }
});

test('experiment registry applies named profile and blocks missing metrics', () => {
  const trusted = trustedExperimentFixture({ profileId: 'fbsde_solver_residual_smoke', experimentId: 'fbsde', seed: 11 });
  const base = { ...trusted.artifact, seed: 11, metric: 'terminal_residual_max' };
  const blocked = buildExperimentRegistry({ artifacts: [{ ...base, metrics: { local_execution: 1, source_mutation_performed: 0, external_action_performed: 0, terminal_residual_max: 0.01 } }], receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier });
  assert.equal(blocked.status, 'experiment_registry_blocked');
  assert.ok(blocked.experiments[0].acceptancePolicy.blockers.includes('experiment_metric_missing:pathwise_seed_reused'));
  const ready = buildExperimentRegistry({ artifacts: [{ ...base, metrics: { local_execution: 1, source_mutation_performed: 0, external_action_performed: 0, terminal_residual_max: 0.01, pathwise_seed_reused: 1 } }], receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier });
  assert.equal(ready.status, 'experiment_registry_ready');
});
