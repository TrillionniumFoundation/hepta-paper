import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousResearchSupervisorDispatchDecision,
  autonomousResearchSupervisorNextSchedule, autonomousResearchSupervisorPausedRecoveryDecision,
  qualificationBindsCurrentRuntime,
  qualificationMetrics,
} from './autonomous-research-supervisor-readiness-policy.mjs';
import {
  createAutonomousResearchMachineIntakeCycleProcessor,
  inspectAutonomousResearchMachineIntakeCampaignBinding,
} from './autonomous-research-machine-intake-supervision.mjs';
import {
  assertAutonomousResearchResidentInstanceConfiguration,
  runAutonomousResearchResident,
} from './autonomous-research-resident-lifecycle.mjs';
import {
  buildAutonomousResearchAutonomyBlockedCycleReceipt,
  buildAutonomousResearchStartupReconciliationReceipt,
  buildAutonomousResearchMachineIntakeBlockedCycleReceipt,
  buildAutonomousResearchMachineIntakeReconciliationProgress,
  buildAutonomousResearchDispatchFailureOutcome,
  compactAutonomousResearchSupervisorOutcome,
} from './autonomous-research-supervisor-progress.mjs';
import {
  createAutonomousResearchSupervisorAutonomyFence,
} from './autonomous-research-supervisor-autonomy-fence.mjs';
import {
  discoverAutonomousResearchCampaignWindow,
} from './autonomous-research-supervisor-cycle.mjs';
import {
  executeAutonomousResearchSupervisorProviderCanary,
} from './autonomous-research-supervisor-provider-canary-dispatch.mjs';
export { selectFairAutonomousCampaignWindow } from './autonomous-research-supervisor-cycle.mjs';
export {
  inspectAutonomousResearchMachineIntakeCampaignBinding,
  verifyAutonomousResearchMachineIntakeEnqueueCommit,
} from './autonomous-research-machine-intake-supervision.mjs';

function nowDate(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('autonomous_research_supervisor_clock_invalid');
  return date;
}

function backoffMilliseconds(policy, failures, random) {
  const exponent = Math.max(0, Math.min(20, Number(failures || 0)));
  const base = Math.min(
    policy.maximumCooldownMs,
    policy.baseCooldownMs * (2 ** exponent),
  );
  const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(1, Number(random()))));
  return Math.min(policy.maximumCooldownMs, base + jitter);
}

function requireDependencies(value) {
  if (!value?.campaignStore || typeof value.campaignStore.listCampaigns !== 'function'
    || !value.stateRepository
    || typeof value.stateRepository.registerCampaign !== 'function'
    || typeof value.dispatchCampaign !== 'function'
    || typeof value.readQualificationState !== 'function'
    || typeof value.ensureRuntimeReproducibility !== 'function'
    || typeof value.runProviderCanary !== 'function'
    || typeof value.renewQualification !== 'function'
    || typeof value.scheduler?.sleep !== 'function') {
    throw new Error('autonomous_research_supervisor_dependencies_invalid');
  }
  if (value.machineIntake && (
    typeof value.machineIntake.loadConfiguredIntakes !== 'function'
    || typeof value.machineIntake.enqueueIntake !== 'function'
    || typeof value.machineIntake.repository?.listPendingIntakes !== 'function'
    || typeof value.machineIntake.repository?.listEnqueuedIntakes !== 'function'
    || typeof value.machineIntake.repository?.readIntake !== 'function'
    || typeof value.machineIntake.repository?.tryAcquireIntakeLease !== 'function'
    || typeof value.machineIntake.repository?.renewIntakeLease !== 'function'
    || typeof value.machineIntake.repository?.assertIntakeLease !== 'function'
    || typeof value.machineIntake.repository?.markIntakeEnqueued !== 'function'
    || typeof value.machineIntake.repository?.markEnqueuedIntakeInvalid !== 'function'
    || typeof value.machineIntake.repository?.deferIntake !== 'function'
    || typeof value.machineIntake.repository?.releaseIntakeLease !== 'function'
    || typeof value.machineIntake.repository?.reconcileExpiredIntakeLeases !== 'function'
  )) throw new Error('autonomous_research_supervisor_machine_intake_dependencies_invalid');
}

