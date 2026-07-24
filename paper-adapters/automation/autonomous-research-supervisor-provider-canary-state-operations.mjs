import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import {
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function recordHashValid(value, kind, hashField) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !SHA256.test(String(value[hashField] || ''))) return false;
  const { [hashField]: claimedHash, ...payload } = value;
  return hashRecord(kind, payload) === claimedHash;
}

function providerCanaryPairReceiptValid(value) {
  return value?.version === 1
    && value?.kind === 'AutonomousResearchProviderCanaryPairReceipt'
    && value?.status === 'autonomous_research_provider_canary_pair_verified'
    && value?.verified === true
    && SHA256.test(String(value?.researchAuthorProviderCanaryReceiptHash || ''))
    && SHA256.test(String(value?.formalReviewerProviderCanaryReceiptHash || ''))
    && recordHashValid(
      value,
      'AutonomousResearchProviderCanaryPairReceipt',
      'providerCanaryPairReceiptHash',
    );
}

function providerCanaryVerifiedSummary({ marker, receiptHash }) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorProviderCanaryVerifiedSummary',
    verified: true,
    attemptId: marker.attemptId,
    reservationHash: marker.reservationHash,
    providerCanaryPairReceiptHash: receiptHash,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorProviderCanaryVerifiedSummaryHash: hashRecord(
      'AutonomousResearchSupervisorProviderCanaryVerifiedSummary', payload,
    ),
  });
}

function providerCanaryActionPlan({
  current,
  identity,
  providerConfigurationHash,
  observedAt,
} = {}) {
  const providerCanaryCount = current.providerCanaryCount + 1;
  const plannedGenerationHash = hashRecord(
    'AutonomousResearchSupervisorProviderCanaryPlannedAttempt',
    {
      campaignId: current.campaignId,
      dispatchCount: current.dispatchCount,
      providerCanaryCount,
      leaseGeneration: identity.leaseGeneration,
      providerConfigurationHash,
      providerCanaryReservedCostUsd:
        current.policy.providerCanaryReservationCostUsd,
      startedAt: observedAt.toISOString(),
    },
  );
  const providerCanaryReservation = Object.freeze({
    generationSequence: providerCanaryCount,
    plannedGenerationHash,
    budgetReservationId: `supervisor-canary:${plannedGenerationHash.slice(7)}`,
    budgetEpochStart: current.lifecycleStartedAt,
    providerCanaryReservedAttemptCount: 1,
    providerCanaryReservedCostUsd:
      current.policy.providerCanaryReservationCostUsd,
  });
  const reservation = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorProviderCanaryReservation',
    campaignId: current.campaignId,
    dispatchCount: current.dispatchCount,
    providerConfigurationHash,
    externalActionConfigurationIdentityHash: providerConfigurationHash,
    providerCanaryReservation,
    priorProviderCanaryState: Object.freeze({
      providerCanaryCount: current.providerCanaryCount,
      providerCanaryReservedCostUsd: current.providerCanaryReservedCostUsd,
      lastProviderCanaryAt: current.lastProviderCanaryAt,
      lastProviderCanaryStatus: current.lastProviderCanaryStatus,
      lastProviderCanaryReceiptHash: current.lastProviderCanaryReceiptHash,
    }),
  });
  const reservationHash = hashRecord(
    'AutonomousResearchSupervisorExternalActionReservation',
    {
      campaignId: current.campaignId,
      actionKind: AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY,
      reservation,
    },
  );
  return Object.freeze({
    providerCanaryCount,
    providerCanaryReservation,
    reservation,
    reservationHash,
  });
}

function assertFinalizedSideEffectPermit({ receipt, required, reservationHash } = {}) {
  if (!required) return;
  if (receipt?.status === 'externally_fenced_sqlite_mutation_finalized'
    && SHA256.test(String(receipt.sideEffectPermitHash || ''))) return;
  const error = new Error(
    'autonomous_research_supervisor_provider_canary_side_effect_permit_required',
  );
  error.committed = true;
  error.reservationId = receipt?.reservationId || null;
  error.sideEffectPermitHash = receipt?.sideEffectPermitHash || null;
  error.sideEffectReservationHash = reservationHash;
  throw error;
}

