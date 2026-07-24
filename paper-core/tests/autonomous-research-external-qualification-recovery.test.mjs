import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID,
  createOfflineExternalQualificationMutationCoordinator,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-mutation-plan.mjs';
import {
  requestExternalResearchQualification,
} from '../../paper-application/automation/external-qualification-recovery.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PAPER_ID = 'external-qualification-online-test';
const DATABASE_INSTANCE_ID =
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID;
const H = (label) => hashRecord('ExternalQualificationOnlineMutationTest', { label });

function coordinator({
  calls = [],
  status = 'externally_fenced_sqlite_mutation_coordinator_ready',
  blockers = [],
  failBeforeApply = false,
  sideEffectMode = 'offline',
} = {}) {
  const local = createOfflineExternalQualificationMutationCoordinator({
    databaseInstanceId: DATABASE_INSTANCE_ID,
  });
  const coveredDatabaseRoles = Object.freeze(['external-qualification']);
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
        sideEffectReservationHashes: Object.freeze([
          ...input.sideEffectReservationHashes,
        ]),
      }));
      if (failBeforeApply) throw new Error('fixture_authority_reservation_unavailable');
      const committed = local.executeMutation(input);
      if (input.sideEffectReservationHashes.length === 0 || sideEffectMode === 'offline') {
        return committed;
      }
      if (sideEffectMode === 'finalization-pending') {
        const error = new Error(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
        );
        error.committed = true;
        error.reservationId = 'reservation:external-qualification:test';
        throw error;
      }
      return Object.freeze({
        ...committed,
        kind: 'ExternallyFencedSqliteMutationReceipt',
        status: 'externally_fenced_sqlite_mutation_finalized',
        reservationId: 'reservation:external-qualification:test',
        sideEffectPermitHash: sideEffectMode === 'finalized'
          ? H('external-request-side-effect-permit') : null,
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

function externalRequestFixture({ onLookup = null, onRequest = null, onVerify = null } = {}) {
  const shared = Object.freeze({
    configurationIdentityHash: H('infrastructure-refund-configuration'),
    trustIdentityHash: H('infrastructure-refund-trust'),
    maximumQualificationCostUsd: 0,
    qualificationCostAuthority: 'externally_operated_zero_cost',
  });
  return Object.freeze({
    campaignReleaseAuthority: Object.freeze({
      campaignId: `autonomous-research:${PAPER_ID}`,
      paperId: PAPER_ID,
      campaignReleaseBundleHash: H('infrastructure-refund-release'),
    }),
    preparation: Object.freeze({
      proposal: Object.freeze({
        machineProposedScientificClaimSetHash: H('infrastructure-refund-proposal'),
      }),
      policyAuthorization: Object.freeze({
        autonomousResearchPolicyAuthorizationHash: H('infrastructure-refund-policy'),
      }),
      seedBinding: Object.freeze({
        autonomousResearchSeedBindingHash: H('infrastructure-refund-seed'),
      }),
    }),
    externalQualificationClient: Object.freeze({
      kind: 'ExternalResearchQualificationClient',
      ...shared,
      serviceIdentityHash: H('infrastructure-refund-client'),
      async lookupQualification(input) {
        return onLookup?.(input) || Object.freeze({
          status: 'qualification_in_progress',
        });
      },
      async requestQualification(input) {
        return onRequest?.(input) || Object.freeze({ receipt: 'unused' });
      },
    }),
    externalQualificationVerifier: Object.freeze({
      kind: 'IndependentExternalResearchQualificationVerifier',
      ...shared,
      serviceIdentityHash: H('infrastructure-refund-verifier'),
      verifyLookup({ candidate }) { return candidate; },
      async verify(input) {
        if (onVerify) return onVerify(input);
        throw new Error('verification_must_not_run');
      },
    }),
  });
}

function verifiedLookupStatus(input, status, receipt = null, terminalFailureCodes = []) {
  return Object.freeze({
    authoritative: true,
    signatureVerified: true,
    requestDigestVerified: true,
    status,
    receipt,
    terminalFailureCodes: Object.freeze([...terminalFailureCodes]),
    idempotencyKey: input.idempotencyKey,
    sideEffectPermitHash: input.sideEffectPermitHash,
    requestHash: H(`lookup-request:${input.idempotencyKey}:${status}`),
    configurationIdentityHash: H('infrastructure-refund-configuration'),
    trustIdentityHash: H('infrastructure-refund-trust'),
    clientServiceIdentityHash: H('infrastructure-refund-client'),
    lookupStatusHash: H(`lookup-status:${input.idempotencyKey}:${status}`),
  });
}

async function createCrashedQualificationAttempt({
  repository,
  fixture,
  crashStage,
  now,
}) {
  try {
    await requestExternalResearchQualification({
      ...fixture,
      qualificationStateStore: repository,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date(now()) }),
        onProgress({ stage }) {
          if (stage !== crashStage) return;
          repository.close();
          throw new Error('fixture_simulated_process_crash');
        },
      }),
      evaluateEligibility() { throw new Error('eligibility_must_not_run_before_reopen'); },
    });
  } catch { /* closing the SQLite handle models abrupt process loss */ }
}

