import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchSupervisorStateRepository,
  normalizeAutonomousResearchSupervisorLifecyclePolicy,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  compactAutonomousResearchSupervisorOutcome,
} from '../../paper-application/automation/autonomous-research-supervisor-progress.mjs';
import {
  createFencedAutonomousResearchProviderCanary,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import {
  runAutonomousResearchProviderCanaryPair,
} from '../../paper-composition/automation/autonomous-research-provider-canary.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  createAutomationReadinessSideEffectLedger,
} from '../../paper-composition/automation/automation-readiness-runtime-probes.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
  verifyAutonomousResearchSupervisorExternalActionAttemptReceipt,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';

const H = (label) => hashRecord('SupervisorExternalActionJournalTestHash', { label });
const T0 = new Date('2026-07-17T05:00:00.000Z');
const PROVIDER_ENVIRONMENT = Object.freeze({
  HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
  HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
  HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
  HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
  HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
  HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
});

function createReservedCampaign(t, suffix, {
  providerCanaryReservationCostUsd = 2,
  policyOverrides = {},
} = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-external-action-${suffix}-`));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const campaignId = `autonomous-research:${suffix}`;
  repository.registerCampaign({
    campaignId,
    paperId: suffix,
    policy: {
      maximumProviderCanaries: 4,
      providerCanaryReservationCostUsd,
      qualificationMaximumTotalCostUsd: 10,
      maximumLifecycleCostUsd: 50,
      ...policyOverrides,
    },
    now: T0,
  });
  const lease = repository.tryAcquireCampaignLease({
    campaignId,
    ownerId: `supervisor:${suffix}`,
    now: T0,
  });
  assert.ok(lease);
  assert.deepEqual(repository.beginDispatch({
    lease,
    campaignCostLimitUsd: 1,
    now: T0,
  }), { authorized: true, dispatchCount: 1 });
  return { runtimeRoot, repository, campaignId, lease };
}

function readinessReservation({ campaignId, dispatchCount, launchMode }) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorReadinessActionReservation',
    campaignId,
    action: 'launch',
    launchMode,
    dispatchCount,
    dispatchAuthorizationHash: H(`${campaignId}:dispatch-authorization`),
    providerConfigurationHash: H(`${campaignId}:provider-configuration`),
  });
}

test('journal repository rejects invalid construction, clocks, and use after close', (t) => {
  assert.throws(
    () => createAutonomousResearchSupervisorStateRepository(),
    /runtime_root_required/,
  );
  const normalized = normalizeAutonomousResearchSupervisorLifecyclePolicy({
    maximumDispatches: 'not-an-integer',
    maximumLifecycleCostUsd: 'not-a-number',
  });
  assert.equal(normalized.maximumDispatches, 256);
  assert.equal(normalized.maximumLifecycleCostUsd, 150);
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-action-guards-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  assert.throws(() => repository.registerCampaign({
    campaignId: 'autonomous-research:invalid-clock',
    paperId: 'invalid-clock',
    now: new Date('invalid'),
  }), /clock_invalid/);
  repository.close();
  assert.throws(() => repository.getCampaign('autonomous-research:invalid-clock'), /closed/);
});

async function runProviderFailureScenario(t, { betweenRoleFenceFails }) {
  const suffix = betweenRoleFenceFails ? 'between-role-fence' : 'reviewer-failure';
  const fixture = createReservedCampaign(t, suffix);
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    environment: PROVIDER_ENVIRONMENT,
  });
  const providerConfigurationHash =
    providerConfiguration.autonomousResearchProviderConfigurationHash;
  const authorization = fixture.repository.beginProviderCanary({
    lease: fixture.lease,
    providerConfigurationHash,
    now: T0,
  });
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.required, true);
  let assertionCount = 0;
  const fencedRepository = betweenRoleFenceFails ? Object.freeze({
    ...fixture.repository,
    assertCampaignLease(input) {
      assertionCount += 1;
      if (assertionCount === 2) throw new Error('test_between_role_fence_lost');
      return fixture.repository.assertCampaignLease(input);
    },
  }) : fixture.repository;
  let probeCount = 0;
  const runProviderCanary = createFencedAutonomousResearchProviderCanary({
    stateRepository: fencedRepository,
    providerConfiguration,
    environment: PROVIDER_ENVIRONMENT,
    clock: { now: () => new Date(T0) },
    providerCanaryRunner(options) {
      return runAutonomousResearchProviderCanaryPair({
        ...options,
        preflightAuthor: () => ({
          codexHome: '/tmp/test-author-home',
          capabilityReceipt: { codexResearchAuthorCapabilityReceiptHash: H('author-capability') },
        }),
        preflightReviewer: () => ({
          capabilityReceipt: { codexFormalReviewerCapabilityReceiptHash: H('reviewer-capability') },
        }),
        probeModelAvailability() {
          probeCount += 1;
          if (probeCount === 1) {
            return Object.freeze({
              codexModelAvailabilityCanaryReceiptHash: H(`${suffix}:author-canary`),
            });
          }
          throw new Error('test_formal_reviewer_canary_failed');
        },
      });
    },
  });
  let failureInspection = null;
  await assert.rejects(
    () => runProviderCanary({
      campaign: {
        spec: { autonomousResearchPreparation: {
          autonomousResearchProviderConfigurationHash: providerConfigurationHash,
        } },
      },
      supervisorLease: fixture.lease,
      providerCanaryReservation: authorization.providerCanaryReservation,
      externalActionAttempt: authorization.externalActionAttempt,
    }),
    (error) => {
      failureInspection = error.autonomousResearchProviderCanarySideEffectInspection;
      assert.ok(failureInspection);
      return true;
    },
  );
  fixture.repository.finishProviderCanary({
    lease: fixture.lease,
    attempt: authorization.externalActionAttempt,
    verified: false,
    sideEffectInspection: failureInspection,
    error: failureInspection.failureCode,
    now: new Date(T0.getTime() + 1000),
  });
  return { ...fixture, authorization, failureInspection };
}

async function raceExternalActionAgainstLeaseClear(t, clearAction) {
  const suffix = `atomic-${clearAction}`;
  const fixture = createReservedCampaign(t, suffix);
  t.after(() => fixture.repository.close());
  const repositoryUrl = pathToFileURL(path.resolve(
    'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs',
  )).href;
  const reservation = readinessReservation({
    campaignId: fixture.campaignId,
    dispatchCount: 1,
    launchMode: 'production-run',
  });
  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createAutonomousResearchSupervisorStateRepository } = await import(workerData.repositoryUrl);
      const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot: workerData.runtimeRoot });
      parentPort.postMessage({ ready: true, operation: workerData.operation });
      const gate = new Int32Array(workerData.gateBuffer);
      Atomics.wait(gate, 0, 0);
      let result;
      try {
        const now = new Date(workerData.now);
        let value;
        if (workerData.operation === 'begin') {
          value = repository.beginExternalActionAttempt({
            lease: workerData.lease,
            actionKind: 'production-readiness',
            reservation: workerData.reservation,
            now,
          });
        } else if (workerData.operation === 'release') {
          value = repository.releaseCampaignLease({ lease: workerData.lease, now });
        } else {
          value = repository.finishDispatch({
            lease: workerData.lease,
            outcome: { status: 'atomic_finish' },
            successful: true,
            nextDispatchAt: now,
            now,
          });
        }
        result = { ok: value !== false, operation: workerData.operation };
      } catch (error) {
        result = { ok: false, operation: workerData.operation, error: String(error.message || error) };
      } finally {
        repository.close();
      }
      parentPort.postMessage({ result });
    })().catch((error) => parentPort.postMessage({
      result: { ok: false, operation: workerData.operation, error: String(error.message || error) },
    }));
  `;
  const startWorker = (operation) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        repositoryUrl,
        runtimeRoot: fixture.runtimeRoot,
        operation,
        lease: fixture.lease,
        reservation,
        now: new Date(T0.getTime() + 1000).toISOString(),
        gateBuffer,
      },
    });
    let readyResolve;
    let resultResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const result = new Promise((resolve, reject) => {
      resultResolve = resolve;
      worker.once('error', reject);
    });
    worker.on('message', (message) => {
      if (message.ready) readyResolve();
      if (message.result) resultResolve(message.result);
    });
    return { worker, ready, result };
  };
  const workers = [startWorker('begin'), startWorker(clearAction)];
  await Promise.all(workers.map((item) => item.ready));
  const gate = new Int32Array(gateBuffer);
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0, workers.length);
  const results = await Promise.all(workers.map((item) => item.result));
  await Promise.all(workers.map((item) => item.worker.terminate()));
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  const attempts = fixture.repository.listExternalActionAttempts({
    campaignId: fixture.campaignId,
  });
  const state = fixture.repository.getCampaign(fixture.campaignId);
  if (attempts.length === 1) {
    assert.equal(attempts[0].status, 'in_progress');
    assert.equal(state.externalActionInProgress, true);
    assert.equal(state.leaseOwner, fixture.lease.ownerId);
  } else {
    assert.equal(attempts.length, 0);
    assert.equal(state.externalActionInProgress, false);
    assert.equal(state.leaseOwner, null);
  }
}

