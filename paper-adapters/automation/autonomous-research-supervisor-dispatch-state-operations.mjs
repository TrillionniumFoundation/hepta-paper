import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousResearchSupervisorLeaseIdentity as leaseIdentity,
  autonomousResearchSupervisorTimestamp as timestamp,
  boundedAutonomousResearchSupervisorOutcome as boundedOutcome,
} from './autonomous-research-supervisor-state-model.mjs';

export function createAutonomousResearchSupervisorDispatchStateOperations({
  mutationCoordinator,
  mutationInput,
  requireOpen,
  fencedRow,
  row,
  mutationValue,
  externalActionSupport,
} = {}) {
  return Object.freeze({
    beginDispatch({ lease, campaignCostLimitUsd, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId: 'supervisor-state.supervisor-state-repository.beginDispatch.v1',
        mutate(transaction) {
          const current = fencedRow(identity, observedAt, transaction);
          if (current.activeDispatchPhase === 'resumable') {
            const resumed = transaction.run(
              'supervisor-state.campaign-dispatch-resume.apply.v1',
              identity.leaseGeneration,
              observedAt.toISOString(),
              current.campaignId,
            );
            if (Number(resumed.changes) !== 1) {
              throw new Error('autonomous_research_supervisor_dispatch_resume_conflict');
            }
            return Object.freeze({
              authorized: true,
              resumed: true,
              dispatchCount: current.activeDispatchCount,
              dispatchReservationHash: current.activeDispatchReservationHash,
            });
          }
          if (current.activeDispatchPhase !== null) {
            throw new Error('autonomous_research_supervisor_active_dispatch_conflict');
          }
          const reservedEnvelope = Number(campaignCostLimitUsd)
            + current.policy.qualificationMaximumTotalCostUsd
            + current.providerCanaryReservedCostUsd
            + current.policy.providerCanaryReservationCostUsd;
          let blocker = null;
          if (!Number.isFinite(Number(campaignCostLimitUsd)) || campaignCostLimitUsd < 0) {
            blocker = 'supervisor_campaign_cost_limit_unknown';
          } else if (reservedEnvelope > current.policy.maximumLifecycleCostUsd) {
            blocker = 'supervisor_lifecycle_cost_envelope_exceeded';
          } else if (current.dispatchCount >= current.policy.maximumDispatches) {
            blocker = 'supervisor_lifecycle_dispatch_budget_exhausted';
          } else if (Date.parse(current.absoluteDeadlineAt) <= observedAt.getTime()) {
            blocker = 'supervisor_lifecycle_deadline_exhausted';
          } else if (!current.costKnown) {
            blocker = 'supervisor_lifecycle_cost_unknown';
          }
          if (blocker) {
            transaction.run(
              'supervisor-state.campaign-block.apply.v1',
              blocker,
              observedAt.toISOString(),
              current.campaignId,
            );
            return Object.freeze({ authorized: false, blocker });
          }
          const nextDispatchCount = current.dispatchCount + 1;
          const dispatchReservationHash = hashRecord(
            'AutonomousResearchSupervisorDispatchReservation',
            {
              campaignId: current.campaignId,
              paperId: current.paperId,
              dispatchCount: nextDispatchCount,
              lifecyclePolicyHash: current.policy.lifecyclePolicyHash,
            },
          );
          const inserted = transaction.run(
            'supervisor-state.campaign-dispatch-begin.apply.v1',
            identity.leaseGeneration,
            dispatchReservationHash,
            observedAt.toISOString(),
            current.campaignId,
          );
          if (Number(inserted.changes) !== 1) {
            throw new Error('autonomous_research_supervisor_active_dispatch_conflict');
          }
          return Object.freeze({
            authorized: true,
            resumed: false,
            dispatchCount: nextDispatchCount,
            dispatchReservationHash,
          });
        },
      }));
    },
    markDispatchStarted({ lease, dispatchCount, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const expectedDispatchCount = Number(dispatchCount);
      if (!Number.isSafeInteger(expectedDispatchCount) || expectedDispatchCount < 1) {
        throw new Error('autonomous_research_supervisor_dispatch_count_invalid');
      }
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.markDispatchStarted.v1',
        mutate(transaction) {
          const current = fencedRow(identity, observedAt, transaction);
          if (current.activeDispatchPhase === 'started'
            && current.activeDispatchCount === expectedDispatchCount) return current;
          const result = transaction.run(
            'supervisor-state.campaign-dispatch-started.apply.v1',
            observedAt.toISOString(),
            identity.campaignId,
            expectedDispatchCount,
            identity.leaseGeneration,
          );
          if (Number(result.changes) !== 1) {
            throw new Error('autonomous_research_supervisor_dispatch_started_fence_lost');
          }
          return row(identity.campaignId, transaction);
        },
      }));
    },
    cancelDispatchInfrastructureDeferred({
      lease,
      dispatchCount,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const expectedDispatchCount = Number(dispatchCount);
      if (!Number.isSafeInteger(expectedDispatchCount) || expectedDispatchCount < 1) {
        throw new Error('autonomous_research_supervisor_dispatch_count_invalid');
      }
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.cancelDispatchInfrastructureDeferred.v1',
        mutate(transaction) {
          const current = fencedRow(identity, observedAt, transaction);
          if (current.dispatchCount !== expectedDispatchCount
            || current.activeExternalActionAttempt) {
            throw new Error(
              'autonomous_research_supervisor_infrastructure_dispatch_cancel_fence_lost',
            );
          }
          const result = transaction.run(
            'supervisor-state.campaign-dispatch-infrastructure-cancel.apply.v1',
            observedAt.toISOString(),
            identity.campaignId,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
            expectedDispatchCount,
            expectedDispatchCount,
            identity.leaseGeneration,
            identity.campaignId,
            expectedDispatchCount,
          );
          if (Number(result.changes) !== 1) {
            throw new Error(
              'autonomous_research_supervisor_infrastructure_dispatch_cancel_fence_lost',
            );
          }
          return row(identity.campaignId, transaction);
        },
      }));
    },
    finishDispatch({
      lease,
      outcome = null,
      observedCampaignCostUsd = 0,
      observedQualificationReservedCostUsd = 0,
      costKnown = true,
      successful = false,
      settled = false,
      terminalReason: suppliedTerminalReason = null,
      nextDispatchAt,
      error = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const nextAt = timestamp(nextDispatchAt || observedAt);
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId: 'supervisor-state.supervisor-state-repository.finishDispatch.v1',
        mutate(transaction) {
          const current = fencedRow(identity, observedAt, transaction);
          if (current.activeExternalActionAttempt) {
            throw new Error('autonomous_research_supervisor_external_action_in_progress');
          }
          const failures = successful ? 0 : current.consecutiveFailures + 1;
          let disposition = settled ? 'settled' : 'active';
          let terminalReason = null;
          const campaignCost = Number(observedCampaignCostUsd);
          const qualificationCost = Number(observedQualificationReservedCostUsd);
          const known = Boolean(costKnown && Number.isFinite(campaignCost)
            && campaignCost >= 0 && Number.isFinite(qualificationCost)
            && qualificationCost >= 0);
          const totalCost = Math.max(
            current.observedCampaignCostUsd,
            known ? campaignCost : 0,
          ) + Math.max(
            current.observedQualificationReservedCostUsd,
            known ? qualificationCost : 0,
          ) + current.providerCanaryReservedCostUsd;
          if (suppliedTerminalReason) {
            disposition = 'blocked';
            terminalReason = String(suppliedTerminalReason).slice(0, 1000);
          } else if (!known) {
            disposition = 'blocked';
            terminalReason = 'supervisor_lifecycle_cost_unknown';
          } else if (totalCost > current.policy.maximumLifecycleCostUsd) {
            disposition = 'blocked';
            terminalReason = 'supervisor_lifecycle_cost_budget_exhausted';
          } else if (failures >= current.policy.maximumConsecutiveFailures) {
            disposition = 'blocked';
            terminalReason = 'supervisor_consecutive_failure_budget_exhausted';
          } else if (nextAt.getTime() > Date.parse(current.absoluteDeadlineAt)) {
            disposition = 'blocked';
            terminalReason = 'supervisor_lifecycle_deadline_exhausted';
          }
          const result = transaction.run(
            'supervisor-state.campaign-dispatch-finish.apply.v1',
            disposition,
            known ? campaignCost : 0,
            known ? qualificationCost : 0,
            known ? 1 : 0,
            failures,
            nextAt.toISOString(),
            boundedOutcome(outcome),
            error ? String(error).slice(0, 1000) : null,
            terminalReason,
            observedAt.toISOString(),
            identity.campaignId,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
          );
          if (Number(result.changes) !== 1) {
            throw new Error('autonomous_research_supervisor_lease_lost');
          }
          return row(identity.campaignId, transaction);
        },
      }));
    },
    finishDispatchFailureFallback({
      lease,
      outcome,
      nextDispatchAt,
      error = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const nextAt = timestamp(nextDispatchAt || observedAt);
      return mutationValue(mutationCoordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.finishDispatchFailureFallback.v1',
        mutate(transaction) {
          const current = fencedRow(identity, observedAt, transaction);
          externalActionSupport.recoverActiveAttemptInTransaction({
            transaction,
            current,
            observedAt,
            blocker:
              'autonomous_research_supervisor_dispatch_failure_finalization_fallback',
          });
          const failures = current.consecutiveFailures + 1;
          const disposition = 'blocked';
          const terminalReason = 'supervisor_lifecycle_cost_unknown';
          const result = transaction.run(
            'supervisor-state.campaign-dispatch-fallback.apply.v1',
            disposition,
            failures,
            nextAt.toISOString(),
            boundedOutcome(outcome),
            error ? String(error).slice(0, 1000) : null,
            terminalReason,
            observedAt.toISOString(),
            identity.campaignId,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
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
