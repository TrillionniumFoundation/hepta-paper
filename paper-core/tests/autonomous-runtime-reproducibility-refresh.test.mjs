import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAutonomousResearchRuntimeRefreshStateRepository,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs';
import {
  createAutonomousResearchRuntimeRefresh,
} from '../../paper-application/automation/autonomous-research-runtime-refresh.mjs';
import {
  runtimeReproducibilityReservation,
} from '../../paper-domain/automation/runtime-reproducibility-refresh-policy.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

function H(value) {
  return hashBytes(Buffer.from(String(value)));
}

function policy(overrides = {}) {
  return {
    budgetEpochMs: 24 * 60 * 60 * 1000,
    maximumAttemptsPerEpoch: 2,
    maximumCostUsdPerEpoch: 10,
    leaseMs: 1000,
    baseBackoffMs: 100,
    maximumBackoffMs: 1000,
    renewalLeadMs: 5000,
    actionSafetyMarginMs: 15 * 60 * 1000,
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return Object.freeze({
    ready: true,
    configurationIdentityHash: H('runtime-refresh-configuration'),
    maximumVerificationCostUsd: 3,
    verificationCostAuthority: 'operator_declared_worst_case_usd',
    maximumVerifierTimeoutMs: 1000,
    minimumRefreshLeadMs: 3000,
    maximumReceiptAgeMs: 24 * 60 * 60 * 1000,
    blockers: Object.freeze([]),
    ...overrides,
  });
}

function missingStatus(config = configuration()) {
  return Object.freeze({
    ready: false,
    configuration: config,
    inspection: null,
    blockers: Object.freeze(['runtime_reproducibility_receipt_missing']),
  });
}

function currentStatus(now, config = configuration(), lifetimeMs = 8 * 60 * 60 * 1000) {
  return Object.freeze({
    ready: true,
    configuration: config,
    inspection: Object.freeze({
      ready: true,
      receiptHash: H('current-runtime-receipt'),
      issuedAt: new Date(now.getTime() - 1000).toISOString(),
      expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
      remainingValidityMs: lifetimeMs,
    }),
    blockers: Object.freeze([]),
  });
}

function publication(now, suffix = 'published') {
  const receiptHash = H(`runtime-receipt:${suffix}`);
  return Object.freeze({
    ready: true,
    inspection: Object.freeze({ ready: true, receiptHash }),
    publication: Object.freeze({
      receiptHash,
      receiptContentHash: H(`runtime-receipt-content:${suffix}`),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    }),
  });
}

function scheduler() {
  return {
    setInterval(callback) { return { callback }; },
    clearInterval() {},
    unref() {},
  };
}

test('global SQLite refresh lease fences concurrent supervisors and an expired old owner before publication', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-fence-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const first = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  const second = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => first.close());
  t.after(() => second.close());
  const now = new Date('2026-07-16T05:00:00.000Z');
  const acquired = first.tryAcquireRefreshLease({ ownerId: 'supervisor:first', now });
  assert.equal(acquired.acquired, true);
  assert.deepEqual(second.tryAcquireRefreshLease({
    ownerId: 'supervisor:concurrent', now,
  }), {
    acquired: false,
    reason: 'runtime_reproducibility_refresh_leased',
    nextAttemptAt: acquired.lease.expiresAt,
  });
  assert.equal(first.reserveRefreshAttempt({
    lease: acquired.lease,
    campaignId: 'autonomous-research:first-paper',
    configuration: configuration(),
    now,
  }).authorized, true);

  const recoveredAt = new Date(now.getTime() + 1001);
  const replacement = second.tryAcquireRefreshLease({
    ownerId: 'supervisor:replacement', now: recoveredAt,
  });
  assert.equal(replacement.acquired, true);
  assert.ok(replacement.lease.leaseGeneration > acquired.lease.leaseGeneration);
  let publicationCalls = 0;
  assert.throws(() => {
    first.assertRefreshLease({ lease: acquired.lease, now: recoveredAt });
    publicationCalls += 1;
  }, /runtime_reproducibility_refresh_lease_lost/);
  assert.equal(publicationCalls, 0);
  assert.equal(first.listAttempts()[0].status, 'failed');

  const replacementReservation = second.reserveRefreshAttempt({
    lease: replacement.lease,
    campaignId: 'autonomous-research:replacement-paper',
    configuration: configuration(),
    now: recoveredAt,
  });
  assert.equal(replacementReservation.authorized, true);
  const report = publication(recoveredAt, 'replacement');
  second.completeRefreshAttempt({
    lease: replacement.lease,
    receiptHash: report.publication.receiptHash,
    receiptContentHash: report.publication.receiptContentHash,
    issuedAt: report.publication.issuedAt,
    expiresAt: report.publication.expiresAt,
    now: recoveredAt,
  });
  assert.equal(first.readState().status, 'refresh_verified');
  assert.equal(first.listBudgetEpochs()[0].attemptCount, 2);
  assert.equal(first.listBudgetEpochs()[0].reservedCostUsd, 6);
});

