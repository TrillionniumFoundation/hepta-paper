import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as coldVolumeCasImportStaging from '../../paper-adapters/archives/cold-volume-cas-import-staging.mjs';
import * as coldVolumeCasObjectInspection from '../../paper-adapters/archives/cold-volume-cas-object-inspection.mjs';
import * as coldVolumeCasPathBoundary from '../../paper-adapters/archives/cold-volume-cas-path-boundary.mjs';
import * as coldVolumeCasPublicationRepository from '../../paper-adapters/archives/cold-volume-cas-publication-repository.mjs';
import * as coldVolumeCasRecordValidation from '../../paper-adapters/archives/cold-volume-cas-record-validation.mjs';
import * as coldVolumeCasRestoreBoundary from '../../paper-adapters/archives/cold-volume-cas-restore-boundary.mjs';
import * as offhostWormCustodyEvidence from '../../paper-adapters/archives/offhost-worm-custody-evidence.mjs';
import * as offhostWormTargetVerification from '../../paper-adapters/archives/offhost-worm-target-verification.mjs';
import * as campaignReleasePackageBuildingMarkerTemporaryRecovery from '../../paper-adapters/automation/campaign-release-package-building-marker-temporary-recovery.mjs';
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
import { DECLARED_TEST_SUITES } from '../src/test-suite-manifest.mjs';

