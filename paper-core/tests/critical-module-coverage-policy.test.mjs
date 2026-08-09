import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as coldVolumeCasObjectInspection from '../../paper-adapters/archives/cold-volume-cas-object-inspection.mjs';
import * as coldVolumeCasPathBoundary from '../../paper-adapters/archives/cold-volume-cas-path-boundary.mjs';
import * as coldVolumeCasPublicationRepository from '../../paper-adapters/archives/cold-volume-cas-publication-repository.mjs';
import * as coldVolumeCasRestoreBoundary from '../../paper-adapters/archives/cold-volume-cas-restore-boundary.mjs';
import * as offhostWormCustodyEvidence from '../../paper-adapters/archives/offhost-worm-custody-evidence.mjs';
import * as offhostWormTargetVerification from '../../paper-adapters/archives/offhost-worm-target-verification.mjs';
import * as releaseEnvironmentDeploymentClosure from '../../paper-adapters/runtime/release-environment-deployment-closure.mjs';
import * as releaseEnvironmentLauncherBoundary from '../../paper-adapters/runtime/release-environment-launcher-boundary.mjs';
import * as sandboxRuntimeSupport from '../../paper-adapters/runtime/os-sandbox-worker-runtime-support.mjs';

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

const EXPECTED_AUDITED_THRESHOLDS = Object.freeze({
  'paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 87 },
  'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 60 },
  'paper-adapters/automation/workspace-attempt-repository.mjs': { lines: 80, functions: 85, maxUncoveredBranchBlocks: 110 },
  'paper-adapters/automation/isolated-agent-executor.mjs': { lines: 75, functions: 80, maxUncoveredBranchBlocks: 60 },
  'paper-application/automation/campaign-node-executor.mjs': { lines: 55, functions: 50, maxUncoveredBranchBlocks: 110 },
  'paper-adapters/runtime/scoped-file-materialization-repository.mjs': { lines: 80, functions: 90, maxUncoveredBranchBlocks: 70 },
  'paper-adapters/automation/system-benchmark-harness.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 56 },
  'paper-application/automation/autonomous-research-campaign.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 81 },
  'paper-domain/automation/autonomous-submission-contract.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 55 },
  'paper-domain/automation/autonomous-venue-compliance-contract.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 81 },
  'paper-adapters/automation/autonomous-research-state-database-inventory.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 57 },
  'paper-adapters/automation/autonomous-research-state-backup-repository.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 49 },
  'paper-composition/automation/autonomous-research-external-capability-composition.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 53 },
  'paper-adapters/automation/http-external-research-replay-adapter.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 61 },
  'paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 71 },
  'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs': { lines: 80, functions: 75, maxUncoveredBranchBlocks: 66 },
  'paper-domain/automation/strict-full-auto-acceptance-plan.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 57 },
  'paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 52 },
  'paper-domain/automation/autonomous-research-release-binding-contract.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 51 },
  'paper-domain/automation/autonomous-formal-support-registry.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 52 },
  'paper-adapters/research-verify/lake-formal-verifier.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 55 },
  'paper-adapters/research-verify/trusted-formal-producer.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 70 },
  'paper-domain/research/formal-certificate-native-closure.mjs': { lines: 90, functions: 90, maxUncoveredBranchBlocks: 92 },
  'paper-adapters/runtime/docker-worker-container-recovery.mjs': { lines: 80, functions: 95, maxUncoveredBranchBlocks: 51 },
  'paper-adapters/runtime/os-sandboxed-worker-runner.mjs': { lines: 85, functions: 85, maxUncoveredBranchBlocks: 102 },
  'paper-adapters/automation/nested-runtime-platform-qualification-verifier.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 54 },
});

