import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchMachineIntakeCycleProcessor,
} from './autonomous-research-machine-intake-supervision.mjs';
import {
  assertAutonomousResearchResidentInstanceConfiguration,
  runAutonomousResearchResident,
} from './autonomous-research-resident-lifecycle.mjs';
import {
  buildAutonomousResearchAutonomyBlockedCycleReceipt,
  buildAutonomousResearchAuthorityEvidenceDeferredCycleReceipt,
  buildAutonomousResearchStateRecoverabilityDeferredCycleReceipt,
  buildAutonomousResearchStartupReconciliationReceipt,
  buildAutonomousResearchMachineIntakeBlockedCycleReceipt,
  buildAutonomousResearchMachineIntakeReconciliationProgress,
} from './autonomous-research-supervisor-progress.mjs';
import {
  createAutonomousResearchSupervisorAutonomyFence,
} from './autonomous-research-supervisor-autonomy-fence.mjs';
import {
  assertAutonomousResearchStateRecoverabilityReady,
} from './autonomous-research-state-recoverability-controller.mjs';
import {
  discoverAutonomousResearchCampaignWindow,
  supervisorNowDate as nowDate,
} from './autonomous-research-supervisor-cycle.mjs';
import {
  createAutonomousResearchSupervisorCampaignProcessor,
} from './autonomous-research-supervisor-campaign-processor.mjs';