export function autonomousResearchSupervisorProviderCanarySuccessEvidenceValid(value, marker) {
  if (providerCanaryPairReceiptValid(value)) {
    return value.autonomousResearchProviderConfigurationHash
      === marker?.reservation?.providerConfigurationHash;
  }
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
    'attemptId', 'autonomousResearchSupervisorProviderCanaryVerifiedSummaryHash', 'kind',
    'providerCanaryPairReceiptHash', 'reservationHash', 'verified', 'version',
  ].sort())) return false;
  const {
    autonomousResearchSupervisorProviderCanaryVerifiedSummaryHash: claimedHash,
    ...payload
  } = value;
  return value.version === 1
    && value.kind === 'AutonomousResearchSupervisorProviderCanaryVerifiedSummary'
    && value.verified === true
    && value.attemptId === marker?.attemptId
    && value.reservationHash === marker?.reservationHash
    && SHA256.test(String(value.providerCanaryPairReceiptHash || ''))
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchSupervisorProviderCanaryVerifiedSummary', payload)
      === claimedHash;
}

export function autonomousResearchSupervisorProviderCanaryProgressEvidenceValid(
  evidence,
  marker,
) {
  const reservation = marker?.reservation || marker;
  if (evidence?.kind === 'AutonomousResearchSupervisorExternalActionMayHaveStarted') {
    return evidence?.version === 1
      && evidence?.actionKind
        === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY
      && evidence?.attemptId === marker?.attemptId
      && evidence?.reservationHash === marker?.reservationHash
      && evidence?.externalActionMayHaveStarted === true;
  }
  return evidence?.kind === 'AutonomousResearchSupervisorProviderCanaryProgress'
    && evidence?.role === 'research_author'
    && SHA256.test(String(evidence?.providerCanaryReceiptHash || ''))
    && evidence?.providerConfigurationHash === reservation?.providerConfigurationHash;
}

