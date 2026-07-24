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
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  createAutonomousResearchSupervisor,
  verifyAutonomousResearchMachineIntakeEnqueueCommit,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  composeAutonomousResearchSupervisor,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import {
  assertAutonomousResearchSupervisorMachineIntakeConfiguration,
} from '../../paper-composition/automation/autonomous-research-supervisor-prerequisites.mjs';
import {
  buildCanonicalAdmissionPreflightExecutionInspection,
  buildExecutionAdmittedSupervisorCampaign,
  buildMachineIntakeExecutionAdmission,
} from './autonomous-research-supervisor-enqueue-test-support.mjs';
import { H, campaign } from './support/autonomous-research-supervisor-fixture.mjs';

test('canonical resident mode rejects pointer drift and fully-autonomous startup without intake', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-startup-fence-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-startup-fence-runtime-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  assert.throws(() => assertAutonomousResearchSupervisorMachineIntakeConfiguration({
    required: true,
    configuredPath: null,
  }), /machine_intake_configuration_required/);
  assert.throws(() => composeAutonomousResearchSupervisor({
    root,
    runtimeRoot,
    environment: {
      HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT: path.join(root, 'attacker-pointer.json'),
    },
  }), /qualification_pointer_path_mismatch/);
});
test('resident cold start loads and enqueues a machine intake under its fenced lease', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-intake-cycle-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => stateRepository.close());
  const now = new Date('2026-07-16T03:40:00.000Z');
  const machineIntake = buildAutonomousResearchMachineIntake({
    intakeId: 'intake:cold-start-test',
    paperId: 'cold-start-test',
    campaignId: 'autonomous-research:cold-start-test',
    launchMode: 'production-run',
    admissionCreatedAt: now.toISOString(),
    objective: 'Evaluate the bounded cold-start supervisor intake.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: 'cold-start-dataset',
      source: '/datasets/cold-start',
      readOnly: true,
      manifestHash: H('cold-start-dataset'),
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
    providerConfigurationHash: H('cold-start-provider'),
    recurringGoldenProvenance: null,
    revisionRounds: 1,
    refereeCount: 2,
  });
  const persistedAdmission = buildAutonomousResearchMachineIntakeAdmission({
    intake: machineIntake,
    sourceKind: 'machine',
    sourceAuthorityHash: H('cold-start-source-authority'),
  });
  const record = Object.freeze({
    intakeId: machineIntake.intakeId,
    intakeHash: machineIntake.intakeHash,
    campaignId: machineIntake.campaignId,
    sourceKind: 'machine',
    sourceRef: 'machine-api',
    sourceAuthorityHash: H('cold-start-source-authority'),
    disposition: 'pending',
    admission: persistedAdmission,
    admissionHash: persistedAdmission.autonomousResearchMachineIntakeAdmissionHash,
    intake: machineIntake,
  });
  const lease = Object.freeze({
    ownerId: 'supervisor:intake-cycle',
    leaseToken: 'intake-lease:test',
    leaseGeneration: 1,
  });
  let listedAt = null;
  let marked = null;
  let released = false;
  let persistedCampaign = null;
  let emittedAdmission = null;
  let emittedReceipt = null;
  const machineRepository = {
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
    listPendingIntakes({ now: listedNow }) {
      listedAt = listedNow;
      return [record];
    },
    listEnqueuedIntakes() { return []; },
    readIntake() { return null; },
    tryAcquireIntakeLease() { return lease; },
    renewIntakeLease() { return { ...lease, expiresAt: '2026-07-16T03:45:00.000Z' }; },
    assertIntakeLease() { return lease; },
    markIntakeEnqueued(input) {
      marked = input;
      return {
        campaignPlanHash: input.campaignPlanHash,
        preparationHash: input.autonomousResearchLoopPreparationReportHash,
        admissionHash: input.autonomousResearchMachineIntakeAdmissionHash,
      };
    },
    markEnqueuedIntakeInvalid() {
      throw new Error('valid_enqueued_intake_must_not_be_invalidated');
    },
    deferIntake() { throw new Error('successful_intake_must_not_be_deferred'); },
    releaseIntakeLease() { released = true; },
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return []; },
      getCampaign() { return persistedCampaign; },
    },
    stateRepository,
    async dispatchCampaign() { throw new Error('enqueue_only_must_not_dispatch'); },
    async readQualificationState() { return null; },
    async ensureRuntimeReproducibility() { return { ready: false }; },
    async runProviderCanary() { throw new Error('no_campaign_canary_must_not_run'); },
    async renewQualification() { throw new Error('no_campaign_renewal_must_not_run'); },
    async reconcileRuntime() { return null; },
    machineIntake: {
      repository: machineRepository,
      async loadConfiguredIntakes({ now: loadedAt }) {
        assert.equal(loadedAt.toISOString(), now.toISOString());
        return { attemptedCount: 1, insertedCount: 1, idempotentCount: 0, errorCount: 0 };
      },
      async enqueueIntake({ intake, machineIntakeAdmission, intakeLease, signal }) {
        emittedAdmission = machineIntakeAdmission;
        assert.equal(intake, record.intake);
        assert.equal(intakeLease.intakeId, record.intakeId);
        assert.equal(intakeLease.leaseToken, lease.leaseToken);
        assert.equal(signal.aborted, false);
        const preparationHash = H('cold-start-preparation');
        const executionAdmission = buildMachineIntakeExecutionAdmission(H('execution-admission'));
        const planPayload = {
          version: 4,
          kind: 'PaperCampaignPlan',
          autonomousResearchMachineIntakeHash: record.intakeHash,
          autonomousResearchMachineIntakeAdmissionHash:
            machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
          executionAdmission,
          autonomousResearchPreparation: {
            proposal: { paperId: record.intake.paperId },
            autonomousResearchLoopPreparationReportHash: preparationHash,
            autonomousResearchMachineIntakeAdmissionHash:
              machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
          },
        };
        const planHash = hashRecord('PaperCampaignPlan', planPayload);
        const admissionPreflightExecutionInspection =
          buildCanonicalAdmissionPreflightExecutionInspection();
        const payload = {
          version: 1,
          kind: 'AutonomousResearchCampaignEnqueueReceipt',
          status: 'autonomous_research_campaign_enqueued',
          campaignId: record.campaignId,
          paperId: record.intake.paperId,
          campaignPlanHash: planHash,
          autonomousResearchMachineIntakeHash: record.intakeHash,
          autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
          autonomousResearchMachineIntakeAdmissionHash:
            machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
          autonomousResearchLoopPreparationReportHash: preparationHash,
          autonomousResearchCampaignExecutionAdmissionHash:
            executionAdmission.autonomousResearchCampaignExecutionAdmissionHash,
          admissionPreflightExecutionInspection,
          admissionOnly: true,
          executionAuthorized: false,
          initialCampaignStatus: 'paused',
          created: true,
          executionStarted: false,
          externalActionPerformed: false,
        };
        persistedCampaign = {
          campaignId: record.campaignId,
          paperId: record.intake.paperId,
          status: 'paused',
          currentPhase: 'admitted-not-authorized',
          spec: { ...planPayload, campaignPlanHash: planHash },
        };
        emittedReceipt = {
          ...payload,
          campaign: persistedCampaign,
          autonomousResearchCampaignEnqueueReceiptHash:
            hashRecord('AutonomousResearchCampaignEnqueueReceipt', payload),
        };
        return emittedReceipt;
      },
    },
    clock: { now: () => new Date(now) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: lease.ownerId,
  });
  const cycle = await supervisor.runCycle();
  assert.equal(listedAt.toISOString(), now.toISOString());
  assert.equal(cycle.machineIntake.processedCount, 1);
  assert.equal(cycle.machineIntake.results[0].status, 'machine_intake_enqueued');
  assert.equal(marked.campaignPlanHash, persistedCampaign.spec.campaignPlanHash);
  assert.equal(released, false);

  const { campaign: _campaign, autonomousResearchCampaignEnqueueReceiptHash: _hash,
    ...attackerPayload } = { ...emittedReceipt, attackerControlled: true };
  const attackerReceipt = {
    ...attackerPayload,
    campaign: persistedCampaign,
    autonomousResearchCampaignEnqueueReceiptHash:
      hashRecord('AutonomousResearchCampaignEnqueueReceipt', attackerPayload),
  };
  assert.throws(() => verifyAutonomousResearchMachineIntakeEnqueueCommit({
    receipt: attackerReceipt,
    record,
    admission: emittedAdmission,
    campaignStore: { getCampaign: () => persistedCampaign },
  }), /enqueue_receipt_invalid/);
  assert.throws(() => verifyAutonomousResearchMachineIntakeEnqueueCommit({
    receipt: emittedReceipt,
    record,
    admission: emittedAdmission,
    campaignStore: { getCampaign: () => null },
  }), /campaign_commit_invalid/);
  const mismatchedCampaign = structuredClone(persistedCampaign);
  mismatchedCampaign.spec.autonomousResearchMachineIntakeHash = H('attacker-intake');
  assert.throws(() => verifyAutonomousResearchMachineIntakeEnqueueCommit({
    receipt: emittedReceipt,
    record,
    admission: emittedAdmission,
    campaignStore: { getCampaign: () => mismatchedCampaign },
  }), /campaign_commit_invalid/);
});

