import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  composeFixedAutonomousResearchOneShotCampaignAttempt,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import {
  defaultAutonomousResearchOneShotNativeStoreSnapshotGuard,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-preflight.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  executionBinding,
} from './support/autonomous-research-one-shot-campaign-attempt-fixture.mjs';

function H(label) {
  return hashRecord('AutonomousResearchOneShotCampaignAttemptTestHash', { label });
}

function fixedPreflightHarness(overrides = {}) {
  const binding = executionBinding();
  const datasetMounts = [{
    name: 'fixed-local-golden-dataset',
    manifestHash: H('fixed-local-golden-dataset-manifest'),
    readOnly: true,
  }];
  const protectedCampaign = {
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    paperId: 'local-auto-20260730-51',
    status: 'failed',
  };
  const nodes = [{
    status: 'failed_terminal',
    leaseOwner: null,
    failureClass: 'agent_usage_unknown_terminal',
  }, ...Array.from({ length: 65 }, () => ({
    status: 'skipped',
    leaseOwner: null,
    failureClass: null,
  }))];
  const counts = {
    campaignAction: 0,
    databaseWrites: 0,
    journal: 0,
    provider: 0,
  };
  return {
    counts,
    options: {
      action: 'plan',
      workspaceRoot: overrides.workspaceRoot,
      root: path.join(overrides.workspaceRoot, 'assets'),
      runtimeRoot: path.join(overrides.workspaceRoot, 'native-runtime'),
      controlRoot: path.join(overrides.workspaceRoot, 'one-shot-control'),
      datasetMounts,
      environment: {},
      clock: { now: () => new Date('2026-08-03T00:00:00.000Z') },
      providerConfigurationResolver: () => ({
        autonomousResearchProviderConfigurationHash:
          AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
      }),
      providerRuntimeBindingInspector: () => {
        counts.provider += 1;
        throw new Error('provider_runtime_inspector_must_not_run');
      },
      datasetAuthorityInspector: () => ({
        status: 'operator_dataset_harness_authority_verified',
        authority: {
          version: 4,
          kind: 'LocalGoldenDatasetHarnessAuthority',
        },
        authorityVerification: {
          cryptographicSignaturesVerified: true,
          timeWindowValid: true,
        },
        datasetManifestHash: datasetMounts[0].manifestHash,
        blockers: [],
        operatorDatasetHarnessAuthorityReceiptHash: H('dataset-authority-receipt'),
      }),
      readOnlyStoreFactory: () => ({
        readOnly: true,
        query: () => ({ ok: true, rows: [{ count: 0 }] }),
        run() {
          counts.databaseWrites += 1;
          throw new Error('database_write_must_not_run');
        },
        execute() {
          counts.databaseWrites += 1;
          throw new Error('database_write_must_not_run');
        },
        close() {},
      }),
      nativeStoreSnapshotGuardFactory: () => ({
        dbPath: path.join(overrides.workspaceRoot, 'synthetic-read-only-store.sqlite'),
        verifyUnchanged() {},
      }),
      campaignStoreFactory: () => ({
        getCampaign: (campaignId) => campaignId
          === AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID
          ? protectedCampaign : null,
        listNodes: () => nodes,
      }),
      codeProvenanceInspector: () => binding.codeProvenance,
      sourceSnapshotInspector: () => ({
        ...binding.sourceExecutionSnapshot,
        blockers: [],
      }),
      campaignAction() {
        counts.campaignAction += 1;
        throw new Error('campaign_action_must_not_run');
      },
      providerCanaryRunner() {
        counts.provider += 1;
        throw new Error('provider_must_not_run');
      },
      journalRepositoryFactory() {
        counts.journal += 1;
        return {
          inspectHistoricalAttempt: () => null,
          close() {},
        };
      },
      ...overrides.options,
    },
  };
}