test('restart and a new campaign cannot reset fixed-epoch attempt or cost reservations', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-restart-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const bounded = policy({ maximumAttemptsPerEpoch: 1, maximumCostUsdPerEpoch: 3 });
  let repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: bounded,
  });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T05:10:00.000Z');
  const first = repository.tryAcquireRefreshLease({ ownerId: 'supervisor:before-restart', now });
  const reservation = repository.reserveRefreshAttempt({
    lease: first.lease,
    campaignId: 'autonomous-research:before-restart',
    configuration: configuration(),
    now,
  });
  assert.equal(reservation.authorized, true);
  const retryAt = new Date(now.getTime() + 500);
  repository.failRefreshAttempt({
    lease: first.lease,
    error: 'external_builder_failed',
    nextAttemptAt: retryAt,
    now,
  });
  repository.close();

  repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: bounded,
  });
  assert.equal(repository.listBudgetEpochs()[0].attemptCount, 1);
  assert.equal(repository.listBudgetEpochs()[0].reservedCostUsd, 3);
  assert.equal(repository.listAttempts()[0].status, 'failed');
  assert.equal(repository.tryAcquireRefreshLease({
    ownerId: 'supervisor:too-early',
    now: new Date(retryAt.getTime() - 1),
  }).reason, 'runtime_reproducibility_refresh_backoff_active');
  const sameEpoch = repository.tryAcquireRefreshLease({
    ownerId: 'supervisor:new-campaign', now: retryAt,
  });
  assert.equal(sameEpoch.acquired, true);
  const exhausted = repository.reserveRefreshAttempt({
    lease: sameEpoch.lease,
    campaignId: 'autonomous-research:new-campaign',
    configuration: configuration(),
    now: retryAt,
  });
  assert.deepEqual(exhausted, {
    authorized: false,
    terminal: false,
    blocker: 'runtime_reproducibility_refresh_epoch_budget_exhausted',
    deferUntil: reservation.epochEnd,
  });
  assert.equal(repository.listAttempts().length, 1);

  const nextEpoch = new Date(reservation.epochEnd);
  const next = repository.tryAcquireRefreshLease({
    ownerId: 'supervisor:fixed-next-epoch', now: nextEpoch,
  });
  assert.equal(next.acquired, true);
  assert.equal(repository.reserveRefreshAttempt({
    lease: next.lease,
    campaignId: 'autonomous-research:fixed-next-epoch',
    configuration: configuration(),
    now: nextEpoch,
  }).authorized, true);
  assert.equal(repository.listBudgetEpochs().length, 2);
});

