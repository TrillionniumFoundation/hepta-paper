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
  createAutonomousResearchSupervisor,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  createAutomationReadinessSideEffectLedger,
} from '../../paper-composition/automation/automation-readiness-runtime-probes.mjs';

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