export function createAutonomousResearchSupervisorProviderCanaryStateOperations({
  database,
  mutationCoordinator,
  databaseInstanceId,
  schemaContractId,
  writerId,
  journalSupport,
  requireOpen,
  row,
  fencedRow,
  leaseIdentity,
  timestamp,
  requireExternallyFencedMutations = false,
} = {}) {
  const providerCanaryActionPermits = new WeakMap();
  function mutationValue(receipt) {
    if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
      throw new Error('autonomous_research_supervisor_state_mutation_receipt_invalid');
    }
    return receipt.value;
  }

  const mutationInput = Object.freeze({
      database,
      databaseInstanceId,
      schemaContractId,
      writerId,
      authorizationReceiptHashes: Object.freeze([]),
      sideEffectReservationHashes: Object.freeze([]),
  });

  return Object.freeze({
    beginProviderCanary({ lease, providerConfigurationHash, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      if (!SHA256.test(String(providerConfigurationHash || ''))) {
        throw new Error('autonomous_research_supervisor_provider_configuration_hash_required');
      }
      const actionPlan = providerCanaryActionPlan({
        current: fencedRow(identity, observedAt),
        identity,
        providerConfigurationHash,
        observedAt,
      });
      const mutationReceipt = mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-provider-canary-state-operations.beginProviderCanary.v1',
        sideEffectReservationHashes: [actionPlan.reservationHash],
        mutate(transaction) {
        const current = fencedRow(identity, observedAt, transaction);
        const lastAt = Date.parse(current.lastProviderCanaryAt || '');
        if (Number.isFinite(lastAt)
          && lastAt + current.policy.providerCanaryIntervalMs > observedAt.getTime()
          && current.lastProviderCanaryStatus === 'verified'
          && SHA256.test(String(current.lastProviderCanaryReceiptHash || ''))) {
          return Object.freeze({ authorized: true, required: false });
        }
        const nextCost = current.providerCanaryReservedCostUsd
          + current.policy.providerCanaryReservationCostUsd;
        const totalCost = current.observedCampaignCostUsd
          + current.observedQualificationReservedCostUsd + nextCost;
        let blocker = null;
        if (current.providerCanaryCount >= current.policy.maximumProviderCanaries) {
          blocker = 'supervisor_provider_canary_budget_exhausted';
        } else if (totalCost > current.policy.maximumLifecycleCostUsd) {
          blocker = 'supervisor_lifecycle_cost_budget_exhausted';
        }
        if (blocker) {
          transaction.run(
            'supervisor-state.campaign-block.apply.v1',
            blocker, observedAt.toISOString(), current.campaignId,
          );
          return Object.freeze({ authorized: false, required: true, blocker });
        }
        transaction.run(
          'supervisor-state.campaign-canary-reserve.apply.v1',
          nextCost, observedAt.toISOString(), observedAt.toISOString(), current.campaignId,
        );
        const reserved = row(current.campaignId, transaction);
        if (reserved.campaignId !== actionPlan.reservation.campaignId
          || reserved.dispatchCount !== actionPlan.reservation.dispatchCount
          || reserved.providerCanaryCount !== actionPlan.providerCanaryCount
          || reserved.lifecycleStartedAt
            !== actionPlan.providerCanaryReservation.budgetEpochStart
          || reserved.policy.providerCanaryReservationCostUsd
            !== actionPlan.providerCanaryReservation.providerCanaryReservedCostUsd) {
          throw new Error('autonomous_research_supervisor_provider_canary_fence_conflict');
        }
        const attempt = journalSupport.insertInTransaction({
          transaction, identity,
          current: reserved,
          actionKind:
            AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY,
          reservation: actionPlan.reservation,
          observedAt,
        });
        if (attempt.reservationHash !== actionPlan.reservationHash) {
          throw new Error('autonomous_research_supervisor_provider_canary_fence_conflict');
        }
        return Object.freeze({
          authorized: true,
          required: true,
          providerCanaryReservation: actionPlan.providerCanaryReservation,
          externalActionAttempt: attempt,
        });
        },
      });
      const authorization = mutationValue(mutationReceipt);
      if (authorization?.authorized === true && authorization?.required === true) {
        assertFinalizedSideEffectPermit({
          receipt: mutationReceipt,
          required: requireExternallyFencedMutations,
          reservationHash: actionPlan.reservationHash,
        });
        providerCanaryActionPermits.set(authorization, Object.freeze({
          required: requireExternallyFencedMutations,
          reservationHash: actionPlan.reservationHash,
          sideEffectPermitHash: mutationReceipt.sideEffectPermitHash || null,
        }));
      }
      return authorization;
    },
    assertProviderCanarySideEffectPermit({ authorization } = {}) {
      const permit = providerCanaryActionPermits.get(authorization);
      providerCanaryActionPermits.delete(authorization);
      if (!permit
        || permit.reservationHash
          !== authorization?.externalActionAttempt?.reservationHash
        || (permit.required && !SHA256.test(String(permit.sideEffectPermitHash || '')))) {
        throw new Error(
          'autonomous_research_supervisor_provider_canary_side_effect_permit_invalid',
        );
      }
      return true;
    },
    cancelProviderCanaryInfrastructureDeferred({
      lease,
      authorization,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const attempt = authorization?.externalActionAttempt || null;
      const cancelled = mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-provider-canary-state-operations.cancelProviderCanaryInfrastructureDeferred.v1',
        mutate(transaction) {
          const externalAction = journalSupport.requireFencedAttempt(
            identity, attempt, observedAt, transaction,
          );
          if (externalAction.actionKind
            !== AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY
            || externalAction.progress !== null) {
            throw new Error(
              'autonomous_research_supervisor_provider_canary_infrastructure_cancel_fence_lost',
            );
          }
          const current = fencedRow(identity, observedAt, transaction);
          const reservation = externalAction.marker.reservation;
          const prior = reservation.priorProviderCanaryState;
          if (!prior
            || current.dispatchCount !== reservation.dispatchCount
            || current.providerCanaryCount
              !== reservation.providerCanaryReservation.generationSequence
            || current.providerCanaryReservedCostUsd
              !== prior.providerCanaryReservedCostUsd
                + reservation.providerCanaryReservation.providerCanaryReservedCostUsd) {
            throw new Error(
              'autonomous_research_supervisor_provider_canary_infrastructure_cancel_fence_lost',
            );
          }
          journalSupport.finishInTransaction({
            transaction,
            identity,
            attempt,
            observedAt,
            successful: false,
            evidence: null,
            actionAccountingComplete: false,
            externalActionPerformed: false,
            blocker: 'autonomous_research_state_recoverability_deferred_before_provider_action',
          });
          const result = transaction.run(
            'supervisor-state.campaign-canary-infrastructure-cancel.apply.v1',
            prior.providerCanaryCount,
            prior.providerCanaryReservedCostUsd,
            prior.lastProviderCanaryAt,
            prior.lastProviderCanaryStatus,
            prior.lastProviderCanaryReceiptHash,
            observedAt.toISOString(),
            identity.campaignId,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
            reservation.dispatchCount,
            reservation.providerCanaryReservation.generationSequence,
          );
          if (Number(result.changes) !== 1) {
            throw new Error(
              'autonomous_research_supervisor_provider_canary_infrastructure_cancel_fence_lost',
            );
          }
          return row(identity.campaignId, transaction);
        },
      }));
      providerCanaryActionPermits.delete(authorization);
      return cancelled;
    },
    finishProviderCanary({
      lease,
      attempt,
      verified,
      receiptHash = null,
      receipt = null,
      sideEffectInspection = null,
      error = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      if (verified && !SHA256.test(String(receiptHash || ''))) {
        throw new Error('autonomous_research_supervisor_provider_canary_receipt_required');
      }
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-provider-canary-state-operations.finishProviderCanary.v1',
        mutate(transaction) {
        const externalAction = journalSupport.requireFencedAttempt(
          identity, attempt, observedAt, transaction,
        );
        if (externalAction.actionKind
          !== AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
          throw new Error('autonomous_research_supervisor_provider_canary_attempt_invalid');
        }
        const reservation = externalAction.marker.reservation;
        let evidence = null;
        let actionAccountingComplete = false;
        let externalActionPerformed = false;
        if (verified) {
          evidence = providerCanaryPairReceiptValid(receipt)
            && receipt.providerCanaryPairReceiptHash === receiptHash
            ? receipt : providerCanaryVerifiedSummary({
              marker: externalAction.marker, receiptHash,
            });
          if (!autonomousResearchSupervisorProviderCanarySuccessEvidenceValid(
            evidence, externalAction.marker,
          )) {
            throw new Error('autonomous_research_supervisor_provider_canary_receipt_invalid');
          }
          actionAccountingComplete = true;
          externalActionPerformed = true;
        } else if (sideEffectInspection !== null) {
          if (!verifyAutonomousResearchProviderCanarySideEffectInspection(
            sideEffectInspection,
            {
              providerConfigurationHash: reservation.providerConfigurationHash,
              reservation: reservation.providerCanaryReservation,
            },
          )) {
            throw new Error(
              'autonomous_research_supervisor_provider_canary_side_effect_inspection_invalid',
            );
          }
          evidence = sideEffectInspection;
          actionAccountingComplete = sideEffectInspection.actionAccountingComplete;
          externalActionPerformed = sideEffectInspection.externalActionPerformed;
        }
        journalSupport.finishInTransaction({
          transaction, identity,
          attempt,
          observedAt,
          successful: Boolean(verified),
          evidence,
          actionAccountingComplete,
          externalActionPerformed,
          blocker: verified ? null : String(error?.message || error
            || 'autonomous_research_supervisor_provider_canary_failed'),
        });
        const result = transaction.run(
          'supervisor-state.campaign-canary-finish.apply.v1',
          verified ? 'verified' : 'failed',
          verified ? String(receiptHash) : null,
          error ? String(error).slice(0, 1000) : null,
          observedAt.toISOString(), identity.campaignId, identity.ownerId,
          identity.leaseToken, identity.leaseGeneration,
        );
        if (Number(result.changes) !== 1) {
          throw new Error('autonomous_research_supervisor_lease_lost');
        }
        return row(identity.campaignId, transaction);
        },
      }));
    },
  });
}
