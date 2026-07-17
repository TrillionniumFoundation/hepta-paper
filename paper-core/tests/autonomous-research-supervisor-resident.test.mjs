import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
  inspectAutonomousResearchSupervisorInstanceStatus,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  createAutonomousResearchSupervisor,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  createAutomationReadinessSideEffectLedger,
} from '../../paper-composition/automation/automation-readiness-runtime-probes.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';

const H = (label) => hashRecord('AutonomousSupervisorTestHash', { label });

function campaign(campaignId, status, stopReason = null) {
  return {
    campaignId,
    paperId: campaignId.split(':').at(-1),
    status,
    stopReason,
    costKnown: true,
    costUsd: 2,
    spec: {
      budgets: { maxCostUsd: 100 },
      autonomousResearchPreparation: {
        proposal: { paperId: campaignId.split(':').at(-1) },
        autonomousResearchProviderConfigurationHash: H('resident-provider-configuration'),
      },
    },
  };
}

test('resident supervisor reconciles startup, canaries providers, and resumes paused/supervisor-stopped campaigns', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-cycle-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const campaigns = [
    campaign(
      'autonomous-research:paused-paper',
      'paused',
      'supervisor_process_shutdown',
    ),
    campaign('autonomous-research:stopped-paper', 'stopped', 'supervisor_transient_failure'),
  ];
  const byId = new Map(campaigns.map((value) => [value.campaignId, value]));
  const qualification = new Map();
  const runtimeReady = new Set();
  const runtimeReceiptHash = H('resident-supervisor-runtime-receipt');
  const dispatches = [];
  let canaries = 0;
  let reconciliations = 0;
  const startupEvents = [];
  const fixedNow = new Date('2026-07-16T03:00:00.000Z');
  const scheduler = {
    async sleep() {},
    setInterval() { return Object.freeze({}); },
    clearInterval() {},
    unref() {},
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [...byId.values()]; },
      getCampaign(id) { return byId.get(id); },
    },
    stateRepository: repository,
    async reconcileRuntime() {
      reconciliations += 1;
      startupEvents.push('runtime-receipt-mirror-reconciled');
      return { status: 'reconciled' };
    },
    async ensureRuntimeReproducibility({ campaign: value }) {
      startupEvents.push(`runtime-status:${value.campaignId}`);
      runtimeReady.add(value.campaignId);
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: '2099-01-01T00:00:00.000Z',
        renewAt: '2098-12-31T23:00:00.000Z',
      };
    },
    async runProviderCanary() {
      canaries += 1;
      return { verified: true, providerCanaryPairReceiptHash: H('resident-canary') };
    },
    async readQualificationState(value) {
      assert.equal(runtimeReady.has(value.campaignId), true);
      return qualification.get(value.campaignId) || null;
    },
    async renewQualification({ campaign: value }) {
      qualification.set(value.campaignId, {
        recovery: {
          status: 'qualification_verified', totalAttemptCount: 1, reservedCostUsd: 0.05,
        },
        receipt: {
          expiresAt: '2099-01-01T00:00:00.000Z',
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      });
      return { ready: true };
    },
    async dispatchCampaign({ campaign: value, action, qualificationRetry, signal }) {
      assert.equal(action, 'resume');
      assert.equal(signal.aborted, false);
      assert.equal(qualificationRetry.maximumTotalAttempts, 48);
      dispatches.push(value.campaignId);
      byId.set(value.campaignId, { ...value, status: 'completed' });
      qualification.set(value.campaignId, {
        recovery: { status: 'qualification_verified', totalAttemptCount: 1, reservedCostUsd: 0.05 },
        receipt: {
          expiresAt: '2099-01-01T00:00:00.000Z',
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      });
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        externalQualification: { status: 'qualification_external_service_verified' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H(`report:${value.campaignId}`),
      };
    },
    lifecyclePolicy: {},
    clock: { now: () => new Date(fixedNow) },
    scheduler,
    ownerId: 'supervisor:test',
    pollMs: 1000,
    random: () => 0,
  });
  const receipt = await supervisor.runCycle();
  assert.equal(receipt.status, 'autonomous_research_supervisor_cycle_completed');
  assert.equal(reconciliations, 1);
  assert.equal(startupEvents[0], 'runtime-receipt-mirror-reconciled');
  assert.equal(startupEvents.filter((event) => event.startsWith('runtime-status:')).length, 2);
  assert.equal(canaries, 2);
  assert.deepEqual(dispatches.sort(), campaigns.map((value) => value.campaignId).sort());
  assert.ok(repository.listCampaigns().every((value) => value.disposition === 'settled'));
  const repeated = await supervisor.runCycle();
  assert.equal(repeated.processedCampaignCount, 2);
  assert.ok(repeated.results.every((value) => value.status === 'not_due_or_leased'));
  assert.equal(reconciliations, 1);
  assert.equal(startupEvents.filter((event) =>
    event === 'runtime-receipt-mirror-reconciled').length, 1);
  assert.equal(canaries, 2);
});

