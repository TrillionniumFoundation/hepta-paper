import crypto from 'node:crypto';
import {
  createAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_EXTERNAL_ACTIONS = new Set([
  'external_qualification_request',
  'external_qualification_verification',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export function externalQualificationAttemptLeaseTokenHash(scope, identity) {
  return hashRecord('AutonomousResearchExternalQualificationAttemptLeaseToken', {
    scope,
    ownerId: identity.ownerId,
    leaseToken: identity.leaseToken,
    leaseGeneration: identity.leaseGeneration,
  });
}

export function externalQualificationAttemptIdempotencyKey(state) {
  return hashRecord('AutonomousExternalQualificationEpochIdempotency', {
    recoveryIdentityHash: state.recovery.recoveryIdentityHash,
    cycle: state.recovery.cycle,
    epoch: state.recovery.epoch,
  });
}

function sameQualificationLifecycle(current, state) {
  return current?.campaignId === state.campaignId
    && current?.paperId === state.paperId
    && current?.campaignReleaseBundleHash === state.campaignReleaseBundleHash;
}

export function externalQualificationAttemptReservationPrior(current, state) {
  const sameLifecycle = sameQualificationLifecycle(current, state);
  const sameAttemptSeries = sameLifecycle
    && current?.recovery?.recoveryIdentityHash === state.recovery.recoveryIdentityHash
    && Number(current?.recovery?.cycle) === Number(state.recovery.cycle)
    && Number(current?.recovery?.epoch) === Number(state.recovery.epoch);
  const prior = Object.freeze({
    attemptCount: sameAttemptSeries ? Number(current.recovery.attemptCount) : 0,
    totalAttemptCount: sameLifecycle
      ? Number(current.recovery.totalAttemptCount) : 0,
    reservedCostUsd: sameLifecycle
      && Object.hasOwn(current?.recovery || {}, 'reservedCostUsd')
      ? Number(current.recovery.reservedCostUsd) : 0,
  });
  if (state.recovery.status !== 'qualification_attempt_in_progress'
    || state.recovery.attemptCount !== prior.attemptCount + 1
    || state.recovery.totalAttemptCount !== prior.totalAttemptCount + 1
    || state.recovery.reservedCostUsd
      !== prior.reservedCostUsd + state.recovery.attemptReservationCostUsd) {
    throw new Error(
      'autonomous_research_qualification_attempt_reservation_delta_invalid',
    );
  }
  return prior;
}

function attemptReservationIdentity({
  expectedStateHash,
  expectedGeneration,
  idempotencyKey,
  attemptLease,
  leaseIdentity,
} = {}) {
  const generation = Number(expectedGeneration);
  if (!SHA256.test(String(expectedStateHash || ''))
    || !Number.isSafeInteger(generation) || generation < 1
    || !SHA256.test(String(idempotencyKey || ''))) {
    throw new Error(
      'autonomous_research_qualification_attempt_reservation_identity_invalid',
    );
  }
  return Object.freeze({
    expectedStateHash: String(expectedStateHash),
    expectedGeneration: generation,
    idempotencyKey: String(idempotencyKey),
    attemptLease: Object.freeze(leaseIdentity(attemptLease)),
  });
}

function exactAttemptLease(row, identity, observedAt) {
  return row
    && row.owner_id === identity.ownerId
    && row.lease_token === identity.leaseToken
    && Number(row.lease_generation) === identity.leaseGeneration
    && Date.parse(row.expires_at) > observedAt.getTime();
}

function parseStartedActions(row) {
  let actions;
  try { actions = JSON.parse(String(row?.started_actions_json || '')); }
  catch {
    throw new Error(
      'autonomous_research_qualification_attempt_external_action_marker_invalid',
    );
  }
  if (!Array.isArray(actions)
    || actions.some((action) => !ATTEMPT_EXTERNAL_ACTIONS.has(action))
    || new Set(actions).size !== actions.length) {
    throw new Error(
      'autonomous_research_qualification_attempt_external_action_marker_invalid',
    );
  }
  return actions;
}

export function createAutonomousResearchQualificationAttemptInfrastructureOperations({
  requireWritableDatabase,
  coordinator,
  databaseInstanceId,
  schemaContractId,
  writerId,
  scope,
  paperId,
  safeNow,
  leaseIdentity,
  parsePersistedState,
  mutationValue,
  boundedLeaseMs,
  requireFinalizedSideEffectPermit = false,
  sideEffectPermitForState = () => null,
} = {}) {
  return Object.freeze({
    markQualificationAttemptExternalActionStarted({
      expectedStateHash,
      expectedGeneration,
      idempotencyKey,
      attemptLease,
      action,
      now = new Date(),
    } = {}) {
      const db = requireWritableDatabase();
      const reservation = attemptReservationIdentity({
        expectedStateHash,
        expectedGeneration,
        idempotencyKey,
        attemptLease,
        leaseIdentity,
      });
      if (!ATTEMPT_EXTERNAL_ACTIONS.has(action)) {
        throw new Error(
          'autonomous_research_qualification_attempt_external_action_invalid',
        );
      }
      const observedAt = safeNow(now);
      const identity = reservation.attemptLease;
      const leaseTokenHash = externalQualificationAttemptLeaseTokenHash(scope, identity);
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.markQualificationAttemptExternalActionStarted.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const persistedLease = transaction.get(
            'external-qualification.attempt-start.lease-current.get.v1',
            scope,
          );
          if (!exactAttemptLease(persistedLease, identity, observedAt)) {
            throw new Error('autonomous_research_qualification_attempt_lease_fence_conflict');
          }
          const current = parsePersistedState(transaction.get(
            'external-qualification.attempt-start.state-current.get.v1',
            scope,
          ), paperId);
          if (!current
            || current.generation !== reservation.expectedGeneration
            || current.autonomousExternalQualificationStateHash
              !== reservation.expectedStateHash
            || current.recovery.status !== 'qualification_attempt_in_progress'
            || externalQualificationAttemptIdempotencyKey(current)
              !== reservation.idempotencyKey) {
            throw new Error(
              'autonomous_research_qualification_attempt_external_action_fence_lost',
            );
          }
          const row = transaction.get(
            'external-qualification.attempt-start.reservation-current.get.v1',
            scope,
            reservation.expectedGeneration,
            reservation.expectedStateHash,
            reservation.idempotencyKey,
          );
          if (!row || row.cancelled_at !== null
            || row.lease_owner_id !== identity.ownerId
            || row.lease_token_hash !== leaseTokenHash
            || Number(row.lease_generation) !== identity.leaseGeneration
            || Number(row.attempt_count) !== current.recovery.attemptCount
            || Number(row.total_attempt_count) !== current.recovery.totalAttemptCount
            || Number(row.reserved_cost_usd) !== current.recovery.reservedCostUsd) {
            throw new Error(
              'autonomous_research_qualification_attempt_external_action_fence_lost',
            );
          }
          const actions = parseStartedActions(row);
          if (action === 'external_qualification_verification'
            && !actions.includes('external_qualification_request')) {
            throw new Error(
              'autonomous_research_qualification_attempt_external_action_order_invalid',
            );
          }
          const ephemeralPermit = sideEffectPermitForState(
            reservation.expectedStateHash,
          );
          const persistedPermit = row.side_effect_permit_hash || null;
          const sideEffectPermitHash = persistedPermit || ephemeralPermit;
          if ((persistedPermit && ephemeralPermit && persistedPermit !== ephemeralPermit)
            || (requireFinalizedSideEffectPermit
              && !SHA256.test(String(sideEffectPermitHash || '')))) {
            throw new Error(
              'autonomous_research_qualification_attempt_side_effect_permit_invalid',
            );
          }
          const nextActions = actions.includes(action) ? actions : [...actions, action];
          const result = transaction.run(
            'external-qualification.attempt-start.reservation-update.apply.v1',
            JSON.stringify(nextActions),
            observedAt.toISOString(),
            observedAt.toISOString(),
            sideEffectPermitHash,
            scope,
            reservation.expectedGeneration,
            reservation.expectedStateHash,
            reservation.idempotencyKey,
            identity.ownerId,
            leaseTokenHash,
            identity.leaseGeneration,
            sideEffectPermitHash,
          );
          if (Number(result.changes) !== 1) {
            throw new Error(
              'autonomous_research_qualification_attempt_external_action_fence_lost',
            );
          }
          return Object.freeze({
            version: 1,
            kind: 'AutonomousResearchQualificationAttemptExternalActionMarker',
            scope,
            stateGeneration: reservation.expectedGeneration,
            stateHash: reservation.expectedStateHash,
            idempotencyKey: reservation.idempotencyKey,
            action,
            externalActionMayHaveStarted: true,
            sideEffectPermitHash,
            markedAt: observedAt.toISOString(),
          });
        },
      }));
    },
    reconcileStaleQualificationAttemptReservation({
      ownerId,
      leaseMs,
      now = new Date(),
    } = {}) {
      const db = requireWritableDatabase();
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error(
          'autonomous_research_qualification_attempt_recovery_owner_invalid',
        );
      }
      const observedAt = safeNow(now);
      const duration = boundedLeaseMs(leaseMs);
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.reconcileStaleQualificationAttemptReservation.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = parsePersistedState(transaction.get(
            'external-qualification.attempt-reconcile.state-current.get.v1',
            scope,
          ), paperId);
          if (!current || current.recovery.status !== 'qualification_attempt_in_progress') {
            throw new Error(
              'autonomous_research_qualification_attempt_recovery_state_invalid',
            );
          }
          const idempotencyKey = externalQualificationAttemptIdempotencyKey(current);
          const row = transaction.get(
            'external-qualification.attempt-reconcile.reservation-current.get.v1',
            scope,
            current.generation,
            current.autonomousExternalQualificationStateHash,
            idempotencyKey,
          );
          const persistedLease = transaction.get(
            'external-qualification.attempt-reconcile.lease-current.get.v1',
            scope,
          );
          if (persistedLease
            && Date.parse(persistedLease.expires_at) > observedAt.getTime()) {
            throw new Error(
              'autonomous_research_qualification_attempt_recovery_lease_active',
            );
          }
          const persistedLeaseIdentity = persistedLease ? Object.freeze({
            ownerId: persistedLease.owner_id,
            leaseToken: persistedLease.lease_token,
            leaseGeneration: Number(persistedLease.lease_generation),
          }) : null;
          if (!row || row.cancelled_at !== null
            || row.recovery_identity_hash !== current.recovery.recoveryIdentityHash
            || Number(row.cycle) !== current.recovery.cycle
            || Number(row.epoch) !== current.recovery.epoch
            || Number(row.attempt_count) !== current.recovery.attemptCount
            || Number(row.total_attempt_count) !== current.recovery.totalAttemptCount
            || Number(row.reserved_cost_usd) !== current.recovery.reservedCostUsd
            || Number(row.prior_attempt_count) !== current.recovery.attemptCount - 1
            || Number(row.prior_total_attempt_count)
              !== current.recovery.totalAttemptCount - 1
            || Number(row.attempt_reservation_cost_usd)
              !== current.recovery.attemptReservationCostUsd
            || (persistedLeaseIdentity
              && (row.lease_owner_id !== persistedLeaseIdentity.ownerId
                || row.lease_token_hash !== externalQualificationAttemptLeaseTokenHash(
                  scope,
                  persistedLeaseIdentity,
                )
                || Number(row.lease_generation)
                  !== persistedLeaseIdentity.leaseGeneration))) {
            throw new Error(
              'autonomous_research_qualification_attempt_recovery_fence_lost',
            );
          }
          const actions = parseStartedActions(row);
          const mayHaveStarted = Number(row.external_action_may_have_started) === 1;
          if (!mayHaveStarted && actions.length !== 0) {
            throw new Error(
              'autonomous_research_qualification_attempt_recovery_marker_invalid',
            );
          }
          if (!mayHaveStarted) {
            const { autonomousExternalQualificationStateHash: _hash, ...payload } = current;
            const nextAttemptAt = new Date(Math.max(
              observedAt.getTime(),
              Date.parse(current.recovery.firstAttemptAt),
            )).toISOString();
            const refundedState = createAutonomousExternalQualificationState(Object.freeze({
              ...payload,
              generation: current.generation + 1,
              recovery: Object.freeze({
                ...current.recovery,
                status: 'qualification_retry_scheduled',
                attemptCount: Number(row.prior_attempt_count),
                totalAttemptCount: Number(row.prior_total_attempt_count),
                reservedCostUsd: Number(row.prior_reserved_cost_usd),
                nextAttemptAt,
              }),
            }));
            const stateResult = transaction.run(
              'external-qualification.attempt-reconcile.state-refund.apply.v1',
              refundedState.generation,
              refundedState.autonomousExternalQualificationStateHash,
              JSON.stringify(refundedState),
              observedAt.toISOString(),
              scope,
              current.generation,
              current.autonomousExternalQualificationStateHash,
            );
            const reservationResult = transaction.run(
              'external-qualification.attempt-reconcile.reservation-refund.apply.v1',
              observedAt.toISOString(),
              refundedState.generation,
              refundedState.autonomousExternalQualificationStateHash,
              scope,
              current.generation,
              current.autonomousExternalQualificationStateHash,
              idempotencyKey,
            );
            const leaseResult = persistedLeaseIdentity ? transaction.run(
              'external-qualification.attempt-reconcile.lease-delete.apply.v1',
              scope,
              persistedLeaseIdentity.ownerId,
              persistedLeaseIdentity.leaseToken,
              persistedLeaseIdentity.leaseGeneration,
              observedAt.toISOString(),
            ) : null;
            if (Number(stateResult.changes) !== 1
              || Number(reservationResult.changes) !== 1
              || (leaseResult && Number(leaseResult.changes) !== 1)) {
              throw new Error(
                'autonomous_research_qualification_attempt_recovery_fence_lost',
              );
            }
            return Object.freeze({
              status: 'stale_attempt_reservation_refunded',
              state: refundedState,
              requestMayBeRepeated: false,
            });
          }
          if (!actions.includes('external_qualification_request')
            || (requireFinalizedSideEffectPermit
              && !SHA256.test(String(row.side_effect_permit_hash || '')))) {
            throw new Error(
              'autonomous_research_qualification_attempt_recovery_marker_invalid',
            );
          }
          const recoveryLease = Object.freeze({
            ownerId: String(ownerId),
            leaseToken: `lease:${crypto.randomUUID()}`,
            leaseGeneration: Math.max(
              Number(row.lease_generation),
              Number(persistedLease?.lease_generation || 0),
            ) + 1,
            expiresAt: new Date(observedAt.getTime() + duration).toISOString(),
          });
          const recoveryLeaseTokenHash = externalQualificationAttemptLeaseTokenHash(
            scope,
            recoveryLease,
          );
          const reservationResult = transaction.run(
            'external-qualification.attempt-reconcile.reservation-takeover.apply.v1',
            recoveryLease.ownerId,
            recoveryLeaseTokenHash,
            recoveryLease.leaseGeneration,
            observedAt.toISOString(),
            scope,
            current.generation,
            current.autonomousExternalQualificationStateHash,
            idempotencyKey,
            row.lease_owner_id,
            row.lease_token_hash,
            Number(row.lease_generation),
          );
          const leaseResult = transaction.run(
            'external-qualification.attempt-reconcile.lease-upsert.apply.v1',
            scope,
            recoveryLease.ownerId,
            recoveryLease.leaseToken,
            recoveryLease.leaseGeneration,
            observedAt.toISOString(),
            observedAt.toISOString(),
            recoveryLease.expiresAt,
          );
          if (Number(reservationResult.changes) !== 1
            || Number(leaseResult.changes) !== 1) {
            throw new Error(
              'autonomous_research_qualification_attempt_recovery_fence_lost',
            );
          }
          return Object.freeze({
            status: 'stale_attempt_authoritative_lookup_required',
            state: current,
            attemptLease: recoveryLease,
            idempotencyKey,
            startedActions: Object.freeze([...actions]),
            sideEffectPermitHash: row.side_effect_permit_hash || null,
            requestMayBeRepeated: false,
          });
        },
      }));
    },
    cancelQualificationAttemptInfrastructureDeferred({
      expectedStateHash,
      expectedGeneration,
      idempotencyKey,
      attemptLease,
      now = new Date(),
    } = {}) {
      const db = requireWritableDatabase();
      const reservation = attemptReservationIdentity({
        expectedStateHash,
        expectedGeneration,
        idempotencyKey,
        attemptLease,
        leaseIdentity,
      });
      const observedAt = safeNow(now);
      const identity = reservation.attemptLease;
      const leaseTokenHash = externalQualificationAttemptLeaseTokenHash(scope, identity);
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.cancelQualificationAttemptInfrastructureDeferred.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const persistedLease = transaction.get(
            'external-qualification.attempt-cancel.lease-current.get.v1',
            scope,
          );
          if (!exactAttemptLease(persistedLease, identity, observedAt)) {
            throw new Error('autonomous_research_qualification_attempt_lease_fence_conflict');
          }
          const current = parsePersistedState(transaction.get(
            'external-qualification.attempt-cancel.state-current.get.v1',
            scope,
          ), paperId);
          if (!current
            || current.generation !== reservation.expectedGeneration
            || current.autonomousExternalQualificationStateHash
              !== reservation.expectedStateHash
            || current.recovery.status !== 'qualification_attempt_in_progress'
            || externalQualificationAttemptIdempotencyKey(current)
              !== reservation.idempotencyKey) {
            throw new Error(
              'autonomous_research_qualification_attempt_infrastructure_cancel_fence_lost',
            );
          }
          const row = transaction.get(
            'external-qualification.attempt-cancel.reservation-current.get.v1',
            scope,
            reservation.expectedGeneration,
            reservation.expectedStateHash,
            reservation.idempotencyKey,
          );
          if (!row || row.cancelled_at !== null
            || Number(row.external_action_may_have_started) !== 0
            || parseStartedActions(row).length !== 0
            || row.lease_owner_id !== identity.ownerId
            || row.lease_token_hash !== leaseTokenHash
            || Number(row.lease_generation) !== identity.leaseGeneration
            || row.recovery_identity_hash !== current.recovery.recoveryIdentityHash
            || Number(row.cycle) !== current.recovery.cycle
            || Number(row.epoch) !== current.recovery.epoch
            || Number(row.attempt_count) !== current.recovery.attemptCount
            || Number(row.total_attempt_count) !== current.recovery.totalAttemptCount
            || Number(row.reserved_cost_usd) !== current.recovery.reservedCostUsd
            || Number(row.prior_attempt_count) !== current.recovery.attemptCount - 1
            || Number(row.prior_total_attempt_count)
              !== current.recovery.totalAttemptCount - 1
            || Number(row.attempt_reservation_cost_usd)
              !== current.recovery.attemptReservationCostUsd) {
            throw new Error(
              'autonomous_research_qualification_attempt_infrastructure_cancel_fence_lost',
            );
          }
          const { autonomousExternalQualificationStateHash: _currentHash, ...payload } = current;
          const nextAttemptAt = new Date(Math.max(
            observedAt.getTime(),
            Date.parse(current.recovery.firstAttemptAt),
          )).toISOString();
          const refundedState = createAutonomousExternalQualificationState(Object.freeze({
            ...payload,
            generation: current.generation + 1,
            recovery: Object.freeze({
              ...current.recovery,
              status: 'qualification_retry_scheduled',
              attemptCount: Number(row.prior_attempt_count),
              totalAttemptCount: Number(row.prior_total_attempt_count),
              reservedCostUsd: Number(row.prior_reserved_cost_usd),
              nextAttemptAt,
            }),
          }));
          const stateResult = transaction.run(
            'external-qualification.attempt-cancel.state-update.apply.v1',
            refundedState.generation,
            refundedState.autonomousExternalQualificationStateHash,
            JSON.stringify(refundedState),
            observedAt.toISOString(),
            scope,
            current.generation,
            current.autonomousExternalQualificationStateHash,
          );
          const reservationResult = transaction.run(
            'external-qualification.attempt-cancel.reservation-update.apply.v1',
            observedAt.toISOString(),
            refundedState.generation,
            refundedState.autonomousExternalQualificationStateHash,
            scope,
            current.generation,
            current.autonomousExternalQualificationStateHash,
            reservation.idempotencyKey,
            identity.ownerId,
            leaseTokenHash,
            identity.leaseGeneration,
          );
          const leaseResult = transaction.run(
            'external-qualification.attempt-cancel.lease-delete.apply.v1',
            scope,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
          );
          if ([stateResult, reservationResult, leaseResult]
            .some((result) => Number(result.changes) !== 1)) {
            throw new Error(
              'autonomous_research_qualification_attempt_infrastructure_cancel_fence_lost',
            );
          }
          return Object.freeze({
            cancelled: true,
            state: refundedState,
            releasedLease: true,
          });
        },
      }));
    },
  });
}
