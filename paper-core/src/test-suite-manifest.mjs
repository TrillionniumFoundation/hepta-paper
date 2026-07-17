const AUTOMATION_TESTS = Object.freeze([
  'paper-core/tests/automation-campaign.test.mjs',
  'paper-core/tests/automation-executors.test.mjs',
  'paper-core/tests/campaign-empirical-repair-semantics.test.mjs',
  'paper-core/tests/automation-orchestration.test.mjs',
  'paper-core/tests/automation-runtime-reconciler.test.mjs',
  'paper-core/tests/automation-readiness-policy.test.mjs',
  'paper-core/tests/analysis-protocol.test.mjs',
  'paper-core/tests/autonomous-provider-configuration-binding.test.mjs',
  'paper-core/tests/autonomous-empirical-execution-profile.test.mjs',
  'paper-core/tests/autonomous-formal-support-registry.test.mjs',
  'paper-core/tests/autonomous-readiness-topology.test.mjs',
  'paper-core/tests/autonomous-research-readiness.test.mjs',
  'paper-core/tests/autonomous-research-campaign.test.mjs',
  'paper-core/tests/autonomous-research-cold-start-e2e.test.mjs',
  'paper-core/tests/autonomous-research-machine-intake-authority-rotation.test.mjs',
  'paper-core/tests/autonomous-research-machine-intake-migration.test.mjs',
  'paper-core/tests/autonomous-research-machine-intake.test.mjs',
  'paper-core/tests/autonomous-research-qualification-progress.test.mjs',
  'paper-core/tests/autonomous-research-supervisor.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-closure.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-pause-recovery.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-resident.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-progress.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-external-action-journal.test.mjs',
  'paper-core/tests/autonomous-research-execution-authorization.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-dispatch-authorization.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-machine-intake.test.mjs',
  'paper-core/tests/autonomous-research-topic-producer.test.mjs',
  'paper-core/tests/autonomous-runtime-reproducibility-refresh.test.mjs',
  'paper-core/tests/autonomous-launch-mode-golden-controller.test.mjs',
  'paper-core/tests/autonomous-external-qualification-process.test.mjs',
  'paper-core/tests/autonomous-formal-lineage.test.mjs',
  'paper-core/tests/campaign-formal-readiness-feedback.test.mjs',
  'paper-core/tests/campaign-release-source-lineage.test.mjs',
  'paper-core/tests/docker-dataset-access-supervisor.test.mjs',
  'paper-core/tests/executor-capabilities.test.mjs',
  'paper-core/tests/empirical-contract.test.mjs',
  'paper-core/tests/empirical-assertion-contract.test.mjs',
  'paper-core/tests/empirical-claim-authority.test.mjs',
  'paper-core/tests/full-research-qualification.test.mjs',
  'paper-core/tests/fully-autonomous-research-system-status.test.mjs',
  'paper-core/tests/operator-dataset-harness-authority.test.mjs',
  'paper-core/tests/system-benchmark-harness-integrity.test.mjs',
  'paper-core/tests/campaign-evolution-policy.test.mjs',
  'paper-core/tests/campaign-query-presenter.test.mjs',
  'paper-core/tests/campaign-command-service.test.mjs',
  'paper-core/tests/runtime-retention.test.mjs',
  'paper-core/tests/campaign-slo.test.mjs',
  'paper-core/tests/campaign-telemetry-persistence.test.mjs',
  'paper-core/tests/multiprocess-resource-governor.test.mjs',
  'paper-core/tests/batch-campaign-mode-plan.test.mjs',
  'paper-core/tests/campaign-mode-execution-semantics.test.mjs',
  'paper-core/tests/campaign-experiment-artifact-authority.test.mjs',
  'paper-core/tests/empirical-p1-authority.test.mjs',
  'paper-core/tests/formal-campaign-release.test.mjs',
  'paper-core/tests/formal-review-agent-bootstrap.test.mjs',
]);