function attemptIdentityFromDatabase(repository, state) {
  const database = new DatabaseSync(repository.statePath, { readOnly: true });
  try {
    const lease = database.prepare(`SELECT owner_id,lease_token,lease_generation
      FROM autonomous_external_qualification_attempt_lease WHERE scope=?`).get(
      `paper:${PAPER_ID}`,
    );
    return Object.freeze({
      expectedStateHash: state.autonomousExternalQualificationStateHash,
      expectedGeneration: state.generation,
      idempotencyKey: hashRecord(
        'AutonomousExternalQualificationEpochIdempotency',
        {
          recoveryIdentityHash: state.recovery.recoveryIdentityHash,
          cycle: state.recovery.cycle,
          epoch: state.recovery.epoch,
        },
      ),
      attemptLease: Object.freeze({
        ownerId: lease.owner_id,
        leaseToken: lease.lease_token,
        leaseGeneration: Number(lease.lease_generation),
      }),
    });
  } finally { database.close(); }
}

test('pre-call infrastructure deferral exactly refunds qualification attempt and lease',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-qualification-infrastructure-refund-'),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    const calls = [];
    const repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ calls, sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    let clientCalls = 0;
    let reservedIdentity = null;
    const fixture = externalRequestFixture({
      onRequest() { clientCalls += 1; },
    });
    let failure = null;
    try {
      await requestExternalResearchQualification({
        ...fixture,
        qualificationStateStore: repository,
        allowRequest: true,
        retry: Object.freeze({
          maximumAttempts: 1,
          maximumEpochs: 1,
          maximumTotalAttempts: 1,
          clock: Object.freeze({
            now: () => new Date('2026-07-18T02:00:00.000Z'),
          }),
          onProgress({ stage }) {
            if (stage !== 'qualification_recovery_before_external_request') return;
            const reservedState = repository.readExternalQualificationState();
            reservedIdentity = attemptIdentityFromDatabase(repository, reservedState);
            const error = new Error('fixture_state_recoverability_deferred');
            error.stateRecoverabilityDeferred = true;
            throw error;
          },
        }),
        evaluateEligibility() { throw new Error('eligibility_must_not_run'); },
      });
    } catch (error) { failure = error; }

    assert.equal(
      failure?.stateRecoverabilityDeferred,
      true,
      `${failure?.stack || ''}\ncause:${failure?.cause?.stack || failure?.cause || ''}`,
    );
    assert.equal(failure?.qualificationInfrastructureReservationCancelled, true);
    assert.equal(clientCalls, 0);
    const refunded = repository.readExternalQualificationState();
    assert.equal(refunded.recovery.status, 'qualification_retry_scheduled');
    assert.equal(refunded.recovery.attemptCount, 0);
    assert.equal(refunded.recovery.totalAttemptCount, 0);
    assert.equal(refunded.recovery.reservedCostUsd, 0);
    assert.equal(calls.some((call) => call.operationId
      .endsWith('cancelQualificationAttemptInfrastructureDeferred.v1')), true);
    assert.equal(calls.some((call) => call.operationId
      .endsWith('markQualificationAttemptExternalActionStarted.v1')), false);

    const reacquired = repository.tryAcquireQualificationAttemptLease({
      ownerId: 'qualification:replacement',
      leaseMs: 1_000,
      now: new Date('2026-07-18T02:00:00.000Z'),
    });
    assert.ok(reacquired);
    repository.releaseQualificationAttemptLease(reacquired);
    assert.throws(() => repository.cancelQualificationAttemptInfrastructureDeferred({
      ...reservedIdentity,
      now: new Date('2026-07-18T02:00:00.000Z'),
    }), /attempt_lease_fence_conflict/);
    assert.deepEqual(repository.readExternalQualificationState(), refunded);
  });

