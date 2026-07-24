import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';

function cancelStaleDispatch({ transaction, current, observedAt }) {
  const result = transaction.run(
    'supervisor-state.campaign-stale-dispatch-cancel.apply.v1',
    observedAt.toISOString(), current.campaignId, current.dispatchCount,
    current.activeDispatchCount, current.activeDispatchLeaseGeneration,
  );
  if (Number(result.changes) !== 1) {
    throw new Error('autonomous_research_supervisor_stale_dispatch_cancel_conflict');
  }
}

function cancelStaleProvider({ transaction, current, attempt, observedAt }) {
  const reservation = attempt.marker.reservation;
  const prior = reservation?.priorProviderCanaryState;
  if (!prior || reservation.dispatchCount !== current.dispatchCount
    || reservation.providerCanaryReservation?.generationSequence
      !== current.providerCanaryCount) {
    throw new Error('autonomous_research_supervisor_stale_provider_cancel_invalid');
  }
  const result = transaction.run(
    'supervisor-state.campaign-stale-provider-cancel.apply.v1',
    prior.providerCanaryCount,
    prior.providerCanaryReservedCostUsd,
    prior.lastProviderCanaryAt,
    prior.lastProviderCanaryStatus,
    prior.lastProviderCanaryReceiptHash,
    observedAt.toISOString(),
    current.campaignId,
    current.dispatchCount,
    current.providerCanaryCount,
    current.activeDispatchCount,
    current.activeDispatchLeaseGeneration,
  );
  if (Number(result.changes) !== 1) {
    throw new Error('autonomous_research_supervisor_stale_provider_cancel_conflict');
  }
}

export function reconcileAutonomousResearchSupervisorStaleDispatchesInTransaction({
  transaction,
  observedAt,
  row,
  journalSupport,
} = {}) {
  const candidates = transaction.all(
    'supervisor-state.dispatch-stale.all.v1',
    observedAt.toISOString(),
  );
  const cancelledReceipts = [];
  const recoveryPendingAttempts = [];
  let cancelledDispatchCount = 0;
  let resumableDispatchCount = 0;
  for (const candidate of candidates) {
    const current = row(candidate.campaign_id, transaction);
    if (!current?.activeDispatchPhase) continue;
    const attempt = current.activeExternalActionAttempt;
    if (current.activeDispatchPhase === 'reserved' && !attempt?.progress) {
      if (attempt) {
        cancelledReceipts.push(journalSupport.cancelAttemptBeforeStartInTransaction({
          transaction,
          attempt,
          observedAt,
          blocker: 'autonomous_research_supervisor_stale_external_action_cancelled_before_start',
        }));
      }
      if (attempt?.actionKind
        === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
        cancelStaleProvider({ transaction, current, attempt, observedAt });
      } else {
        cancelStaleDispatch({ transaction, current, observedAt });
      }
      cancelledDispatchCount += 1;
      continue;
    }
    if (attempt?.progress) {
      const pending = transaction.run(
        'supervisor-state.campaign-dispatch-recovery-pending.apply.v1',
        observedAt.toISOString(), current.campaignId, current.activeDispatchCount,
        current.activeDispatchLeaseGeneration,
      );
      if (Number(pending.changes) !== 1) {
        throw new Error('autonomous_research_supervisor_dispatch_recovery_pending_conflict');
      }
      recoveryPendingAttempts.push(attempt);
      continue;
    }
    if (!attempt && ['started', 'resumable'].includes(current.activeDispatchPhase)) {
      const resumable = transaction.run(
        'supervisor-state.campaign-dispatch-recovery-resolved.apply.v1',
        observedAt.toISOString(), current.campaignId, current.activeDispatchCount,
      );
      if (Number(resumable.changes) !== 1) {
        throw new Error('autonomous_research_supervisor_dispatch_resume_conflict');
      }
      resumableDispatchCount += 1;
      continue;
    }
    throw new Error('autonomous_research_supervisor_stale_dispatch_state_invalid');
  }
  return Object.freeze({
    inspectedDispatchCount: candidates.length,
    cancelledDispatchCount,
    resumableDispatchCount,
    cancelledReceipts: Object.freeze(cancelledReceipts),
    recoveryPendingAttempts: Object.freeze(recoveryPendingAttempts),
  });
}