const SPLIT_TRUST_BOUNDARY_DIRECTORIES = Object.freeze([
  Object.freeze({
    directory: new URL('../bin/', import.meta.url),
    pattern: /^release-evidence-.*\.mjs$/u,
    prefix: 'paper-core/bin/',
  }),
  Object.freeze({
    directory: new URL('../../paper-adapters/runtime/', import.meta.url),
    pattern: /^os-sandbox-worker-execution-.*\.mjs$/u,
    prefix: 'paper-adapters/runtime/',
  }),
]);

const RELEASE_AND_PORTAL_TRUST_BOUNDARIES = Object.freeze([
  'paper-adapters/authority/authority-signatures.mjs',
  'paper-adapters/runtime/release-environment-deployment-closure.mjs',
  'paper-adapters/runtime/release-environment-entrypoint.mjs',
  'paper-adapters/runtime/release-environment-launcher-boundary.mjs',
  'paper-adapters/submission/portal-target-qualification-registry-repository.mjs',
  'paper-composition/bootstrap/release-environment-composition.mjs',
  'paper-composition/submission/portal-target-qualification-composition.mjs',
  'paper-core/bin/portal-target-qualification.mjs',
  'paper-core/bin/journal-connector-coverage.mjs',
  'paper-core/bin/release-env.mjs',
  'paper-domain/submission/portal-target-qualification-contract.mjs',
]);

const RELEASE_INTEGRITY_TRUST_BOUNDARIES = Object.freeze([
  'paper-core/bin/release-integrity-evidence.mjs',
  'paper-core/bin/release-integrity-filesystem.mjs',
  'paper-core/bin/release-integrity-key-management.mjs',
  'paper-core/bin/release-integrity-key-provisioning.mjs',
  'paper-core/bin/release-integrity-key-reader.mjs',
  'paper-core/bin/release-integrity-key-storage.mjs',
  'paper-core/bin/release-integrity-key.mjs',
  'paper-core/bin/release-integrity-signing.mjs',
]);

const SHARED_TRUST_BOUNDARIES = Object.freeze([
  'paper-adapters/archives/cold-volume-cas-object-inspection.mjs',
  'paper-adapters/archives/cold-volume-cas-path-boundary.mjs',
  'paper-adapters/archives/cold-volume-cas-publication-repository.mjs',
  'paper-adapters/archives/cold-volume-cas-repository.mjs',
  'paper-adapters/archives/cold-volume-cas-restore-boundary.mjs',
  'paper-adapters/archives/offhost-worm-repository.mjs',
  'paper-adapters/archives/offhost-worm-custody-evidence.mjs',
  'paper-adapters/archives/offhost-worm-target-verification.mjs',
  'paper-adapters/research-verify/latex-manuscript-reader-support.mjs',
  'paper-adapters/runtime/os-sandbox-worker-runtime-support.mjs',
]);

function splitTrustBoundaryTargets() {
  return [
    ...SPLIT_TRUST_BOUNDARY_DIRECTORIES.flatMap(({ directory, pattern, prefix }) => (
      fs.readdirSync(directory)
        .filter((name) => pattern.test(name))
        .map((name) => `${prefix}${name}`)
    )),
    'paper-adapters/authority/external-principal-identity-attestation-bundle-codec.mjs',
  ].sort();
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

test('critical coverage baselines and audited override thresholds are exact', () => {
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
        {
          lines: override.lines,
          functions: override.functions,
          maxUncoveredBranchBlocks: override.maxUncoveredBranchBlocks,
        },
      ])),
    EXPECTED_AUDITED_THRESHOLDS,
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

test('split trust modules and the canonical principal codec remain critical targets', () => {
  const targetsByPath = new Map(CRITICAL_COVERAGE_TARGET_REGISTRY.map(
    (entry) => [entry.path, entry],
  ));
  const splitTargets = splitTrustBoundaryTargets();
  assert.ok(splitTargets.length >= 8, 'split trust-boundary inventory unexpectedly shrank');
  for (const relative of splitTargets) {
    assert.deepEqual(targetsByPath.get(relative), {
      path: relative,
      trustBoundary: true,
    }, relative);
  }
});

