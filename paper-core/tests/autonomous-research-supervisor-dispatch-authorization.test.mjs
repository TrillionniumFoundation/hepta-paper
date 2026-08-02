import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  issueAutonomousResearchSupervisorDispatchAuthorization,
} from '../../paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs';
import {
  buildAutonomousResearchDispatchFailureOutcome,
} from '../../paper-application/automation/autonomous-research-supervisor-progress.mjs';
import {
  composeAutonomousResearchCampaignAction,
} from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  createAutomationReadinessSideEffectLedger,
} from '../../paper-composition/automation/automation-readiness-runtime-probes.mjs';
import {
  buildAutonomousResearchSupervisorExternalActionAttemptMarker,
  buildAutonomousResearchSupervisorExternalActionAttemptReceipt,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import {
  createReadOnlyAutonomousSubmissionHandoffOutboxFixture,
} from './support/autonomous-submission-handoff-fixture.mjs';

const H = (label) => hashRecord('SupervisorDispatchAuthorizationTestHash', { label });
const NOW = new Date('2026-07-17T04:00:00.000Z');
const ENVIRONMENT = Object.freeze({
  HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
  HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
  HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
  HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
  HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
  HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
});
const FULL_READY = Object.freeze({
  fullResearchQualificationReady: true,
  campaignFullyQualified: true,
  fullAutomaticResearchWritingReady: true,
  researchExecutionReleaseAttestorProductionReady: true,
  runtimeImageReproducibilityReady: true,
  runtimeImageReproducibility: Object.freeze({
    remainingValidityMs: 24 * 60 * 60 * 1000,
  }),
  fullResearchQualification: Object.freeze({
    remainingValidityMs: 24 * 60 * 60 * 1000,
  }),
});

function machinePlan(
  providerConfigurationHash,
  suffix = 'resident-dispatch',
  launchMode = 'production-run',
) {
  const golden = launchMode === 'golden-bootstrap';
  const templateId = 'resident-dispatch-golden';
  const epochStart = NOW.toISOString();
  const paperId = golden
    ? `golden:${templateId}:${epochStart.replace(/[-:.]/g, '')}`
    : 'resident-dispatch';
  const campaignId = `autonomous-research:${paperId}`;
  const intake = buildAutonomousResearchMachineIntake({
    intakeId: `intake:${suffix}`,
    paperId,
    campaignId,
    launchMode,
    admissionCreatedAt: golden ? epochStart : '2026-07-17T03:00:00.000Z',
    recurringGoldenProvenance: golden ? {
      version: 1,
      kind: 'AutonomousResearchRecurringGoldenProvenance',
      templateId,
      templateHash: H('resident-dispatch-golden-template'),
      epochStart,
      epochDurationMs: 4 * 60 * 60 * 1000,
      sourceAuthorityHash: H('resident-dispatch-golden-authority'),
    } : null,
    objective: `Execute resident dispatch authorization fixture ${suffix}.`,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: 'resident-dispatch-dataset',
      source: '/datasets/resident-dispatch',
      readOnly: true,
      manifestHash: H('dataset-manifest'),
      licenseId: 'CC0-1.0',
      benchmarkFamily: 'ml_algorithm_benchmark',
    }],
    budgets: {
      maxWallTimeMs: 60 * 60 * 1000,
      maxAgentCalls: 10,
      maxCpuJobs: 10,
      maxGpuJobs: 0,
      maxTokenCount: 10_000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    providerConfigurationHash,
    revisionRounds: 1,
    refereeCount: 2,
  });
  const intakeAdmission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: golden ? 'recurring-golden' : 'machine',
    sourceAuthorityHash: H('source-authority'),
  });
  const preparationPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    launchMode: intake.launchMode,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    autonomousResearchMachineIntakeAdmissionHash:
      intakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
  });
  const preparation = Object.freeze({
    ...preparationPayload,
    autonomousResearchLoopPreparationReportHash: hashRecord(
      'AutonomousResearchLoopPreparationReport',
      preparationPayload,
    ),
  });
  const executionPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionAdmission',
    status: 'autonomous_research_campaign_admitted_not_authorized',
    initialCampaignStatus: 'paused',
    launchMode: intake.launchMode,
    supervisorDispatchAuthorizationRequired: true,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmissionHash:
      intakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    providerConfigurationHash,
  });
  const planPayload = Object.freeze({
    campaignId,
    paperId,
    maxRounds: 1,
    nodes: Object.freeze([Object.freeze({
      nodeId: `${campaignId}:research-plan`,
      kind: 'research-plan',
      roundIndex: 0,
      dependencies: Object.freeze([]),
      maxAttempts: 1,
    })]),
    autonomousResearchPreparation: preparation,
    autonomousResearchMachineIntake: intake,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmission: intakeAdmission,
    autonomousResearchMachineIntakeAdmissionHash:
      intakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    executionAdmission: Object.freeze({
      ...executionPayload,
      autonomousResearchCampaignExecutionAdmissionHash: hashRecord(
        'AutonomousResearchCampaignExecutionAdmission', executionPayload,
      ),
    }),
  });
  return Object.freeze({
    ...planPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
  });
}