test('unknown or mismatched builder pricing authority fails closed before reservation', () => {
  assert.throws(() => runtimeReproducibilityReservation(configuration({
    maximumVerificationCostUsd: 3,
    verificationCostAuthority: 'externally_operated_zero_cost',
  })), /runtime_reproducibility_refresh_verification_cost_unknown/);
  assert.throws(() => runtimeReproducibilityReservation(configuration({
    maximumVerificationCostUsd: 0,
    verificationCostAuthority: 'operator_declared_worst_case_usd',
  })), /runtime_reproducibility_refresh_verification_cost_unknown/);
  assert.equal(runtimeReproducibilityReservation(configuration({
    maximumVerificationCostUsd: 0,
    verificationCostAuthority: 'externally_operated_zero_cost',
  })).maximumVerificationCostUsd, 0);
});

test('a verifier maximum cost above the fixed epoch budget cannot reserve or publish', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-cost-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot,
    policy: policy({ maximumCostUsdPerEpoch: 2 }),
  });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T05:15:00.000Z');
  let publications = 0;
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: repository,
    readStatus: () => missingStatus(),
    async publish() { publications += 1; return publication(now); },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    random: () => 0,
  });
  const result = await refresh.ensureReady({
    campaign: {
      campaignId: 'autonomous-research:over-cost-paper',
      spec: { budgets: { maxWallTimeMs: 60 * 60 * 1000 } },
    },
    ownerId: 'supervisor:over-cost',
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'runtime_reproducibility_refresh_epoch_budget_exhausted');
  assert.equal(publications, 0);
  assert.deepEqual(repository.listAttempts(), []);
  assert.equal(repository.listBudgetEpochs()[0].attemptCount, 0);
  assert.equal(repository.listBudgetEpochs()[0].reservedCostUsd, 0);
});

test('remaining campaign wall time plus the safety margin forces proactive refresh', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-wall-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T05:17:00.000Z');
  let publications = 0;
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: repository,
    readStatus: () => currentStatus(now, configuration(), 6 * 60 * 60 * 1000 + 60_000),
    async publish() { publications += 1; return publication(now, 'wall-coverage'); },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    random: () => 0,
  });
  const result = await refresh.ensureReady({
    campaign: {
      campaignId: 'autonomous-research:wall-coverage-paper',
      accumulatedRunMs: 0,
      spec: { budgets: { maxWallTimeMs: 6 * 60 * 60 * 1000 } },
    },
    ownerId: 'supervisor:wall-coverage',
  });
  assert.equal(result.ready, true);
  assert.equal(result.refreshed, true);
  assert.equal(publications, 1);
  assert.equal(repository.listAttempts()[0].status, 'succeeded');
});

test('an un-coverable campaign wall window and an insufficient lead both fail before publish', async (t) => {
  const scenarios = [
    {
      name: 'window',
      refreshPolicy: policy(),
      campaign: {
        campaignId: 'autonomous-research:uncoverable-window',
        spec: { budgets: { maxWallTimeMs: 24 * 60 * 60 * 1000 } },
      },
      reason: 'runtime_reproducibility_refresh_campaign_window_uncoverable',
    },
    {
      name: 'lead',
      refreshPolicy: policy({ renewalLeadMs: 3999 }),
      campaign: {
        campaignId: 'autonomous-research:insufficient-lead',
        spec: { budgets: { maxWallTimeMs: 60 * 60 * 1000 } },
      },
      reason: 'runtime_reproducibility_refresh_lead_insufficient',
    },
  ];
  for (const scenario of scenarios) {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(),
      `hepta-runtime-refresh-${scenario.name}-`));
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const repository = createAutonomousResearchRuntimeRefreshStateRepository({
      runtimeRoot, policy: scenario.refreshPolicy,
    });
    t.after(() => repository.close());
    const now = new Date('2026-07-16T05:18:00.000Z');
    let publications = 0;
    const refresh = createAutonomousResearchRuntimeRefresh({
      stateRepository: repository,
      readStatus: () => missingStatus(),
      async publish() { publications += 1; return publication(now); },
      clock: { now: () => new Date(now) },
      scheduler: scheduler(),
      random: () => 0,
    });
    const result = await refresh.ensureReady({
      campaign: scenario.campaign,
      ownerId: `supervisor:${scenario.name}`,
    });
    assert.equal(result.ready, false, scenario.name);
    assert.equal(result.terminal, true, scenario.name);
    assert.equal(result.reason, scenario.reason, scenario.name);
    assert.equal(publications, 0, scenario.name);
    assert.deepEqual(repository.listAttempts(), [], scenario.name);
  }
});