test('resident run owns a heartbeat lease and clears health immediately on graceful shutdown', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-instance-run-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); });
  const controller = new AbortController();
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return []; },
      getCampaign() { return null; },
    },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    residentInstanceLeaseMs: 15 * 60 * 1000,
    residentInstanceHeartbeatMs: 30_000,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() { throw new Error('unexpected runtime check'); },
    async readQualificationState() { throw new Error('unexpected qualification read'); },
    async runProviderCanary() { throw new Error('unexpected canary'); },
    async renewQualification() { throw new Error('unexpected qualification renewal'); },
    async dispatchCampaign() { throw new Error('unexpected dispatch'); },
    clock: createSystemClock(),
    scheduler: createSystemScheduler(),
    ownerId: 'supervisor:resident-run',
    pollMs: 1000,
    signal: controller.signal,
    onCycle() { controller.abort('supervisor_process_shutdown'); },
  });
  const receipt = await supervisor.run();
  assert.equal(receipt.status, 'autonomous_research_supervisor_stopped_gracefully');
  assert.equal(receipt.cycleCount, 1);
  const status = inspectAutonomousResearchSupervisorInstanceStatus({ runtimeRoot });
  assert.equal(status.healthy, false);
  assert.match(status.blockers.join(','), /instance_stopped/);
});

test('startup reconciliation marks startup ready before a long first dispatch completes', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-long-first-cycle-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); });
  const controller = new AbortController();
  const runtimeReceiptHash = H('long-first-cycle-runtime');
  let value = campaign(
    'autonomous-research:long-first-cycle',
    'paused',
    'supervisor_process_shutdown',
  );
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  let finishDispatch;
  const dispatchGate = new Promise((resolve) => { finishDispatch = resolve; });
  const clock = createSystemClock();
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    async reconcileRuntime() { return { status: 'startup_reconciled' }; },
    async ensureRuntimeReproducibility() {
      const now = clock.now().getTime();
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
        renewAt: new Date(now + 7 * 60 * 60 * 1000).toISOString(),
      };
    },
    async readQualificationState() {
      return {
        recovery: {
          status: 'qualification_verified', totalAttemptCount: 1, reservedCostUsd: 0.05,
        },
        receipt: {
          expiresAt: new Date(clock.now().getTime() + 8 * 60 * 60 * 1000).toISOString(),
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      };
    },
    async runProviderCanary() {
      return { verified: true, providerCanaryPairReceiptHash: H('long-first-cycle-canary') };
    },
    async renewQualification() { throw new Error('qualification already current'); },
    async dispatchCampaign({ action }) {
      assert.equal(action, 'resume');
      dispatchStarted();
      await dispatchGate;
      value = { ...value, status: 'completed', effectiveStatus: 'completed' };
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H('long-first-cycle-report'),
      };
    },
    lifecyclePolicy: { maximumLifetimeMs: 60 * 60 * 1000 },
    clock,
    scheduler: createSystemScheduler(),
    ownerId: 'supervisor:long-first-cycle',
    pollMs: 1000,
    signal: controller.signal,
    onCycle() { controller.abort('supervisor_process_shutdown'); },
  });
  const running = supervisor.run();
  await started;
  const duringDispatch = inspectAutonomousResearchSupervisorInstanceStatus({ runtimeRoot });
  assert.equal(duringDispatch.healthy, true);
  assert.equal(duringDispatch.startupReady, true);
  assert.equal(duringDispatch.ready, false);
  assert.ok(duringDispatch.instance.startupReconciliationReceiptHash);
  assert.equal(duringDispatch.instance.lastCycleReceiptHash, null);
  finishDispatch();
  const result = await running;
  assert.equal(result.cycleCount, 1);
});