const EXPECTED_AUDITED_THRESHOLDS = Object.freeze({
  'paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 87 },
  'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs': { lines: 55, functions: 40, maxUncoveredBranchBlocks: 60 },
  'paper-adapters/automation/workspace-attempt-repository.mjs': { lines: 80, functions: 85, maxUncoveredBranchBlocks: 110 },
  'paper-adapters/automation/isolated-agent-executor.mjs': { lines: 75, functions: 80, maxUncoveredBranchBlocks: 60 },
  'paper-application/automation/campaign-node-executor.mjs': { lines: 55, functions: 50, maxUncoveredBranchBlocks: 110 },
  'paper-adapters/runtime/scoped-file-materialization-repository.mjs': { lines: 80, functions: 90, maxUncoveredBranchBlocks: 70 },
  'paper-adapters/automation/system-benchmark-harness.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 59 },
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
  'paper-composition/automation/automation-readiness-query.mjs': { lines: 90, functions: 60, maxUncoveredBranchBlocks: 52 },
  'paper-composition/automation/automation-readiness-research-assurance-authority-inspection.mjs': { lines: 55, functions: 55, maxUncoveredBranchBlocks: 92 },
  'paper-composition/automation/automation-readiness-experiment-ir-authority-inspection.mjs': { lines: 80, functions: 95, maxUncoveredBranchBlocks: 97 },
  'paper-adapters/automation/campaign-release-materialization.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 65 },
  'paper-adapters/automation/campaign-release-packager.mjs': { lines: 85, functions: 85, maxUncoveredBranchBlocks: 119 },
  'paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs': { lines: 80, functions: 95, maxUncoveredBranchBlocks: 60 },
  'paper-adapters/automation/campaign-release-package-transaction-repository.mjs': { lines: 75, functions: 95, maxUncoveredBranchBlocks: 66 },
  'paper-adapters/submission/handoff-bundle-detached-records.mjs': { lines: 85, functions: 95, maxUncoveredBranchBlocks: 53 },
  'paper-adapters/submission/handoff-bundle-exporter.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 60 },
  'paper-adapters/submission/handoff-bundle-integrity.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 51 },
  'paper-adapters/submission/handoff-bundle-recovery.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 52 },
  'paper-adapters/submission/sqlite-submission-handoff-export-authority-query.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 95 },
  'paper-domain/submission/submission-handoff-export-request.mjs': { lines: 85, functions: 95, maxUncoveredBranchBlocks: 71 },
  'paper-adapters/automation/trusted-autonomous-manuscript-renderer.mjs': { lines: 85, functions: 80, maxUncoveredBranchBlocks: 56 },
  'paper-adapters/automation/trusted-autonomous-manuscript-revalidation.mjs': { lines: 70, functions: 65, maxUncoveredBranchBlocks: 72 },
  'paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs': { lines: 90, functions: 95, maxUncoveredBranchBlocks: 80 },
  'paper-domain/automation/gpu-scientific-release-authority-freshness-receipt-contract.mjs': { lines: 95, functions: 95, maxUncoveredBranchBlocks: 69 },
  'paper-adapters/build-package/offline-operator-dataset-authority-verifier.mjs': { lines: 90, functions: 90, maxUncoveredBranchBlocks: 54 },
  'paper-domain/automation/full-research-release-qualification-inspection.mjs': { lines: 80, functions: 85, maxUncoveredBranchBlocks: 101 },
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
  'paper-application/execution-context.mjs',
  'paper-application/automation/campaign-generation-lock-wait-abort-recovery.mjs',
  'paper-adapters/automation/campaign-release-materialization.mjs',
  'paper-adapters/automation/campaign-release-package-building-marker-temporary-recovery.mjs',
  'paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs',
  'paper-adapters/automation/campaign-release-package-fenced-transaction-inventory.mjs',
  'paper-adapters/automation/campaign-release-package-generation-budget.mjs',
  'paper-adapters/automation/campaign-release-package-generation-lease.mjs',
  'paper-adapters/automation/campaign-release-package-generation-lease-wait.mjs',
  'paper-adapters/automation/campaign-release-package-transaction-repository.mjs',
  'paper-adapters/automation/campaign-release-packager.mjs',
  'paper-adapters/authority/authority-signatures.mjs',
  'paper-adapters/runtime/release-environment-deployment-closure.mjs',
  'paper-adapters/runtime/release-environment-entrypoint.mjs',
  'paper-adapters/runtime/release-environment-launcher-boundary.mjs',
  'paper-adapters/submission/handoff-artifact-repository-boundary.mjs',
  'paper-adapters/submission/handoff-bundle-detached-records.mjs',
  'paper-adapters/submission/handoff-bundle-detached-verifier.mjs',
  'paper-adapters/submission/handoff-bundle-exporter.mjs',
  'paper-adapters/submission/handoff-bundle-integrity.mjs',
  'paper-adapters/submission/handoff-bundle-pinned-writer.mjs',
  'paper-adapters/submission/handoff-bundle-publication-journal-atomic-writer.mjs',
  'paper-adapters/submission/handoff-bundle-publication-journal-repository.mjs',
  'paper-adapters/submission/handoff-bundle-publication-repository.mjs',
  'paper-adapters/submission/handoff-bundle-recovery.mjs',
  'paper-adapters/submission/handoff-bundle-resource-plan.mjs',
  'paper-adapters/submission/handoff-bundle-sealed-package-copy.mjs',
  'paper-adapters/submission/handoff-bundle-staging-namespace.mjs',
  'paper-adapters/submission/handoff-bundle-staging-owner-repository.mjs',
  'paper-adapters/submission/sqlite-submission-handoff-export-authority-query.mjs',
  'paper-adapters/submission/submission-handoff-export-input-snapshot.mjs',
  'paper-adapters/submission/portal-target-qualification-registry-repository.mjs',
  'paper-composition/bootstrap/release-environment-composition.mjs',
  'paper-composition/bootstrap/submission-handoff-export-context-bootstrap.mjs',
  'paper-composition/submission/submission-handoff-export-composition.mjs',
  'paper-composition/submission/portal-target-qualification-composition.mjs',
  'paper-core/bin/paper-submission-handoff-export.mjs',
  'paper-core/bin/portal-target-qualification.mjs',
  'paper-core/bin/journal-connector-coverage.mjs',
  'paper-core/bin/release-env.mjs',
  'paper-domain/submission/submission-handoff-export-request.mjs',
  'paper-ports/submission-handoff-export-authority-query-port.mjs',
  'paper-composition/automation/automation-readiness-query.mjs',
  'paper-composition/automation/automation-readiness-capability-scope-composition.mjs',
  'paper-composition/automation/automation-readiness-gpu-scientific-snapshot-binding.mjs',
  'paper-composition/automation/automation-readiness-research-assurance-authority-inspection.mjs',
  'paper-composition/automation/automation-readiness-experiment-ir-authority-inspection.mjs',
  'paper-domain/submission/delivery-runtime.mjs',
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
  'paper-adapters/archives/cold-volume-cas-import-staging.mjs',
  'paper-adapters/archives/cold-volume-cas-object-inspection.mjs',
  'paper-adapters/archives/cold-volume-cas-path-boundary.mjs',
  'paper-adapters/archives/cold-volume-cas-publication-repository.mjs',
  'paper-adapters/archives/cold-volume-cas-record-validation.mjs',
  'paper-adapters/archives/cold-volume-cas-repository.mjs',
  'paper-adapters/archives/cold-volume-cas-restore-boundary.mjs',
  'paper-adapters/archives/offhost-worm-repository.mjs',
  'paper-adapters/archives/offhost-worm-custody-evidence.mjs',
  'paper-adapters/archives/offhost-worm-target-verification.mjs',
  'paper-adapters/research-verify/latex-manuscript-reader-support.mjs',
  'paper-adapters/runtime/os-sandbox-worker-runtime-support.mjs',
]);