export { selectFairAutonomousCampaignWindow } from './autonomous-research-supervisor-cycle.mjs';
export {
  inspectAutonomousResearchMachineIntakeCampaignBinding,
  verifyAutonomousResearchMachineIntakeEnqueueCommit,
} from './autonomous-research-machine-intake-supervision.mjs';

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
  recoverAutonomousSubmission = null,
  onlineAuthorityEvidenceController = null,
  stateRecoverabilityController = null,
  externalActionRecoveryController = null,
  reconcileRuntime = async () => null,
  machineIntake = null,
  requireFullyAutonomous = false,
  inspectFullyAutonomousPrerequisites = null,
  machineIntakeLeaseMs = 5 * 60 * 1000,
  residentInstanceRepository = null,
  residentCycleIntentRepository = null,
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
  if (recoverAutonomousSubmission !== null
    && typeof recoverAutonomousSubmission !== 'function') {
    throw new Error('autonomous_research_supervisor_submission_recovery_invalid');
  }
  if (onlineAuthorityEvidenceController !== null
    && (typeof onlineAuthorityEvidenceController.reconcile !== 'function'
      || typeof onlineAuthorityEvidenceController.assertCurrent !== 'function')) {
    throw new Error('autonomous_research_supervisor_online_authority_evidence_invalid');
  }
  if (stateRecoverabilityController !== null
    && (typeof stateRecoverabilityController.reconcile !== 'function'
      || typeof stateRecoverabilityController.assertCurrent !== 'function'
      || typeof stateRecoverabilityController.markMutationFinalized !== 'function'
      || typeof stateRecoverabilityController.epochStatus !== 'function')) {
    throw new Error('autonomous_research_supervisor_state_recoverability_invalid');
  }
  if (externalActionRecoveryController !== null
    && (typeof externalActionRecoveryController.reconcile !== 'function'
      || typeof externalActionRecoveryController.inspectStatus !== 'function')) {
    throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
  }
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
    assertDynamicInfrastructureCurrent: onlineAuthorityEvidenceController
      ? ({ action, residentLeaseContext }) => {
        const requiredValidityMs =
          onlineAuthorityEvidenceController.policy?.renewalLeadMs || 0;
        if (residentLeaseContext) {
          const reconciled = onlineAuthorityEvidenceController.reconcile({
            residentLeaseContext,
            requiredValidityMs,
          });
          if (reconciled?.ready === true) return reconciled;
        }
        return onlineAuthorityEvidenceController.assertCurrent({
          requiredValidityMs,
          action,
        });
      } : null,
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

  async function reconcileOnlineAuthorityEvidence(onResidentProgress, action) {
    if (!onlineAuthorityEvidenceController) return null;
    const residentLeaseContext = await onResidentProgress?.({
      stage: `before_online_authority_evidence:${action}`,
    });
    const receipt = onlineAuthorityEvidenceController.reconcile({
      residentLeaseContext,
      requiredValidityMs:
        onlineAuthorityEvidenceController.policy?.renewalLeadMs || 0,
    });
    await onResidentProgress?.({
      stage: `after_online_authority_evidence:${action}`,
    });
    return receipt;
  }

  async function reconcileStateRecoverability({
    residentLeaseContext,
    action,
    requiredValidityMs = 0,
  } = {}) {
    if (onlineAuthorityEvidenceController) {
      const authorityValidityMs = Math.max(
        requiredValidityMs,
        onlineAuthorityEvidenceController.policy?.renewalLeadMs || 0,
      );
      const authority = onlineAuthorityEvidenceController.reconcile({
        residentLeaseContext,
        requiredValidityMs: authorityValidityMs,
      });
      if (authority?.ready !== true) {
        onlineAuthorityEvidenceController.assertCurrent({
          requiredValidityMs: authorityValidityMs,
          action,
        });
      }
    }
    if (!stateRecoverabilityController) return null;
    const recovery = await stateRecoverabilityController.reconcile({
      residentLeaseContext,
      requiredValidityMs,
    });
    return assertAutonomousResearchStateRecoverabilityReady(recovery, { action });
  }

  function assertStateRecoverabilityCurrent(action) {
    onlineAuthorityEvidenceController?.assertCurrent({
      requiredValidityMs: 0,
      action,
    });
    return stateRecoverabilityController?.assertCurrent({ action }) || null;
  }

  async function startupReconciliation(onResidentProgress = null) {
    if (startupReconciled) return null;
    const residentLeaseContext = await onResidentProgress?.({
      stage: 'before_startup_reconciliation',
    });
    const now = nowDate(clock);
    const supervisorLeaseRecovery = externalActionRecoveryController
      ? await externalActionRecoveryController.reconcile({
        residentLeaseContext,
        signal: executionSignal,
      })
      : stateRepository.reconcileStaleLeases({ now });
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
    reconcileStateRecoverability,
    assertStateRecoverabilityCurrent,
  });
  const processCampaign = createAutonomousResearchSupervisorCampaignProcessor({
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
  });

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
    let reconciliation;
    try { reconciliation = await startupReconciliation(onResidentProgress); }
    catch (error) {
      if (error?.externalActionRecoveryFatal === true) throw error;
      if (error?.externalActionRecoveryDeferred !== true) throw error;
      return buildAutonomousResearchStateRecoverabilityDeferredCycleReceipt({
        stateRecoverability: Object.freeze({
          status: 'autonomous_research_supervisor_external_action_recovery_deferred',
          blockers: Object.freeze([String(error.message)]),
          nextAttemptAt: error.retryAt || null,
        }),
        ownerId,
        startupReconciliation: null,
        startupReconciliationReceipt: null,
        now: nowDate(clock),
      });
    }
    if (startupReconciliationReceipt && !startupReconciliationPublished
      && typeof onStartupReconciled === 'function') {
      await onStartupReconciled(startupReconciliationReceipt);
      startupReconciliationPublished = true;
    }
    const authorityEvidence = await reconcileOnlineAuthorityEvidence(
      onResidentProgress,
      'cycle',
    );
    if (authorityEvidence && authorityEvidence.ready !== true) {
      return buildAutonomousResearchAuthorityEvidenceDeferredCycleReceipt({
        authorityEvidence,
        ownerId,
        startupReconciliation: reconciliation,
        startupReconciliationReceipt,
        now: nowDate(clock),
      });
    }
    const residentLeaseContext = await onResidentProgress?.({
      stage: 'before_autonomy_prerequisite_reconciliation',
    });
    try {
      await externalActionRecoveryController?.reconcile({
        residentLeaseContext,
        signal: executionSignal,
      });
      await reconcileStateRecoverability({
        residentLeaseContext,
        action: 'supervisor_cycle_quiet_point',
      });
      assertStateRecoverabilityCurrent('supervisor_cycle_side_effect_gate');
    } catch (error) {
      if (error?.externalActionRecoveryFatal === true) throw error;
      if (error?.externalActionRecoveryDeferred === true) {
        return buildAutonomousResearchStateRecoverabilityDeferredCycleReceipt({
          stateRecoverability: Object.freeze({
            status: 'autonomous_research_supervisor_external_action_recovery_deferred',
            blockers: Object.freeze([String(error.message)]),
            nextAttemptAt: error.retryAt || null,
          }),
          ownerId,
          startupReconciliation: reconciliation,
          startupReconciliationReceipt,
          now: nowDate(clock),
        });
      }
      if (error?.stateRecoverabilityFatal === true) throw error;
      if (error?.stateRecoverabilityDeferred !== true) throw error;
      return buildAutonomousResearchStateRecoverabilityDeferredCycleReceipt({
        stateRecoverability: error.recoverabilityReceipt || Object.freeze({
          status: 'autonomous_research_state_recoverability_deferred',
          blockers: error.blockers || Object.freeze([String(error.message)]),
          nextAttemptAt: error.retryAt || null,
        }),
        ownerId,
        startupReconciliation: reconciliation,
        startupReconciliationReceipt,
        now: nowDate(clock),
      });
    }
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
      const campaignAuthorityEvidence = await reconcileOnlineAuthorityEvidence(
        onResidentProgress,
        `campaign:${campaign.campaignId}`,
      );
      if (campaignAuthorityEvidence && campaignAuthorityEvidence.ready !== true) {
        results.push(Object.freeze({
          campaignId: campaign.campaignId,
          status: 'infrastructure_deferred',
          reason: campaignAuthorityEvidence.reason,
          retryAt: campaignAuthorityEvidence.retryAt || null,
          externalSubmissionPerformed: false,
        }));
        break;
      }
      const campaignResidentLeaseContext = await onResidentProgress?.({
        stage: `before_campaign:${campaign.campaignId}`,
      });
      try {
        await reconcileStateRecoverability({
          residentLeaseContext: campaignResidentLeaseContext,
          action: `campaign_quiet_point:${campaign.campaignId}`,
        });
        assertStateRecoverabilityCurrent(`campaign_entry:${campaign.campaignId}`);
      } catch (error) {
        if (error?.stateRecoverabilityFatal === true) throw error;
        if (error?.stateRecoverabilityDeferred !== true) throw error;
        results.push(Object.freeze({
          campaignId: campaign.campaignId,
          status: 'infrastructure_deferred',
          reason: String(error?.message || error),
          retryAt: error?.retryAt || null,
          externalSubmissionPerformed: false,
        }));
        break;
      }
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
      externalSubmissionPerformed: results.some((result) =>
        result?.externalSubmissionPerformed === true),
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
      residentCycleIntentRepository,
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