test('heartbeat lease loss aborts the builder and fences the expired publisher', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-heartbeat-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const first = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  const second = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => first.close());
  t.after(() => second.close());
  let nowMs = Date.parse('2026-07-16T05:19:00.000Z');
  let heartbeat = null;
  let replacement = null;
  let publications = 0;
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: first,
    readStatus: () => missingStatus(),
    async publish({ signal }) {
      publications += 1;
      nowMs += 1001;
      replacement = second.tryAcquireRefreshLease({
        ownerId: 'supervisor:heartbeat-replacement',
        now: new Date(nowMs),
      });
      assert.equal(replacement.acquired, true);
      heartbeat();
      assert.equal(signal.aborted, true);
      throw new Error(String(signal.reason));
    },
    clock: { now: () => new Date(nowMs) },
    scheduler: {
      setInterval(callback) { heartbeat = callback; return { callback }; },
      clearInterval() {},
      unref() {},
    },
    random: () => 0,
  });
  const result = await refresh.ensureReady({
    campaign: {
      campaignId: 'autonomous-research:heartbeat-paper',
      spec: { budgets: { maxWallTimeMs: 60 * 60 * 1000 } },
    },
    ownerId: 'supervisor:heartbeat-old',
  });
  assert.equal(result.ready, false);
  assert.equal(result.leaseLost, true);
  assert.equal(result.reason, 'runtime_reproducibility_refresh_lease_lost');
  assert.equal(publications, 1);
  assert.equal(first.listAttempts()[0].status, 'failed');
  assert.equal(first.listBudgetEpochs()[0].reservedCostUsd, 3);
  assert.equal(first.readState().leaseOwner, 'supervisor:heartbeat-replacement');
  assert.equal(second.assertRefreshLease({
    lease: replacement.lease,
    now: new Date(nowMs),
  }), true);
});

test('current runtime status is strictly read-only and never invokes publish', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-status-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T05:20:00.000Z');
  let publications = 0;
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: repository,
    readStatus: () => currentStatus(now),
    async publish() { publications += 1; return publication(now); },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    random: () => 0,
  });
  const before = repository.readState();
  const result = await refresh.ensureReady({
    campaign: { campaignId: 'autonomous-research:status-paper' },
    lifecycle: { absoluteDeadlineAt: new Date(now.getTime() + 30_000).toISOString() },
    ownerId: 'supervisor:status',
  });
  assert.equal(result.ready, true);
  assert.equal(result.refreshed, false);
  assert.equal(publications, 0);
  assert.deepEqual(repository.readState(), before);
  assert.deepEqual(repository.listAttempts(), []);
});

test('cancellation persists a non-refundable reservation and restart-visible backoff', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-cancel-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  let repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T05:30:00.000Z');
  let publications = 0;
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: repository,
    readStatus: () => missingStatus(),
    async publish() { publications += 1; return publication(now); },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    random: () => 0,
  });
  const controller = new AbortController();
  controller.abort('supervisor_process_shutdown');
  await assert.rejects(() => refresh.ensureReady({
    campaign: { campaignId: 'autonomous-research:cancel-paper' },
    lifecycle: { absoluteDeadlineAt: new Date(now.getTime() + 30_000).toISOString() },
    ownerId: 'supervisor:cancel',
    signal: controller.signal,
  }), /supervisor_process_shutdown/);
  assert.equal(publications, 0);
  assert.equal(repository.listAttempts()[0].status, 'cancelled');
  assert.equal(repository.listBudgetEpochs()[0].reservedCostUsd, 3);
  const nextAttemptAt = repository.readState().nextAttemptAt;
  repository.close();
  repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  assert.equal(repository.readState().nextAttemptAt, nextAttemptAt);
  assert.equal(repository.listAttempts()[0].reservedCostUsd, 3);
});

