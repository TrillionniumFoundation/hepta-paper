import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  createAutonomousResearchSupervisor,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  createAutonomousResearchMachineIntakeCycleProcessor,
} from '../../paper-application/automation/autonomous-research-machine-intake-supervision.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fullyAutonomousConstructorDependencies,
  fullyAutonomousResidentInstanceRepository,
} from './autonomous-research-supervisor-machine-intake-test-support.mjs';

const H = (label) => hashRecord('SupervisorMachineIntakeTestHash', { label });

function scheduler() {
  return Object.freeze({
    async sleep() {},
    setInterval() { return {}; },
    clearInterval() {},
    unref() {},
  });
}

function residentLeaseContext() {
  const lease = Object.freeze({
    ownerId: 'resident:test',
    leaseToken: 'resident-lease:test',
    leaseGeneration: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return Object.freeze({ lease, assertCurrent() { return lease; } });
}

test('fully autonomous cycles require the private resident singleton authority', async () => {
  const dependencies = fullyAutonomousConstructorDependencies(scheduler());
  assert.throws(() => createAutonomousResearchSupervisor(dependencies),
    /resident_instance_repository_required/);
  const supervisor = createAutonomousResearchSupervisor({
    ...dependencies,
    residentInstanceRepository: fullyAutonomousResidentInstanceRepository(),
  });
  await assert.rejects(supervisor.runCycle(), /resident_cycle_authority_required/);
});

function machineIntake(label, now) {
  return buildAutonomousResearchMachineIntake({
    intakeId: `intake:${label}`,
    paperId: `paper:${label}`,
    campaignId: `autonomous-research:paper:${label}`,
    launchMode: 'production-run',
    admissionCreatedAt: now.toISOString(),
    objective: `Evaluate the bounded ${label} supervisor intake.`,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: `dataset-${label}`,
      source: `/datasets/${label}`,
      readOnly: true,
      manifestHash: H(`dataset:${label}`),
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
    providerConfigurationHash: H('provider'),
    recurringGoldenProvenance: null,
    revisionRounds: 1,
    refereeCount: 2,
  });
}

function enqueuedAuthority(label, now) {
  const intake = machineIntake(label, now);
  const admission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: 'machine',
    sourceAuthorityHash: H('source-authority'),
  });
  const preparationHash = H(`preparation:${label}`);
  const planPayload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    autonomousResearchMachineIntake: intake,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmission: admission,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    autonomousResearchPreparation: {
      proposal: { paperId: intake.paperId },
      autonomousResearchLoopPreparationReportHash: preparationHash,
      autonomousResearchMachineIntakeAdmissionHash:
        admission.autonomousResearchMachineIntakeAdmissionHash,
    },
  };
  const campaignPlanHash = hashRecord('PaperCampaignPlan', planPayload);
  const campaign = Object.freeze({
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    status: 'paused',
    costKnown: true,
    costUsd: 0,
    spec: Object.freeze({ ...planPayload, campaignPlanHash }),
  });
  return Object.freeze({
    campaign,
    record: {
      intake,
      intakeId: intake.intakeId,
      intakeHash: intake.intakeHash,
      campaignId: intake.campaignId,
      admission,
      admissionHash: admission.autonomousResearchMachineIntakeAdmissionHash,
      disposition: 'enqueued',
      sourceKind: 'machine',
      sourceAuthorityHash: H('source-authority'),
      campaignPlanHash,
      preparationHash,
    },
  });
}