test('provider journal persists author success before reviewer failure and never refunds reservation', async (t) => {
  const fixture = await runProviderFailureScenario(t, { betweenRoleFenceFails: false });
  t.after(() => fixture.repository.close());
  const attempt = fixture.repository.getExternalActionAttempt(
    fixture.authorization.externalActionAttempt.attemptId,
  );
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.progress.sequence, 1);
  assert.equal(attempt.progress.evidence.role, 'research_author');
  assert.equal(attempt.receipt.actionAccountingComplete, true);
  assert.equal(attempt.receipt.externalActionPerformed, true);
  assert.equal(attempt.receipt.evidence.providerCanaryActionCount, 2);
  assert.equal(attempt.receipt.evidence.researchAuthorCanaryAttemptCount, 1);
  assert.equal(attempt.receipt.evidence.formalReviewerCanaryAttemptCount, 1);
  assert.equal(attempt.receipt.evidence.successfulProviderCanaryActionCount, 1);
  assert.equal(attempt.receipt.evidence.failedProviderCanaryActionCount, 1);
  const state = fixture.repository.getCampaign(fixture.campaignId);
  assert.equal(state.providerCanaryCount, 1);
  assert.equal(state.providerCanaryReservedCostUsd, 2);
  assert.equal(state.lastProviderCanaryStatus, 'failed');
});