test('release and portal qualification boundaries cannot fall out of critical coverage', () => {
  const targetsByPath = new Map(CRITICAL_COVERAGE_TARGET_REGISTRY.map(
    (entry) => [entry.path, entry],
  ));
  for (const relative of [
    ...RELEASE_AND_PORTAL_TRUST_BOUNDARIES,
    ...RELEASE_INTEGRITY_TRUST_BOUNDARIES,
    ...SHARED_TRUST_BOUNDARIES,
  ]) {
    assert.deepEqual(targetsByPath.get(relative), {
      path: relative,
      trustBoundary: true,
    }, relative);
  }
});

test('sandbox runtime support facade has one exact permission surface', () => {
  assert.deepEqual(Object.keys(sandboxRuntimeSupport).sort(), [
    'beginWorkerProcessIdentity',
    'bubblewrapRuntimeResourceMounts',
    'buildBubblewrapWorkerCommand',
    'buildDockerWorkerCommand',
    'completeWorkerProcessIdentity',
    'createDatasetSupervisorEvidenceFiles',
    'datasetRuntimePreflightBlockers',
    'dockerSystemMounts',
    'executableRuntimePathSupported',
    'explicitContainerRuntimeIdentityPayload',
    'normalizeTrustedDatasetSupervisorImage',
    'prepareUnprivilegedDatasetWorkspace',
  ]);
});

test('offhost custody evidence verifier has one exact trust surface', () => {
  assert.deepEqual(Object.keys(offhostWormCustodyEvidence), [
    'inspectOffhostWormCustodyEvidence',
  ]);
});

test('cold-volume CAS path boundary has one exact trust surface', () => {
  assert.deepEqual(Object.keys(coldVolumeCasPathBoundary), [
    'assertPinnedCasDirectoryChain',
    'assertPinnedCasFileCurrent',
    'assertPinnedCasOwnedDirectory',
    'assertPinnedCasPublishedFile',
    'closePinnedCasDirectoryChain',
    'duplicatePinnedCasFileForRead',
    'errorCausedByCode',
    'hashPinnedCasFile',
    'openPinnedCasAbsoluteDirectoryChain',
    'openPinnedCasChildDirectory',
    'openPinnedCasJsonRecord',
    'openPinnedCasRegularFile',
    'pinnedCasChildPath',
    'readPinnedCasDirectory',
    'readPinnedCasJsonRecord',
  ]);
});

test('cold-volume CAS object inspection has one exact trust surface', () => {
  assert.deepEqual(Object.keys(coldVolumeCasObjectInspection), [
    'closePinnedCasObjectInspection',
    'inspectPinnedCasObjects',
    'pinnedCasObjectBindingBlockers',
  ]);
});

test('cold-volume CAS publication boundary has one exact trust surface', () => {
  assert.deepEqual(Object.keys(coldVolumeCasPublicationRepository), [
    'publishPinnedCasBytes',
    'publishPinnedCasSourceFile',
    'replacePinnedCasBytes',
  ]);
});

test('cold-volume CAS restore boundary has one exact trust surface', () => {
  assert.deepEqual(Object.keys(coldVolumeCasRestoreBoundary), [
    'inspectPinnedCasArchiveListing',
    'inspectRestoredCasEntryInventory',
  ]);
});

test('offhost target verifier has one exact trust surface', () => {
  assert.deepEqual(Object.keys(offhostWormTargetVerification), [
    'verifyOffhostWormTarget',
  ]);
});

test('release environment launcher boundary has one exact permission surface', () => {
  assert.deepEqual(Object.keys(releaseEnvironmentLauncherBoundary), [
    'inspectReleaseEnvironmentLauncherBoundary',
  ]);
});

test('release deployment closure verifier has one exact trust surface', () => {
  assert.deepEqual(Object.keys(releaseEnvironmentDeploymentClosure), [
    'inspectSealedDeploymentClosure',
  ]);
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