test('a successful fenced publish produces the only readiness result that can precede qualification', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-refresh-success-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T05:40:00.000Z');
  const events = [];
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: repository,
    readStatus: () => { events.push('status'); return missingStatus(); },
    async publish({ signal }) {
      assert.equal(signal.aborted, false);
      events.push('publish');
      return publication(now, 'success');
    },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    random: () => 0,
  });
  const result = await refresh.ensureReady({
    campaign: { campaignId: 'autonomous-research:success-paper' },
    lifecycle: { absoluteDeadlineAt: new Date(now.getTime() + 30_000).toISOString() },
    ownerId: 'supervisor:success',
  });
  assert.equal(result.ready, true);
  assert.equal(result.refreshed, true);
  assert.deepEqual(events, ['status', 'status', 'publish']);
  assert.equal(repository.listAttempts()[0].status, 'succeeded');
  assert.equal(repository.readState().status, 'refresh_verified');
});

test('runtime refresh auto-recovers a committed publication before retrying status', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-runtime-refresh-publication-recovery-',
  ));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => repository.close());
  let nowMs = Date.parse('2026-07-16T05:50:00.000Z');
  let pendingFinalization = false;
  let publishedAuthority = false;
  let recoveryCalls = 0;
  let statusCalls = 0;
  let publicationDmlCalls = 0;
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: repository,
    recoverPendingPublication() {
      recoveryCalls += 1;
      if (pendingFinalization) {
        pendingFinalization = false;
        publishedAuthority = true;
      }
    },
    readStatus() {
      statusCalls += 1;
      return publishedAuthority
        ? currentStatus(new Date(nowMs)) : missingStatus();
    },
    async publish() {
      publicationDmlCalls += 1;
      pendingFinalization = true;
      const error = new Error(
        'externally_fenced_sqlite_mutation_committed_finalization_pending',
      );
      error.committed = true;
      throw error;
    },
    clock: { now: () => new Date(nowMs) },
    scheduler: scheduler(),
    random: () => 0,
  });
  const campaign = Object.freeze({
    campaignId: 'autonomous-research:publication-recovery',
    spec: Object.freeze({ budgets: Object.freeze({ maxWallTimeMs: 60 * 60 * 1000 }) }),
  });
  const first = await refresh.ensureReady({
    campaign,
    ownerId: 'supervisor:publication-recovery',
  });
  assert.equal(first.ready, false);
  assert.equal(publicationDmlCalls, 1);
  assert.equal(pendingFinalization, true);
  nowMs += 101;
  const recovered = await refresh.ensureReady({
    campaign,
    ownerId: 'supervisor:publication-recovery',
  });
  assert.equal(recovered.ready, true);
  assert.equal(recovered.refreshed, false);
  assert.equal(publicationDmlCalls, 1);
  assert.equal(recoveryCalls, 3);
  assert.equal(statusCalls, 3);
});

test('runtime publication recovery failure defers within the configured bound', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-runtime-refresh-publication-recovery-failure-',
  ));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot, policy: policy(),
  });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T06:00:00.000Z');
  let statusCalls = 0;
  const refresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: repository,
    recoverPendingPublication() { throw new Error('authority_temporarily_unavailable'); },
    readStatus() { statusCalls += 1; return missingStatus(); },
    async publish() { throw new Error('publish_must_not_run'); },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    random: () => 0,
  });
  const result = await refresh.ensureReady({
    campaign: Object.freeze({ campaignId: 'autonomous-research:recovery-failure' }),
    ownerId: 'supervisor:recovery-failure',
  });
  assert.equal(result.ready, false);
  assert.equal(result.terminal, false);
  assert.equal(
    result.reason,
    'runtime_reproducibility_pending_publication_recovery_failed',
  );
  assert.equal(
    result.deferUntil,
    new Date(now.getTime() + policy().maximumBackoffMs).toISOString(),
  );
  assert.equal(statusCalls, 0);
});
