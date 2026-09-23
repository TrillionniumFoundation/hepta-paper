import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
  compileAutonomousEmpiricalFamilyPluginRegistry,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildAutonomousEmpiricalPluginReleasePlan,
  createAutonomousAdvancedNumericalPluginReleaseTemplate,
} from '../../paper-domain/automation/autonomous-empirical-plugin-release-contract.mjs';
import {
  buildVersionedExperimentIr,
  verifyVersionedExperimentIr,
  versionedExperimentIrFor,
} from '../../paper-domain/automation/versioned-experiment-ir.mjs';

const ADVANCED = Object.freeze([
  'condition-number-bound-v1',
  'convergence-rate-bound-v1',
  'error-bound-v1',
  'optimality-gap-bound-v1',
]);

test('signed production profile compiles to complete, authority-bound Experiment IR', () => {
  const experimentIr = versionedExperimentIrFor('operations_optimization_benchmark');
  assert.equal(verifyVersionedExperimentIr(experimentIr), true);
  assert.equal(experimentIr.sourceAuthority.signatureVerified, true);
  assert.equal(experimentIr.sourceAuthority.productionAuthorized, true);
  assert.deepEqual(experimentIr.design.arms, ['treatment', 'baseline', 'ablation']);
  assert.equal(experimentIr.estimator.primaryMetric, 'mean_score');
  assert.ok(experimentIr.metrics.every((metric) => Number.isFinite(metric.minimum)
    && Number.isFinite(metric.maximum)));
  assert.equal(experimentIr.stopping.earlyStoppingAllowed, false);
  assert.equal(experimentIr.dataset.runtimeNetworkAccessAllowed, false);
  assert.equal(experimentIr.oracleAbi.candidateAuthoredValuesAccepted, false);
  assert.equal(experimentIr.runtimeRegistryMutationAllowed, false);
});

test('advanced numerical release path emits a full Experiment IR but remains unauthorized', () => {
  const plan = buildAutonomousEmpiricalPluginReleasePlan(
    createAutonomousAdvancedNumericalPluginReleaseTemplate({
      benchmarkFamilies: ['ml_algorithm_benchmark'],
    }),
  );
  assert.equal(plan.experimentIrProductionAuthorizationPending, true);
  assert.equal(plan.experimentIrs.length, 1);
  assert.deepEqual(
    plan.experimentIrs[0].oracleAbi.requiredOracleTypes.filter((oracleType) => (
      ADVANCED.includes(oracleType)
    )),
    ADVANCED,
  );
  assert.equal(plan.experimentIrs[0].oracleAbi.independentRecomputationRequired, true);
  assert.equal(plan.experimentIrs[0].sourceAuthority.productionAuthorized, false);
  assert.equal(plan.releaseRequiresConfiguredExternalEd25519Authority, true);
  assert.equal(plan.unsignedRepositoryTemplateIsAuthority, false);
});

test('unregistered and mutated profiles fail closed at the production IR boundary', () => {
  const standalone = compileAutonomousEmpiricalFamilyPluginRegistry([
    {
      ...AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[0],
      profileId: 'unregistered-profile-v1',
    },
  ]).profiles[0];
  assert.throws(
    () => buildVersionedExperimentIr(standalone),
    /experiment_ir_production_authority_required/,
  );
  const mutated = structuredClone(standalone);
  mutated.metricSpecs[mutated.primaryMetric].maximum += 1;
  assert.throws(
    () => buildVersionedExperimentIr(mutated, { requireProductionAuthority: false }),
    /experiment_ir_profile_invalid/,
  );
  assert.throws(
    () => versionedExperimentIrFor('unknown-benchmark-family'),
    /experiment_ir_benchmark_family_unsupported/,
  );
});

test('production authority cannot be injected with self-asserted inspection booleans', () => {
  const profile = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[0];
  const registry = compileAutonomousEmpiricalFamilyPluginRegistry([profile]);
  const compiled = registry.profiles[0];
  assert.throws(() => buildVersionedExperimentIr(compiled, {
    registry,
    startupInspection: {
      signatureVerified: true,
      registryHash: registry.autonomousEmpiricalFamilyPluginRegistryHash,
      packageHash: `sha256:${'a'.repeat(64)}`,
      autonomousEmpiricalFamilyPluginStartupInspectionHash: `sha256:${'b'.repeat(64)}`,
    },
  }), /experiment_ir_production_authority_required/);
});