const GPU_SCIENTIFIC_TRUST_BOUNDARIES = Object.freeze([
  'paper-adapters/automation/campaign-release-gpu-scientific-authority-freshness.mjs',
  'paper-adapters/automation/gpu-scientific-campaign-qualification-intake-repository.mjs',
  'paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs',
  'paper-adapters/build-package/gpu-scientific-artifact-body-archive-file-repository.mjs',
  'paper-adapters/build-package/gpu-scientific-artifact-body-offline-replay.mjs',
  'paper-adapters/build-package/gpu-scientific-artifact-body-archive-source-validation.mjs',
  'paper-adapters/build-package/gpu-scientific-artifact-body-archive.mjs',
  'paper-adapters/build-package/research-evidence-capsule-gpu-scientific.mjs',
  'paper-adapters/runtime/gpu-selector-execution-lease-file-identity.mjs',
  'paper-adapters/runtime/gpu-selector-execution-lease-file-lock.mjs',
  'paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs',
  'paper-adapters/runtime/gpu-selector-execution-lease-state.mjs',
  'paper-adapters/runtime/os-sandbox-worker-gpu-selector-lease.mjs',
  'paper-composition/automation/autonomous-research-gpu-scientific-plan.mjs',
  'paper-composition/automation/gpu-scientific-campaign-composition.mjs',
  'paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs',
  'paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs',
  'paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs',
  'paper-domain/automation/gpu-scientific-campaign-promotion-contract-validation.mjs',
  'paper-domain/automation/gpu-scientific-release-authority-freshness-receipt-contract.mjs',
  'paper-domain/automation/gpu-selector-execution-lease-contract.mjs',
  'paper-ports/gpu-selector-execution-lease-port.mjs',
]);

