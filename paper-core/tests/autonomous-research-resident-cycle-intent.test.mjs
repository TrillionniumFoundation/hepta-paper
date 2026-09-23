import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAutonomousResearchResidentCycleIntentRepository,
  inspectAutonomousResearchResidentCycleReceipt,
  listPendingAutonomousResearchResidentCycleIntents,
  publishAutonomousResearchResidentCycleIntent,
} from '../../paper-adapters/automation/autonomous-research-resident-cycle-intent-repository.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  inspectAutonomousResearchStrictMachineIntakeReconciliation,
} from '../../paper-adapters/automation/autonomous-research-strict-machine-intake-reconciliation-repository.mjs';
import {
  runAutonomousResearchResident,
} from '../../paper-application/automation/autonomous-research-resident-lifecycle.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('AutonomousResearchResidentCycleIntentTestHash', { label });

function completedCycle(ownerId, observedAt = new Date()) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorCycleReceipt',
    status: 'autonomous_research_supervisor_cycle_completed',
    ownerId,
    observedAt: observedAt.toISOString(),
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorCycleReceiptHash:
      hashRecord('AutonomousResearchSupervisorCycleReceipt', payload),
  });
}

function completedMachineIntakeCycle(ownerId, observedAt = new Date()) {
  const reconciliationPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorMachineIntakeReconciliationReceipt',
    machineIntakeConfigurationHash: H('machine-intake-configuration'),
    topicProducerDatasetSnapshotHash: H('machine-intake-dataset'),
    machineIntakeCycleResultHash: H('machine-intake-cycle'),
    reconciledAt: observedAt.toISOString(),
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  const machineIntakeReconciliationReceipt = Object.freeze({
    ...reconciliationPayload,
    autonomousResearchSupervisorMachineIntakeReconciliationReceiptHash:
      hashRecord(
        'AutonomousResearchSupervisorMachineIntakeReconciliationReceipt',
        reconciliationPayload,
      ),
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorCycleReceipt',
    status: 'autonomous_research_supervisor_cycle_completed',
    ownerId,
    machineIntakeReconciliationReceipt,
    observedAt: observedAt.toISOString(),
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorCycleReceiptHash:
      hashRecord('AutonomousResearchSupervisorCycleReceipt', payload),
  });
}

function scheduler() {
  return Object.freeze({
    async sleep() {},
    setInterval() { return Object.freeze({}); },
    clearInterval() {},
    unref() {},
  });
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  } while (Date.now() < deadline);
  throw new Error('resident_cycle_intent_test_wait_timed_out');
}

function captureChild(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => { stdout += bytes.toString('utf8'); });
  child.stderr.on('data', (bytes) => { stderr += bytes.toString('utf8'); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({
      exitCode, signal, stdout, stderr,
    }));
  });
  return completed;
}