test('invalidated enqueued bindings fail reconciliation and fence campaign dispatch', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-reconcile-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => stateRepository.close());
  const now = new Date('2026-07-16T05:00:00.000Z');
  const missing = enqueuedAuthority('missing', now);
  const mismatch = enqueuedAuthority('mismatch', now);
  mismatch.record.campaignPlanHash = H('stale-plan-binding');
  const records = new Map([
    [missing.record.intakeId, missing.record],
    [mismatch.record.intakeId, mismatch.record],
  ]);
  const invalidated = [];
  const repository = {
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
    listEnqueuedIntakes() { return [...records.values()]; },
    listPendingIntakes() { return []; },
    readIntake(intakeId) { return records.get(intakeId) || null; },
    tryAcquireIntakeLease() { return null; },
    renewIntakeLease() { return null; },
    assertIntakeLease() { throw new Error('no_pending_intake_expected'); },
    markIntakeEnqueued() { throw new Error('no_pending_intake_expected'); },
    deferIntake() { throw new Error('no_pending_intake_expected'); },
    releaseIntakeLease() { throw new Error('no_pending_intake_expected'); },
    markEnqueuedIntakeInvalid(input) {
      const record = records.get(input.intakeId);
      assert.equal(input.autonomousResearchMachineIntakeAdmissionHash, record.admissionHash);
      record.disposition = 'invalid';
      invalidated.push(input);
      return record;
    },
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [mismatch.campaign]; },
      getCampaign(campaignId) {
        return campaignId === mismatch.campaign.campaignId ? mismatch.campaign : null;
      },
    },
    stateRepository,
    async dispatchCampaign() { throw new Error('invalid_intake_must_not_dispatch'); },
    async readQualificationState() { return null; },
    async ensureRuntimeReproducibility() {
      throw new Error('invalid_intake_must_not_refresh_runtime');
    },
    async runProviderCanary() { throw new Error('invalid_intake_must_not_canary'); },
    async renewQualification() { throw new Error('invalid_intake_must_not_renew'); },
    async reconcileRuntime() { return null; },
    machineIntake: {
      repository,
      async loadConfiguredIntakes() {
        return {
          configurationHash: H('machine-intake-configuration'),
          attemptedCount: 0,
          insertedCount: 0,
          idempotentCount: 0,
          errorCount: 0,
        };
      },
      async enqueueIntake() { throw new Error('no_pending_intake_expected'); },
    },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    ownerId: 'supervisor:intake-reconcile',
  });
  const cycle = await supervisor.runCycle();
  assert.equal(invalidated.length, 2);
  assert.equal(cycle.machineIntake.enqueuedReconciliation.length, 2);
  assert.ok(cycle.machineIntake.enqueuedReconciliation.every((result) =>
    result.status === 'machine_intake_enqueued_binding_invalidated'));
  assert.equal(cycle.status,
    'autonomous_research_supervisor_machine_intake_reconciliation_blocked');
  assert.equal(cycle.machineIntakeReconciliationReceipt, null);
  assert.match(cycle.machineIntakeReconciliationBlocker,
    /enqueued_reconciliation_unsuccessful/);
  assert.deepEqual(cycle.results, []);
});

test('runtime intake configuration failure globally fences existing campaign dispatch', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-load-isolation-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => stateRepository.close());
  const now = new Date('2026-07-16T05:10:00.000Z');
  const existing = {
    campaignId: 'autonomous-research:existing-recovery',
    paperId: 'existing-recovery',
    status: 'paused',
    costKnown: true,
    costUsd: 0,
    spec: {
      budgets: { maxCostUsd: 10 },
      autonomousResearchPreparation: { proposal: { paperId: 'existing-recovery' } },
    },
  };
  const repository = {
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
    listEnqueuedIntakes() { return []; }, listPendingIntakes() { return []; },
    readIntake() { return null; }, tryAcquireIntakeLease() { return null; },
    renewIntakeLease() { return null; }, assertIntakeLease() { return null; },
    markIntakeEnqueued() { return null; }, markEnqueuedIntakeInvalid() { return null; },
    deferIntake() { return null; }, releaseIntakeLease() { return null; },
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: { listCampaigns: () => [existing], getCampaign: () => existing },
    stateRepository,
    async dispatchCampaign() { throw new Error('runtime_deferral_must_not_dispatch'); },
    async readQualificationState() { return null; },
    async ensureRuntimeReproducibility() {
      return { ready: false, reason: 'runtime_refresh_deferred', deferUntil: now };
    },
    async runProviderCanary() { throw new Error('runtime_deferral_must_not_canary'); },
    async renewQualification() { throw new Error('runtime_deferral_must_not_renew'); },
    async reconcileRuntime() { return null; },
    machineIntake: {
      repository,
      async loadConfiguredIntakes() { throw new Error('one_static_file_corrupt'); },
      async enqueueIntake() { throw new Error('intake_load_failed'); },
    },
    clock: { now: () => new Date(now) }, scheduler: scheduler(),
    ownerId: 'supervisor:intake-load-isolation',
  });
  const cycle = await supervisor.runCycle();
  assert.equal(cycle.machineIntake.status, 'machine_intake_configuration_or_load_failed');
  assert.match(cycle.machineIntake.error, /one_static_file_corrupt/);
  assert.equal(cycle.status,
    'autonomous_research_supervisor_machine_intake_reconciliation_blocked');
  assert.equal(cycle.discoveredCampaignCount, 0);
  assert.equal(cycle.processedCampaignCount, 0);
  assert.deepEqual(cycle.results, []);
});