test('generic pre-call progress fence failure also exactly refunds qualification budget',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-qualification-progress-refund-'),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    const calls = [];
    const repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ calls, sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    let clientCalls = 0;
    const fixture = externalRequestFixture({
      onRequest() { clientCalls += 1; },
    });

    await assert.rejects(() => requestExternalResearchQualification({
      ...fixture,
      qualificationStateStore: repository,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({
          now: () => new Date('2026-07-18T02:00:00.000Z'),
        }),
        onProgress({ stage }) {
          if (stage === 'qualification_recovery_before_external_request') {
            throw new Error('fixture_generic_progress_failure');
          }
        },
      }),
      evaluateEligibility() { throw new Error('eligibility_must_not_run'); },
    }), (error) => {
      assert.equal(
        error.message,
        'autonomous_research_qualification_progress_fence_lost',
      );
      assert.equal(error.cause?.message, 'fixture_generic_progress_failure');
      assert.equal(error.qualificationInfrastructureReservationCancelled, true);
      return true;
    });

    assert.equal(clientCalls, 0);
    const refunded = repository.readExternalQualificationState();
    assert.equal(refunded.recovery.attemptCount, 0);
    assert.equal(refunded.recovery.totalAttemptCount, 0);
    assert.equal(refunded.recovery.reservedCostUsd, 0);
    assert.equal(calls.some((call) => call.operationId
      .endsWith('cancelQualificationAttemptInfrastructureDeferred.v1')), true);
    const replacement = repository.tryAcquireQualificationAttemptLease({
      ownerId: 'qualification:progress-replacement',
      leaseMs: 1_000,
      now: new Date('2026-07-18T02:00:00.000Z'),
    });
    assert.ok(replacement);
    repository.releaseQualificationAttemptLease(replacement);
  });

test('durable qualification external-action marker permanently forbids infrastructure refund',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-qualification-infrastructure-started-'),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    const calls = [];
    const repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ calls, sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    let clientCalls = 0;
    let reservedIdentity = null;
    const fixture = externalRequestFixture({
      onRequest() { clientCalls += 1; },
    });
    let failure = null;
    try {
      await requestExternalResearchQualification({
        ...fixture,
        qualificationStateStore: repository,
        allowRequest: true,
        retry: Object.freeze({
          maximumAttempts: 1,
          maximumEpochs: 1,
          maximumTotalAttempts: 1,
          clock: Object.freeze({
            now: () => new Date('2026-07-18T02:00:00.000Z'),
          }),
          onProgress({ stage }) {
            if (stage !== 'qualification_recovery_after_external_request_marker') return;
            const reservedState = repository.readExternalQualificationState();
            reservedIdentity = attemptIdentityFromDatabase(repository, reservedState);
            const error = new Error('fixture_authority_evidence_deferred_after_marker');
            error.authorityEvidenceRenewalDeferred = true;
            throw error;
          },
        }),
        evaluateEligibility() { throw new Error('eligibility_must_not_run'); },
      });
    } catch (error) { failure = error; }

    assert.equal(failure?.authorityEvidenceRenewalDeferred, true);
    assert.equal(failure?.qualificationInfrastructureReservationCancelled, undefined);
    assert.equal(clientCalls, 0);
    const current = repository.readExternalQualificationState();
    assert.equal(current.recovery.status, 'qualification_attempt_in_progress');
    assert.equal(current.recovery.attemptCount, 1);
    assert.equal(current.recovery.totalAttemptCount, 1);
    assert.equal(current.recovery.reservedCostUsd, 0.05);
    assert.equal(calls.some((call) => call.operationId
      .endsWith('markQualificationAttemptExternalActionStarted.v1')), true);
    assert.equal(calls.some((call) => call.operationId
      .endsWith('cancelQualificationAttemptInfrastructureDeferred.v1')), false);
    assert.throws(() => repository.cancelQualificationAttemptInfrastructureDeferred({
      ...reservedIdentity,
      now: new Date('2026-07-18T02:00:00.000Z'),
    }), /infrastructure_cancel_fence_lost/);

    const database = new DatabaseSync(repository.statePath, { readOnly: true });
    const marker = database.prepare(`SELECT external_action_may_have_started,
      started_actions_json,cancelled_at
      FROM autonomous_external_qualification_attempt_reservation
      WHERE scope=? AND state_generation=?`).get(
      `paper:${PAPER_ID}`,
      current.generation,
    );
    database.close();
    assert.equal(Number(marker.external_action_may_have_started), 1);
    assert.deepEqual(JSON.parse(marker.started_actions_json), [
      'external_qualification_request',
    ]);
    assert.equal(marker.cancelled_at, null);
  });

