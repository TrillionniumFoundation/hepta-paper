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
  ResidentReactivationRequired,
  autonomousResearchResidentExitCode,
  isResidentReactivationRequired,
} from '../../paper-application/automation/autonomous-research-resident-reactivation-required.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';

const H = (label) => hashRecord('AutonomousSupervisorTestHash', { label });

function residentPrerequisiteReceipt(now, identityLabel) {
  const identity = Object.freeze({
    externalQualificationConfigurationInspectionHash: H(`inspection:${identityLabel}`),
    externalQualificationConfigurationIdentityHash: H(`configuration:${identityLabel}`),
    externalQualificationTrustIdentityHash: H(`external-trust:${identityLabel}`),
    externalQualificationMaximumCostUsd: 1,
    externalQualificationCostAuthority: 'operator_declared_worst_case_usd',
    runtimeImageReproducibilityConfigurationIdentityHash: H(`runtime:${identityLabel}`),
    runtimeImageReproducibilityTrustIdentityHash: H(`runtime-trust:${identityLabel}`),
    externalActionRecoveryConfigurationIdentityHash:
      H(`external-action-recovery:${identityLabel}`),
    codeWorktreeStateHash: H(`worktree:${identityLabel}`),
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentPrerequisiteReceipt',
    status: 'autonomous_research_resident_prerequisites_ready',
    ready: true,
    infrastructureReady: true,
    globalQualificationReady: true,
    operationMode: 'full',
    inspectedAt: now.toISOString(),
    ...identity,
    autonomousResearchResidentPrerequisiteIdentityHash: hashRecord(
      'AutonomousResearchResidentPrerequisiteIdentity', identity,
    ),
    zeroCostAuthorityEvidenceScope: null,
    fullResearchQualificationExpiresAt:
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    runtimeImageReproducibilityExpiresAt:
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    externalActionPerformed: false,
    networkActionPerformed: false,
    providerCanaryPerformed: false,
    releaseSignerChallengePerformed: false,
    infrastructureBlockers: Object.freeze([]),
    globalQualificationBlockers: Object.freeze([]),
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchResidentPrerequisiteReceiptHash: hashRecord(
      'AutonomousResearchResidentPrerequisiteReceipt', payload,
    ),
  });
}

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

test('valid prerequisite rotation exits 75, releases the resident, and replacement reruns startup', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-reactivate-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); });
  const now = new Date('2026-07-20T01:00:00.000Z');
  const receipts = {
    startup: residentPrerequisiteReceipt(now, 'startup'),
    rotated: residentPrerequisiteReceipt(now, 'rotated'),
  };
  let startupReconciliations = 0;
  let prerequisiteInspections = 0;
  const effects = { provider: 0, qualification: 0, submission: 0, topic: 0 };
  const scheduler = {
    async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
  };
  const dependencies = {
    campaignStore: { listCampaigns() { return []; }, getCampaign() { return null; } },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    residentInstanceLeaseMs: 15 * 60 * 1000,
    residentInstanceHeartbeatMs: 30_000,
    requireFullyAutonomous: true,
    async reconcileRuntime() { startupReconciliations += 1; return { status: 'reconciled' }; },
    async ensureRuntimeReproducibility() { effects.topic += 1; throw new Error('unexpected'); },
    async readQualificationState() { effects.qualification += 1; throw new Error('unexpected'); },
    async runProviderCanary() { effects.provider += 1; throw new Error('unexpected'); },
    async renewQualification() { effects.qualification += 1; throw new Error('unexpected'); },
    async dispatchCampaign() { effects.submission += 1; throw new Error('unexpected'); },
    clock: { now: () => new Date(now) },
    scheduler,
    pollMs: 1000,
  };
  const first = createAutonomousResearchSupervisor({
    ...dependencies,
    ownerId: 'supervisor:reactivation:first',
    inspectFullyAutonomousPrerequisites() {
      prerequisiteInspections += 1;
      return prerequisiteInspections === 1 ? receipts.startup : receipts.rotated;
    },
  });
  let thrown = null;
  await assert.rejects(() => first.run(), (error) => {
    thrown = error;
    return isResidentReactivationRequired(error)
      && error instanceof ResidentReactivationRequired
      && error.source === 'resident_prerequisite'
      && error.startupIdentityHash
        === receipts.startup.autonomousResearchResidentPrerequisiteIdentityHash
      && error.observedIdentityHash
        === receipts.rotated.autonomousResearchResidentPrerequisiteIdentityHash;
  });
  assert.equal(autonomousResearchResidentExitCode(thrown), 75);
  assert.deepEqual(effects, { provider: 0, qualification: 0, submission: 0, topic: 0 });
  const stopped = instanceRepository.readInstance();
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.stopReason, /resident_reactivation_required/);
  assert.match(stopped.stopReason, /resident_prerequisite/);

  const replacementController = new AbortController();
  const replacement = createAutonomousResearchSupervisor({
    ...dependencies,
    ownerId: 'supervisor:reactivation:replacement',
    signal: replacementController.signal,
    inspectFullyAutonomousPrerequisites() { return receipts.rotated; },
    onCycle() { replacementController.abort('replacement_test_complete'); },
  });
  const replacementReceipt = await replacement.run();
  assert.equal(replacementReceipt.cycleCount, 1);
  assert.equal(startupReconciliations, 2);
  assert.deepEqual(effects, { provider: 0, qualification: 0, submission: 0, topic: 0 });
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
