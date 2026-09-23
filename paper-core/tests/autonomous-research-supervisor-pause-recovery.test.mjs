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
  autonomousResearchSupervisorDispatchDecision,
} from '../../paper-application/automation/autonomous-research-supervisor-readiness-policy.mjs';
import {
  buildExecutionAdmittedSupervisorCampaign,
} from './autonomous-research-supervisor-enqueue-test-support.mjs';

const H = (label) => hashRecord('AutonomousSupervisorTestHash', { label });

function pausedCampaign(campaignId, stopReason = null) {
  const paperId = campaignId.split(':').at(-1);
  return Object.freeze({
    campaignId,
    paperId,
    status: 'paused',
    stopReason,
    costKnown: true,
    costUsd: 0,
    spec: Object.freeze({
      budgets: Object.freeze({ maxCostUsd: 10 }),
      autonomousResearchPreparation: Object.freeze({
        proposal: Object.freeze({ paperId }),
      }),
    }),
  });
}

function lifecycle(now) {
  return Object.freeze({
    absoluteDeadlineAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    policy: Object.freeze({
      qualificationRenewalLeadMs: 15 * 60 * 1000,
      qualificationActionSafetyMarginMs: 15 * 60 * 1000,
      qualificationMaximumTotalAttempts: 48,
      qualificationMaximumTotalCostUsd: 25,
      qualificationAttemptReservationCostUsd: 0.05,
    }),
  });
}

test('supervisor resumes only execution-admitted or explicitly recoverable paused campaigns', () => {
  const now = new Date('2026-07-16T04:44:00.000Z');
  const runtimeReceiptHash = H('paused-recovery-runtime');
  const decide = (campaign) => autonomousResearchSupervisorDispatchDecision({
    campaign,
    lifecycle: lifecycle(now),
    qualificationState: null,
    runtimeReadiness: Object.freeze({
      ready: true,
      receiptHash: runtimeReceiptHash,
      renewAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    }),
    now,
  });
  const admitted = buildExecutionAdmittedSupervisorCampaign({
    launchMode: 'production-run',
    suffix: 'paused-recovery-policy',
  });
  assert.equal(decide(admitted).action, 'resume');

  assert.deepEqual(decide({ ...admitted, currentPhase: 'paused' }), {
    block: true,
    reason: 'supervisor_nonrecoverable_paused_campaign:unknown',
  });
  const invalidAdmission = structuredClone(admitted);
  invalidAdmission.spec.executionAdmission.providerConfigurationHash = H('attacker-provider');
  assert.deepEqual(decide(invalidAdmission), {
    block: true,
    reason: 'supervisor_nonrecoverable_paused_campaign:unknown',
  });
  assert.deepEqual(decide({ ...admitted, stopReason: 'operator_paused' }), {
    block: true,
    reason: 'supervisor_nonrecoverable_paused_campaign:operator_paused',
  });
  assert.deepEqual(decide(pausedCampaign('autonomous-research:unknown-pause')), {
    block: true,
    reason: 'supervisor_nonrecoverable_paused_campaign:unknown',
  });
  assert.equal(decide(pausedCampaign(
    'autonomous-research:supervisor-pause',
    'supervisor_process_shutdown',
  )).action, 'resume');
});

test('resident blocks operator and unknown pauses before readiness or provider actions', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-paused-block-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const campaigns = [
    pausedCampaign('autonomous-research:operator-paused', 'operator_paused'),
    pausedCampaign('autonomous-research:unknown-paused'),
  ];
  const actions = {
    readinessChecks: 0,
    qualificationReads: 0,
    canaries: 0,
    renewals: 0,
    dispatches: 0,
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return campaigns; },
      getCampaign(id) { return campaigns.find((value) => value.campaignId === id); },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      actions.readinessChecks += 1;
      return { ready: true };
    },
    async readQualificationState() { actions.qualificationReads += 1; return null; },
    async runProviderCanary() { actions.canaries += 1; return { verified: true }; },
    async renewQualification() { actions.renewals += 1; return { ready: true }; },
    async dispatchCampaign() { actions.dispatches += 1; return null; },
    clock: { now: () => new Date('2026-07-16T02:55:00.000Z') },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:paused-block',
  });
  const receipt = await supervisor.runCycle();
  assert.deepEqual(receipt.results.map(({ status, reason }) => ({ status, reason })), [
    {
      status: 'blocked',
      reason: 'supervisor_nonrecoverable_paused_campaign:operator_paused',
    },
    {
      status: 'blocked',
      reason: 'supervisor_nonrecoverable_paused_campaign:unknown',
    },
  ]);
  assert.deepEqual(actions, {
    readinessChecks: 0,
    qualificationReads: 0,
    canaries: 0,
    renewals: 0,
    dispatches: 0,
  });
});