test('resident aborts fail-closed when its instance heartbeat fence is lost', async () => {
  const repository = {
    reconcileStaleLeases() { return { recoveredLeaseCount: 0 }; },
    registerCampaign() { throw new Error('unexpected campaign'); },
  };
  let releases = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return []; },
      getCampaign() { return null; },
    },
    stateRepository: repository,
    residentInstanceRepository: {
      acquireInstanceLease() {
        return {
          ownerId: 'supervisor:heartbeat-loss',
          leaseToken: 'instance:heartbeat-loss',
          leaseGeneration: 1,
          heartbeatMs: 30_000,
          leaseMs: 15 * 60 * 1000,
        };
      },
      markStartupReconciled() {
        return {
          ownerId: 'supervisor:heartbeat-loss',
          leaseToken: 'instance:heartbeat-loss',
          leaseGeneration: 1,
        };
      },
      markMachineIntakeReconciled() { throw new Error('unexpected intake success'); },
      markMachineIntakeReconciliationFailed() {
        throw new Error('unexpected intake failure');
      },
      assertInstanceLease() { throw new Error('unexpected instance assertion'); },
      heartbeatInstanceLease() { return null; },
      releaseInstanceLease() { releases += 1; return false; },
    },
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() { throw new Error('unexpected runtime check'); },
    async readQualificationState() { throw new Error('unexpected qualification read'); },
    async runProviderCanary() { throw new Error('unexpected canary'); },
    async renewQualification() { throw new Error('unexpected qualification renewal'); },
    async dispatchCampaign() { throw new Error('unexpected dispatch'); },
    clock: { now: () => new Date('2026-07-16T03:10:00.000Z') },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:heartbeat-loss',
  });
  await assert.rejects(() => supervisor.run(), /instance_lease_lost/);
  assert.equal(releases, 1);
});

test('crash cooldown is durably requeued and a replacement supervisor resumes without a machine command', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-cooldown-restart-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  let repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  let value = campaign(
    'autonomous-research:cooldown-restart-paper',
    'paused',
    'supervisor_transient_failure',
  );
  let nowMs = Date.parse('2026-07-16T03:20:00.000Z');
  const clock = { now: () => new Date(nowMs) };
  const runtimeReceiptHash = H('cooldown-restart-runtime');
  const qualification = {
    recovery: {
      status: 'qualification_verified',
      totalAttemptCount: 1,
      reservedCostUsd: 0.05,
    },
    receipt: {
      expiresAt: new Date(nowMs + 8 * 60 * 60 * 1000).toISOString(),
      runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
    },
  };
  const lifecyclePolicy = {
    maximumLifetimeMs: 60 * 60 * 1000,
    baseCooldownMs: 1000,
    maximumCooldownMs: 1000,
  };
  const common = {
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: new Date(nowMs + 8 * 60 * 60 * 1000).toISOString(),
        renewAt: new Date(nowMs + 7 * 60 * 60 * 1000).toISOString(),
      };
    },
    async readQualificationState() { return qualification; },
    async runProviderCanary() {
      return { verified: true, providerCanaryPairReceiptHash: H('cooldown-restart-canary') };
    },
    async renewQualification() { throw new Error('qualification already current'); },
    lifecyclePolicy,
    clock,
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    random: () => 0,
    pollMs: 100,
  };
  const crashing = createAutonomousResearchSupervisor({
    ...common,
    stateRepository: repository,
    ownerId: 'supervisor:before-crash',
    async dispatchCampaign({ action }) {
      assert.equal(action, 'resume');
      const ledger = createAutomationReadinessSideEffectLedger({
        environment: {},
        spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'unavailable' }),
      });
      ledger.spawnSyncFor('provider-readiness')('codex', ['login', 'status']);
      const error = new Error('simulated_supervisor_process_crash');
      error.automationReadinessSideEffectInspection = ledger.inspection({
        failureCode: error.message,
      });
      throw error;
    },
  });
  const failed = await crashing.runCycle();
  assert.equal(failed.results[0].status, 'cooldown');
  const persistedFailure = repository.getCampaign(value.campaignId);
  assert.equal(persistedFailure.nextDispatchAt,
    new Date(nowMs + 1000).toISOString());
  assert.equal(
    persistedFailure.lastOutcome.readinessAttemptReceipt.kind,
    'AutomationReadinessSideEffectInspection',
  );
  assert.equal(
    persistedFailure.lastOutcome.readinessAttemptReceipt.failedProcessActionCount,
    1,
  );
  repository.close();
  repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });

  let replacementDispatches = 0;
  const replacement = createAutonomousResearchSupervisor({
    ...common,
    stateRepository: repository,
    ownerId: 'supervisor:replacement',
    async dispatchCampaign({ action }) {
      replacementDispatches += 1;
      assert.equal(action, 'resume');
      value = { ...value, status: 'completed', effectiveStatus: 'completed' };
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H('cooldown-restart-report'),
      };
    },
  });
  nowMs += 999;
  const cooling = await replacement.runCycle();
  assert.equal(cooling.results[0].status, 'not_due_or_leased');
  assert.equal(replacementDispatches, 0);
  nowMs += 2;
  const resumed = await replacement.runCycle();
  assert.equal(replacementDispatches, 1);
  assert.equal(resumed.results[0].status, 'settled');
});