export function createAutonomousResearchSupervisor({
  campaignStore,
  stateRepository,
  dispatchCampaign,
  readQualificationState,
  ensureRuntimeReproducibility,
  runProviderCanary,
  renewQualification,
  reconcileRuntime = async () => null,
  machineIntake = null,
  requireFullyAutonomous = false,
  inspectFullyAutonomousPrerequisites = null,
  machineIntakeLeaseMs = 5 * 60 * 1000,
  residentInstanceRepository = null,
  residentInstanceLeaseMs = 15 * 60 * 1000,
  residentInstanceHeartbeatMs = 30_000,
  lifecyclePolicy = {},
  clock = { now: () => new Date() },
  scheduler,
  ownerId = `supervisor:${process.pid}`,
  pollMs = 5000,
  maximumCampaignsPerCycle = 100,
  random = Math.random,
  signal = null,
  onCycle = null,
} = {}) {
  requireDependencies({
    campaignStore,
    stateRepository,
    dispatchCampaign,
    readQualificationState,
    ensureRuntimeReproducibility,
    runProviderCanary,
    renewQualification,
    machineIntake,
    scheduler,
  });
  if (!ownerId || typeof ownerId !== 'string') {
    throw new Error('autonomous_research_supervisor_owner_id_invalid');
  }
  if (requireFullyAutonomous
    && typeof inspectFullyAutonomousPrerequisites !== 'function') {
    throw new Error('autonomous_research_supervisor_full_prerequisite_inspector_required');
  }
  if (requireFullyAutonomous && !residentInstanceRepository) {
    throw new Error('autonomous_research_supervisor_resident_instance_repository_required');
  }
  assertAutonomousResearchResidentInstanceConfiguration({
    repository: residentInstanceRepository,
    leaseMs: residentInstanceLeaseMs,
    heartbeatMs: residentInstanceHeartbeatMs,
  });
  const autonomyFence = createAutonomousResearchSupervisorAutonomyFence({
    required: requireFullyAutonomous,
    inspectPrerequisites: inspectFullyAutonomousPrerequisites,
    clock,
  });
  const residentCycleAuthority = Object.freeze({});
  const executionController = new AbortController();
  const onSupervisorAbort = () => {
    if (!executionController.signal.aborted) {
      executionController.abort(signal?.reason || 'supervisor_process_shutdown');
    }
  };
  if (signal?.aborted) onSupervisorAbort();
  else signal?.addEventListener?.('abort', onSupervisorAbort, { once: true });
  const executionSignal = executionController.signal;
  let startupReconciled = false;
  let startupReconciliationReceipt = null;
  let startupReconciliationPublished = false;
  let discoveryCursor = null;

  async function startupReconciliation(onResidentProgress = null) {
    if (startupReconciled) return null;
    await onResidentProgress?.({ stage: 'before_startup_reconciliation' });
    const now = nowDate(clock);
    const supervisorLeaseRecovery = stateRepository.reconcileStaleLeases({ now });
    const machineIntakeLeaseRecovery = machineIntake
      ? machineIntake.repository.reconcileExpiredIntakeLeases({ now }) : null;
    const runtime = await reconcileRuntime({ now });
    await onResidentProgress?.({ stage: 'after_startup_runtime_reconciliation' });
    const fullyAutonomousPrerequisiteReceipt = autonomyFence.inspectStartup();
    const reconciliation = Object.freeze({
      supervisorLeaseRecovery,
      machineIntakeLeaseRecovery,
      runtime,
    });
    startupReconciliationReceipt = buildAutonomousResearchStartupReconciliationReceipt({
      ownerId,
      reconciliation,
      fullyAutonomousPrerequisiteReceipt,
      reconciledAt: nowDate(clock).toISOString(),
    });
    startupReconciled = true;
    return reconciliation;
  }

  const processMachineIntakes = createAutonomousResearchMachineIntakeCycleProcessor({
    machineIntake,
    campaignStore,
    assertAutonomyCurrent: autonomyFence.assertCurrent,
    clock,
    scheduler,
    ownerId,
    machineIntakeLeaseMs,
    maximumCampaignsPerCycle,
    pollMs,
    signal: executionSignal,
  });

  async function processCampaign(campaign, onResidentProgress = null) {
    const intakeId = campaign?.spec?.autonomousResearchMachineIntakeAdmission?.intakeId;
    const machineRecord = machineIntake && intakeId
      ? machineIntake.repository.readIntake(intakeId) : null;
    const machineBinding = inspectAutonomousResearchMachineIntakeCampaignBinding({
      campaign,
      ...(machineIntake && intakeId ? { record: machineRecord, requireRecord: true } : {}),
    });
    if (!machineBinding.ready) {
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
      return Object.freeze({ campaignId: campaign.campaignId, status: 'registration_blocked', error: error.message });
    }
    const lease = stateRepository.tryAcquireCampaignLease({
      campaignId: campaign.campaignId,
      ownerId,
      leaseMs: lifecycle.policy.leaseMs,
      now,
    });
    if (!lease) return Object.freeze({ campaignId: campaign.campaignId, status: 'not_due_or_leased' });
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
    try {
      let residentLeaseContext = await publishCampaignProgress(
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
          outcome: { status: runtimeReadiness?.reason || 'runtime_reproducibility_refresh_deferred' },
          now: nowDate(clock),
        });
        finalized = true;
        return Object.freeze({ campaignId: campaign.campaignId, status: final.disposition,
          reason: runtimeReadiness?.reason || 'runtime_reproducibility_refresh_deferred' });
      }
      const qualificationBefore = await readQualificationState(campaign);
      const decision = autonomousResearchSupervisorDispatchDecision({
        campaign,
        lifecycle,
        qualificationState: qualificationBefore,
        runtimeReadiness,
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
        return Object.freeze({ campaignId: campaign.campaignId, status: result.disposition, reason: decision.reason });
      }
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
      const canaryStep = await executeAutonomousResearchSupervisorProviderCanary({
        stateRepository, lease, campaign, qualificationState: qualificationBefore,
        runtimeReadiness, decision, runProviderCanary, publishCampaignProgress,
        autonomyFence, machineRecord, residentLeaseContext,
        signal: localController.signal, now: () => nowDate(clock),
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
        autonomyFence.assertCurrent({ campaign, record: machineRecord, residentLeaseContext });
        qualificationRenewal = await renewQualification({
          campaign,
          runtimeReadiness,
          requiredQualificationValidityMs: decision.requiredQualificationValidityMs,
          qualificationRetry: decision.qualificationRetry,
          supervisorLease: lease,
          signal: localController.signal,
          onProgress: ({ stage = 'qualification_renewal' } = {}) =>
            publishCampaignProgress(`qualification:${stage}`),
          onSynchronousProgress: ({ stage = 'qualification_synchronous_operation' } = {}) =>
            publishCampaignProgress(`qualification:${stage}`),
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
      if (localController.signal.aborted) throw new Error(String(localController.signal.reason));
      residentLeaseContext = await publishCampaignProgress(
        'before_campaign_dispatch',
      ) || residentLeaseContext;
      autonomyFence.assertCurrent({ campaign, record: machineRecord, residentLeaseContext });
      const report = await dispatchCampaign({
        campaign,
        action: decision.action,
        qualificationRetry: decision.qualificationRetry,
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
      const schedule = autonomousResearchSupervisorNextSchedule({
        report,
        campaign: currentCampaign || campaign,
        qualificationState: qualificationAfter,
        runtimeReadiness,
        lifecycle,
        now: nowDate(clock),
        pollMs,
      });
      const currentCostKnown = currentCampaign?.costKnown !== false;
      const final = stateRepository.finishDispatch({
        lease,
        outcome: compactAutonomousResearchSupervisorOutcome(report),
        observedCampaignCostUsd: currentCostKnown ? Number(currentCampaign?.costUsd || 0) : 0,
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
        outcome: compactAutonomousResearchSupervisorOutcome(report),
      });
    } catch (error) {
      if (leaseLost) {
        return Object.freeze({ campaignId: campaign.campaignId, status: 'lease_lost' });
      }
      const latest = stateRepository.getCampaign(campaign.campaignId);
      const cooldown = backoffMilliseconds(latest.policy, latest.consecutiveFailures, random);
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
  }

  async function runCycle({
    cycleAuthority = null,
    onStartupReconciled = null,
    onMachineIntakeReconciled = null,
    onMachineIntakeReconciliationFailed = null,
    onResidentProgress = null,
  } = {}) {
    if (requireFullyAutonomous && cycleAuthority !== residentCycleAuthority) {
      throw new Error('autonomous_research_supervisor_resident_cycle_authority_required');
    }
    const reconciliation = await startupReconciliation(onResidentProgress);
    if (startupReconciliationReceipt && !startupReconciliationPublished
      && typeof onStartupReconciled === 'function') {
      await onStartupReconciled(startupReconciliationReceipt);
      startupReconciliationPublished = true;
    }
    const residentLeaseContext = await onResidentProgress?.({
      stage: 'before_autonomy_prerequisite_reconciliation',
    });
    const autonomyInspection = autonomyFence.inspectCurrent({ residentLeaseContext });
    if (!autonomyInspection.ready) {
      await onMachineIntakeReconciliationFailed?.(
        `autonomy_fence:${autonomyInspection.reason}`,
      );
      return buildAutonomousResearchAutonomyBlockedCycleReceipt({
        machineIntake: null,
        machineIntakeReconciliationReceipt: null,
        prerequisiteInspection: autonomyInspection,
        reason: autonomyInspection.reason,
        ownerId,
        startupReconciliation: reconciliation,
        startupReconciliationReceipt,
        now: nowDate(clock),
      });
    }
    await onResidentProgress?.({ stage: 'before_machine_intake_reconciliation' });
    const machineIntakeResult = await processMachineIntakes({
      onProgress: onResidentProgress,
      operationMode: autonomyInspection.operationMode === 'bootstrap-only'
        ? 'bootstrap-only' : 'full',
    });
    await onResidentProgress?.({ stage: 'after_machine_intake_reconciliation' });
    const machineIntakeProgress = buildAutonomousResearchMachineIntakeReconciliationProgress({
      result: machineIntakeResult,
      ownerId,
      now: nowDate(clock),
    });
    if (machineIntakeProgress.ready) {
      await onMachineIntakeReconciled?.(machineIntakeProgress.receipt);
    } else {
      await onMachineIntakeReconciliationFailed?.(machineIntakeProgress.reason);
    }
    if (machineIntake && !machineIntakeProgress.ready) {
      return buildAutonomousResearchMachineIntakeBlockedCycleReceipt({
        machineIntake: machineIntakeResult,
        reason: machineIntakeProgress.reason,
        ownerId,
        startupReconciliation: reconciliation,
        startupReconciliationReceipt,
        now: nowDate(clock),
      });
    }
    const window = discoverAutonomousResearchCampaignWindow({
      campaignStore,
      autonomyFence,
      operationMode: autonomyInspection.operationMode,
      machineIntake,
      afterCampaignId: discoveryCursor,
      limit: maximumCampaignsPerCycle,
    });
    const discovered = window.campaigns;
    discoveryCursor = window.nextCursor;
    const results = [];
    for (const campaign of discovered) {
      if (executionSignal.aborted) break;
      await onResidentProgress?.({ stage: `before_campaign:${campaign.campaignId}` });
      results.push(await processCampaign(campaign, onResidentProgress));
      await onResidentProgress?.({ stage: `after_campaign:${campaign.campaignId}` });
    }
    const payload = {
      version: 1,
      kind: 'AutonomousResearchSupervisorCycleReceipt',
      status: executionSignal.aborted
        ? 'autonomous_research_supervisor_stopping'
        : 'autonomous_research_supervisor_cycle_completed',
      ownerId,
      startupReconciliation: reconciliation,
      startupReconciliationReceipt,
      machineIntake: machineIntakeResult,
      machineIntakeReconciliationReceipt: machineIntakeProgress.receipt,
      autonomyOperationMode: autonomyInspection.operationMode,
      fullyAutonomousPrerequisiteReceipt: autonomyInspection.receipt || null,
      suppressedCampaignCount: window.suppressedCampaignCount,
      discoveredCampaignCount: discovered.length,
      processedCampaignCount: results.length,
      results: Object.freeze(results),
      observedAt: nowDate(clock).toISOString(),
      externalSubmissionPerformed: false,
      automaticBudgetExpansionPerformed: false,
    };
    return Object.freeze({
      ...payload,
      autonomousResearchSupervisorCycleReceiptHash:
        hashRecord('AutonomousResearchSupervisorCycleReceipt', payload),
    });
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisor',
    runCycle,
    run: () => runAutonomousResearchResident({
      residentInstanceRepository,
      residentInstanceLeaseMs,
      residentInstanceHeartbeatMs,
      requireFullyAutonomous,
      ownerId,
      clock,
      scheduler,
      executionController,
      runCycle,
      cycleAuthority: residentCycleAuthority,
      onCycle,
      pollMs,
    }),
  });
}
