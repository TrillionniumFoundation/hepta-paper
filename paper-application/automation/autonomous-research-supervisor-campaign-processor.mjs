import {
  autonomousResearchSupervisorDispatchDecision,
  autonomousResearchSupervisorNextSchedule,
  autonomousResearchSupervisorPausedRecoveryDecision,
  autonomousResearchCampaignRequiresExternalSubmission,
  qualificationBindsCurrentRuntime,
  qualificationMetrics,
} from './autonomous-research-supervisor-readiness-policy.mjs';
import {
  inspectAutonomousResearchMachineIntakeCampaignBinding,
} from './autonomous-research-machine-intake-supervision.mjs';
import {
  buildAutonomousResearchDispatchFailureOutcome,
  compactAutonomousResearchSupervisorOutcome,
} from './autonomous-research-supervisor-progress.mjs';
import {
  isResidentReactivationRequired,
} from './autonomous-research-resident-reactivation-required.mjs';
import {
  supervisorBackoffMilliseconds as backoffMilliseconds,
  supervisorNowDate as nowDate,
} from './autonomous-research-supervisor-cycle.mjs';
import {
  executeAutonomousResearchSupervisorProviderCanary,
} from './autonomous-research-supervisor-provider-canary-dispatch.mjs';
import {
  executeAutonomousResearchSupervisorSubmissionRecovery,
} from './autonomous-research-supervisor-submission-recovery.mjs';
import {
  resolveAutonomousResearchScientificDisposition,
} from '../../paper-domain/automation/autonomous-research-scientific-disposition-contract.mjs';

function currentCampaignNodes(campaignStore, campaignId) {
  return typeof campaignStore?.listNodes === 'function'
    ? campaignStore.listNodes(campaignId) : [];
}

function scientificDispositionOutcome(campaign, receipt) {
  return compactAutonomousResearchSupervisorOutcome({
    status: receipt.status,
    campaign: { status: campaign.status },
    scientificDispositionReceipt: receipt,
  });
}