test('runtime reproducibility deferral prevents every qualification and campaign dispatch side effect', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-runtime-gate-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const value = campaign(
    'autonomous-research:runtime-gated-paper',
    'paused',
    'supervisor_transient_failure',
  );
  const now = new Date('2026-07-16T03:30:00.000Z');
  let qualificationReads = 0;
  let dispatches = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: false,
        reason: 'runtime_reproducibility_refresh_leased',
        deferUntil: new Date(now.getTime() + 1000).toISOString(),
      };
    },
    async readQualificationState() { qualificationReads += 1; return null; },
    async runProviderCanary() { throw new Error('provider_canary_must_not_run'); },
    async renewQualification() { throw new Error('qualification_renewal_must_not_run'); },
    async dispatchCampaign() { dispatches += 1; return null; },
    lifecyclePolicy: {},
    clock: { now: () => new Date(now) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:runtime-gate',
  });
  const cycle = await supervisor.runCycle();
  assert.equal(cycle.results[0].reason, 'runtime_reproducibility_refresh_leased');
  assert.equal(qualificationReads, 0);
  assert.equal(dispatches, 0);
  assert.equal(repository.getCampaign(value.campaignId).disposition, 'active');
});

test('resident supervisor recovers uncertain submission on the next cycle before settling', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-submission-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const value = campaign('autonomous-research:submission-resident', 'completed');
  value.spec.autonomousResearchPreparation.venueProfileSelection = {
    profile: { externalSubmissionEnabled: true },
  };
  let now = new Date('2026-07-16T03:40:00.000Z');
  const runtimeReceiptHash = H('submission-resident-runtime');
  let recoveryCalls = 0;
  let runtimeChecks = 0;
  let dispatches = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async recoverAutonomousSubmission() {
      recoveryCalls += 1;
      return recoveryCalls === 1 ? {
        required: true,
        stateCount: 1,
        ready: false,
        terminal: false,
        explicitFailure: false,
        lookupRequired: true,
        externalActionPerformed: true,
        status: 'autonomous_research_submission_recovery_pending',
        delivery: {
          status: 'autonomous_submission_delivery_uncertain',
          terminal: false,
          lookupRequired: true,
        },
      } : {
        required: true,
        stateCount: 1,
        ready: true,
        terminal: true,
        explicitFailure: false,
        lookupRequired: false,
        externalActionPerformed: true,
        status: 'autonomous_research_submission_recovery_completed',
        delivery: {
          status: 'autonomous_submission_delivery_completed',
          terminal: true,
          lookupRequired: false,
        },
      };
    },
    async ensureRuntimeReproducibility() {
      runtimeChecks += 1;
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: '2099-01-01T00:00:00.000Z',
        renewAt: '2098-12-31T00:00:00.000Z',
      };
    },
    async readQualificationState() {
      return {
        recovery: {
          status: 'qualification_verified',
          totalAttemptCount: 1,
          reservedCostUsd: 0.05,
        },
        receipt: {
          expiresAt: '2099-01-01T00:00:00.000Z',
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      };
    },
    async runProviderCanary() { throw new Error('provider_canary_must_not_run'); },
    async renewQualification() { throw new Error('qualification_renewal_must_not_run'); },
    async dispatchCampaign() { dispatches += 1; return null; },
    lifecyclePolicy: {},
    clock: { now: () => new Date(now) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:submission-resident',
    pollMs: 1000,
  });
  const pending = await supervisor.runCycle();
  assert.equal(pending.results[0].status, 'active');
  assert.equal(pending.results[0].reason, 'autonomous_submission_recovery_scheduled');
  assert.equal(runtimeChecks, 0);
  now = new Date(now.getTime() + 2000);
  const completed = await supervisor.runCycle();
  assert.equal(completed.results[0].status, 'settled');
  assert.equal(completed.results[0].reason, 'qualified_beyond_lifecycle');
  assert.equal(recoveryCalls, 2);
  assert.equal(runtimeChecks, 1);
  assert.equal(dispatches, 0);
});