function fixture({
  action = 'launch',
  launchMode = 'production-run',
  observedAt = new Date(NOW.getTime() - 60_000),
} = {}) {
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    environment: ENVIRONMENT,
  });
  const campaignSpec = machinePlan(
    providerConfiguration.autonomousResearchProviderConfigurationHash,
    'resident-dispatch',
    launchMode,
  );
  const campaignId = campaignSpec.campaignId;
  const campaignPlanHash = campaignSpec.campaignPlanHash;
  const campaignLease = Object.freeze({
    campaignId,
    ownerId: 'supervisor:test',
    leaseToken: 'lease-token:test',
    leaseGeneration: 7,
  });
  const providerCanaryState = Object.freeze({
    campaignId,
    policy: Object.freeze({ providerCanaryIntervalMs: 15 * 60 * 1000 }),
    lastProviderCanaryAt: observedAt.toISOString(),
    lastProviderCanaryStatus: 'verified',
    lastProviderCanaryReceiptHash: H('provider-canary-pair'),
    leaseOwner: campaignLease.ownerId,
    leaseToken: campaignLease.leaseToken,
    leaseGeneration: campaignLease.leaseGeneration,
    leaseExpiresAt: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
    dispatchCount: 1,
  });
  const residentInstanceLease = Object.freeze({
    ownerId: campaignLease.ownerId,
    leaseToken: 'instance-lease-token:test',
    leaseGeneration: 11,
    expiresAt: new Date(NOW.getTime() + 20 * 60 * 1000).toISOString(),
  });
  let campaignFenceValid = true;
  let residentFenceValid = true;
  let persistedCampaignState = providerCanaryState;
  const residentLeaseContext = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentLeaseContext',
    stage: 'before_campaign_dispatch',
    ownerId: residentInstanceLease.ownerId,
    leaseGeneration: residentInstanceLease.leaseGeneration,
    leaseExpiresAt: residentInstanceLease.expiresAt,
    lease: residentInstanceLease,
    assertCurrent({ now }) {
      if (!residentFenceValid || Date.parse(residentInstanceLease.expiresAt) <= now.getTime()) {
        throw new Error('resident_lease_lost');
      }
    },
  });
  const authorization = issueAutonomousResearchSupervisorDispatchAuthorization({
    campaignId,
    campaignPlanHash,
    launchMode,
    campaignSpec,
    action,
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    campaignLease,
    residentLeaseContext,
    providerCanaryState,
    now: NOW,
    assertCampaignLease({ lease }) {
      if (!campaignFenceValid || lease !== campaignLease) throw new Error('lease_lost');
    },
    readCampaignState() { return persistedCampaignState; },
  });
  return {
    action,
    campaignId,
    campaignPlanHash,
    campaignSpec,
    launchMode,
    providerConfiguration,
    campaignLease,
    residentLeaseContext,
    providerCanaryState,
    authorization,
    loseFence() { campaignFenceValid = false; },
    loseResidentFence() { residentFenceValid = false; },
    replaceCanaryState() {
      persistedCampaignState = Object.freeze({
        ...providerCanaryState,
        lastProviderCanaryReceiptHash: H('replacement-provider-canary-pair'),
      });
    },
  };
}