test('one-shot plan reports the reviewed-target binding gap without mutation or external action', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-one-shot-plan-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const harness = fixedPreflightHarness({ workspaceRoot });
  const report = await composeFixedAutonomousResearchOneShotCampaignAttempt(
    harness.options,
  );

  assert.equal(
    report.status,
    'autonomous_research_one_shot_campaign_preflight_blocked',
  );
  assert.ok(report.blockers.some((blocker) => blocker.errorCode
    === 'autonomous_research_one_shot_dataset_binding_mismatch'));
  assert.ok(report.blockers.some((blocker) => blocker.errorCode
    === 'autonomous_research_one_shot_provider_runtime_not_proven'));
  assert.ok(report.blockers.some((blocker) => blocker.errorCode
    === 'autonomous_research_one_shot_reviewer_independence_not_proven'));
  assert.equal(report.readyForReservation, false);
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.campaignPreparationVerified, false);
  assert.equal(report.providerCanaryVerified, false);
  assert.equal(report.launchReadinessVerified, false);
  assert.equal(report.checks.reviewedTarget.targetCampaignAbsent, true);
  assert.equal(report.checks.reviewedTarget.targetJournalAttemptAbsent, true);
  assert.equal(report.checks.reviewerIndependence.status, 'not_proven');
  assert.match(
    report.checks.reviewedTarget.protectedCampaignFingerprintHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.deepEqual(report.sideEffects, {
    reservationCreated: false,
    journalWriteRepositoryOpened: false,
    journalReadOnlyInspectionPerformed: true,
    nativeDatabaseWritePerformed: false,
    nativeStoreReadOnlyInspectionPerformed: true,
    nativeStoreImmutableSnapshotVerified: true,
    nativeStoreFilesystemWritePerformed: false,
    providerInvocationPerformed: false,
    campaignLaunchPerformed: false,
    networkAccessPerformed: false,
  });
  assert.deepEqual(harness.counts, {
    campaignAction: 0,
    databaseWrites: 0,
    journal: 1,
    provider: 0,
  });
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'native-runtime')), false);
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'one-shot-control')), false);
});

test('one-shot plan returns only typed allowlisted diagnostics without sensitive prose', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-one-shot-plan-blocked-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const sensitivePath = '/private/provider/sk-sensitive-config.json';
  const sensitiveToken = 'synthetic-sensitive-provider-token';
  const harness = fixedPreflightHarness({
    workspaceRoot,
    options: {
      datasetAuthorityInspector: () => ({
        status: 'operator_dataset_harness_authority_blocked',
        authority: { version: 3, kind: 'OperatorDatasetHarnessAuthority' },
        authorityVerification: {
          cryptographicSignaturesVerified: false,
          timeWindowValid: false,
        },
        datasetManifestHash: H('drifted-dataset-manifest'),
        blockers: [
          `operator_dataset_source_unreadable:${sensitivePath}:${sensitiveToken}`,
        ],
      }),
    },
  });
  const report = await composeFixedAutonomousResearchOneShotCampaignAttempt(
    harness.options,
  );
  const serialized = JSON.stringify(report);

  assert.equal(
    report.status,
    'autonomous_research_one_shot_campaign_preflight_blocked',
  );
  assert.equal(report.readyForReservation, false);
  assert.ok(report.blockers.length >= 3);
  for (const blocker of report.blockers) {
    assert.deepEqual(Object.keys(blocker).sort(), [
      'diagnosticHash',
      'errorCode',
      'failingStage',
      'failureClass',
      'kind',
      'version',
    ]);
    assert.match(blocker.errorCode, /^autonomous_research_one_shot_[a-z0-9_:]+$/);
    assert.match(blocker.diagnosticHash, /^sha256:[0-9a-f]{64}$/);
  }
  assert.equal(serialized.includes(sensitivePath), false);
  assert.equal(serialized.includes(sensitiveToken), false);
  assert.deepEqual(harness.counts, {
    campaignAction: 0,
    databaseWrites: 0,
    journal: 1,
    provider: 0,
  });
});