test('pre-marker process crash refunds the exact stale attempt after real database reopen',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-qualification-crash-before-marker-'),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    let now = '2026-07-18T02:00:00.000Z';
    let requestCalls = 0;
    let lookupCalls = 0;
    const fixture = externalRequestFixture({
      onRequest() { requestCalls += 1; },
      onLookup() { lookupCalls += 1; },
    });
    let repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    await createCrashedQualificationAttempt({
      repository,
      fixture,
      crashStage: 'qualification_recovery_before_external_request',
      now: () => now,
    });

    now = '2026-07-18T02:10:00.001Z';
    repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    const result = await requestExternalResearchQualification({
      ...fixture,
      qualificationStateStore: repository,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date(now) }),
      }),
      evaluateEligibility() { throw new Error('eligibility_must_not_run'); },
    });

    assert.equal(
      result.status,
      'qualification_external_service_stale_attempt_refunded',
    );
    assert.equal(requestCalls, 0);
    assert.equal(lookupCalls, 0);
    const refunded = repository.readExternalQualificationState();
    assert.equal(refunded.recovery.status, 'qualification_retry_scheduled');
    assert.equal(refunded.recovery.attemptCount, 0);
    assert.equal(refunded.recovery.totalAttemptCount, 0);
    assert.equal(refunded.recovery.reservedCostUsd, 0);
    const replacement = repository.tryAcquireQualificationAttemptLease({
      ownerId: 'qualification:crash-replacement',
      leaseMs: 10 * 60 * 1000,
      now: new Date(now),
    });
    assert.ok(replacement);
    repository.releaseQualificationAttemptLease(replacement);
  });

test('post-marker process crash uses authoritative lookup after reopen without duplicate cost',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-qualification-crash-after-marker-'),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    let now = '2026-07-18T02:00:00.000Z';
    let requestCalls = 0;
    let lookupCalls = 0;
    let verifierCalls = 0;
    let lookupIdempotencyKey = null;
    const recoveredReceipt = Object.freeze({
      kind: 'RecoveredExternalQualificationReceipt',
      expiresAt: '2026-07-19T01:00:00.000Z',
    });
    const fixture = externalRequestFixture({
      onRequest() {
        requestCalls += 1;
        throw new Error('duplicate_external_qualification_request_forbidden');
      },
      onLookup(input) {
        lookupCalls += 1;
        lookupIdempotencyKey = input.idempotencyKey;
        assert.match(input.sideEffectPermitHash, /^sha256:[0-9a-f]{64}$/);
        return Object.freeze({
          authoritative: true,
          signatureVerified: true,
          requestDigestVerified: true,
          status: 'qualification_found',
          receipt: recoveredReceipt,
          terminalFailureCodes: Object.freeze([]),
          idempotencyKey: input.idempotencyKey,
          sideEffectPermitHash: input.sideEffectPermitHash,
          requestHash: H(`lookup-request:${input.idempotencyKey}`),
          configurationIdentityHash: H('infrastructure-refund-configuration'),
          trustIdentityHash: H('infrastructure-refund-trust'),
          clientServiceIdentityHash: H('infrastructure-refund-client'),
          lookupStatusHash: H(`lookup-status:${input.idempotencyKey}`),
        });
      },
      onVerify({ receipt }) {
        verifierCalls += 1;
        assert.equal(receipt, recoveredReceipt);
        return Object.freeze({
          version: 1,
          kind: 'FullResearchQualificationInspection',
          status: 'full_research_qualification_verified',
          ready: true,
          receiptAccepted: true,
          campaignId: `autonomous-research:${PAPER_ID}`,
          paperId: PAPER_ID,
          campaignReleaseBundleHash: H('infrastructure-refund-release'),
          failureCodes: Object.freeze([]),
          blockers: Object.freeze([]),
        });
      },
    });
    let repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    await createCrashedQualificationAttempt({
      repository,
      fixture,
      crashStage: 'qualification_recovery_after_external_request_marker',
      now: () => now,
    });

    now = '2026-07-18T02:10:00.001Z';
    repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    const result = await requestExternalResearchQualification({
      ...fixture,
      qualificationStateStore: repository,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date(now) }),
      }),
      evaluateEligibility() {
        return Object.freeze({ fullAutomaticResearchWritingReady: true });
      },
    });

    assert.equal(result.status, 'qualification_external_service_verified');
    assert.equal(requestCalls, 0);
    assert.equal(lookupCalls, 1);
    assert.equal(verifierCalls, 1);
    assert.match(lookupIdempotencyKey, /^sha256:[0-9a-f]{64}$/);
    const recovered = repository.readExternalQualificationState();
    assert.equal(recovered.recovery.status, 'qualification_verified');
    assert.equal(recovered.recovery.attemptCount, 1);
    assert.equal(recovered.recovery.totalAttemptCount, 1);
    assert.equal(recovered.recovery.reservedCostUsd, 0.05);
    assert.deepEqual(recovered.receipt, recoveredReceipt);
  });

