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
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_PLAN_HASH,
  createOfflineSupervisorStateMutationCoordinator,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-mutation-plan.mjs';
import {
  composeAutonomousResearchSupervisorState,
} from '../../paper-composition/automation/autonomous-research-supervisor-state-composition.mjs';
import {
  executeAutonomousResearchSupervisorProviderCanary,
} from '../../paper-application/automation/autonomous-research-supervisor-provider-canary-dispatch.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import {
  createAutomationReadinessSideEffectLedger,
} from '../../paper-composition/automation/automation-readiness-runtime-probes.mjs';

const H = (label) => hashRecord('SupervisorStateOnlineMutationTest', { label });
const T0 = new Date('2026-07-18T09:00:00.000Z');

function coordinator({
  calls = [],
  status = 'externally_fenced_sqlite_mutation_coordinator_ready',
  blockers = [],
  inspectTypedTransaction = false,
  sideEffectMode = 'finalized',
} = {}) {
  const local = createOfflineSupervisorStateMutationCoordinator();
  const coveredDatabaseRoles = Object.freeze(['supervisor-state']);
  let inspected = false;
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      calls.push(Object.freeze({
        databaseRole: input.databaseRole,
        databaseInstanceId: input.databaseInstanceId,
        schemaContractId: input.schemaContractId,
        writerId: input.writerId,
        operationId: input.operationId,
        authorizationReceiptHashes: Object.freeze([...input.authorizationReceiptHashes]),
        sideEffectReservationHashes: Object.freeze([...input.sideEffectReservationHashes]),
      }));
      const mutate = input.mutate;
      const receipt = local.executeMutation({
        ...input,
        mutate(transaction) {
          if (inspectTypedTransaction && !inspected) {
            inspected = true;
            assert.equal(Object.isFrozen(transaction), true);
            assert.deepEqual(Object.keys(transaction).sort(), ['all', 'get', 'run']);
            assert.equal(transaction.exec, undefined);
            assert.equal(transaction.prepare, undefined);
            assert.throws(
              () => transaction.run('supervisor-state.unregistered.apply.v1'),
              /statement_not_authorized/,
            );
          }
          return mutate(transaction);
        },
      });
      if (input.sideEffectReservationHashes.length === 0) return receipt;
      if (sideEffectMode === 'pending') {
        const error = new Error(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
        );
        error.committed = true;
        error.reservationId = `reservation:${calls.length}`;
        throw error;
      }
      return Object.freeze({
        ...receipt,
        status: 'externally_fenced_sqlite_mutation_finalized',
        reservationId: `reservation:${calls.length}`,
        sideEffectPermitHash: sideEffectMode === 'finalized'
          ? H(`permit:${input.sideEffectReservationHashes.join(',')}`)
          : null,
      });
    },
    recoverPendingMutations() { return Object.freeze({ recovered: 0 }); },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status,
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([...blockers]),
      });
    },
  });
}

function lifecyclePolicy() {
  return Object.freeze({
    maximumDispatches: 16,
    maximumProviderCanaries: 4,
    providerCanaryReservationCostUsd: 1,
    qualificationMaximumTotalCostUsd: 2,
    maximumLifecycleCostUsd: 20,
  });
}

function readinessReservation(campaignId, dispatchCount) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorReadinessActionReservation',
    campaignId,
    action: 'launch',
    launchMode: 'production-run',
    dispatchCount,
    dispatchAuthorizationHash: H(`${campaignId}:dispatch`),
    providerConfigurationHash: H(`${campaignId}:provider`),
    externalActionConfigurationIdentityHash: H(`${campaignId}:external-action`),
  });
}

function registerAndAcquire(repository, suffix, offsetMs = 0) {
  const now = new Date(T0.getTime() + offsetMs);
  const campaignId = `autonomous-research:supervisor-online-${suffix}`;
  repository.registerCampaign({
    campaignId,
    paperId: `paper-${suffix}`,
    policy: lifecyclePolicy(),
    now,
  });
  const lease = repository.tryAcquireCampaignLease({
    campaignId,
    ownerId: `supervisor:${suffix}`,
    now,
  });
  assert.ok(lease);
  return { campaignId, lease, now };
}

