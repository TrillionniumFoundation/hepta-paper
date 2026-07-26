import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildCriticalCoverageTargetThresholds,
  CRITICAL_COVERAGE_DEFAULT_THRESHOLD,
  CRITICAL_COVERAGE_MAXIMUM_AUDITED_BRANCH_CAP,
  CRITICAL_COVERAGE_TARGET_OVERRIDES,
  CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
  validateCriticalCoveragePolicy,
} from '../verification/critical-module-coverage-policy.mjs';

const EXPECTED_AUDITED_CAPS = Object.freeze({
  'paper-adapters/automation/workspace-attempt-repository.mjs': 110,
  'paper-adapters/automation/isolated-agent-executor.mjs': 60,
  'paper-application/automation/campaign-node-executor.mjs': 110,
  'paper-adapters/runtime/scoped-file-materialization-repository.mjs': 70,
  'paper-adapters/automation/system-benchmark-harness.mjs': 56,
  'paper-application/automation/autonomous-research-campaign.mjs': 81,
  'paper-domain/automation/autonomous-submission-contract.mjs': 55,
  'paper-domain/automation/autonomous-venue-compliance-contract.mjs': 81,
  'paper-adapters/automation/autonomous-research-state-database-inventory.mjs': 57,
  'paper-adapters/automation/autonomous-research-state-backup-repository.mjs': 49,
  'paper-composition/automation/autonomous-research-external-capability-composition.mjs': 53,
  'paper-adapters/automation/http-external-research-replay-adapter.mjs': 61,
  'paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs': 71,
  'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs': 66,
  'paper-domain/automation/strict-full-auto-acceptance-plan.mjs': 57,
  'paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs': 52,
  'paper-domain/automation/autonomous-research-release-binding-contract.mjs': 51,
  'paper-domain/automation/autonomous-formal-support-registry.mjs': 52,
  'paper-adapters/research-verify/lake-formal-verifier.mjs': 55,
  'paper-adapters/research-verify/trusted-formal-producer.mjs': 70,
  'paper-domain/research/formal-certificate-native-closure.mjs': 92,
  'paper-adapters/runtime/docker-worker-container-recovery.mjs': 51,
  'paper-adapters/runtime/os-sandboxed-worker-runner.mjs': 102,
  'paper-adapters/automation/nested-runtime-platform-qualification-verifier.mjs': 54,
});

const REQUIRED_NEW_TRUST_TARGETS = Object.freeze([
  'paper-adapters/automation/formal-domain-qualification-recovery-journal.mjs',
  'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs',
  'paper-adapters/automation/recoverable-reviewer-workspace-snapshot.mjs',
  'paper-adapters/automation/opaque-runtime-credential-file.mjs',
  'paper-adapters/automation/reviewer-principal-executor-pool.mjs',
  'paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs',
  'paper-adapters/automation/reviewer-principal-executor-recovery-port.mjs',
  'paper-adapters/automation/reviewer-principal-signer-recovery-port.mjs',
  'paper-adapters/automation/reviewer-principal-recovery-support.mjs',
  'paper-composition/automation/formal-domain-qualification-external-evidence-composition.mjs',
  'paper-composition/automation/reviewer-principal-pool-composition.mjs',
  'paper-ports/external-research-replay-port.mjs',
  'paper-ports/reviewer-receipt-signer-port.mjs',
  'paper-adapters/runtime/docker-worker-container-recovery.mjs',
  'paper-adapters/runtime/os-sandboxed-worker-runner.mjs',
  'paper-adapters/runtime/runtime-resource-mounts.mjs',
  'paper-domain/automation/nested-runtime-authority-independence-contract.mjs',
  'paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs',
  'paper-adapters/automation/strict-full-auto-acceptance-control-file-repository.mjs',
  'paper-adapters/automation/strict-full-auto-acceptance-control-paths.mjs',
  'paper-adapters/automation/strict-full-auto-acceptance-control-store-repository.mjs',
  'paper-adapters/automation/strict-full-auto-acceptance-plan-control-store.mjs',
  'paper-adapters/automation/strict-full-auto-acceptance-repository.mjs',
  'paper-adapters/automation/strict-full-auto-acceptance-root-binding.mjs',
  'paper-application/automation/strict-full-auto-acceptance-live-verification.mjs',
  'paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs',
  'paper-application/automation/strict-full-auto-acceptance-state.mjs',
  'paper-domain/automation/strict-full-auto-acceptance-plan.mjs',
  'paper-domain/automation/strict-full-auto-acceptance-policy.mjs',
  'paper-domain/research/native-formal-certificate-intake-v4.mjs',
  'paper-domain/research/formal-certificate-intake.mjs',
  'paper-domain/research/formal-certificate-intake-primitives.mjs',
  'paper-domain/research/formal-certificate-native-closure.mjs',
  'paper-domain/research/formal-certificate-intake-builder.mjs',
  'paper-adapters/research-verify/trusted-formal-producer-contract.mjs',
  'paper-adapters/research-verify/dynamic-formal-sandbox-probe-verifier.mjs',
]);