const IMMUTABLE_RELEASE_AND_RUNTIME_ADOPTION_TRUST_BOUNDARIES = Object.freeze([
  'paper-domain/contracts/immutable-release-deployment-contract.mjs',
  'paper-ports/immutable-release-deployment-port.mjs',
  'paper-adapters/runtime/immutable-release-candidate-repository.mjs',
  'paper-adapters/runtime/immutable-release-deployment-closure-repository.mjs',
  'paper-adapters/runtime/immutable-release-deployment-intent-repository.mjs',
  'paper-adapters/runtime/immutable-release-deployment-lock-repository.mjs',
  'paper-adapters/runtime/immutable-release-host-artifact-repository.mjs',
  'paper-adapters/runtime/immutable-release-linux-host-repository.mjs',
  'paper-adapters/runtime/immutable-release-linux-host-systemd.mjs',
  'paper-adapters/runtime/immutable-release-process-reference-inspection.mjs',
  'paper-adapters/runtime/immutable-release-submodule-materializer.mjs',
  'paper-adapters/runtime/immutable-release-workspace-repository.mjs',
  'paper-application/orchestration/immutable-release-deployment-recovery.mjs',
  'paper-application/orchestration/immutable-release-deployment-transaction.mjs',
  'paper-composition/bootstrap/immutable-release-deployment-composition.mjs',
  'paper-composition/bootstrap/immutable-release-deployment-cli.mjs',
  'paper-core/bin/immutable-release-deploy.mjs',
  'paper-domain/contracts/release-state-contract.mjs',
  'paper-adapters/runtime/release-state-repository.mjs',
  'paper-core/bin/release-state-check.mjs',
  'paper-adapters/runtime/strict-npm-audit-launcher.mjs',
  'paper-composition/bootstrap/strict-npm-audit-composition.mjs',
  'paper-core/bin/strict-npm-audit.mjs',
  'paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs',
  'paper-domain/automation/strict-full-auto-acceptance-runtime-adoption.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-authority.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-completion.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-state.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition.mjs',
  'paper-adapters/automation/autonomous-research-pristine-runtime-state.mjs',
  'paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs',
  'paper-adapters/automation/local-autonomous-research-state-authority-schema-rebind.mjs',
  'paper-composition/automation/autonomous-research-online-schema-transition-composition.mjs',
  'paper-composition/automation/autonomous-research-pristine-runtime-state-composition.mjs',
  'paper-composition/automation/strict-full-auto-acceptance-composition.mjs',
  'paper-core/bin/autonomous-research-online-schema-transition.mjs',
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
  assert.match(source, /delete environment\.GIT_INDEX_FILE/);
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
  assert.deepEqual(CRITICAL_COVERAGE_TARGET_REGISTRY.find((entry) => (
    entry.path === 'paper-core/verification/critical-module-coverage-target-overrides.mjs'
  )), {
    path: 'paper-core/verification/critical-module-coverage-target-overrides.mjs',
    trustBoundary: false,
  });

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
    ...GPU_SCIENTIFIC_TRUST_BOUNDARIES,
  ]) {
    assert.deepEqual(targetsByPath.get(relative), {
      path: relative,
      trustBoundary: true,
    }, relative);
  }
});

test('immutable release, release state, strict audit, and runtime adoption boundaries cannot fall out of critical coverage', () => {
  const targetsByPath = new Map(CRITICAL_COVERAGE_TARGET_REGISTRY.map(
    (entry) => [entry.path, entry],
  ));
  const thresholds = buildCriticalCoverageTargetThresholds();
  for (const relative of IMMUTABLE_RELEASE_AND_RUNTIME_ADOPTION_TRUST_BOUNDARIES) {
    assert.deepEqual(targetsByPath.get(relative), {
      path: relative,
      trustBoundary: true,
    }, relative);
    assert.deepEqual(
      thresholds.get(relative) || CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
      CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
      relative,
    );
  }
});