test('supervisor state strict mode rejects unactivated fencing before all file I/O', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-state-strict-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configured = coordinator({
    status: 'externally_fenced_sqlite_mutation_coordinator_configured',
    blockers: ['autonomous_research_online_mutation_runtime_activation_required'],
  });
  assert.throws(() => createAutonomousResearchSupervisorStateRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator: configured,
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => createAutonomousResearchSupervisorStateRepository({
    runtimeRoot,
    offlineProvision: true,
    mutationCoordinator: coordinator(),
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchSupervisorState({
    runtimeRoot,
    supervisorStateMutationCoordinator: configured,
    requireExternallyFencedSupervisorState: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchSupervisorState({
    runtimeRoot,
    requireExternallyFencedSupervisorState: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => createAutonomousResearchSupervisorStateRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator: coordinator(),
    requireExternallyFencedMutations: true,
  }), /offline_provisioning_required/);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

for (const sideEffectMode of ['pending', 'no-permit']) {
  test(`supervisor provider canary ${sideEffectMode} receipt performs zero provider calls and recovers without replay`, async (t) => {
    const runtimeRoot = fs.mkdtempSync(path.join(
      os.tmpdir(), `hepta-supervisor-provider-${sideEffectMode}-`,
    ));
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
    provisioner.close();
    const repository = createAutonomousResearchSupervisorStateRepository({
      runtimeRoot,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    const fixture = registerAndAcquire(repository, sideEffectMode);
    repository.beginDispatch({
      lease: fixture.lease,
      campaignCostLimitUsd: 1,
      now: fixture.now,
    });
    const providerConfigurationHash = H(`provider:${sideEffectMode}`);
    let providerCalls = 0;
    let progressCalls = 0;
    await assert.rejects(() => executeAutonomousResearchSupervisorProviderCanary({
      stateRepository: repository,
      lease: fixture.lease,
      campaign: Object.freeze({
        campaignId: fixture.campaignId,
        spec: Object.freeze({
          autonomousResearchPreparation: Object.freeze({
            autonomousResearchProviderConfigurationHash: providerConfigurationHash,
          }),
        }),
      }),
      qualificationState: null,
      runtimeReadiness: null,
      decision: Object.freeze({
        qualificationRenewalRequired: false,
        requiredQualificationValidityMs: 0,
      }),
      runProviderCanary() { providerCalls += 1; },
      publishCampaignProgress() { progressCalls += 1; },
      autonomyFence: Object.freeze({ assertCurrent() { return true; } }),
      machineRecord: null,
      residentLeaseContext: Object.freeze({}),
      signal: null,
      now: () => new Date(fixture.now.getTime() + 1000),
    }), sideEffectMode === 'pending'
      ? /committed_finalization_pending/
      : /provider_canary_side_effect_permit_required/);
    assert.equal(providerCalls, 0);
    assert.equal(progressCalls, 1);
    const active = repository.getCampaign(fixture.campaignId).activeExternalActionAttempt;
    assert.equal(active.status, 'in_progress');
    const recovery = repository.reconcileStaleLeases({
      now: new Date(fixture.now.getTime() + 16 * 60 * 1000),
    });
    assert.equal(recovery.recoveredExternalActionCount, 1);
    assert.equal(repository.getExternalActionAttempt(active.attemptId).status, 'failed');
    assert.equal(providerCalls, 0);
  });
}

test('supervisor finalized provider permit authorizes exactly one provider runner call', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-provider-permit-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  provisioner.close();
  const calls = [];
  const repository = createAutonomousResearchSupervisorStateRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator: coordinator({ calls, sideEffectMode: 'finalized' }),
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());
  const fixture = registerAndAcquire(repository, 'finalized-provider');
  repository.beginDispatch({
    lease: fixture.lease,
    campaignCostLimitUsd: 1,
    now: fixture.now,
  });
  const providerConfigurationHash = H('finalized-provider-configuration');
  let providerCalls = 0;
  const residentLeaseContext = Object.freeze({ stage: 'provider-permit-test' });
  const result = await executeAutonomousResearchSupervisorProviderCanary({
    stateRepository: repository,
    lease: fixture.lease,
    campaign: Object.freeze({
      campaignId: fixture.campaignId,
      spec: Object.freeze({
        autonomousResearchPreparation: Object.freeze({
          autonomousResearchProviderConfigurationHash: providerConfigurationHash,
        }),
      }),
    }),
    qualificationState: null,
    runtimeReadiness: null,
    decision: Object.freeze({
      qualificationRenewalRequired: false,
      requiredQualificationValidityMs: 0,
    }),
    async runProviderCanary() {
      providerCalls += 1;
      return Object.freeze({
        verified: true,
        providerCanaryPairReceiptHash: H('finalized-provider-pair'),
      });
    },
    async publishCampaignProgress() { return residentLeaseContext; },
    autonomyFence: Object.freeze({ assertCurrent() { return true; } }),
    machineRecord: null,
    residentLeaseContext,
    signal: null,
    now: () => fixture.now,
  });
  assert.equal(result.blocked, false);
  assert.equal(providerCalls, 1);
  assert.equal(repository.getCampaign(fixture.campaignId).lastProviderCanaryStatus,
    'verified');
  const beginCall = calls.find((call) => call.operationId
    === 'supervisor-state.supervisor-provider-canary-state-operations.beginProviderCanary.v1');
  const attempt = repository.listExternalActionAttempts({
    campaignId: fixture.campaignId,
  })[0];
  assert.deepEqual(beginCall.sideEffectReservationHashes, [attempt.reservationHash]);
});

test('a plain provider authorization value cannot forge the strict permit verifier', async () => {
  let beginCalls = 0;
  let providerCalls = 0;
  await assert.rejects(() => executeAutonomousResearchSupervisorProviderCanary({
    stateRepository: Object.freeze({
      externallyFencedMutationsRequired: true,
      beginProviderCanary() {
        beginCalls += 1;
        return Object.freeze({
          authorized: true,
          required: true,
          sideEffectPermitHash: H('forged-ordinary-value'),
        });
      },
    }),
    runProviderCanary() { providerCalls += 1; },
    campaign: Object.freeze({ spec: Object.freeze({}) }),
    now: () => T0,
  }), /side_effect_permit_verifier_required/);
  assert.equal(beginCalls, 0);
  assert.equal(providerCalls, 0);
});

test('supervisor state eighteen-operation writer pins DML and preserves journal semantics', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-state-online-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  provisioner.close();
  const calls = [];
  const repository = createAutonomousResearchSupervisorStateRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator: coordinator({ calls, inspectTypedTransaction: true }),
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());
  assert.equal(repository.offlineProvisioningPerformed, false);
  assert.equal(repository.externallyFencedMutations, true);
  assert.equal(Object.keys(AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS).length, 18);
  assert.match(AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_PLAN_HASH, /^sha256:/);

  repository.reconcileStaleLeases({ now: T0 });
  const first = registerAndAcquire(repository, 'fallback', 1000);
  const renewed = repository.renewCampaignLease({
    lease: first.lease,
    now: new Date(first.now.getTime() + 1000),
  });
  assert.ok(renewed);
  const dispatch = repository.beginDispatch({
    lease: renewed,
    campaignCostLimitUsd: 1,
    now: new Date(first.now.getTime() + 2000),
  });
  assert.deepEqual({
    authorized: dispatch.authorized,
    resumed: dispatch.resumed,
    dispatchCount: dispatch.dispatchCount,
  }, {
    authorized: true,
    resumed: false,
    dispatchCount: 1,
  });
  assert.match(dispatch.dispatchReservationHash, /^sha256:[0-9a-f]{64}$/);
  const progressAttempt = repository.beginExternalActionAttempt({
    lease: renewed,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS,
    reservation: readinessReservation(first.campaignId, 1),
    now: new Date(first.now.getTime() + 3000),
  });
  repository.recordExternalActionProgress({
    lease: renewed,
    attempt: progressAttempt,
    evidence: { phase: 'external-action-started' },
    now: new Date(first.now.getTime() + 4000),
  });
  assert.throws(() => repository.cancelExternalActionInfrastructureDeferred({
    lease: renewed,
    attempt: progressAttempt,
    now: new Date(first.now.getTime() + 4500),
  }), /infrastructure_cancel_fence_lost/,
  'a durable may-have-started marker makes the dispatch non-refundable');
  const fallback = repository.finishDispatchFailureFallback({
    lease: renewed,
    outcome: { status: 'failed' },
    error: 'external_action_failed',
    now: new Date(first.now.getTime() + 5000),
  });
  assert.equal(fallback.disposition, 'blocked');

  const second = registerAndAcquire(repository, 'finish-external', 10_000);
  repository.beginDispatch({ lease: second.lease, campaignCostLimitUsd: 1, now: second.now });
  const finishedAttempt = repository.beginExternalActionAttempt({
    lease: second.lease,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS,
    reservation: readinessReservation(second.campaignId, 1),
    now: new Date(second.now.getTime() + 1000),
  });
  repository.finishExternalActionAttempt({
    lease: second.lease,
    attempt: finishedAttempt,
    successful: false,
    evidence: null,
    actionAccountingComplete: false,
    externalActionPerformed: false,
    blocker: 'readiness_failed_before_action',
    now: new Date(second.now.getTime() + 2000),
  });
  assert.throws(() => repository.cancelDispatchInfrastructureDeferred({
    lease: second.lease,
    dispatchCount: 1,
    now: new Date(second.now.getTime() + 2500),
  }), /dispatch_cancel_fence_lost/,
  'completed action history for the dispatch blocks a generic refund');
  assert.equal(repository.releaseCampaignLease({
    lease: second.lease,
    now: new Date(second.now.getTime() + 3000),
  }), true);

  const third = registerAndAcquire(repository, 'canary', 20_000);
  repository.beginDispatch({ lease: third.lease, campaignCostLimitUsd: 1, now: third.now });
  const canary = repository.beginProviderCanary({
    lease: third.lease,
    providerConfigurationHash: H('provider-canary-configuration'),
    now: new Date(third.now.getTime() + 1000),
  });
  assert.equal(canary.required, true);
  repository.finishProviderCanary({
    lease: third.lease,
    attempt: canary.externalActionAttempt,
    verified: false,
    error: 'provider_canary_failed_before_action',
    now: new Date(third.now.getTime() + 2000),
  });
  const finished = repository.finishDispatch({
    lease: third.lease,
    outcome: { status: 'retry' },
    observedCampaignCostUsd: 1,
    observedQualificationReservedCostUsd: 0,
    successful: false,
    nextDispatchAt: new Date(third.now.getTime() + 60_000),
    now: new Date(third.now.getTime() + 3000),
  });
  assert.equal(finished.disposition, 'active');

  const fourth = registerAndAcquire(repository, 'dispatch-cancel', 30_000);
  const fourthDispatch = repository.beginDispatch({
    lease: fourth.lease,
    campaignCostLimitUsd: 1,
    now: fourth.now,
  });
  const fourthCancelled = repository.cancelDispatchInfrastructureDeferred({
    lease: fourth.lease,
    dispatchCount: fourthDispatch.dispatchCount,
    now: new Date(fourth.now.getTime() + 1000),
  });
  assert.equal(fourthCancelled.dispatchCount, 0);
  assert.equal(fourthCancelled.consecutiveFailures, 0);

  const fifth = registerAndAcquire(repository, 'provider-cancel', 40_000);
  repository.beginDispatch({ lease: fifth.lease, campaignCostLimitUsd: 1, now: fifth.now });
  const fifthCanary = repository.beginProviderCanary({
    lease: fifth.lease,
    providerConfigurationHash: H('provider-canary-cancel-configuration'),
    now: new Date(fifth.now.getTime() + 1000),
  });
  const fifthCancelled = repository.cancelProviderCanaryInfrastructureDeferred({
    lease: fifth.lease,
    authorization: fifthCanary,
    now: new Date(fifth.now.getTime() + 2000),
  });
  assert.equal(fifthCancelled.dispatchCount, 0);
  assert.equal(fifthCancelled.providerCanaryCount, 0);
  assert.equal(fifthCancelled.providerCanaryReservedCostUsd, 0);

  const sixth = registerAndAcquire(repository, 'readiness-cancel', 50_000);
  repository.beginDispatch({ lease: sixth.lease, campaignCostLimitUsd: 1, now: sixth.now });
  const sixthAttempt = repository.beginExternalActionAttempt({
    lease: sixth.lease,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS,
    reservation: readinessReservation(sixth.campaignId, 1),
    now: new Date(sixth.now.getTime() + 1000),
  });
  const sixthCancelled = repository.cancelExternalActionInfrastructureDeferred({
    lease: sixth.lease,
    attempt: sixthAttempt,
    now: new Date(sixth.now.getTime() + 2000),
  });
  assert.equal(sixthCancelled.cancelled, true);
  assert.equal(sixthCancelled.campaign.dispatchCount, 0);
  assert.equal(sixthCancelled.campaign.consecutiveFailures, 0);
  assert.equal(sixthCancelled.attempt.receipt.externalActionPerformed, false);

  const seventh = registerAndAcquire(repository, 'readiness-recovery', 60_000);
  const seventhDispatch = repository.beginDispatch({
    lease: seventh.lease,
    campaignCostLimitUsd: 1,
    now: seventh.now,
  });
  const seventhAttempt = repository.beginExternalActionAttempt({
    lease: seventh.lease,
    actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS,
    reservation: readinessReservation(seventh.campaignId, seventhDispatch.dispatchCount),
    now: new Date(seventh.now.getTime() + 1000),
  });
  repository.markDispatchStarted({
    lease: seventh.lease,
    dispatchCount: seventhDispatch.dispatchCount,
    now: new Date(seventh.now.getTime() + 2000),
  });
  const seventhProgress = repository.recordExternalActionProgress({
    lease: seventh.lease,
    attempt: seventhAttempt,
    evidence: { phase: 'external-action-started' },
    now: new Date(seventh.now.getTime() + 3000),
  });
  repository.reconcileStaleLeases({
    now: new Date(seventh.now.getTime() + 16 * 60 * 1000),
  });
  const inspection = createAutomationReadinessSideEffectLedger({
    environment: {},
  }).inspection({ failureCode: 'recovered_external_action_failed' });
  const recovered = repository.resolveExternalActionRecovery({
    resolution: {
      outcome: 'failed',
      actionKind: seventhAttempt.actionKind,
      idempotencyKey: seventhAttempt.idempotencyKey,
      markerHash:
        seventhAttempt.marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash,
      reservationHash: seventhAttempt.reservationHash,
      actionConfigurationIdentityHash:
        seventhAttempt.marker.reservation.externalActionConfigurationIdentityHash,
      progressHash:
        seventhProgress.progress.autonomousResearchSupervisorExternalActionProgressReceiptHash,
      actionAccountingComplete: true,
      externalActionPerformed: inspection.externalActionPerformed,
      completedAt: new Date(seventh.now.getTime() + 16 * 60 * 1000 + 1000).toISOString(),
      result: {
        sideEffectInspection: inspection,
        actionResult: { readinessSideEffectInspection: inspection },
      },
    },
    now: new Date(seventh.now.getTime() + 16 * 60 * 1000 + 1000),
  });
  assert.equal(recovered.successful, false);

  const observedOperations = new Set(calls.map((call) => call.operationId));
  assert.deepEqual(
    observedOperations,
    new Set(Object.keys(AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS)),
  );
  const sideEffectReservationsByOperation = new Map([
    [
      'supervisor-state.supervisor-external-action-repository-support.beginExternalActionAttempt.v1',
      new Set([
        progressAttempt.reservationHash,
        finishedAttempt.reservationHash,
        sixthAttempt.reservationHash,
        seventhAttempt.reservationHash,
      ]),
    ],
    [
      'supervisor-state.supervisor-provider-canary-state-operations.beginProviderCanary.v1',
      new Set([
        canary.externalActionAttempt.reservationHash,
        fifthCanary.externalActionAttempt.reservationHash,
      ]),
    ],
  ]);
  for (const call of calls) {
    assert.equal(call.databaseRole, 'supervisor-state');
    assert.equal(call.databaseInstanceId, 'supervisor-state');
    assert.equal(call.schemaContractId, 'supervisor-state-schema-v1');
    assert.equal(call.writerId, AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID);
    assert.deepEqual(call.authorizationReceiptHashes, []);
    const expectedReservations = sideEffectReservationsByOperation.get(call.operationId);
    if (expectedReservations) {
      assert.equal(call.sideEffectReservationHashes.length, 1);
      assert.equal(expectedReservations.has(call.sideEffectReservationHashes[0]), true);
    } else {
      assert.deepEqual(call.sideEffectReservationHashes, []);
    }
  }
  for (const plan of Object.values(AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS)) {
    for (const statement of plan.statements) {
      assert.doesNotMatch(statement.sql, /\b(?:CREATE|ALTER|DROP|PRAGMA|ATTACH|BEGIN|COMMIT)\b/i);
    }
  }
});