async function runComposition(t, fixtureValue, {
  authorization = fixtureValue.authorization,
  now = NOW,
  readinessCalls = [],
  action = fixtureValue.action,
  campaignSpec = fixtureValue.campaignSpec,
  readinessSideEffectInspection = null,
  environment = ENVIRONMENT,
  journalSideEffectMode = 'offline',
  journalEvents = [],
  releaseAttestorCalls = [],
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-dispatch-auth-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'paper');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(root);
  fs.mkdirSync(runtimeRoot);
  const store = createDefaultPaperStore({ root, runtimeRoot });
  t.after(() => store.close?.());
  if (campaignSpec) {
    createSqliteCampaignStore({
      store,
      clock: { now: () => now, nowIso: () => now.toISOString() },
    })
      .createCampaign(campaignSpec);
  }
  let journalSequence = 0;
  const supervisorExternalActionJournal = Object.freeze({
    sideEffectPermitRequired: journalSideEffectMode !== 'offline',
    begin({ actionKind, reservation, now: startedAt }) {
      journalEvents.push('begin');
      journalSequence += 1;
      const marker = buildAutonomousResearchSupervisorExternalActionAttemptMarker({
        attemptId: `external-action:test:${journalSequence}`,
        campaignId: reservation.campaignId,
        actionKind,
        reservation,
        dispatchCount: reservation.dispatchCount,
        providerCanaryCount: 0,
        leaseGeneration: fixtureValue.campaignLease.leaseGeneration,
        startedAt: startedAt.toISOString(),
      });
      if (['pending', 'no-permit'].includes(journalSideEffectMode)) {
        const error = new Error(journalSideEffectMode === 'pending'
          ? 'externally_fenced_sqlite_mutation_committed_finalization_pending'
          : 'autonomous_research_supervisor_external_action_side_effect_permit_required');
        error.committed = true;
        error.reservationId = 'reservation:readiness-test';
        error.sideEffectPermitHash = null;
        throw error;
      }
      const attempt = Object.freeze({
        attemptId: marker.attemptId,
        campaignId: marker.campaignId,
        actionKind: marker.actionKind,
        reservationHash: marker.reservationHash,
        idempotencyKey: marker.idempotencyKey,
        leaseGeneration: marker.leaseGeneration,
        dispatchCount: marker.dispatchCount,
        providerCanaryCount: marker.providerCanaryCount,
        status: 'in_progress',
        marker,
        progress: null,
        receipt: null,
        startedAt: marker.startedAt,
        completedAt: null,
        recoveryResult: null,
        recoveryResultHash: null,
      });
      return journalSideEffectMode === 'forged-value'
        ? Object.freeze({ ...attempt, sideEffectPermitHash: H('forged-permit') })
        : attempt;
    },
    async reconcileAfterBegin() {
      journalEvents.push('reconcile-after-begin');
      if (journalSideEffectMode === 'reconcile-deferred') {
        const error = new Error('autonomous_research_state_recoverability_deferred');
        error.stateRecoverabilityDeferred = true;
        throw error;
      }
      return true;
    },
    cancelInfrastructureDeferred() {
      journalEvents.push('cancel-infrastructure-deferred');
      return Object.freeze({ cancelled: true });
    },
    assertSideEffectPermit() {
      if (['offline', 'finalized'].includes(journalSideEffectMode)) return true;
      throw new Error(
        'autonomous_research_supervisor_external_action_side_effect_permit_invalid',
      );
    },
    finish({
      attempt, successful, evidence, actionAccountingComplete,
      externalActionPerformed, blocker, now: completedAt,
    }) {
      return Object.freeze({
        receipt: buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
          marker: attempt.marker,
          status: successful ? 'completed' : 'failed',
          evidence,
          completedAt: completedAt.toISOString(),
          actionAccountingComplete,
          externalActionPerformed,
          blocker,
        }),
      });
    },
  });
  return composeAutonomousResearchCampaignAction({
    action,
    launchMode: fixtureValue.launchMode,
    paperId: 'resident-dispatch',
    campaignId: fixtureValue.campaignId,
    root,
    runtimeRoot,
    budgets: { maxCostUsd: 10 },
    environment,
    readinessClock: { now: () => now },
    supervisorDispatchAuthorization: authorization,
    supervisorExternalActionJournal,
    releaseAttestorSpawnSyncImpl(executable, args) {
      releaseAttestorCalls.push({ executable, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    serviceOverrides: {
      store,
      autonomousSubmissionOutbox:
        createReadOnlyAutonomousSubmissionHandoffOutboxFixture(),
    },
    productionReadinessInspector(input) {
      readinessCalls.push(input);
      return { report: {
        ...FULL_READY,
        fullAutomaticResearchWritingReady: false,
        readinessSideEffectInspection,
      } };
    },
  });
}

test('readiness post-begin infrastructure deferral cancels before any action', async (t) => {
  const resident = fixture();
  const readinessCalls = [];
  const journalEvents = [];
  await assert.rejects(
    () => runComposition(t, resident, {
      readinessCalls,
      journalEvents,
      journalSideEffectMode: 'reconcile-deferred',
    }),
    (error) => error.stateRecoverabilityDeferred === true
      && error.dispatchInfrastructureReservationCancelled === true,
  );
  assert.deepEqual(journalEvents, [
    'begin',
    'reconcile-after-begin',
    'cancel-infrastructure-deferred',
  ]);
  assert.equal(readinessCalls.length, 0);
});

test('resident authorization reuses one fenced canary pair without a second live provider call', async (t) => {
  const resident = fixture();
  const readinessCalls = [];
  const ledger = createAutomationReadinessSideEffectLedger({
    environment: {},
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  ledger.spawnSyncFor('release-attestor')('kms-probe', ['health']);
  const readinessSideEffectInspection = ledger.inspection();
  await assert.rejects(
    () => runComposition(t, resident, { readinessCalls, readinessSideEffectInspection }),
    (error) => {
      assert.match(error.message, /autonomous_research_production_full_readiness_required/);
      const outcome = buildAutonomousResearchDispatchFailureOutcome(error);
      assert.equal(outcome.readinessAttemptReceipt.processActionCount, 1);
      assert.equal(outcome.readinessAttemptReceipt.releaseAttestorProcessActionCount, 1);
      return true;
    },
  );
  assert.equal(readinessCalls.length, 1);
  assert.equal(readinessCalls[0].liveProviderCanaryRequested, false);
  assert.equal(readinessCalls[0].now.toISOString(), NOW.toISOString());
  await assert.rejects(
    () => runComposition(t, resident, { readinessCalls, readinessSideEffectInspection }),
    /autonomous_research_supervisor_dispatch_authorization_invalid/,
  );
  assert.equal(readinessCalls.length, 1,
    'a reserved readiness authorization cannot repeat any readiness action');

  const directCalls = [];
  const direct = fixture();
  await assert.rejects(() => runComposition(t, direct, {
    authorization: null,
    campaignSpec: null,
    readinessCalls: directCalls,
  }), /autonomous_research_production_readiness_authorization_required/);
  assert.equal(directCalls.length, 0,
    'no live readiness action may occur without a persisted plan reservation');
});

test('Golden machine dispatch reserves authorization before release-attestor verification', async (t) => {
  const golden = fixture({ launchMode: 'golden-bootstrap' });
  const readinessCalls = [];
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-golden-kms-reserve-'));
  t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
  const invalidConfigPath = path.join(configRoot, 'release-attestor.json');
  fs.writeFileSync(invalidConfigPath, '{invalid-json', { mode: 0o600 });
  const environment = {
    ...ENVIRONMENT,
    HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: invalidConfigPath,
  };
  await assert.rejects(
    () => runComposition(t, golden, {
      readinessCalls,
      environment,
    }),
    (error) => {
      const outcome = buildAutonomousResearchDispatchFailureOutcome(error);
      assert.equal(outcome.readinessAttemptReceipt.processActionCount, 0);
      return true;
    },
  );
  assert.equal(readinessCalls.length, 0,
    'Golden bootstrap does not use production full-readiness/provider probes');
  await assert.rejects(
    () => runComposition(t, golden, {
      readinessCalls,
      environment,
    }),
    /autonomous_research_supervisor_dispatch_authorization_invalid/,
  );
  assert.equal(readinessCalls.length, 0);
});

for (const journalSideEffectMode of ['pending', 'no-permit', 'forged-value']) {
  test(`production readiness ${journalSideEffectMode} permit state performs zero readiness actions`, async (t) => {
    const resident = fixture();
    const readinessCalls = [];
    const releaseAttestorCalls = [];
    await assert.rejects(() => runComposition(t, resident, {
      readinessCalls,
      releaseAttestorCalls,
      journalSideEffectMode,
    }), journalSideEffectMode === 'pending'
      ? /committed_finalization_pending/
      : journalSideEffectMode === 'no-permit'
        ? /side_effect_permit_required/
        : /side_effect_permit_invalid/);
    assert.equal(readinessCalls.length, 0);
    assert.equal(releaseAttestorCalls.length, 0);
  });

  test(`Golden release-attestor ${journalSideEffectMode} permit state performs zero KMS actions`, async (t) => {
    const golden = fixture({ launchMode: 'golden-bootstrap' });
    const readinessCalls = [];
    const releaseAttestorCalls = [];
    const configRoot = fs.mkdtempSync(path.join(
      os.tmpdir(), `hepta-golden-${journalSideEffectMode}-`,
    ));
    t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
    const invalidConfigPath = path.join(configRoot, 'release-attestor.json');
    fs.writeFileSync(invalidConfigPath, '{invalid-json', { mode: 0o600 });
    await assert.rejects(() => runComposition(t, golden, {
      readinessCalls,
      releaseAttestorCalls,
      journalSideEffectMode,
      environment: {
        ...ENVIRONMENT,
        HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: invalidConfigPath,
      },
    }), journalSideEffectMode === 'pending'
      ? /committed_finalization_pending/
      : journalSideEffectMode === 'no-permit'
        ? /side_effect_permit_required/
        : /side_effect_permit_invalid/);
    assert.equal(readinessCalls.length, 0);
    assert.equal(releaseAttestorCalls.length, 0);
  });
}

test('stale, mismatched, forged, and fence-replaced resident authorizations fail closed', async (t) => {
  {
    const stale = fixture();
    const calls = [];
    await assert.rejects(() => runComposition(t, stale, {
      now: new Date(NOW.getTime() + 16 * 60 * 1000),
      readinessCalls: calls,
    }), /autonomous_research_supervisor_dispatch_authorization_invalid/);
    assert.equal(calls.length, 0);
  }
  {
    const mismatch = fixture({ action: 'resume' });
    const calls = [];
    await assert.rejects(() => runComposition(t, mismatch, {
      action: 'launch', readinessCalls: calls,
    }), /autonomous_research_supervisor_dispatch_authorization_invalid/);
    assert.equal(calls.length, 0);
  }
  {
    const forged = fixture();
    await assert.rejects(() => runComposition(t, forged, {
      authorization: Object.freeze({ ...forged.authorization }),
    }), /autonomous_research_supervisor_dispatch_authorization_invalid/);
  }
  {
    const replaced = fixture();
    replaced.loseFence();
    await assert.rejects(
      () => runComposition(t, replaced),
      /autonomous_research_supervisor_dispatch_authorization_invalid/,
    );
  }
  {
    const replaced = fixture();
    replaced.loseResidentFence();
    await assert.rejects(
      () => runComposition(t, replaced),
      /autonomous_research_supervisor_dispatch_authorization_invalid/,
    );
  }
  {
    const replaced = fixture();
    replaced.replaceCanaryState();
    await assert.rejects(
      () => runComposition(t, replaced),
      /autonomous_research_supervisor_dispatch_authorization_invalid/,
    );
  }
  const reserved = fixture();
  const calls = [];
  await assert.rejects(() => runComposition(t, reserved, { readinessCalls: calls }),
    /autonomous_research_production_full_readiness_required/);
  await assert.rejects(() => runComposition(t, reserved, { readinessCalls: calls }),
    /autonomous_research_supervisor_dispatch_authorization_invalid/);
  assert.equal(calls.length, 1);

  const wrongPlan = fixture();
  const wrongPlanCalls = [];
  await assert.rejects(() => runComposition(t, wrongPlan, {
    campaignSpec: machinePlan(
      wrongPlan.providerConfiguration.autonomousResearchProviderConfigurationHash,
      'wrong-persisted-plan',
    ),
    readinessCalls: wrongPlanCalls,
  }), /autonomous_research_supervisor_dispatch_authorization_invalid/);
  assert.equal(wrongPlanCalls.length, 0);
});