test('between-role fence failure preserves the author action without inventing reviewer work', async (t) => {
  const fixture = await runProviderFailureScenario(t, { betweenRoleFenceFails: true });
  t.after(() => fixture.repository.close());
  const attempt = fixture.repository.getExternalActionAttempt(
    fixture.authorization.externalActionAttempt.attemptId,
  );
  assert.equal(fixture.failureInspection.failurePhase, 'between_role_fence');
  assert.equal(fixture.failureInspection.providerCanaryActionCount, 1);
  assert.equal(fixture.failureInspection.researchAuthorCanaryAttemptCount, 1);
  assert.equal(fixture.failureInspection.formalReviewerCanaryAttemptCount, 0);
  assert.equal(attempt.progress, null,
    'the durable author checkpoint is written only after the between-role fence passes');
  assert.equal(attempt.receipt.externalActionPerformed, true);
  assert.equal(fixture.repository.getCampaign(fixture.campaignId).providerCanaryReservedCostUsd, 2);
});

test('marker creation is atomic against dispatch finish and graceful lease release', async (t) => {
  await raceExternalActionAgainstLeaseClear(t, 'finish');
  await raceExternalActionAgainstLeaseClear(t, 'release');
});

test('an uninterrupted resident next cycle recovers an expired active marker before reacquiring', (t) => {
  const fixture = createReservedCampaign(t, 'same-process-reacquire');
  t.after(() => fixture.repository.close());
  const authorization = fixture.repository.beginProviderCanary({
    lease: fixture.lease,
    providerConfigurationHash: H('same-process-provider'),
    now: T0,
  });
  const replacement = fixture.repository.tryAcquireCampaignLease({
    campaignId: fixture.campaignId,
    ownerId: 'supervisor:same-process-next-cycle',
    now: new Date(T0.getTime() + 16 * 60 * 1000),
  });
  assert.ok(replacement);
  assert.equal(replacement.leaseGeneration, fixture.lease.leaseGeneration + 1);
  const interrupted = fixture.repository.getExternalActionAttempt(
    authorization.externalActionAttempt.attemptId,
  );
  assert.equal(interrupted.status, 'recovered_incomplete');
  assert.equal(interrupted.receipt.actionAccountingComplete, false);
  assert.equal(interrupted.receipt.externalActionMayHaveOccurred, true);
  const state = fixture.repository.getCampaign(fixture.campaignId);
  assert.equal(state.externalActionInProgress, false);
  assert.equal(state.lastProviderCanaryStatus, 'failed_unattributed');
  assert.equal(state.providerCanaryCount, 1);
  assert.equal(state.providerCanaryReservedCostUsd, 2);
  assert.equal(state.recoveredLeaseCount, 1);
  assert.equal(state.leaseOwner, replacement.ownerId);
  assert.throws(() => fixture.repository.beginExternalActionAttempt({
    lease: replacement,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY,
    reservation: authorization.externalActionAttempt.marker.reservation,
    now: new Date(T0.getTime() + 16 * 60 * 1000 + 1),
  }), /UNIQUE|constraint/i);
});