test('dynamic full-to-bootstrap downgrade prevents pending production enqueue', async () => {
  const now = new Date('2026-07-17T06:00:00.000Z');
  const intake = machineIntake('dynamic-autonomy-downgrade', now);
  const admission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: 'machine',
    sourceAuthorityHash: H('dynamic-source-authority'),
  });
  const record = {
    intake,
    admission,
    intakeId: intake.intakeId,
    intakeHash: intake.intakeHash,
    campaignId: intake.campaignId,
    admissionHash: admission.autonomousResearchMachineIntakeAdmissionHash,
    disposition: 'pending',
    sourceKind: 'machine',
    sourceRef: 'machine-api',
    sourceAuthorityHash: admission.sourceAuthorityHash,
  };
  const lease = Object.freeze({
    ownerId: 'supervisor:dynamic-downgrade',
    leaseToken: 'intake-lease:dynamic-downgrade',
    leaseGeneration: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let autonomyChecks = 0;
  let enqueueCalls = 0;
  let deferred = 0;
  const repository = {
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
    listEnqueuedIntakes() { return []; },
    listPendingIntakes() { return [record]; },
    readIntake() { return record; },
    tryAcquireIntakeLease() { return lease; },
    renewIntakeLease() { return lease; },
    assertIntakeLease() { return lease; },
    markIntakeEnqueued() { throw new Error('production_enqueue_must_not_commit'); },
    markEnqueuedIntakeInvalid() { throw new Error('no_enqueued_intake_expected'); },
    deferIntake() { deferred += 1; return record; },
    releaseIntakeLease() {},
  };
  const processor = createAutonomousResearchMachineIntakeCycleProcessor({
    machineIntake: {
      repository,
      async loadConfiguredIntakes() {
        return {
          configurationHash: H('dynamic-configuration'),
          attemptedCount: 0,
          insertedCount: 0,
          idempotentCount: 0,
          errorCount: 0,
        };
      },
      async enqueueIntake() { enqueueCalls += 1; },
    },
    campaignStore: { getCampaign() { return null; } },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    ownerId: lease.ownerId,
    machineIntakeLeaseMs: 5 * 60 * 1000,
    maximumCampaignsPerCycle: 10,
    pollMs: 1000,
    signal: null,
    assertAutonomyCurrent({ requireFullOperationMode }) {
      autonomyChecks += 1;
      const operationMode = autonomyChecks === 1 ? 'full' : 'bootstrap-only';
      if (requireFullOperationMode && operationMode !== 'full') {
        throw new Error('dynamic_global_qualification_downgrade');
      }
      return Object.freeze({ ready: true, operationMode });
    },
  });
  const result = await processor({
    operationMode: 'full',
    onProgress() { return residentLeaseContext(); },
  });
  assert.equal(autonomyChecks, 2);
  assert.equal(enqueueCalls, 0);
  assert.equal(deferred, 1);
  assert.equal(result.processedCount, 1);
  assert.equal(result.results[0].status, 'machine_intake_deferred');
  assert.match(result.results[0].error, /dynamic_global_qualification_downgrade/);
});