export function createAutonomousResearchSupervisorCampaignProcessor({
  machineIntake,
  requireFullyAutonomous,
  stateRepository,
  lifecyclePolicy,
  ownerId,
  clock,
  scheduler,
  executionSignal,
  autonomyFence,
  reconcileStateRecoverability,
  assertStateRecoverabilityCurrent,
  recoverAutonomousSubmission,
  pollMs,
  ensureRuntimeReproducibility,
  readQualificationState,
  runProviderCanary,
  renewQualification,
  dispatchCampaign,
  campaignStore,
  random,
} = {}) {
  return async function processCampaign(campaign, onResidentProgress = null) {
    const intakeId = campaign?.spec?.autonomousResearchMachineIntakeAdmission?.intakeId;
    const machineRecord = machineIntake && intakeId
      ? machineIntake.repository.readIntake(intakeId) : null;
    const machineBinding = inspectAutonomousResearchMachineIntakeCampaignBinding({
      campaign,
      ...(machineIntake && intakeId ? { record: machineRecord } : {}),
      requireRecord: requireFullyAutonomous || Boolean(machineIntake && intakeId),
    });
    if (!machineBinding.ready
      || (requireFullyAutonomous && machineBinding.machineBound !== true)) {
      return Object.freeze({
        campaignId: campaign.campaignId,
        status: 'machine_intake_binding_blocked',
        reason: machineBinding.reason,
      });
    }
    const pausedRecovery = autonomousResearchSupervisorPausedRecoveryDecision(campaign);
    if (pausedRecovery) return Object.freeze({ campaignId: campaign.campaignId,
      status: 'blocked', reason: pausedRecovery.reason });
    const now = nowDate(clock);
    let lifecycle;
    try {
      lifecycle = stateRepository.registerCampaign({
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        policy: lifecyclePolicy,
        now,
      });
    } catch (error) {
      if (error?.stateRecoverabilityFatal === true
        || error?.stateRecoverabilityDeferred === true) throw error;
      return Object.freeze({ campaignId: campaign.campaignId,
        status: 'registration_blocked', error: error.message });
    }
    const lease = stateRepository.tryAcquireCampaignLease({
      campaignId: campaign.campaignId,
      ownerId,
      leaseMs: lifecycle.policy.leaseMs,
      now,
    });
    if (!lease) return Object.freeze({ campaignId: campaign.campaignId,
      status: 'not_due_or_leased' });
    lifecycle = stateRepository.getCampaign(campaign.campaignId);
    const localController = new AbortController();
    const onAbort = () => localController.abort(
      executionSignal.reason || 'supervisor_process_shutdown',
    );
    if (executionSignal.aborted) onAbort();
    else executionSignal.addEventListener?.('abort', onAbort, { once: true });
    let leaseLost = false;
    const heartbeat = scheduler.setInterval(() => {
      try {
        const renewed = stateRepository.renewCampaignLease({
          lease,
          leaseMs: lifecycle.policy.leaseMs,
          now: nowDate(clock),
        });
        if (!renewed) leaseLost = true;
      } catch { leaseLost = true; }
      if (leaseLost) localController.abort('supervisor_lease_lost');
    }, Math.max(250, Math.floor(lifecycle.policy.leaseMs / 3)));
    scheduler.unref?.(heartbeat);
    const publishCampaignProgress = (stage) => {
      let renewed = null;
      try {
        renewed = stateRepository.renewCampaignLease({
          lease,
          leaseMs: lifecycle.policy.leaseMs,
          now: nowDate(clock),
        });
      } catch { /* handled by the common fence-loss path below */ }
      if (!renewed) {
        leaseLost = true;
        localController.abort('supervisor_lease_lost');
        throw new Error('supervisor_lease_lost');
      }
      const residentLeaseContext = onResidentProgress?.({ stage });
      if (typeof residentLeaseContext?.then === 'function') {
        throw new Error('autonomous_research_resident_progress_must_be_synchronous');
      }
      autonomyFence.assertCurrent({
        campaign,
        record: machineRecord,
        residentLeaseContext,
        action: `campaign_progress:${stage}`,
      });
      return residentLeaseContext;
    };
    let finalized = false;
    let dispatchReservation = null;
    let externalSideEffectPossiblyStarted = false;
    const markDispatchExternalSideEffectStarted = () => {
      if (!dispatchReservation) {
        throw new Error('autonomous_research_supervisor_dispatch_reservation_required');
      }
      stateRepository.markDispatchStarted({
        lease,
        dispatchCount: dispatchReservation.dispatchCount,
        now: nowDate(clock),
      });
      externalSideEffectPossiblyStarted = true;
    };
    const cancelInfrastructureDeferredDispatch = () => {
      if (!dispatchReservation || externalSideEffectPossiblyStarted) return;
      try {
        stateRepository.cancelDispatchInfrastructureDeferred({
          lease,
          dispatchCount: dispatchReservation.dispatchCount,
          now: nowDate(clock),
        });
      } catch (error) {
        const fatal = new Error(
          'autonomous_research_supervisor_infrastructure_dispatch_cancel_failed',
          { cause: error },
        );
        fatal.stateRecoverabilityFatal = true;
        throw fatal;
      }
      dispatchReservation = null;
    };
    try {
      let residentLeaseContext = publishCampaignProgress(
        'after_campaign_lease_acquire',
      );
      await reconcileStateRecoverability({
        residentLeaseContext,
        action: 'campaign_after_lease_acquire',
      });
      const submissionRequired =
        autonomousResearchCampaignRequiresExternalSubmission(campaign);
      const initialScientificDisposition =
        resolveAutonomousResearchScientificDisposition({
          campaign,
          nodes: currentCampaignNodes(campaignStore, campaign.campaignId),
          submissionRequired,
          now: nowDate(clock),
        });
      if (initialScientificDisposition) {
        assertStateRecoverabilityCurrent(
          'campaign_scientific_disposition_settlement',
        );
        const dispositionOutcome = scientificDispositionOutcome(
          campaign,
          initialScientificDisposition,
        );
        const final = stateRepository.finishDispatch({
          lease,
          successful: true,
          settled: true,
          observedCampaignCostUsd: campaign.costKnown
            ? Number(campaign.costUsd || 0) : 0,
          observedQualificationReservedCostUsd: 0,
          costKnown: campaign.costKnown,
          outcome: dispositionOutcome,
          now: nowDate(clock),
        });
        finalized = true;
        return Object.freeze({
          campaignId: campaign.campaignId,
          status: final.disposition,
          reason: initialScientificDisposition.settlementReason,
          outcome: dispositionOutcome,
          scientificDispositionReceipt: initialScientificDisposition,
          externalSubmissionPerformed: false,
        });
      }
      assertStateRecoverabilityCurrent('campaign_submission_recovery_entry');
      const submissionStep = await executeAutonomousResearchSupervisorSubmissionRecovery({
        recoverAutonomousSubmission, publishCampaignProgress, autonomyFence, campaign,
        machineRecord, stateRepository, lease, clock, pollMs, signal: localController.signal,
        reconcileStateRecoverability,
        assertStateRecoverabilityCurrent,
      });
      const submissionRecovery = submissionStep.recovery;
      if (submissionStep.finalizedOutcome) {
        finalized = true;
        return submissionStep.finalizedOutcome;
      }
      const recoveredScientificDisposition =
        resolveAutonomousResearchScientificDisposition({
          campaign,
          nodes: currentCampaignNodes(campaignStore, campaign.campaignId),
          submissionRequired,
          submissionDelivery: submissionRecovery?.delivery || null,
          now: nowDate(clock),
        });
      if (recoveredScientificDisposition) {
        assertStateRecoverabilityCurrent(
          'campaign_recovered_scientific_disposition_settlement',
        );
        const dispositionOutcome = scientificDispositionOutcome(
          campaign,
          recoveredScientificDisposition,
        );
        const final = stateRepository.finishDispatch({
          lease,
          successful: true,
          settled: true,
          observedCampaignCostUsd: campaign.costKnown
            ? Number(campaign.costUsd || 0) : 0,
          observedQualificationReservedCostUsd: 0,
          costKnown: campaign.costKnown,
          outcome: dispositionOutcome,
          now: nowDate(clock),
        });
        finalized = true;
        return Object.freeze({
          campaignId: campaign.campaignId,
          status: final.disposition,
          reason: recoveredScientificDisposition.settlementReason,
          outcome: dispositionOutcome,
          scientificDispositionReceipt: recoveredScientificDisposition,
          externalSubmissionPerformed:
            submissionRecovery?.externalActionPerformed === true,
        });
      }
      residentLeaseContext = await publishCampaignProgress(
        'before_runtime_reproducibility',
      );
      autonomyFence.assertCurrent({ campaign, record: machineRecord, residentLeaseContext });
      const runtimeReadiness = await ensureRuntimeReproducibility({
        campaign, lifecycle, ownerId, signal: localController.signal,
      });
      residentLeaseContext = await publishCampaignProgress(
        'after_runtime_reproducibility',
      ) || residentLeaseContext;
      if (runtimeReadiness?.ready !== true) {
        const final = stateRepository.finishDispatch({
          lease,
          successful: runtimeReadiness?.terminal !== true,
          terminalReason: runtimeReadiness?.terminal ? runtimeReadiness.reason : null,
          nextDispatchAt: runtimeReadiness?.deferUntil || now,
          observedCampaignCostUsd: campaign.costKnown ? Number(campaign.costUsd || 0) : 0,
          observedQualificationReservedCostUsd: 0,
          costKnown: campaign.costKnown,
          outcome: { status: runtimeReadiness?.reason
            || 'runtime_reproducibility_refresh_deferred' },
          now: nowDate(clock),
        });
        finalized = true;
        return Object.freeze({ campaignId: campaign.campaignId,
          status: final.disposition,
          reason: runtimeReadiness?.reason
            || 'runtime_reproducibility_refresh_deferred' });
      }
      const qualificationBefore = await readQualificationState(campaign);
      const decision = autonomousResearchSupervisorDispatchDecision({
        campaign,
        lifecycle,
        qualificationState: qualificationBefore,
        runtimeReadiness,
        submissionRecovery,
        now,
      });
      if (decision.settle || decision.block || decision.deferUntil) {
        const result = stateRepository.finishDispatch({
          lease,
          successful: Boolean(decision.settle || decision.deferUntil),
          settled: decision.settle,
          terminalReason: decision.block ? decision.reason : null,
          nextDispatchAt: decision.deferUntil || now,
          observedCampaignCostUsd: campaign.costKnown ? Number(campaign.costUsd || 0) : 0,
          observedQualificationReservedCostUsd:
            qualificationMetrics(qualificationBefore).reservedCostUsd,
          costKnown: campaign.costKnown,
          outcome: { status: decision.reason },
          now,
        });
        finalized = true;
        return Object.freeze({ campaignId: campaign.campaignId,
          status: result.disposition, reason: decision.reason });
      }
      await publishCampaignProgress('before_dispatch_budget_reservation');
      const dispatchAuthorization = stateRepository.beginDispatch({
        lease,
        campaignCostLimitUsd: Number(campaign.spec?.budgets?.maxCostUsd),
        now,
      });
      if (!dispatchAuthorization.authorized) {
        finalized = true;
        return Object.freeze({
          campaignId: campaign.campaignId,
          status: 'blocked',
          reason: dispatchAuthorization.blocker,
        });
      }
      dispatchReservation = dispatchAuthorization;
      residentLeaseContext = publishCampaignProgress(
        'after_dispatch_budget_reservation',
      ) || residentLeaseContext;
      await reconcileStateRecoverability({
        residentLeaseContext,
        action: 'campaign_after_dispatch_budget_reservation',
      });
      assertStateRecoverabilityCurrent('campaign_provider_canary_entry');
      const canaryStep = await executeAutonomousResearchSupervisorProviderCanary({
        stateRepository, lease, campaign, qualificationState: qualificationBefore,
        runtimeReadiness, decision, runProviderCanary, publishCampaignProgress,
        autonomyFence, machineRecord, residentLeaseContext,
        signal: localController.signal, now: () => nowDate(clock),
        reconcileStateRecoverability,
        assertStateRecoverabilityCurrent,
        onExternalSideEffectStarted: () => {
          markDispatchExternalSideEffectStarted();
        },
      });
      residentLeaseContext = canaryStep.residentLeaseContext;
      if (canaryStep.blocked) {
        finalized = true;
        return Object.freeze({
          campaignId: campaign.campaignId,
          status: 'blocked',
          reason: canaryStep.reason,
        });
      }
      let qualificationCurrent = qualificationBefore;
      let qualificationRenewal = null;
      if (decision.qualificationRenewalRequired) {
        residentLeaseContext = await publishCampaignProgress(
          'before_qualification_renewal',
        ) || residentLeaseContext;
        await reconcileStateRecoverability({
          residentLeaseContext,
          action: 'campaign_before_qualification_renewal',
        });
        assertStateRecoverabilityCurrent('campaign_qualification_renewal_entry');
        autonomyFence.assertCurrent({ campaign, record: machineRecord, residentLeaseContext });
        qualificationRenewal = await renewQualification({
          campaign,
          runtimeReadiness,
          requiredQualificationValidityMs: decision.requiredQualificationValidityMs,
          qualificationRetry: {
            ...decision.qualificationRetry,
            onExternalSideEffectStarted: () => {
              markDispatchExternalSideEffectStarted();
            },
          },
          supervisorLease: lease,
          signal: localController.signal,
          onProgress: async ({ stage = 'qualification_renewal' } = {}) => {
            residentLeaseContext = publishCampaignProgress(`qualification:${stage}`)
              || residentLeaseContext;
            await reconcileStateRecoverability({
              residentLeaseContext,
              action: `qualification:${stage}`,
            });
            assertStateRecoverabilityCurrent(`qualification:${stage}:side_effect`);
            return residentLeaseContext;
          },
          onSynchronousProgress: ({
            stage = 'qualification_synchronous_operation',
          } = {}) => {
            residentLeaseContext?.assertCurrent?.({ now: nowDate(clock) });
            assertStateRecoverabilityCurrent(`qualification:${stage}:synchronous`);
            return residentLeaseContext;
          },
        });
        residentLeaseContext = await publishCampaignProgress(
          'after_qualification_renewal',
        ) || residentLeaseContext;
        qualificationCurrent = await readQualificationState(campaign);
        if (qualificationRenewal?.ready !== true) {
          const persistedNext = Date.parse(
            qualificationCurrent?.recovery?.nextAttemptAt || '',
          );
          const renewalNow = nowDate(clock);
          const final = stateRepository.finishDispatch({
            lease,
            successful: qualificationRenewal?.terminal !== true,
            terminalReason: qualificationRenewal?.terminal
              ? qualificationRenewal.reason : null,
            nextDispatchAt: new Date(Math.max(
              renewalNow.getTime() + pollMs,
              Number.isFinite(persistedNext) ? persistedNext : 0,
            )),
            observedCampaignCostUsd: campaign.costKnown
              ? Number(campaign.costUsd || 0) : 0,
            observedQualificationReservedCostUsd:
              qualificationMetrics(qualificationCurrent).reservedCostUsd,
            costKnown: campaign.costKnown,
            outcome: {
              status: qualificationRenewal?.reason || 'qualification_renewal_deferred',
            },
            now: renewalNow,
          });
          finalized = true;
          return Object.freeze({
            campaignId: campaign.campaignId,
            status: final.disposition,
            reason: qualificationRenewal?.reason || 'qualification_renewal_deferred',
          });
        }
      }
      const dispatchNow = nowDate(clock);
      stateRepository.assertCampaignLease({ lease, now: dispatchNow });
      if (qualificationRenewal?.preReleaseExecutionAuthorized !== true
        && !qualificationBindsCurrentRuntime({
          qualificationState: qualificationCurrent,
          runtimeReadiness,
          requiredValidityMs: decision.requiredQualificationValidityMs,
          now: dispatchNow,
        })) {
        throw new Error('supervisor_qualification_runtime_binding_not_current');
      }
      const providerCanaryState = stateRepository.getCampaign(campaign.campaignId);
      if (localController.signal.aborted) {
        throw new Error(String(localController.signal.reason));
      }
      residentLeaseContext = await publishCampaignProgress(
        'before_campaign_dispatch',
      ) || residentLeaseContext;
      await reconcileStateRecoverability({
        residentLeaseContext,
        action: 'campaign_before_dispatch',
      });
      assertStateRecoverabilityCurrent('campaign_dispatch_side_effect');
      autonomyFence.assertCurrent({ campaign, record: machineRecord, residentLeaseContext });
      const report = await dispatchCampaign({
        campaign,
        action: decision.action,
        qualificationRetry: {
          ...decision.qualificationRetry,
          onExternalSideEffectStarted: () => {
            markDispatchExternalSideEffectStarted();
          },
        },
        supervisorDispatchEvidence: Object.freeze({
          campaignLease: lease,
          providerCanaryState,
          residentLeaseContext,
        }),
        signal: localController.signal,
      });
      await publishCampaignProgress('after_campaign_dispatch');
      if (leaseLost) throw new Error('supervisor_lease_lost');
      const currentCampaign = campaignStore.getCampaign(campaign.campaignId);
      const qualificationAfter = await readQualificationState(currentCampaign || campaign);
      const scientificDisposition =
        resolveAutonomousResearchScientificDisposition({
          campaign: currentCampaign || campaign,
          nodes: currentCampaignNodes(campaignStore, campaign.campaignId),
          submissionRequired: autonomousResearchCampaignRequiresExternalSubmission(
            currentCampaign || campaign,
          ),
          submissionDelivery: report?.autonomousSubmission?.delivery || null,
          now: nowDate(clock),
        });
      const schedule = autonomousResearchSupervisorNextSchedule({
        report,
        campaign: currentCampaign || campaign,
        qualificationState: qualificationAfter,
        runtimeReadiness,
        lifecycle,
        now: nowDate(clock),
        pollMs,
        scientificDispositionReceipt: scientificDisposition,
      });
      const currentCostKnown = currentCampaign?.costKnown !== false;
      const compactOutcome = compactAutonomousResearchSupervisorOutcome(
        scientificDisposition
          ? { ...report, scientificDispositionReceipt: scientificDisposition }
          : report,
      );
      const final = stateRepository.finishDispatch({
        lease,
        outcome: compactOutcome,
        observedCampaignCostUsd: currentCostKnown
          ? Number(currentCampaign?.costUsd || 0) : 0,
        observedQualificationReservedCostUsd:
          qualificationMetrics(qualificationAfter).reservedCostUsd,
        costKnown: currentCostKnown,
        successful: true,
        settled: schedule.settled,
        terminalReason: schedule.terminalReason || null,
        nextDispatchAt: schedule.nextAt,
        now: nowDate(clock),
      });
      finalized = true;
      return Object.freeze({
        campaignId: campaign.campaignId,
        status: final.disposition,
        reason: schedule.reason,
        outcome: compactOutcome,
        ...(scientificDisposition ? {
          scientificDispositionReceipt: scientificDisposition,
        } : {}),
        externalSubmissionPerformed:
          report?.autonomousSubmission?.delivery?.externalActionPerformed === true,
      });
    } catch (error) {
      if (isResidentReactivationRequired(error)) throw error;
      if (error?.stateRecoverabilityFatal === true) throw error;
      if (error?.stateRecoverabilityDeferred === true) {
        if (error.dispatchInfrastructureReservationCancelled === true) {
          dispatchReservation = null;
        }
        cancelInfrastructureDeferredDispatch();
        return Object.freeze({
          campaignId: campaign.campaignId,
          status: 'infrastructure_deferred',
          reason: String(error?.message || error),
          retryAt: error?.retryAt || null,
          externalSubmissionPerformed: false,
        });
      }
      if (error?.authorityEvidenceRenewalFatal === true) throw error;
      if (error?.authorityEvidenceRenewalDeferred === true) {
        if (error.dispatchInfrastructureReservationCancelled === true) {
          dispatchReservation = null;
        }
        cancelInfrastructureDeferredDispatch();
        return Object.freeze({
          campaignId: campaign.campaignId,
          status: 'infrastructure_deferred',
          reason: String(error?.message || error),
          retryAt: error?.retryAt || null,
          externalSubmissionPerformed: false,
        });
      }
      if (leaseLost) {
        return Object.freeze({ campaignId: campaign.campaignId, status: 'lease_lost' });
      }
      const latest = stateRepository.getCampaign(campaign.campaignId);
      const cooldown = backoffMilliseconds(
        latest.policy,
        latest.consecutiveFailures,
        random,
      );
      const failureOutcome = buildAutonomousResearchDispatchFailureOutcome(error);
      try {
        const currentCampaign = campaignStore.getCampaign(campaign.campaignId) || campaign;
        const qualification = await readQualificationState(currentCampaign);
        const final = stateRepository.finishDispatch({
          lease,
          observedCampaignCostUsd: currentCampaign.costKnown
            ? Number(currentCampaign.costUsd || 0) : 0,
          observedQualificationReservedCostUsd:
            qualificationMetrics(qualification).reservedCostUsd,
          costKnown: currentCampaign.costKnown,
          successful: false,
          nextDispatchAt: new Date(nowDate(clock).getTime() + cooldown),
          error: error?.message || error,
          outcome: failureOutcome,
          now: nowDate(clock),
        });
        finalized = true;
        return Object.freeze({
          campaignId: campaign.campaignId,
          status: final.disposition === 'blocked' ? 'blocked' : 'cooldown',
          error: String(error?.message || error),
          cooldownMs: cooldown,
        });
      } catch (finalizeError) {
        try {
          const final = stateRepository.finishDispatchFailureFallback({
            lease,
            outcome: failureOutcome,
            nextDispatchAt: new Date(nowDate(clock).getTime() + cooldown),
            error: `${String(error?.message || error)};fallback_after:${String(
              finalizeError?.message || finalizeError,
            )}`,
            now: nowDate(clock),
          });
          finalized = true;
          return Object.freeze({
            campaignId: campaign.campaignId,
            status: final.disposition === 'blocked' ? 'blocked' : 'cooldown',
            error: String(error?.message || error),
            finalizationFallback: true,
            cooldownMs: cooldown,
          });
        } catch (fallbackError) {
          return Object.freeze({
            campaignId: campaign.campaignId,
            status: 'finalization_failed',
            error: String(fallbackError?.message || fallbackError),
            originalFinalizationError: String(finalizeError?.message || finalizeError),
          });
        }
      }
    } finally {
      scheduler.clearInterval(heartbeat);
      executionSignal.removeEventListener?.('abort', onAbort);
      if (!finalized && !leaseLost) {
        try { stateRepository.releaseCampaignLease({ lease, now: nowDate(clock) }); }
        catch { /* stale leases are reconciled on the next startup/cycle */ }
      }
    }
  };
}
