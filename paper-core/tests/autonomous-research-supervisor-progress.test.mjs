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
  buildAutonomousResearchMachineIntakeReconciliationProgress,
} from '../../paper-application/automation/autonomous-research-supervisor-progress.mjs';

const H = (label) => hashRecord('AutonomousSupervisorProgressTestHash', { label });
const STAGE_MS = 4 * 60 * 1000;

function campaign() {
  return {
    campaignId: 'autonomous-research:resident-progress',
    paperId: 'resident-progress',
    status: 'paused',
    effectiveStatus: 'paused',
    stopReason: 'supervisor_process_shutdown',
    costKnown: true,
    costUsd: 1,
    spec: {
      budgets: { maxCostUsd: 100 },
      autonomousResearchPreparation: {
        proposal: { paperId: 'resident-progress' },
        autonomousResearchProviderConfigurationHash: H(
          'resident-progress-provider-configuration',
        ),
      },
    },
  };
}

function emptyMachineIntake(configurationHash, advance) {
  const repository = {
    listPendingIntakes() { return []; },
    listEnqueuedIntakes() { return []; },
    readIntake() { return null; },
    tryAcquireIntakeLease() { return null; },
    renewIntakeLease() { return null; },
    assertIntakeLease() { return true; },
    markIntakeEnqueued() { throw new Error('unexpected intake enqueue'); },
    markEnqueuedIntakeInvalid() { throw new Error('unexpected intake invalidation'); },
    deferIntake() { throw new Error('unexpected intake deferral'); },
    releaseIntakeLease() { return false; },
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
  };
  return {
    repository,
    async loadConfiguredIntakes() {
      advance();
      return {
        configurationHash,
        attemptedCount: 0,
        insertedCount: 0,
        idempotentCount: 0,
        errorCount: 0,
        results: [],
      };
    },
    async enqueueIntake() { throw new Error('unexpected intake enqueue'); },
  };
}

test('topic-producer reconciliation cannot omit the canonical dataset snapshot', () => {
  const progress = buildAutonomousResearchMachineIntakeReconciliationProgress({
    result: {
      configured: true,
      loaded: {
        configurationHash: H('producer-configuration'),
        errorCount: 0,
        topicProducer: { ready: true },
        topicProducerDatasetSnapshot: null,
      },
      enqueuedReconciliation: [],
    },
    ownerId: 'supervisor:dataset-snapshot-negative',
    now: new Date(),
  });
  assert.equal(progress.ready, false);
  assert.equal(progress.reason,
    'autonomous_research_topic_producer_dataset_snapshot_hash_missing');
});

test('pending machine-intake reconciliation is ready only for verified successful commits', () => {
  const successful = Object.freeze({
    intakeId: 'intake:verified',
    campaignId: 'autonomous-research:verified',
    status: 'machine_intake_enqueued',
    campaignPlanHash: H('verified-plan'),
    preparationHash: H('verified-preparation'),
    admissionHash: H('verified-admission'),
  });
  const base = {
    configured: true,
    loaded: { configurationHash: H('strict-intake-configuration'), errorCount: 0 },
    enqueuedReconciliation: [],
    pendingCount: 1,
    processedCount: 1,
    results: [successful],
  };
  const inspect = (overrides = {}) =>
    buildAutonomousResearchMachineIntakeReconciliationProgress({
      result: { ...base, ...overrides },
      ownerId: 'supervisor:strict-pending-progress',
      now: new Date('2026-07-16T08:00:00.000Z'),
    });

  assert.equal(inspect().ready, true);
  assert.equal(inspect({ pendingCount: 0, processedCount: 0, results: [] }).ready, true);
  assert.equal(inspect({ processedCount: 0, results: [] }).reason,
    'autonomous_research_machine_intake_pending_reconciliation_incomplete');
  assert.equal(inspect({
    results: [{
      intakeId: 'intake:deferred',
      status: 'machine_intake_deferred',
      error: 'autonomous_research_machine_intake_campaign_commit_invalid',
    }],
  }).reason, 'autonomous_research_machine_intake_pending_processing_unsuccessful');
  assert.equal(inspect({
    results: [{ intakeId: 'intake:lost', status: 'machine_intake_lease_lost' }],
  }).reason, 'autonomous_research_machine_intake_pending_processing_unsuccessful');
  assert.equal(inspect({
    results: [{ intakeId: 'intake:leased', status: 'machine_intake_leased' }],
  }).reason, 'autonomous_research_machine_intake_pending_lease_held');
  assert.equal(inspect({
    results: [{ intakeId: 'intake:not-due', status: 'machine_intake_not_due' }],
  }).reason, 'autonomous_research_machine_intake_pending_not_due');
  assert.equal(inspect({
    results: [{ ...successful, campaignPlanHash: null }],
  }).reason, 'autonomous_research_machine_intake_pending_processing_unsuccessful');
  assert.equal(inspect({
    enqueuedReconciliation: [{
      intakeId: 'intake:invalidated',
      status: 'machine_intake_enqueued_binding_invalidated',
    }],
  }).reason, 'autonomous_research_machine_intake_enqueued_reconciliation_unsuccessful');
});