test('signed definitive not-found resumes the same permit and idempotency without new cost',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-qualification-definitive-not-found-'),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    let now = '2026-07-18T02:00:00.000Z';
    let lookupRequest = null;
    let resumedRequest = null;
    const resumedReceipt = Object.freeze({
      kind: 'SameKeyResumedExternalQualificationReceipt',
      expiresAt: '2026-07-19T01:00:00.000Z',
    });
    const fixture = externalRequestFixture({
      onLookup(input) {
        lookupRequest = input;
        return verifiedLookupStatus(
          input,
          'qualification_definitively_not_found',
        );
      },
      onRequest(input) {
        resumedRequest = input;
        return resumedReceipt;
      },
      onVerify() {
        return Object.freeze({
          kind: 'FullResearchQualificationInspection',
          status: 'full_research_qualification_verified',
          ready: true,
          receiptAccepted: true,
          campaignId: `autonomous-research:${PAPER_ID}`,
          paperId: PAPER_ID,
          campaignReleaseBundleHash: H('infrastructure-refund-release'),
          failureCodes: Object.freeze([]),
          blockers: Object.freeze([]),
        });
      },
    });
    let repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    await createCrashedQualificationAttempt({
      repository,
      fixture,
      crashStage: 'qualification_recovery_after_external_request_marker',
      now: () => now,
    });
    now = '2026-07-18T02:10:00.001Z';
    repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());

    const result = await requestExternalResearchQualification({
      ...fixture,
      qualificationStateStore: repository,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date(now) }),
      }),
      evaluateEligibility() {
        return Object.freeze({ fullAutomaticResearchWritingReady: true });
      },
    });

    assert.equal(result.status, 'qualification_external_service_verified');
    assert.ok(lookupRequest);
    assert.ok(resumedRequest);
    assert.equal(resumedRequest.idempotencyKey, lookupRequest.idempotencyKey);
    assert.equal(resumedRequest.sideEffectPermitHash,
      lookupRequest.sideEffectPermitHash);
    const state = repository.readExternalQualificationState();
    assert.equal(state.recovery.attemptCount, 1);
    assert.equal(state.recovery.totalAttemptCount, 1);
    assert.equal(state.recovery.reservedCostUsd, 0.05);
  });

test('signed in-progress lookup holds the recovery lease and never repeats the request',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-qualification-lookup-in-progress-'),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    let now = '2026-07-18T02:00:00.000Z';
    let lookupCalls = 0;
    let requestCalls = 0;
    const fixture = externalRequestFixture({
      onLookup(input) {
        lookupCalls += 1;
        return verifiedLookupStatus(input, 'qualification_in_progress');
      },
      onRequest() { requestCalls += 1; },
    });
    let repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    await createCrashedQualificationAttempt({
      repository,
      fixture,
      crashStage: 'qualification_recovery_after_external_request_marker',
      now: () => now,
    });
    now = '2026-07-18T02:10:00.001Z';
    repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ sideEffectMode: 'finalized' }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    const common = {
      ...fixture,
      qualificationStateStore: repository,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date(now) }),
      }),
      evaluateEligibility() { throw new Error('eligibility_must_not_run'); },
    };

    const {
      lookupQualification: _missingLookup,
      ...clientWithoutLookup
    } = fixture.externalQualificationClient;
    const missingLookup = await requestExternalResearchQualification({
      ...common,
      externalQualificationClient: Object.freeze(clientWithoutLookup),
    });
    assert.equal(missingLookup.status,
      'qualification_external_service_authoritative_lookup_required');
    assert.equal(lookupCalls, 0);
    assert.equal(requestCalls, 0);
    const first = await requestExternalResearchQualification(common);
    const second = await requestExternalResearchQualification(common);
    assert.equal(first.status,
      'qualification_external_service_authoritative_lookup_pending');
    assert.equal(second.status, 'qualification_external_service_attempt_in_progress');
    assert.equal(lookupCalls, 1);
    assert.equal(requestCalls, 0);
    const state = repository.readExternalQualificationState();
    assert.equal(state.recovery.attemptCount, 1);
    assert.equal(state.recovery.totalAttemptCount, 1);
    assert.equal(state.recovery.reservedCostUsd, 0.05);
  });
