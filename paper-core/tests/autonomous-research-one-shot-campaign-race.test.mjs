import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  buildAutonomousResearchOneShotCampaignAttemptReservation,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import {
  composeAutonomousResearchOneShotCampaignAttempt,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  executionBinding,
} from './support/autonomous-research-one-shot-campaign-attempt-fixture.mjs';

const H = (label) => hashRecord(
  'AutonomousResearchOneShotCampaignAttemptTestHash',
  { label },
);

function fixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-one-shot-race-${label}-`));
  const runtimeRoot = path.join(root, 'native-runtime');
  const controlRoot = path.join(root, 'one-shot-control');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const open = () => createCampaignOneShotAttemptJournalRepository({
    controlRoot,
    runtimeRoot,
    create: true,
    clock: { now: () => new Date('2026-08-03T00:00:00.000Z') },
  });
  const repository = open();
  t.after(() => {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const reservation = buildAutonomousResearchOneShotCampaignAttemptReservation({
    attemptId: `attempt-race-${label}`,
    idempotencyKey: H(`idempotency-race-${label}`),
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    protectedCampaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    executionBinding: executionBinding(),
    reservedAt: '2026-08-03T00:00:00.000Z',
  });
  return { repository, reservation, open };
}

function appendPhase(repository, inspection, phase, evidence = { ready: true }) {
  return repository.appendEvent({
    attemptId: inspection.reservation.attemptId,
    phase,
    evidence,
    expectedSequence: inspection.events.length + 1,
    expectedPhase: inspection.headPhase,
    expectedPreviousEventHash: inspection.headEventHash,
  });
}

function counts() {
  return { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
}

function callbacks(observed, overrides = {}) {
  return {
    async inspectPreconditions() {
      observed.preconditions += 1;
      return { evidence: { ready: true } };
    },
    async prepareCampaign() {
      observed.prepare += 1;
      return { evidence: { providerFree: true } };
    },
    async assertProviderActionReady() {},
    async executeProviderAction() {
      observed.provider += 1;
      return { evidence: { providerReceiptHash: H('provider-receipt') } };
    },
    async assertLaunchActionReady() {},
    async launchCampaign() {
      observed.launch += 1;
      return { terminalStatus: 'completed', outcome: { campaignStatus: 'completed' } };
    },
    async inspectLaunchOutcome() {
      observed.monitor += 1;
      return { terminal: false };
    },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test('async or false external-action permits fail closed before provider and launch', async (t) => {
  const providerFixture = fixture(t, 'async-provider-permit-denied');
  const providerCounts = counts();
  const providerDeniedRepository = Object.freeze({
    ...providerFixture.repository,
    assertExternalActionSideEffectPermit: async () => false,
  });
  const providerReport = await composeAutonomousResearchOneShotCampaignAttempt({
    repository: providerDeniedRepository,
    reservation: providerFixture.reservation,
    ...callbacks(providerCounts),
  });
  assert.equal(providerReport.status,
    'autonomous_research_one_shot_campaign_attempt_monitor_only');
  assert.equal(providerReport.terminalReceipt, null);
  assert.equal(providerReport.inspection.headPhase, 'provider_started');
  assert.equal(providerCounts.provider, 0);
  assert.equal(providerCounts.launch, 0);

  const launchFixture = fixture(t, 'async-launch-permit-denied');
  const launchCounts = counts();
  const launchDeniedRepository = Object.freeze({
    ...launchFixture.repository,
    async assertExternalActionSideEffectPermit({ transition }) {
      if (transition.mutationDisposition.phase === 'launch_started') return false;
      return launchFixture.repository.assertExternalActionSideEffectPermit({ transition });
    },
  });
  const launchReport = await composeAutonomousResearchOneShotCampaignAttempt({
    repository: launchDeniedRepository,
    reservation: launchFixture.reservation,
    ...callbacks(launchCounts),
  });
  assert.equal(launchReport.status,
    'autonomous_research_one_shot_campaign_attempt_monitor_only');
  assert.equal(launchReport.terminalReceipt, null);
  assert.equal(launchReport.inspection.headPhase, 'launch_started');
  assert.equal(launchCounts.provider, 1);
  assert.equal(launchCounts.launch, 0);
});

test('an exact-replay marker loser cannot impersonate the provider owner', async (t) => {
  const { repository, reservation, open } = fixture(t, 'provider-append-race');
  const observerRepository = open();
  t.after(() => observerRepository.close());
  let inspection = repository.reserveAttempt({ reservation });
  inspection = appendPhase(repository, inspection, 'preconditions_verified');
  appendPhase(repository, inspection, 'prepare_verified', { providerFree: true });

  const observerReady = deferred();
  const releaseObserver = deferred();
  const ownerAtPermit = deferred();
  const releaseOwner = deferred();
  const ownerRepository = Object.freeze({
    ...repository,
    async assertExternalActionSideEffectPermit({ transition }) {
      ownerAtPermit.resolve();
      await releaseOwner.promise;
      return repository.assertExternalActionSideEffectPermit({ transition });
    },
  });
  const observerCounts = counts();
  const observer = composeAutonomousResearchOneShotCampaignAttempt({
    repository: observerRepository,
    reservation,
    ...callbacks(observerCounts, {
      async assertProviderActionReady() {
        observerReady.resolve();
        await releaseObserver.promise;
      },
    }),
  });
  await observerReady.promise;
  const ownerCounts = counts();
  const owner = composeAutonomousResearchOneShotCampaignAttempt({
    repository: ownerRepository,
    reservation,
    ...callbacks(ownerCounts),
  });
  await ownerAtPermit.promise;
  releaseObserver.resolve();
  const observed = await observer;
  assert.equal(observed.status,
    'autonomous_research_one_shot_campaign_attempt_monitor_only');
  assert.equal(observed.terminalReceipt, null);
  assert.equal(observed.inspection.headPhase, 'provider_started');
  assert.equal(observerCounts.provider, 0);
  releaseOwner.resolve();
  const completed = await owner;
  assert.equal(completed.terminalReceipt.terminalStatus, 'completed');
  assert.equal(ownerCounts.provider, 1);
  assert.equal(ownerCounts.launch, 1);
});

test('concurrent observation cannot terminalize an owned provider marker', async (t) => {
  const { repository, reservation, open } = fixture(t, 'provider-owner-race');
  const observer = open();
  t.after(() => observer.close());
  const entered = deferred();
  const released = deferred();
  let providerEffects = 0;
  const ownerCounts = counts();
  const owner = composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(ownerCounts, {
      async executeProviderAction() {
        entered.resolve();
        await released.promise;
        providerEffects += 1;
        return { evidence: { providerReceiptHash: H('owned-provider-receipt') } };
      },
    }),
  });
  await entered.promise;
  const observerCounts = counts();
  const observed = await composeAutonomousResearchOneShotCampaignAttempt({
    repository: observer,
    reservation,
    ...callbacks(observerCounts),
  });
  assert.equal(observed.status,
    'autonomous_research_one_shot_campaign_attempt_monitor_only');
  assert.equal(observed.terminalReceipt, null);
  assert.equal(observer.inspectAttempt({ attemptId: reservation.attemptId }).terminalReceipt, null);
  released.resolve();
  const completed = await owner;
  assert.equal(completed.terminalReceipt.terminalStatus, 'completed');
  assert.equal(providerEffects, 1);
  assert.equal(observerCounts.provider, 0);
});

test('concurrent launch observation cannot revoke an active launch owner', async (t) => {
  const { repository, reservation, open } = fixture(t, 'launch-owner-race');
  const observer = open();
  t.after(() => observer.close());
  const entered = deferred();
  const released = deferred();
  let launchEffects = 0;
  const ownerCounts = counts();
  const owner = composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(ownerCounts, {
      async launchCampaign() {
        entered.resolve();
        await released.promise;
        launchEffects += 1;
        return { terminalStatus: 'completed', outcome: { campaignStatus: 'completed' } };
      },
    }),
  });
  await entered.promise;
  const observerCounts = counts();
  const observed = await composeAutonomousResearchOneShotCampaignAttempt({
    repository: observer,
    reservation,
    ...callbacks(observerCounts, {
      async inspectLaunchOutcome() { throw new Error('campaign_not_found'); },
    }),
  });
  assert.equal(observed.status,
    'autonomous_research_one_shot_campaign_attempt_monitor_only');
  assert.equal(observed.terminalReceipt, null);
  assert.equal(observer.inspectAttempt({ attemptId: reservation.attemptId }).terminalReceipt, null);
  released.resolve();
  const completed = await owner;
  assert.equal(completed.terminalReceipt.terminalStatus, 'completed');
  assert.equal(launchEffects, 1);
  assert.equal(observerCounts.launch, 0);
});