test('explicit progress heartbeats preserve resident and campaign fences when intervals never fire', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-progress-fence-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  const competitor = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); competitor.close(); });

  let nowMs = Date.parse('2026-07-16T08:00:00.000Z');
  const clock = { now: () => new Date(nowMs) };
  const advance = () => { nowMs += STAGE_MS; };
  let intervalRegistrations = 0;
  let intervalCallbacks = 0;
  const scheduler = {
    async sleep() {},
    setInterval() {
      intervalRegistrations += 1;
      return { inactive: true };
    },
    clearInterval() {},
    unref() {},
  };
  const controller = new AbortController();
  const runtimeReceiptHash = H('runtime');
  let value = campaign();
  let qualificationReady = false;
  let providerCanaryCalls = 0;
  let dispatchCalls = 0;
  const qualificationState = () => qualificationReady ? {
    recovery: {
      status: 'qualification_verified',
      totalAttemptCount: 1,
      reservedCostUsd: 0.05,
    },
    receipt: {
      expiresAt: new Date(nowMs + 8 * 60 * 60 * 1000).toISOString(),
      runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
    },
  } : {
    recovery: {
      status: 'qualification_retry_scheduled',
      nextAttemptAt: new Date(nowMs - 1).toISOString(),
      totalAttemptCount: 0,
      reservedCostUsd: 0,
    },
    receipt: null,
  };

  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    machineIntake: emptyMachineIntake(H('intake-configuration'), advance),
    async reconcileRuntime() { advance(); return { status: 'reconciled' }; },
    async ensureRuntimeReproducibility() {
      advance();
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: new Date(nowMs + 8 * 60 * 60 * 1000).toISOString(),
        renewAt: new Date(nowMs + 7 * 60 * 60 * 1000).toISOString(),
      };
    },
    async readQualificationState() { return qualificationState(); },
    async runProviderCanary() {
      providerCanaryCalls += 1;
      advance();
      return { verified: true, providerCanaryPairReceiptHash: H('canary') };
    },
    async renewQualification({ onProgress, onSynchronousProgress }) {
      advance();
      const probeContext = onSynchronousProgress({ stage: 'after_attestor_probe' });
      probeContext.assertCurrent({ now: clock.now() });
      advance();
      await onProgress({ stage: 'after_attestor_sign' });
      qualificationReady = true;
      return { ready: true };
    },
    async dispatchCampaign({ supervisorDispatchEvidence }) {
      dispatchCalls += 1;
      advance();
      supervisorDispatchEvidence.residentLeaseContext.assertCurrent({ now: clock.now() });
      value = { ...value, status: 'completed', effectiveStatus: 'completed' };
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H('report'),
      };
    },
    clock,
    scheduler,
    ownerId: 'supervisor:explicit-progress',
    pollMs: 1000,
    signal: controller.signal,
    onCycle() {
      const persisted = instanceRepository.readInstance();
      assert.equal(persisted.status, 'running');
      assert.equal(persisted.lastHeartbeatAt, clock.now().toISOString());
      assert.equal(competitor.acquireInstanceLease({
        ownerId: 'supervisor:false-takeover',
        now: clock.now(),
      }), null);
      controller.abort('supervisor_process_shutdown');
    },
  });
  const result = await supervisor.run();
  assert.equal(result.cycleCount, 1);
  assert.equal(providerCanaryCalls, 1);
  assert.equal(dispatchCalls, 1);
  assert.ok(nowMs - Date.parse('2026-07-16T08:00:00.000Z') > 15 * 60 * 1000);
  assert.ok(intervalRegistrations >= 2);
  assert.equal(intervalCallbacks, 0);
});