test('package lifecycle recovery and live retention authority cannot fall out of critical coverage', () => {
  const targetsByPath = new Map(CRITICAL_COVERAGE_TARGET_REGISTRY.map(
    (entry) => [entry.path, entry],
  ));
  const thresholds = buildCriticalCoverageTargetThresholds();
  for (const relative of [
    'paper-domain/automation/package-lifecycle-authority-contract.mjs',
    'paper-domain/automation/package-lifecycle-receipt-contract.mjs',
    'paper-domain/automation/package-recovery-authority-readiness-contract.mjs',
    'paper-domain/automation/package-recovery-deletion-lease-contract.mjs',
    'paper-domain/automation/package-recovery-deletion-lease-resume-contract.mjs',
    'paper-domain/automation/package-recovery-storage-authority-subject.mjs',
    'paper-domain/automation/package-recovery-tree-inventory-contract.mjs',
    'paper-domain/automation/package-retention-recovery-proof-contract.mjs',
    'paper-domain/automation/package-retention-recovery-authority-contract.mjs',
    'paper-domain/evidence/receipt-issuer-policy-registry.mjs',
    'paper-adapters/artifacts/filesystem-artifact-repository.mjs',
    'paper-adapters/artifacts/write-artifact.mjs',
    'paper-application/automation/package-lifecycle-authority-service.mjs',
    'paper-application/automation/package-recovery-deletion-lease-client.mjs',
    'paper-application/automation/package-retention-recovery-provisioner.mjs',
    'paper-application/automation/campaign-command-service.mjs',
    'paper-ports/package-recovery-authority-readiness-port.mjs',
    'paper-ports/package-recovery-authority-port.mjs',
    'paper-ports/package-recovery-deletion-lease-port.mjs',
    'paper-ports/package-recovery-live-source-inspection.mjs',
    'paper-adapters/automation/package-retention-recovery-lock-repository.mjs',
    'paper-adapters/automation/package-lifecycle-materialization-inspector.mjs',
    'paper-adapters/automation/package-recovery-tree-inventory-repository.mjs',
    'paper-adapters/automation/package-recovery-exact-restore-boundary.mjs',
    'paper-adapters/automation/package-recovery-exact-restore-repository.mjs',
    'paper-composition/automation/package-recovery-production-composition.mjs',
    'paper-composition/automation/autonomous-research-supervisor-runtime-composition.mjs',
    'paper-composition/automation/campaign-command-composition.mjs',
    'paper-composition/automation/paper-campaign-command-composition.mjs',
    'paper-adapters/automation/runtime-retention-package-lifecycle-authority.mjs',
    'paper-adapters/automation/runtime-retention-reachability-provider-repository.mjs',
    'paper-adapters/automation/runtime-retention-live-authority.mjs',
    'paper-adapters/automation/runtime-retention-intent-operations.mjs',
    'paper-adapters/automation/runtime-retention-intent-repository.mjs',
    'paper-adapters/automation/runtime-retention-scope-repository.mjs',
    'paper-adapters/automation/runtime-retention-quarantine-repository.mjs',
    'paper-adapters/automation/runtime-retention-authorized-package-removal.mjs',
    'paper-adapters/automation/runtime-retention-package-deletion-authority.mjs',
    'paper-adapters/automation/runtime-retention-fenced-staging-deletion-authority.mjs',
    'paper-adapters/automation/runtime-retention-package-removal-live-boundary.mjs',
    'paper-adapters/automation/runtime-retention-package-deletion-fence-contract.mjs',
    'paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs',
    'paper-adapters/automation/runtime-retention-package-deletion-fence-storage-repository.mjs',
    'paper-adapters/automation/runtime-retention-package-deletion-writer-boundary.mjs',
    'paper-adapters/automation/runtime-retention-published-package-deletion-lease.mjs',
    'paper-adapters/automation/runtime-retention-removal-recovery-contract.mjs',
    'paper-adapters/automation/runtime-retention-removal-snapshot-repository.mjs',
    'paper-adapters/automation/runtime-retention-pinned-removal-repository.mjs',
    'paper-adapters/automation/runtime-retention-removal-storage-repository.mjs',
    'paper-adapters/automation/runtime-retention-removal-recovery-repository.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-config.mjs',
    'paper-adapters/automation/campaign-release-packaging-helpers.mjs',
    'paper-adapters/persistence/runtime-retention-package-deletion-writer-store.mjs',
    'paper-adapters/persistence/sqlite-campaign-mutation-boundary.mjs',
    'paper-adapters/persistence/sqlite-campaign-prepared-integration-operations.mjs',
    'paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs',
    'paper-adapters/persistence/sqlite-receipt-ledger.mjs',
    'paper-adapters/referee-revise/index.mjs',
    'paper-adapters/referee-revise/post-repair.mjs',
    'paper-composition/bootstrap/capability-scoped-bootstrap.mjs',
    'paper-composition/bootstrap/context-foundation-composition.mjs',
    'paper-composition/bootstrap/operator-persistence-composition.mjs',
    'paper-composition/bootstrap/automation-campaign-state-composition.mjs',
    'paper-composition/bootstrap/automation-context-bootstrap.mjs',
    'paper-composition/bootstrap/automation-research-authority-composition.mjs',
    'paper-composition/compat/legacy-context-bootstrap.mjs',
    'paper-composition/compat/legacy-stage-port-composition.mjs',
    'paper-core/bin/automation-reconcile.mjs',
    'paper-core/bin/hepta-store.mjs',
    'paper-core/bin/paper-campaign.mjs',
    'paper-core/bin/repair-receipt-ledger-integrity.mjs',
    'paper-core/bin/runtime-hygiene.mjs',
    'paper-core/bin/workspace-lineage-backfill.mjs',
    'paper-ports/execution-service-ports.mjs',
  ]) {
    assert.deepEqual(targetsByPath.get(relative), {
      path: relative,
      trustBoundary: true,
    }, relative);
    assert.deepEqual(
      thresholds.get(relative) || CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
      CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
      relative,
    );
  }
});