test('one-shot plan detects an immutable prior target attempt by campaign id read-only', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-one-shot-plan-journal-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const harness = fixedPreflightHarness({ workspaceRoot });
  fs.mkdirSync(harness.options.controlRoot, { recursive: true });
  fs.writeFileSync(
    path.join(harness.options.controlRoot, 'campaign-one-shot-attempt.sqlite'),
    'read-only-inspection-sentinel',
  );
  let closed = false;
  harness.options.journalRepositoryFactory = ({ create }) => {
    assert.equal(create, false);
    return {
      inspectHistoricalAttempt({ campaignId }) {
        assert.equal(campaignId, AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID);
        return { reservation: { campaignId } };
      },
      close() { closed = true; },
    };
  };

  const report = await composeFixedAutonomousResearchOneShotCampaignAttempt(
    harness.options,
  );

  assert.equal(closed, true);
  assert.equal(report.checks.reviewedTarget.targetJournalAttemptAbsent, false);
  assert.equal(report.sideEffects.journalReadOnlyInspectionPerformed, true);
  assert.equal(report.sideEffects.journalWriteRepositoryOpened, false);
  assert.ok(report.blockers.some((blocker) => blocker.errorCode
    === 'autonomous_research_one_shot_target_campaign_attempt_already_recorded'));
});

test('native store snapshot guard pins the inspected inode and detects path replacement', (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-one-shot-native-pin-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(workspaceRoot, 'native-runtime');
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  const movedPath = path.join(runtimeRoot, 'hepta-paper.moved.sqlite');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.writeFileSync(dbPath, 'original-native-store');

  const guard = defaultAutonomousResearchOneShotNativeStoreSnapshotGuard({
    root: path.join(workspaceRoot, 'assets'),
    runtimeRoot,
  });
  t.after(() => guard.close());
  assert.equal(fs.readFileSync(guard.dbPath, 'utf8'), 'original-native-store');

  fs.renameSync(dbPath, movedPath);
  fs.writeFileSync(dbPath, 'replacement-native-store');
  assert.equal(fs.readFileSync(guard.dbPath, 'utf8'), 'original-native-store');
  assert.throws(
    () => guard.verifyUnchanged(),
    /autonomous_research_one_shot_native_store_changed/u,
  );
});

test('native store snapshot guard rejects dangling sidecars and symlink runtime roots', (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-one-shot-native-path-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const runtimeRoot = path.join(workspaceRoot, 'native-runtime');
  const linkedRuntimeRoot = path.join(workspaceRoot, 'linked-runtime');
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.writeFileSync(dbPath, 'native-store');
  fs.symlinkSync('missing-wal-target', `${dbPath}-wal`);

  assert.throws(
    () => defaultAutonomousResearchOneShotNativeStoreSnapshotGuard({
      root: path.join(workspaceRoot, 'assets'),
      runtimeRoot,
    }),
    /autonomous_research_one_shot_native_store_sidecar_present/u,
  );
  fs.unlinkSync(`${dbPath}-wal`);
  fs.symlinkSync(runtimeRoot, linkedRuntimeRoot);
  assert.throws(
    () => defaultAutonomousResearchOneShotNativeStoreSnapshotGuard({
      root: path.join(workspaceRoot, 'assets'),
      runtimeRoot: linkedRuntimeRoot,
    }),
    /autonomous_research_one_shot_native_store_runtime_root_unsafe/u,
  );
});

test('one-shot plan routes a dangling journal path through the safe repository', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-one-shot-journal-link-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const harness = fixedPreflightHarness({ workspaceRoot });
  fs.mkdirSync(harness.options.runtimeRoot, { mode: 0o700 });
  fs.mkdirSync(harness.options.controlRoot, { mode: 0o700 });
  const journalPath = path.join(
    harness.options.controlRoot,
    'campaign-one-shot-attempt.sqlite',
  );
  fs.symlinkSync('missing-journal-target', journalPath);
  harness.options.journalRepositoryFactory =
    createCampaignOneShotAttemptJournalRepository;

  const report = await composeFixedAutonomousResearchOneShotCampaignAttempt(
    harness.options,
  );

  assert.equal(report.checks.reviewedTarget.targetJournalAttemptAbsent, null);
  assert.equal(report.sideEffects.journalReadOnlyInspectionPerformed, true);
  assert.ok(report.blockers.some((blocker) => blocker.errorCode
    === 'autonomous_research_one_shot_attempt_journal_not_ready'));
  assert.equal(fs.lstatSync(journalPath).isSymbolicLink(), true);
});