function trustTargetsFor(overrides = CRITICAL_COVERAGE_TARGET_OVERRIDES) {
  return new Set(Object.entries(overrides)
    .filter(([, override]) => override.trustBoundary)
    .map(([relative]) => relative));
}

function changedOverride(relative, change) {
  return Object.freeze({
    ...CRITICAL_COVERAGE_TARGET_OVERRIDES,
    [relative]: Object.freeze({
      ...CRITICAL_COVERAGE_TARGET_OVERRIDES[relative],
      ...change,
    }),
  });
}

test('critical coverage baselines and audited branch caps are exact', () => {
  assert.deepEqual(CRITICAL_COVERAGE_DEFAULT_THRESHOLD, {
    lines: 40,
    functions: 25,
    maxUncoveredBranchBlocks: 180,
  });
  assert.deepEqual(CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD, {
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 48,
  });
  assert.equal(CRITICAL_COVERAGE_MAXIMUM_AUDITED_BRANCH_CAP, 120);
  assert.deepEqual(
    Object.fromEntries(Object.entries(CRITICAL_COVERAGE_TARGET_OVERRIDES)
      .map(([relative, override]) => [
        relative,
        override.maxUncoveredBranchBlocks,
      ])),
    EXPECTED_AUDITED_CAPS,
  );
  assert.equal(validateCriticalCoveragePolicy({
    trustTargets: trustTargetsFor(),
  }), true);
});

test('critical coverage policy rejects silent threshold relaxation', () => {
  const relative =
    'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';
  for (const change of [
    { maxUncoveredBranchBlocks: 121 },
    { lines: 54 },
    { functions: 39 },
    { rationale: 'too short' },
    { reviewedAttackSurface: ['tamper', 'tamper'] },
    { trustBoundary: false },
  ]) {
    const overrides = changedOverride(relative, change);
    assert.throws(() => validateCriticalCoveragePolicy({
      trustTargets: trustTargetsFor(),
      targetOverrides: overrides,
    }), new RegExp(`critical_coverage_target_override_invalid:${relative}`));
  }
});

test('coverage runner consumes the reviewed policy and targets every new trust module', () => {
  const source = fs.readFileSync(
    new URL('../bin/critical-module-coverage.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /buildCriticalCoverageTargetThresholds/);
  assert.doesNotMatch(source, /const TARGET_THRESHOLDS = new Map/);
  for (const relative of REQUIRED_NEW_TRUST_TARGETS) {
    assert.equal(
      source.split(`'${relative}'`).length - 1,
      2,
      relative,
    );
  }
  const thresholds = buildCriticalCoverageTargetThresholds({
    trustTargets: trustTargetsFor(),
  });
  assert.deepEqual(thresholds.get(
    'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs',
  ), {
    lines: 80,
    functions: 75,
    maxUncoveredBranchBlocks: 66,
  });
  assert.equal(
    Object.hasOwn(thresholds.get(
      'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs',
    ), 'rationale'),
    false,
  );
});