const AUTOMATION_DEDUPLICATED_ELSEWHERE = new Set([
  'paper-core/tests/automation-executors.test.mjs',
  'paper-core/tests/campaign-empirical-repair-semantics.test.mjs',
  'paper-core/tests/runtime-retention.test.mjs',
  'paper-core/tests/campaign-slo.test.mjs',
  'paper-core/tests/campaign-telemetry-persistence.test.mjs',
]);

const SALVAGE_HARDENING_TESTS = Object.freeze([
  'paper-core/tests/workspace-registry.test.mjs',
  'paper-core/tests/workspace-snapshot-exporter.test.mjs',
  'paper-core/tests/package-verifier.test.mjs',
  'paper-core/tests/manuscript-promotion-boundaries.test.mjs',
  'paper-core/tests/formal-claim-binding-policy.test.mjs',
  'paper-core/tests/lean-source-formal-verifier.test.mjs',
  'paper-core/tests/paper-quality-policy.test.mjs',
  'paper-core/tests/theorem-manuscript-readiness-policy.test.mjs',
  'paper-core/tests/evidence-reference-validity.test.mjs',
  'paper-core/tests/evidence-consumption-policy.test.mjs',
  'paper-core/tests/dependency-freshness-policy.test.mjs',
  'paper-core/tests/legacy-history-snapshot.test.mjs',
  'paper-core/tests/campaign-slo.test.mjs',
  'paper-core/tests/campaign-telemetry-persistence.test.mjs',
  'paper-core/tests/typed-research-gap-plan.test.mjs',
  'paper-core/tests/experiment-acceptance-policy.test.mjs',
  'paper-core/tests/manuscript-surface-analyzer.test.mjs',
  'paper-core/tests/submission-live-delivery.test.mjs',
  'paper-core/tests/submission-handoff-bundle.test.mjs',
  'paper-core/tests/legacy-salvage-boundary-hardening.test.mjs',
  'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs',
]);

const SALVAGE_DEDUPLICATED_ELSEWHERE = new Set([
  'paper-core/tests/workspace-snapshot-exporter.test.mjs',
  'paper-core/tests/campaign-slo.test.mjs',
  'paper-core/tests/campaign-telemetry-persistence.test.mjs',
]);

function declaredSuite({ tests, deduplicatedElsewhere, nodeArguments, isolated }) {
  const deduplicated = tests.filter((candidate) => !deduplicatedElsewhere.has(candidate));
  return Object.freeze({
    nodeArguments: Object.freeze([...nodeArguments]),
    isolated,
    full: tests,
    deduplicated: Object.freeze(deduplicated),
    omittedFromDeduplicated: Object.freeze(tests.filter((candidate) => deduplicatedElsewhere.has(candidate))),
  });
}

export const DECLARED_TEST_SUITES = Object.freeze({
  automation: declaredSuite({
    tests: AUTOMATION_TESTS,
    deduplicatedElsewhere: AUTOMATION_DEDUPLICATED_ELSEWHERE,
    nodeArguments: ['--test', '--test-concurrency=1'],
    isolated: false,
  }),
  'salvage-hardening': declaredSuite({
    tests: SALVAGE_HARDENING_TESTS,
    deduplicatedElsewhere: SALVAGE_DEDUPLICATED_ELSEWHERE,
    nodeArguments: ['--test'],
    isolated: true,
  }),
});

export function declaredTestSuite(name, profile = 'full') {
  const suite = DECLARED_TEST_SUITES[String(name || '')];
  if (!suite) throw new Error(`declared_test_suite_unknown:${name || '<empty>'}`);
  if (!['full', 'deduplicated'].includes(profile)) throw new Error(`declared_test_suite_profile_invalid:${profile}`);
  return Object.freeze({
    name: String(name),
    profile,
    isolated: suite.isolated,
    nodeArguments: suite.nodeArguments,
    tests: suite[profile],
  });
}
