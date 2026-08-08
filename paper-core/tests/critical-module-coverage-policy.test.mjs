import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildCriticalCoveragePolicy,
  buildCriticalCoverageTargetThresholds,
  CRITICAL_COVERAGE_DEFAULT_THRESHOLD,
  CRITICAL_COVERAGE_MAXIMUM_AUDITED_BRANCH_CAP,
  CRITICAL_COVERAGE_TARGET_OVERRIDES,
  CRITICAL_COVERAGE_TARGET_REGISTRY,
  CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
  validateCriticalCoveragePolicy,
  validateCriticalCoverageTargetRegistry,
} from '../verification/critical-module-coverage-policy.mjs';

const EXPECTED_AUDITED_CAPS = Object.freeze({
  'paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs': 87,
  'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs': 60,
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
  assert.equal(validateCriticalCoveragePolicy(), true);
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
    assert.throws(() => validateCriticalCoveragePolicy({ targetOverrides: overrides }),
      new RegExp(`critical_coverage_target_override_invalid:${relative}`));
  }
});

test('coverage runner consumes the canonical registry instead of duplicate target sets', () => {
  const source = fs.readFileSync(
    new URL('../bin/critical-module-coverage.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /buildCriticalCoveragePolicy/);
  assert.doesNotMatch(source, /const explicitlyTargetedModules/);
  assert.doesNotMatch(source, /const TRUST_TARGETS = new Set/);
});

test('critical coverage targets, trust boundaries, and thresholds derive from one registry', () => {
  assert.equal(validateCriticalCoverageTargetRegistry(), true);
  const paths = CRITICAL_COVERAGE_TARGET_REGISTRY.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(CRITICAL_COVERAGE_TARGET_REGISTRY.every((entry) => (
    Object.keys(entry).sort().join(',') === 'path,trustBoundary'
      && typeof entry.trustBoundary === 'boolean'
  )), true);

  const policy = buildCriticalCoveragePolicy();
  assert.deepEqual(policy.targets, paths);
  assert.deepEqual(
    [...policy.trustTargets],
    CRITICAL_COVERAGE_TARGET_REGISTRY
      .filter((entry) => entry.trustBoundary)
      .map((entry) => entry.path),
  );
  for (const [relative, override] of Object.entries(
    CRITICAL_COVERAGE_TARGET_OVERRIDES,
  )) {
    assert.equal(paths.includes(relative), true, relative);
    assert.equal(policy.trustTargets.has(relative), override.trustBoundary, relative);
  }

  const thresholds = buildCriticalCoverageTargetThresholds();
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

test('dynamic target derivation preserves order, deduplicates, and only upgrades trust', () => {
  const upgraded = 'paper-domain/automation/analysis-statistics.mjs';
  const leading = Object.freeze({
    path: 'paper-domain/contracts/discovered-contract.mjs',
    trustBoundary: false,
  });
  const trailing = Object.freeze({
    path: 'paper-adapters/automation/discovered-online-state.mjs',
    trustBoundary: true,
  });
  const policy = buildCriticalCoveragePolicy({
    leadingTargets: [leading],
    trailingTargets: [
      Object.freeze({ path: upgraded, trustBoundary: true }),
      trailing,
    ],
  });
  assert.equal(policy.targets[0], leading.path);
  assert.equal(policy.targets.at(-1), trailing.path);
  assert.equal(policy.targets.filter((relative) => relative === upgraded).length, 1);
  assert.equal(policy.trustTargets.has(upgraded), true);
  assert.equal(policy.trustTargets.has(leading.path), false);
  assert.equal(policy.trustTargets.has(trailing.path), true);
});

test('critical coverage registry rejects duplicate or malformed declarations', () => {
  const valid = Object.freeze({ path: 'paper-domain/example.mjs', trustBoundary: false });
  for (const targetRegistry of [
    [valid, valid],
    [{ path: '../escape.mjs', trustBoundary: false }],
    [{ path: 'paper-domain/example.mjs', trustBoundary: 'false' }],
    [{ ...valid, extra: true }],
  ]) {
    assert.throws(() => validateCriticalCoverageTargetRegistry({ targetRegistry }),
      /critical_coverage_target_registry_invalid/);
  }
});