test('SIGKILL-equivalent cold recovery conservatively closes an unfinished reservation and forbids replay', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-action-sigkill-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repositoryUrl = pathToFileURL(path.resolve(
    'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs',
  )).href;
  const campaignId = 'autonomous-research:sigkill';
  const childSource = `
    import { createAutonomousResearchSupervisorStateRepository } from ${JSON.stringify(repositoryUrl)};
    const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot: ${JSON.stringify(runtimeRoot)} });
    const now = new Date(${JSON.stringify(T0.toISOString())});
    repository.registerCampaign({ campaignId: ${JSON.stringify(campaignId)}, paperId: 'sigkill', policy: {
      maximumProviderCanaries: 4, providerCanaryReservationCostUsd: 2,
      qualificationMaximumTotalCostUsd: 10, maximumLifecycleCostUsd: 50,
    }, now });
    const lease = repository.tryAcquireCampaignLease({ campaignId: ${JSON.stringify(campaignId)}, ownerId: 'supervisor:sigkill', now });
    repository.beginDispatch({ lease, campaignCostLimitUsd: 1, now });
    repository.beginProviderCanary({ lease, providerConfigurationHash: ${JSON.stringify(H('sigkill-provider'))}, now });
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8',
  });
  assert.equal(child.signal, 'SIGKILL');

  let repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  let state = repository.getCampaign(campaignId);
  assert.equal(state.externalActionInProgress, true);
  assert.equal(state.providerCanaryCount, 1);
  assert.equal(state.providerCanaryReservedCostUsd, 2);
  const interruptedAttempt = state.activeExternalActionAttempt;
  const interruptedLease = Object.freeze({
    campaignId,
    ownerId: state.leaseOwner,
    leaseToken: state.leaseToken,
    leaseGeneration: state.leaseGeneration,
  });
  assert.equal(repository.reconcileStaleLeases({
    now: new Date(T0.getTime() + 60_000),
  }).recoveredExternalActionCount, 0);
  assert.throws(() => repository.releaseCampaignLease({
    lease: interruptedLease,
    now: new Date(T0.getTime() + 60_000),
  }), /external_action_in_progress/);

  const recovery = repository.reconcileStaleLeases({
    now: new Date(T0.getTime() + 16 * 60 * 1000),
  });
  assert.equal(recovery.recoveredExternalActionCount, 1);
  const recovered = recovery.recoveredExternalActionReceipts[0];
  assert.equal(recovered.status, 'recovered_incomplete');
  assert.equal(recovered.actionAccountingComplete, false);
  assert.equal(recovered.externalActionPerformed, false);
  assert.equal(recovered.externalActionMayHaveOccurred, true);
  assert.equal(verifyAutonomousResearchSupervisorExternalActionAttemptReceipt(recovered), true);
  state = repository.getCampaign(campaignId);
  assert.equal(state.externalActionInProgress, false);
  assert.equal(state.providerCanaryCount, 1);
  assert.equal(state.providerCanaryReservedCostUsd, 2);

  const replacementLease = repository.tryAcquireCampaignLease({
    campaignId,
    ownerId: 'supervisor:replacement',
    now: new Date(T0.getTime() + 16 * 60 * 1000 + 1),
  });
  assert.ok(replacementLease);
  assert.throws(() => repository.beginExternalActionAttempt({
    lease: replacementLease,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY,
    reservation: interruptedAttempt.marker.reservation,
    now: new Date(T0.getTime() + 16 * 60 * 1000 + 2),
  }), /UNIQUE|constraint/i);
  const next = repository.beginProviderCanary({
    lease: replacementLease,
    providerConfigurationHash: H('sigkill-provider'),
    now: new Date(T0.getTime() + 16 * 60 * 1000 + 3),
  });
  assert.equal(next.authorized, true);
  assert.equal(next.providerCanaryReservation.generationSequence, 2);
  state = repository.getCampaign(campaignId);
  assert.equal(state.providerCanaryCount, 2);
  assert.equal(state.providerCanaryReservedCostUsd, 4);

  const tamperedAttemptId = next.externalActionAttempt.attemptId;
  const databasePath = repository.databasePath;
  repository.close();
  const database = new DatabaseSync(databasePath);
  const raw = database.prepare(`SELECT marker_json FROM
    autonomous_research_supervisor_external_action_journal WHERE attempt_id=?`).get(
    tamperedAttemptId,
  );
  const marker = JSON.parse(raw.marker_json);
  marker.reservation.providerConfigurationHash = H('tampered-provider');
  database.prepare(`UPDATE autonomous_research_supervisor_external_action_journal
    SET marker_json=? WHERE attempt_id=?`).run(JSON.stringify(marker), tamperedAttemptId);
  database.close();
  repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  assert.throws(
    () => repository.getExternalActionAttempt(tamperedAttemptId),
    /external_action_journal_invalid/,
  );
});

test('unknown failed readiness accounting is rejected, then fallback persists a conservative terminal receipt', (t) => {
  const fixture = createReservedCampaign(t, 'readiness-fallback');
  t.after(() => fixture.repository.close());
  const state = fixture.repository.getCampaign(fixture.campaignId);
  const attempt = fixture.repository.beginExternalActionAttempt({
    lease: fixture.lease,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS,
    reservation: readinessReservation({
      campaignId: fixture.campaignId,
      dispatchCount: state.dispatchCount,
      launchMode: 'production-run',
    }),
    now: T0,
  });
  assert.throws(() => fixture.repository.finishExternalActionAttempt({
    lease: fixture.lease,
    attempt,
    successful: false,
    evidence: null,
    now: new Date(T0.getTime() + 1000),
  }), /readiness_receipt_invalid/);
  assert.throws(() => fixture.repository.finishDispatch({
    lease: fixture.lease,
    outcome: { status: 'must_not_clear_active_marker' },
    now: new Date(T0.getTime() + 1000),
  }), /external_action_in_progress/);
  const final = fixture.repository.finishDispatchFailureFallback({
    lease: fixture.lease,
    outcome: { status: 'supervisor_dispatch_failed' },
    error: 'qualification_state_read_failed',
    now: new Date(T0.getTime() + 2000),
  });
  assert.equal(final.disposition, 'blocked');
  assert.equal(final.costKnown, false);
  assert.equal(final.terminalReason, 'supervisor_lifecycle_cost_unknown');
  assert.equal(final.lastOutcome.status, 'supervisor_dispatch_failed');
  const recovered = fixture.repository.getExternalActionAttempt(attempt.attemptId).receipt;
  assert.equal(recovered.status, 'recovered_incomplete');
  assert.equal(recovered.actionAccountingComplete, false);
  assert.equal(recovered.externalActionMayHaveOccurred, true);
});

test('dispatch finalization persists every lifecycle terminal policy before clearing its lease', (t) => {
  const scenarios = [
    {
      suffix: 'explicit-terminal',
      finish: { successful: true, terminalReason: 'test_explicit_terminal_reason' },
      expected: 'test_explicit_terminal_reason',
    },
    {
      suffix: 'unknown-cost',
      finish: { costKnown: false },
      expected: 'supervisor_lifecycle_cost_unknown',
    },
    {
      suffix: 'cost-budget',
      finish: {
        observedCampaignCostUsd: 41,
        observedQualificationReservedCostUsd: 10,
      },
      expected: 'supervisor_lifecycle_cost_budget_exhausted',
    },
    {
      suffix: 'failure-budget',
      policyOverrides: { maximumConsecutiveFailures: 1 },
      finish: { successful: false },
      expected: 'supervisor_consecutive_failure_budget_exhausted',
    },
    {
      suffix: 'dispatch-deadline',
      policyOverrides: { maximumLifetimeMs: 60_000 },
      finish: { nextDispatchAt: new Date(T0.getTime() + 60_001) },
      expected: 'supervisor_lifecycle_deadline_exhausted',
    },
  ];
  for (const scenario of scenarios) {
    const fixture = createReservedCampaign(t, scenario.suffix, {
      policyOverrides: scenario.policyOverrides,
    });
    t.after(() => fixture.repository.close());
    const finalized = fixture.repository.finishDispatch({
      lease: fixture.lease,
      outcome: { status: `test_${scenario.suffix}` },
      now: new Date(T0.getTime() + 1000),
      ...scenario.finish,
    });
    assert.equal(finalized.disposition, 'blocked', scenario.suffix);
    assert.equal(finalized.terminalReason, scenario.expected, scenario.suffix);
    assert.equal(finalized.leaseOwner, null, scenario.suffix);
  }
});

test('successful Golden KMS ledger is hash-verified in the durable supervisor outcome', (t) => {
  const fixture = createReservedCampaign(t, 'golden-outcome');
  t.after(() => fixture.repository.close());
  const state = fixture.repository.getCampaign(fixture.campaignId);
  const attempt = fixture.repository.beginExternalActionAttempt({
    lease: fixture.lease,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.GOLDEN_RELEASE_ATTESTOR,
    reservation: readinessReservation({
      campaignId: fixture.campaignId,
      dispatchCount: state.dispatchCount,
      launchMode: 'golden-bootstrap',
    }),
    now: T0,
  });
  const ledger = createAutomationReadinessSideEffectLedger({
    environment: {},
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  ledger.spawnSyncFor('release-attestor')('kms-test-backend', ['health']);
  const inspection = ledger.inspection({
    releaseAttestorInspection: {
      backendProbeExternalActionAttempted: true,
      activeSignerChallengeExternalActionAttempted: true,
      researchExecutionReleaseAttestorConfigurationInspectionHash: H('golden-attestor'),
    },
  });
  const completed = fixture.repository.finishExternalActionAttempt({
    lease: fixture.lease,
    attempt,
    successful: true,
    evidence: inspection,
    actionAccountingComplete: true,
    externalActionPerformed: true,
    now: new Date(T0.getTime() + 1000),
  });
  assert.equal(completed.receipt.actionKind, 'golden-release-attestor');
  assert.equal(completed.receipt.marker.dispatchCount, 1);
  assert.equal(completed.receipt.marker.reservationHash, attempt.reservationHash);
  assert.equal(verifyAutonomousResearchSupervisorExternalActionAttemptReceipt(
    completed.receipt,
  ), true);
  const compact = compactAutonomousResearchSupervisorOutcome({
    status: 'autonomous_research_campaign_completed_and_qualified',
    campaign: { status: 'completed' },
    campaignFullyQualified: true,
    fullAutomaticResearchWritingReady: true,
    autonomousResearchCampaignExecutionReportHash: H('golden-report'),
    supervisorExternalActionReceipts: [completed.receipt],
  });
  fixture.repository.finishDispatch({
    lease: fixture.lease,
    outcome: compact,
    successful: true,
    settled: true,
    observedCampaignCostUsd: 1,
    observedQualificationReservedCostUsd: 0,
    now: new Date(T0.getTime() + 2000),
  });
  const persisted = fixture.repository.getCampaign(fixture.campaignId).lastOutcome;
  assert.equal(persisted.externalActionReceipts.length, 1);
  assert.equal(verifyAutonomousResearchSupervisorExternalActionAttemptReceipt(
    persisted.externalActionReceipts[0],
  ), true);
  assert.equal(
    persisted.externalActionReceipts[0]
      .autonomousResearchSupervisorExternalActionAttemptReceiptHash,
    completed.receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash,
  );

  const tampered = JSON.parse(JSON.stringify(completed.receipt));
  tampered.evidence.processActionCount = 0;
  assert.throws(() => compactAutonomousResearchSupervisorOutcome({
    supervisorExternalActionReceipts: [tampered],
  }), /external_action_receipts_invalid/);
});