test('a fresh recurring Golden campaign executes before its first releasable qualification exists', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-golden-first-run-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const base = buildExecutionAdmittedSupervisorCampaign({
    launchMode: 'golden-bootstrap',
    suffix: 'golden-first-run',
  });
  let value = base;
  const now = new Date('2026-07-16T03:45:00.000Z');
  const runtimeReceiptHash = H('golden-first-run-runtime');
  let qualificationState = null;
  const events = [];
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: '2026-07-17T03:45:00.000Z',
        renewAt: '2026-07-17T03:30:00.000Z',
      };
    },
    async readQualificationState() { return qualificationState; },
    async runProviderCanary() {
      events.push('provider-canary');
      return {
        verified: true,
        providerCanaryPairReceiptHash: H('golden-first-run-canary'),
      };
    },
    async renewQualification({ campaign: renewingCampaign }) {
      events.push('pre-release-renewal');
      assert.equal(
        renewingCampaign.spec.autonomousResearchPreparation.launchMode,
        'golden-bootstrap',
      );
      assert.equal(qualificationState, null);
      return {
        ready: true,
        preReleaseExecutionAuthorized: true,
        reason: 'golden_bootstrap_must_produce_fresh_promotable_release',
      };
    },
    async dispatchCampaign({ action }) {
      events.push('golden-execution');
      assert.equal(action, 'resume');
      value = { ...value, status: 'completed', effectiveStatus: 'completed' };
      qualificationState = {
        recovery: {
          status: 'qualification_verified',
          totalAttemptCount: 1,
          reservedCostUsd: 0.05,
        },
        receipt: {
          expiresAt: '2026-07-17T03:45:00.000Z',
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      };
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        externalQualification: { status: 'qualification_external_service_verified' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H('golden-first-run-report'),
      };
    },
    lifecyclePolicy: {
      maximumLifetimeMs: 2 * 60 * 60 * 1000,
      providerCanaryReservationCostUsd: 1,
      maximumProviderCanaries: 8,
    },
    clock: { now: () => new Date(now) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:golden-first-run',
    pollMs: 1000,
  });
  const receipt = await supervisor.runCycle();
  assert.deepEqual(events, [
    'provider-canary',
    'pre-release-renewal',
    'golden-execution',
  ]);
  assert.equal(receipt.results[0].status, 'settled');
  assert.equal(receipt.results[0].outcome.campaignFullyQualified, true);
});