test('strict production runner waits for a plan-bound cycle completed by the fenced resident',
  { timeout: 15_000 }, async (t) => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-cycle-intent-'));
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const instanceRepository =
      createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
    t.after(() => instanceRepository.close());
    const residentCycleIntentRepository =
      createAutonomousResearchResidentCycleIntentRepository({ runtimeRoot });
    const acceptancePlanHash = H('acceptance-plan');
    const acceptanceStepIdempotencyKey = H('production-step');
    const ownerId = 'supervisor:resident-cycle-intent-test';
    const child = spawn(process.execPath, [
      path.resolve('paper-core/bin/autonomous-research-supervisor.mjs'),
      '--request-resident-cycle',
      '--runtime-root', runtimeRoot,
      '--resident-cycle-wait-ms', '10000',
      '--resident-cycle-poll-ms', '10',
    ], {
      cwd: path.resolve('.'),
      env: {
        PATH: process.env.PATH,
        HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH: acceptancePlanHash,
        HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY:
          acceptanceStepIdempotencyKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const childCompleted = captureChild(child);
    await waitUntil(() => (
      listPendingAutonomousResearchResidentCycleIntents({ runtimeRoot }).length === 1
    ));

    const controller = new AbortController();
    const privateCycleAuthority = Object.freeze({});
    const resident = runAutonomousResearchResident({
      residentInstanceRepository: instanceRepository,
      residentCycleIntentRepository,
      residentInstanceLeaseMs: 15 * 60 * 1000,
      residentInstanceHeartbeatMs: 30_000,
      requireFullyAutonomous: true,
      ownerId,
      clock: { now: () => new Date() },
      scheduler: scheduler(),
      executionController: controller,
      cycleAuthority: privateCycleAuthority,
      async runCycle({ cycleAuthority }) {
        assert.equal(cycleAuthority, privateCycleAuthority);
        return completedCycle(ownerId);
      },
      onCycle() { controller.abort('test_complete'); },
      pollMs: 1000,
    });
    const [residentReceipt, childReceipt] = await Promise.all([
      resident,
      childCompleted,
    ]);
    assert.equal(residentReceipt.cycleCount, 1);
    assert.equal(childReceipt.exitCode, 0, childReceipt.stderr);
    const report = JSON.parse(childReceipt.stdout);
    assert.equal(report.status, 'autonomous_research_resident_cycle_completed');
    assert.equal(report.acceptancePlanHash, acceptancePlanHash);
    assert.equal(report.acceptanceStepIdempotencyKey,
      acceptanceStepIdempotencyKey);
    assert.equal(report.residentOwnerId, ownerId);
    assert.equal(report.residentFullyAutonomousRequired, true);
    assert.equal(listPendingAutonomousResearchResidentCycleIntents({
      runtimeRoot,
    }).length, 0);
  });

test('cycle intents are no-clobber idempotent and cannot be completed without a live resident lease',
  (t) => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-cycle-fence-'));
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const instanceRepository =
      createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
    t.after(() => instanceRepository.close());
    const acceptancePlanHash = H('fence-plan');
    const acceptanceStepIdempotencyKey = H('fence-step');
    const first = publishAutonomousResearchResidentCycleIntent({
      runtimeRoot,
      acceptancePlanHash,
      acceptanceStepIdempotencyKey,
      now: new Date(),
    });
    const repeated = publishAutonomousResearchResidentCycleIntent({
      runtimeRoot,
      acceptancePlanHash,
      acceptanceStepIdempotencyKey,
      now: new Date(Date.now() + 1000),
    });
    assert.equal(first.published, true);
    assert.equal(repeated.published, false);
    assert.equal(repeated.intent.autonomousResearchResidentCycleIntentHash,
      first.intent.autonomousResearchResidentCycleIntentHash);
    assert.throws(() => (
      createAutonomousResearchResidentCycleIntentRepository({ runtimeRoot }).complete({
        intent: first.intent,
        cycleReceipt: completedCycle('supervisor:not-running'),
        residentLeaseContext: {
          kind: 'AutonomousResearchResidentLeaseContext',
          ownerId: 'supervisor:not-running',
          leaseGeneration: 1,
          lease: {
            ownerId: 'supervisor:not-running',
            leaseToken: 'instance:not-running',
            leaseGeneration: 1,
            heartbeatMs: 30_000,
            leaseMs: 15 * 60 * 1000,
          },
        },
        now: new Date(),
      })
    ), /instance_lease_fence_conflict/);
    const inspection = inspectAutonomousResearchResidentCycleReceipt({
      runtimeRoot,
      acceptancePlanHash,
      acceptanceStepIdempotencyKey,
      now: new Date(),
    });
    assert.equal(inspection.ready, false);
  });

test('machine-intake acceptance is also published by the resident-owned cycle', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-machine-cycle-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const instanceRepository =
    createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => instanceRepository.close());
  const residentCycleIntentRepository =
    createAutonomousResearchResidentCycleIntentRepository({ runtimeRoot });
  const acceptancePlanHash = H('machine-plan');
  const acceptanceStepIdempotencyKey = H('machine-step');
  publishAutonomousResearchResidentCycleIntent({
    runtimeRoot,
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    purpose: 'machine-intake',
    now: new Date(),
  });
  const controller = new AbortController();
  const ownerId = 'supervisor:resident-machine-cycle-test';
  const result = await runAutonomousResearchResident({
    residentInstanceRepository: instanceRepository,
    residentCycleIntentRepository,
    residentInstanceLeaseMs: 15 * 60 * 1000,
    residentInstanceHeartbeatMs: 30_000,
    requireFullyAutonomous: true,
    ownerId,
    clock: { now: () => new Date() },
    scheduler: scheduler(),
    executionController: controller,
    cycleAuthority: Object.freeze({}),
    async runCycle() { return completedMachineIntakeCycle(ownerId); },
    onCycle() { controller.abort('test_complete'); },
    pollMs: 1000,
  });
  assert.equal(result.cycleCount, 1);
  const inspection = inspectAutonomousResearchStrictMachineIntakeReconciliation({
    runtimeRoot,
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    machineIntake: {
      coldStartAutonomyReady: true,
      configurationHash: H('machine-intake-configuration'),
      topicProducerDatasetSnapshotHash: H('machine-intake-dataset'),
    },
    now: new Date(),
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.receipt.cycleReceiptHash,
    result.lastCycle.autonomousResearchSupervisorCycleReceiptHash);
});
