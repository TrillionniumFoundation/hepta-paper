import crypto from 'node:crypto';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
  buildAutonomousResearchSupervisorExternalActionAttemptMarker,
  buildAutonomousResearchSupervisorExternalActionAttemptReceipt,
  buildAutonomousResearchSupervisorExternalActionProgressReceipt,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import {
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {
  verifyAutomationReadinessSideEffectInspection,
} from '../../paper-domain/automation/automation-readiness-side-effect-inspection.mjs';
import {
  autonomousResearchSupervisorExternalActionStableKey,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-recovery-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertAutonomousResearchSupervisorFinalizedSideEffectPermit,
  autonomousResearchSupervisorExternalActionReservationValid,
  autonomousResearchSupervisorSideEffectReservationHash,
  mapAutonomousResearchSupervisorExternalActionRow,
} from './autonomous-research-supervisor-external-action-journal-storage.mjs';
import {
  autonomousResearchStateMutationValue,
  buildAutonomousResearchStateMutationInput,
} from './autonomous-research-state-mutation-support.mjs';

export {
  installAutonomousResearchSupervisorExternalActionJournalSchema,
} from './autonomous-research-supervisor-external-action-journal-storage.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function createAutonomousResearchSupervisorExternalActionRepositorySupport({
  database,
  mutationCoordinator,
  databaseInstanceId,
  schemaContractId,
  writerId,
  requireOpen,
  fencedRow,
  leaseIdentity,
  timestamp,
  providerCanarySuccessEvidenceValid,
  providerCanaryProgressEvidenceValid,
  requireExternallyFencedMutations = false,
} = {}) {
  const externalActionPermits = new WeakMap();
  const mutationValue = autonomousResearchStateMutationValue;
  const mutationInput = buildAutonomousResearchStateMutationInput({
    database,
    databaseInstanceId,
    schemaContractId,
    writerId,
  });

  function externalActionRow(attemptId, transaction = null) {
    requireOpen();
    const value = transaction
      ? transaction.get('supervisor-state.external-attempt.get.v1', attemptId)
      : database.prepare(
        `SELECT * FROM autonomous_research_supervisor_external_action_journal
          WHERE attempt_id=?`,
      ).get(attemptId);
    return mapAutonomousResearchSupervisorExternalActionRow(value);
  }

  function activeAttemptForCampaign(campaignId, transaction = null) {
    const value = transaction
      ? transaction.get('supervisor-state.external-active.get.v1', campaignId)
      : database.prepare(`SELECT * FROM
        autonomous_research_supervisor_external_action_journal
        WHERE campaign_id=? AND status='in_progress'`).get(campaignId);
    return mapAutonomousResearchSupervisorExternalActionRow(value);
  }

  function attemptForIdempotencyKey(idempotencyKey, transaction = null) {
    const value = transaction
      ? transaction.get('supervisor-state.external-idempotency.get.v1', idempotencyKey)
      : database.prepare(`SELECT * FROM
        autonomous_research_supervisor_external_action_journal
        WHERE idempotency_key=?`).get(idempotencyKey);
    return mapAutonomousResearchSupervisorExternalActionRow(value);
  }

  function insertInTransaction({
    transaction, identity, current, actionKind, reservation, observedAt,
  }) {
    if (!autonomousResearchSupervisorExternalActionReservationValid(
      actionKind,
      reservation,
      current,
    )) {
      throw new Error('autonomous_research_supervisor_external_action_reservation_invalid');
    }
    const attemptId = `external-action:${crypto.randomUUID()}`;
    const idempotencyKey = autonomousResearchSupervisorExternalActionStableKey({
      campaignId: current.campaignId,
      actionKind,
      dispatchCount: current.dispatchCount,
      providerCanaryCount: current.providerCanaryCount,
      providerConfigurationHash: reservation.providerConfigurationHash,
      actionConfigurationIdentityHash:
        reservation.externalActionConfigurationIdentityHash
          || reservation.providerConfigurationHash,
      attemptScopeHash: reservation.providerCanaryReservation?.plannedGenerationHash
        || reservation.dispatchAuthorizationHash,
      action: reservation.action || null,
      launchMode: reservation.launchMode || null,
    });
    const existing = attemptForIdempotencyKey(idempotencyKey, transaction);
    if (existing) {
      if (existing.campaignId !== current.campaignId
        || existing.actionKind !== actionKind
        || existing.dispatchCount !== current.dispatchCount
        || !['in_progress', 'completed', 'failed'].includes(existing.status)) {
        throw new Error(
          'autonomous_research_supervisor_external_action_idempotency_conflict',
        );
      }
      return existing;
    }
    const marker = buildAutonomousResearchSupervisorExternalActionAttemptMarker({
      attemptId,
      campaignId: current.campaignId,
      actionKind,
      reservation,
      dispatchCount: current.dispatchCount,
      providerCanaryCount: current.providerCanaryCount,
      leaseGeneration: identity.leaseGeneration,
      idempotencyKey,
      startedAt: observedAt.toISOString(),
    });
    transaction.run(
      'supervisor-state.external-start.apply.v1',
      marker.attemptId, marker.campaignId, marker.actionKind, marker.reservationHash,
      marker.idempotencyKey,
      marker.leaseGeneration, marker.dispatchCount, marker.providerCanaryCount,
      'in_progress', JSON.stringify(marker),
      marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash, marker.startedAt,
    );
    return externalActionRow(attemptId, transaction);
  }

  function requireFencedAttempt(identity, attempt, observedAt, transaction) {
    fencedRow(identity, observedAt, transaction);
    const value = externalActionRow(attempt?.attemptId || attempt, transaction);
    if (!value || value.status !== 'in_progress'
      || value.campaignId !== identity.campaignId
      || value.leaseGeneration !== identity.leaseGeneration
      || (attempt?.reservationHash && attempt.reservationHash !== value.reservationHash)) {
      throw new Error('autonomous_research_supervisor_external_action_fence_conflict');
    }
    return value;
  }

  function finishInTransaction({
    transaction,
    identity,
    attempt,
    observedAt,
    successful,
    evidence,
    actionAccountingComplete,
    externalActionPerformed,
    blocker,
  }) {
    const current = requireFencedAttempt(identity, attempt, observedAt, transaction);
    if (current.actionKind
      === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
      const reservation = current.marker.reservation;
      const validSuccess = successful === true
        && providerCanarySuccessEvidenceValid(evidence, current.marker)
        && actionAccountingComplete === true && externalActionPerformed === true;
      const validFailure = successful === false && (evidence === null
        || verifyAutonomousResearchProviderCanarySideEffectInspection(evidence, {
          providerConfigurationHash: reservation.providerConfigurationHash,
          reservation: reservation.providerCanaryReservation,
        })) && (evidence === null
        ? actionAccountingComplete === false
        : actionAccountingComplete === evidence.actionAccountingComplete
          && externalActionPerformed === evidence.externalActionPerformed);
      if (!validSuccess && !validFailure) {
        throw new Error('autonomous_research_supervisor_provider_canary_receipt_invalid');
      }
    } else {
      const validInspection = verifyAutomationReadinessSideEffectInspection(evidence);
      if ((successful === true && !validInspection)
        || (evidence !== null && !validInspection)
        || (successful === false && evidence === null && actionAccountingComplete !== false)
        || (validInspection && externalActionPerformed !== evidence.externalActionPerformed)) {
        throw new Error('autonomous_research_supervisor_readiness_receipt_invalid');
      }
    }
    const status = successful === true ? 'completed' : 'failed';
    const receipt = buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
      marker: current.marker,
      status,
      evidence,
      lastProgress: current.progress,
      completedAt: observedAt.toISOString(),
      actionAccountingComplete,
      externalActionPerformed,
      blocker,
    });
    const result = transaction.run(
      'supervisor-state.external-finish.apply.v1',
      status, JSON.stringify(receipt),
      receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash,
      receipt.completedAt, current.attemptId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error('autonomous_research_supervisor_external_action_fence_conflict');
    }
    return externalActionRow(current.attemptId, transaction);
  }

  function recoverAttemptInTransaction({ transaction, attempt, observedAt, blocker }) {
    const receipt = buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
      marker: attempt.marker,
      status: 'recovered_incomplete',
      evidence: null,
      lastProgress: attempt.progress,
      completedAt: observedAt.toISOString(),
      actionAccountingComplete: false,
      externalActionPerformed: Boolean(attempt.progress),
      blocker,
    });
    const updated = transaction.run(
      'supervisor-state.external-recover.apply.v1',
      JSON.stringify(receipt),
      receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash,
      receipt.completedAt,
      attempt.attemptId,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error('autonomous_research_supervisor_external_action_recovery_conflict');
    }
    return receipt;
  }

  function cancelAttemptBeforeStartInTransaction({
    transaction,
    attempt,
    observedAt,
    blocker,
  }) {
    if (attempt.status !== 'in_progress' || attempt.progress !== null) {
      throw new Error(
        'autonomous_research_supervisor_external_action_pre_start_cancel_invalid',
      );
    }
    const receipt = buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
      marker: attempt.marker,
      status: 'failed',
      evidence: null,
      lastProgress: null,
      completedAt: observedAt.toISOString(),
      actionAccountingComplete: true,
      externalActionPerformed: false,
      blocker,
    });
    const updated = transaction.run(
      'supervisor-state.external-finish.apply.v1',
      'failed',
      JSON.stringify(receipt),
      receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash,
      receipt.completedAt,
      attempt.attemptId,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error('autonomous_research_supervisor_external_action_recovery_conflict');
    }
    return receipt;
  }

  function markProviderAttemptInterrupted(transaction, attempt) {
    if (attempt.actionKind
      !== AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) return;
    transaction.run(
      'supervisor-state.campaign-canary-interrupted.apply.v1',
      'autonomous_research_supervisor_provider_canary_interrupted',
      attempt.campaignId,
    );
  }

  function completeRecoveryInTransaction({
    transaction,
    attempt,
    resolution,
    observedAt,
  }) {
    if (attempt.status !== 'in_progress' || !attempt.progress
      || !['completed', 'failed'].includes(resolution?.outcome)
      || resolution.actionKind !== attempt.actionKind
      || resolution.idempotencyKey !== attempt.idempotencyKey
      || resolution.markerHash
        !== attempt.marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash
      || resolution.reservationHash !== attempt.reservationHash
      || resolution.actionConfigurationIdentityHash
        !== (attempt.marker.reservation.externalActionConfigurationIdentityHash
          || attempt.marker.reservation.providerConfigurationHash)
      || resolution.progressHash
        !== attempt.progress.autonomousResearchSupervisorExternalActionProgressReceiptHash
      || resolution.actionAccountingComplete !== true
      || !resolution.result || typeof resolution.result !== 'object'
      || Array.isArray(resolution.result)) {
      throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
    }
    const successful = resolution.outcome === 'completed';
    let evidence = null;
    if (attempt.actionKind
      === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
      evidence = successful
        ? resolution.result.providerCanaryPairReceipt || null
        : resolution.result.sideEffectInspection || null;
      if ((successful && !providerCanarySuccessEvidenceValid(evidence, attempt.marker))
        || (!successful && !verifyAutonomousResearchProviderCanarySideEffectInspection(
          evidence,
          {
            providerConfigurationHash: attempt.marker.reservation.providerConfigurationHash,
            reservation: attempt.marker.reservation.providerCanaryReservation,
          },
        ))) {
        throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
      }
    } else {
      evidence = resolution.result.sideEffectInspection || null;
      const actionResult = resolution.result.actionResult;
      const productionReport = actionResult?.report || actionResult?.readiness || actionResult;
      const embeddedInspection = attempt.actionKind
        === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS
        ? productionReport?.readinessSideEffectInspection || null
        : evidence;
      if (!verifyAutomationReadinessSideEffectInspection(evidence)
        || !actionResult || typeof actionResult !== 'object' || Array.isArray(actionResult)
        || JSON.stringify(embeddedInspection) !== JSON.stringify(evidence)) {
        throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
      }
    }
    if (resolution.externalActionPerformed !== evidence.externalActionPerformed) {
      throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
    }
    const status = successful ? 'completed' : 'failed';
    const receipt = buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
      marker: attempt.marker,
      status,
      evidence,
      lastProgress: attempt.progress,
      completedAt: resolution.completedAt || observedAt.toISOString(),
      actionAccountingComplete: true,
      externalActionPerformed: resolution.externalActionPerformed,
      blocker: successful ? null
        : 'autonomous_research_supervisor_external_action_recovered_failure',
    });
    const updated = transaction.run(
      'supervisor-state.external-finish.apply.v1',
      status, JSON.stringify(receipt),
      receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash,
      receipt.completedAt, attempt.attemptId,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error('autonomous_research_supervisor_external_action_recovery_conflict');
    }
    const recoveryResultHash = storeRecoveryResultInTransaction({
      transaction, attempt, result: resolution.result,
    });
    return Object.freeze({ receipt, recoveryResultHash, evidence, successful });
  }

  function storeRecoveryResultInTransaction({ transaction, attempt, result }) {
    const resultHash = hashRecord(
      'AutonomousResearchSupervisorExternalActionRecoveryResult',
      {
        actionKind: attempt.actionKind,
        idempotencyKey: attempt.idempotencyKey,
        result,
      },
    );
    const updated = transaction.run(
      'supervisor-state.external-recovery-result.apply.v1',
      JSON.stringify(result), resultHash, attempt.attemptId,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error('autonomous_research_supervisor_external_action_recovery_conflict');
    }
    return resultHash;
  }

  return Object.freeze({
    activeAttemptForCampaign,
    insertInTransaction,
    requireFencedAttempt,
    finishInTransaction,
    cancelInfrastructureDeferred({
      lease,
      attempt = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-external-action-repository-support.cancelInfrastructureDeferred.v1',
        mutate(transaction) {
          const current = fencedRow(identity, observedAt, transaction);
          const active = attempt
            ? requireFencedAttempt(identity, attempt, observedAt, transaction)
            : activeAttemptForCampaign(identity.campaignId, transaction);
          if (!active) return Object.freeze({ cancelled: false });
          if (active.actionKind
              === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY
            || active.progress !== null
            || active.dispatchCount !== current.dispatchCount) {
            throw new Error(
              'autonomous_research_supervisor_external_action_infrastructure_cancel_fence_lost',
            );
          }
          const finished = finishInTransaction({
            transaction,
            identity,
            attempt: active,
            observedAt,
            successful: false,
            evidence: null,
            actionAccountingComplete: false,
            externalActionPerformed: false,
            blocker: 'autonomous_research_supervisor_infrastructure_deferred_before_external_action',
          });
          const result = transaction.run(
            'supervisor-state.campaign-external-infrastructure-cancel.apply.v1',
            observedAt.toISOString(), identity.campaignId, identity.ownerId,
            identity.leaseToken, identity.leaseGeneration,
            active.dispatchCount, active.dispatchCount, identity.leaseGeneration,
            identity.campaignId, active.dispatchCount,
            active.attemptId,
          );
          if (Number(result.changes) !== 1) {
            throw new Error(
              'autonomous_research_supervisor_external_action_infrastructure_cancel_fence_lost',
            );
          }
          externalActionPermits.delete(attempt || active);
          return Object.freeze({
            cancelled: true,
            attempt: finished,
            campaign: fencedRow(identity, observedAt, transaction),
          });
        },
      }));
    },
    beginExternalActionAttempt({ lease, actionKind, reservation, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const current = fencedRow(identity, observedAt);
      const idempotencyKey = autonomousResearchSupervisorExternalActionStableKey({
        campaignId: current.campaignId,
        actionKind,
        dispatchCount: current.dispatchCount,
        providerCanaryCount: current.providerCanaryCount,
        providerConfigurationHash: reservation?.providerConfigurationHash,
        actionConfigurationIdentityHash:
          reservation?.externalActionConfigurationIdentityHash
            || reservation?.providerConfigurationHash,
        attemptScopeHash: reservation?.providerCanaryReservation?.plannedGenerationHash
          || reservation?.dispatchAuthorizationHash,
        action: reservation?.action || null,
        launchMode: reservation?.launchMode || null,
      });
      const prior = attemptForIdempotencyKey(idempotencyKey);
      const reservationHash = prior?.reservationHash
        || autonomousResearchSupervisorSideEffectReservationHash({
        campaignId: identity.campaignId,
        actionKind,
        reservation,
      });
      const mutationReceipt = mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-external-action-repository-support.beginExternalActionAttempt.v1',
        sideEffectReservationHashes: [reservationHash],
        mutate(transaction) {
        const current = fencedRow(identity, observedAt, transaction);
        const attempt = insertInTransaction({
          transaction, identity, current, actionKind, reservation, observedAt,
        });
        return attempt;
        },
      });
      const attempt = mutationValue(mutationReceipt);
      if (attempt?.reservationHash !== reservationHash
        || attempt?.idempotencyKey !== idempotencyKey) {
        throw new Error('autonomous_research_supervisor_external_action_reservation_invalid');
      }
      if (attempt.status !== 'in_progress') return attempt;
      assertAutonomousResearchSupervisorFinalizedSideEffectPermit({
        receipt: mutationReceipt,
        required: requireExternallyFencedMutations,
        reservationHash,
      });
      externalActionPermits.set(attempt, Object.freeze({
        required: requireExternallyFencedMutations,
        reservationHash,
        sideEffectPermitHash: mutationReceipt.sideEffectPermitHash || null,
      }));
      return attempt;
    },
    assertExternalActionSideEffectPermit({ attempt } = {}) {
      const permit = externalActionPermits.get(attempt);
      externalActionPermits.delete(attempt);
      if (!permit || permit.reservationHash !== attempt?.reservationHash
        || (permit.required && !SHA256.test(String(permit.sideEffectPermitHash || '')))) {
        throw new Error(
          'autonomous_research_supervisor_external_action_side_effect_permit_invalid',
        );
      }
      return true;
    },
    recordExternalActionProgress({ lease, attempt, evidence, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-external-action-repository-support.recordExternalActionProgress.v1',
        mutate(transaction) {
        const campaign = fencedRow(identity, observedAt, transaction);
        const current = requireFencedAttempt(identity, attempt, observedAt, transaction);
        if (current.actionKind
          === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY
          && !providerCanaryProgressEvidenceValid(
            evidence, current.marker,
          )) {
          throw new Error('autonomous_research_supervisor_external_action_progress_invalid');
        }
        const progress = buildAutonomousResearchSupervisorExternalActionProgressReceipt({
          marker: current.marker,
          evidence,
          sequence: (current.progress?.sequence || 0) + 1,
          recordedAt: observedAt.toISOString(),
        });
        const result = transaction.run(
          'supervisor-state.external-progress.apply.v1',
          JSON.stringify(progress),
          progress.autonomousResearchSupervisorExternalActionProgressReceiptHash,
          current.attemptId,
        );
        if (Number(result.changes) !== 1) {
          throw new Error('autonomous_research_supervisor_external_action_fence_conflict');
        }
        if (campaign.activeDispatchPhase === 'reserved') {
          const started = transaction.run(
            'supervisor-state.campaign-dispatch-started.apply.v1',
            observedAt.toISOString(), identity.campaignId, current.dispatchCount,
            identity.leaseGeneration,
          );
          if (Number(started.changes) !== 1) {
            throw new Error('autonomous_research_supervisor_dispatch_started_fence_lost');
          }
        } else if (campaign.activeDispatchPhase !== 'started'
          || campaign.activeDispatchCount !== current.dispatchCount) {
          throw new Error('autonomous_research_supervisor_dispatch_started_fence_lost');
        }
        return externalActionRow(current.attemptId, transaction);
        },
      }));
    },
    finishExternalActionAttempt({
      lease,
      attempt,
      successful,
      evidence = null,
      actionAccountingComplete = true,
      externalActionPerformed = false,
      blocker = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-external-action-repository-support.finishExternalActionAttempt.v1',
        mutate: (transaction) => finishInTransaction({
          transaction, identity, attempt, observedAt, successful, evidence,
          actionAccountingComplete, externalActionPerformed, blocker,
        }),
      }));
    },
    getExternalActionAttempt(attemptId) {
      return externalActionRow(attemptId);
    },
    listExternalActionAttempts({ campaignId, limit = 1000 } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(campaignId || ''))) {
        throw new Error('autonomous_research_supervisor_campaign_scope_invalid');
      }
      const bounded = Math.max(1, Math.min(10_000, Number(limit || 1000)));
      return Object.freeze(database.prepare(`SELECT * FROM
        autonomous_research_supervisor_external_action_journal WHERE campaign_id=?
        ORDER BY started_at,attempt_id LIMIT ?`).all(campaignId, bounded)
        .map(mapAutonomousResearchSupervisorExternalActionRow));
    },
    staleAttemptsInTransaction({ transaction, observedAt }) {
      return Object.freeze(transaction.all(
        'supervisor-state.external-stale.all.v1',
        observedAt.toISOString(),
      )
        .map(mapAutonomousResearchSupervisorExternalActionRow));
    },
    cancelAttemptBeforeStartInTransaction,
    completeRecoveryInTransaction,
    storeRecoveryResultInTransaction,
    recoverActiveAttemptInTransaction({ transaction, current, observedAt, blocker }) {
      const attempt = current.activeExternalActionAttempt;
      if (!attempt) return null;
      const receipt = recoverAttemptInTransaction({
        transaction, attempt, observedAt, blocker,
      });
      markProviderAttemptInterrupted(transaction, attempt);
      return receipt;
    },
  });
}