test('qualification cooldown survives resident replacement and resumes automatically when due', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-resident-restart-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  let repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  let value = campaign(
    'autonomous-research:qualification-resident-restart',
    'paused',
    'supervisor_transient_failure',
  );
  let nowMs = Date.parse('2026-07-16T03:25:00.000Z');
  const runtimeReceiptHash = H('qualification-resident-runtime');
  let qualification = {
    recovery: {
      status: 'qualification_recovery_budget_exhausted',
      nextAttemptAt: new Date(nowMs + 2000).toISOString(),
      totalAttemptCount: 1,
      reservedCostUsd: 0.05,
    },
    receipt: null,
  };
  let renewalCalls = 0;
  let dispatches = 0;
  const options = {
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: new Date(nowMs + 8 * 60 * 60 * 1000).toISOString(),
        renewAt: new Date(nowMs + 7 * 60 * 60 * 1000).toISOString(),
      };
    },
    async readQualificationState() { return qualification; },
    async runProviderCanary() {
      return { verified: true, providerCanaryPairReceiptHash: H('qualification-resident-canary') };
    },
    async renewQualification() {
      renewalCalls += 1;
      if (nowMs < Date.parse(qualification.recovery.nextAttemptAt || '')) {
        return {
          ready: false,
          terminal: false,
          reason: 'qualification_external_service_recovery_cooldown',
        };
      }
      qualification = {
        recovery: {
          status: 'qualification_verified',
          totalAttemptCount: 2,
          reservedCostUsd: 0.1,
        },
        receipt: {
          expiresAt: new Date(nowMs + 8 * 60 * 60 * 1000).toISOString(),
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      };
      return { ready: true };
    },
    async dispatchCampaign({ action }) {
      dispatches += 1;
      assert.equal(action, 'resume');
      value = { ...value, status: 'completed', effectiveStatus: 'completed' };
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H('qualification-resident-report'),
      };
    },
    lifecyclePolicy: { maximumLifetimeMs: 60 * 60 * 1000 },
    clock: { now: () => new Date(nowMs) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    pollMs: 100,
  };
  const first = createAutonomousResearchSupervisor({
    ...options,
    stateRepository: repository,
    ownerId: 'supervisor:qualification-before-restart',
  });
  const deferred = await first.runCycle();
  assert.equal(deferred.results[0].reason,
    'qualification_external_service_recovery_cooldown');
  assert.equal(repository.getCampaign(value.campaignId).nextDispatchAt,
    qualification.recovery.nextAttemptAt);
  assert.equal(dispatches, 0);
  repository.close();
  repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });

  const replacement = createAutonomousResearchSupervisor({
    ...options,
    stateRepository: repository,
    ownerId: 'supervisor:qualification-replacement',
  });
  nowMs += 1999;
  const stillCooling = await replacement.runCycle();
  assert.equal(stillCooling.results[0].status, 'not_due_or_leased');
  nowMs += 2;
  const resumed = await replacement.runCycle();
  assert.equal(resumed.results[0].status, 'settled');
  assert.equal(renewalCalls, 2);
  assert.equal(dispatches, 1);
});