test('hepta-store backup file validation cannot fall out of critical coverage', () => {
  const targetEntry = CRITICAL_COVERAGE_TARGET_REGISTRY.find(
    (entry) => entry.path
      === 'paper-adapters/persistence/hepta-store-backup-file-repository.mjs',
  );
  assert.deepEqual(targetEntry, {
    path: 'paper-adapters/persistence/hepta-store-backup-file-repository.mjs',
    trustBoundary: true,
  });
  assert.deepEqual(
    buildCriticalCoverageTargetThresholds().get(targetEntry.path)
      || CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
    CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
  );
});

test('campaign release building marker recovery has one exact trust surface', () => {
  assert.deepEqual(
    Object.keys(campaignReleasePackageBuildingMarkerTemporaryRecovery),
    [
      'removeExactCampaignReleasePackageAbortedStagingSync',
      'removeExactUnpublishedCampaignReleasePackageBuildingMarkerTemporarySync',
    ],
  );
});

test('GPU scientific production tests cannot fall out of the declared automation suite', () => {
  const gpuScientificTestName =
    /(?:gpu-scientific|gpu-selector-execution-lease|gpu-worker-device-isolation|pde-poisson-2d-gpu|deep-learning-(?:canonical|gpu))/u;
  const declared = new Set(DECLARED_TEST_SUITES.automation.full);
  const discovered = fs.readdirSync(new URL('./', import.meta.url), {
    withFileTypes: true,
  }).filter((entry) => (
    entry.isFile()
      && entry.name.endsWith('.test.mjs')
      && gpuScientificTestName.test(entry.name)
  )).map((entry) => `paper-core/tests/${entry.name}`).sort();
  assert.ok(discovered.length >= 15, 'GPU scientific test inventory unexpectedly shrank');
  assert.deepEqual(
    discovered.filter((candidate) => !declared.has(candidate)),
    [],
  );
});

test('sandbox runtime support facade has one exact permission surface', () => {
  assert.deepEqual(Object.keys(sandboxRuntimeSupport).sort(), [
    'beginWorkerProcessIdentity',
    'bubblewrapRuntimeResourceMounts',
    'buildBubblewrapWorkerCommand',
    'buildDockerWorkerCommand',
    'buildWorkerProcessInvocationBinding',
    'completeWorkerProcessIdentity',
    'createDatasetSupervisorEvidenceFiles',
    'datasetRuntimePreflightBlockers',
    'dockerSystemMounts',
    'executableRuntimePathSupported',
    'explicitContainerRuntimeIdentityPayload',
    'normalizeNvidiaGpuDeviceSelector',
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

test('cold-volume CAS import staging has one exact internal surface', () => {
  assert.deepEqual(Object.keys(coldVolumeCasImportStaging), [
    'acquireColdVolumeCasImportLease',
    'coldVolumeCasImportArchivePath',
    'combineColdVolumeCasImportCleanupError',
    'inspectColdVolumeCasImportArchive',
    'openColdVolumeCasImportStaging',
    'openColdVolumeCasImportTempDirectory',
    'publishColdVolumeCasImportArchive',
    'releaseColdVolumeCasImportLease',
    'removeColdVolumeCasImportArchive',
    'removeColdVolumeCasImportTempDirectory',
    'sealColdVolumeCasImportArchive',
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

test('cold-volume CAS record validation has one exact trust surface', () => {
  assert.deepEqual(Object.keys(coldVolumeCasRecordValidation), [
    'expectedColdVolumeCasContractBinding',
    'isColdVolumeCasCurrentPointer',
    'validateColdVolumeCasManifest',
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
    'assertOffhostWormTargetMountBinding',
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
    'APPROVED_PREDECESSOR_CLOSURE_HASHES',
    'CODEX_DIRECTORY',
    'EXACT_SEAL_POLICY',
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