test('machine-intake load errors clear readiness and the next clean cycle restores it', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-progress-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); });
  const configurationHash = H('recovering-intake-configuration');
  const machineIntake = emptyMachineIntake(configurationHash, () => {});
  let loadFails = true;
  machineIntake.loadConfiguredIntakes = async () => ({
    configurationHash,
    attemptedCount: 1,
    insertedCount: loadFails ? 0 : 1,
    idempotentCount: 0,
    errorCount: loadFails ? 1 : 0,
    results: loadFails ? [{ error: 'invalid intake' }] : [{ inserted: true }],
  });
  const controller = new AbortController();
  let cycles = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return []; },
      getCampaign() { return null; },
    },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    machineIntake,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() { throw new Error('unexpected runtime check'); },
    async readQualificationState() { throw new Error('unexpected qualification read'); },
    async runProviderCanary() { throw new Error('unexpected provider canary'); },
    async renewQualification() { throw new Error('unexpected qualification renewal'); },
    async dispatchCampaign() { throw new Error('unexpected campaign dispatch'); },
    clock: { now: () => new Date() },
    scheduler: {
      async sleep() {},
      setInterval() { return {}; },
      clearInterval() {},
      unref() {},
    },
    ownerId: 'supervisor:intake-progress-recovery',
    signal: controller.signal,
    onCycle() {
      cycles += 1;
      const current = instanceRepository.readInstance();
      if (cycles === 1) {
        assert.equal(current.machineIntakeReconciliationReceiptHash, null);
        assert.match(current.machineIntakeReconciliationFailure, /load_errors_present/);
        loadFails = false;
      } else {
        assert.ok(current.machineIntakeReconciliationReceiptHash);
        assert.equal(current.machineIntakeConfigurationHash, configurationHash);
        assert.equal(current.machineIntakeReconciliationFailure, null);
        controller.abort('supervisor_process_shutdown');
      }
    },
  });
  const result = await supervisor.run();
  assert.equal(result.cycleCount, 2);
});

test('deferred pending intake clears resident reconciliation readiness and health', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-pending-health-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); });
  const machineIntake = emptyMachineIntake(H('pending-health-configuration'), () => {});
  let exposePending = false;
  let deferredCount = 0;
  machineIntake.repository.listPendingIntakes = () => exposePending ? [{
    intakeId: 'intake:pending-health',
    campaignId: 'autonomous-research:pending-health',
    sourceKind: 'static-file',
    sourceAuthorityHash: H('pending-health-authority'),
    intake: {},
  }] : [];
  machineIntake.repository.tryAcquireIntakeLease = () => ({
    ownerId: 'supervisor:pending-health',
    leaseToken: 'pending-health-lease',
    leaseGeneration: 1,
  });
  machineIntake.repository.deferIntake = () => { deferredCount += 1; return true; };
  const controller = new AbortController();
  let cycles = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: { listCampaigns: () => [], getCampaign: () => null },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    machineIntake,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() { throw new Error('unexpected runtime check'); },
    async readQualificationState() { throw new Error('unexpected qualification read'); },
    async runProviderCanary() { throw new Error('unexpected provider canary'); },
    async renewQualification() { throw new Error('unexpected qualification renewal'); },
    async dispatchCampaign() { throw new Error('unexpected campaign dispatch'); },
    clock: { now: () => new Date() },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:pending-health',
    signal: controller.signal,
    onCycle(cycle) {
      cycles += 1;
      const instance = instanceRepository.readInstance();
      const health = inspectAutonomousResearchSupervisorInstanceStatus({
        runtimeRoot,
        now: new Date(),
      });
      if (cycles === 1) {
        assert.ok(instance.machineIntakeReconciliationReceiptHash);
        assert.equal(health.ready, true);
        exposePending = true;
        return;
      }
      assert.equal(cycle.status,
        'autonomous_research_supervisor_machine_intake_reconciliation_blocked');
      assert.equal(cycle.machineIntake.results[0].status, 'machine_intake_deferred');
      assert.equal(instance.machineIntakeReconciliationReceiptHash, null);
      assert.match(instance.machineIntakeReconciliationFailure,
        /pending_processing_unsuccessful/);
      assert.equal(health.machineIntakeReconciliationReady, false);
      assert.equal(health.ready, false);
      assert.match(health.blockers.join(','), /machine_intake_reconciliation_required/);
      controller.abort('supervisor_process_shutdown');
    },
  });
  const result = await supervisor.run();
  assert.equal(result.cycleCount, 2);
  assert.equal(deferredCount, 1);
});
