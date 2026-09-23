import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
  verifyAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  isResidentReactivationRequired,
} from './autonomous-research-resident-reactivation-required.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MACHINE_ENQUEUE_RECEIPT_KEYS = Object.freeze([
  'admissionOnly',
  'admissionPreflightExecutionInspection',
  'autonomousResearchCampaignEnqueueReceiptHash',
  'autonomousResearchCampaignExecutionAdmissionHash',
  'autonomousResearchLoopPreparationReportHash',
  'autonomousResearchMachineIntakeAdmission',
  'autonomousResearchMachineIntakeAdmissionHash',
  'autonomousResearchMachineIntakeHash',
  'campaign',
  'campaignId',
  'campaignPlanHash',
  'created',
  'executionAuthorized',
  'executionStarted',
  'externalActionPerformed',
  'kind',
  'initialCampaignStatus',
  'paperId',
  'status',
  'version',
].sort());
const ADMISSION_PREFLIGHT_INSPECTION_KEYS = Object.freeze([
  'autonomousResearchAdmissionPreflightExecutionInspectionHash',
  'externalActionPerformed',
  'kind',
  'localDaemonActionPerformed',
  'localDockerDaemonProbeCount',
  'localProcessActionPerformed',
  'networkActionPerformed',
  'processCount',
  'sandbox',
  'version',
].sort());

function nowDate(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_supervisor_clock_invalid');
  }
  return date;
}

function admissionPreflightInspectionValid(inspection) {
  const {
    autonomousResearchAdmissionPreflightExecutionInspectionHash: claimedHash,
    ...payload
  } = inspection || {};
  const processCount = Number(inspection?.processCount);
  const daemonCount = Number(inspection?.localDockerDaemonProbeCount);
  return exactKeys(inspection, ADMISSION_PREFLIGHT_INSPECTION_KEYS)
    && inspection.version === 1
    && inspection.kind === 'AutonomousResearchAdmissionPreflightExecutionInspection'
    && inspection.sandbox === 'bubblewrap-unshare-net-read-only-root-v1'
    && processCount === 8
    && daemonCount === 2
    && inspection.localProcessActionPerformed === true
    && inspection.localDaemonActionPerformed === true
    && inspection.networkActionPerformed === false
    && inspection.externalActionPerformed === false
    && hashRecord('AutonomousResearchAdmissionPreflightExecutionInspection', payload)
      === claimedHash;
}

function assertSynchronousAutonomyCurrent({
  assertAutonomyCurrent,
  residentLeaseContext,
  requireFullOperationMode,
  action,
} = {}) {
  if (typeof assertAutonomyCurrent !== 'function') {
    throw new Error('autonomous_research_machine_intake_autonomy_fence_required');
  }
  const inspection = assertAutonomyCurrent({
    residentLeaseContext,
    requireFullOperationMode,
    action,
  });
  const allowedModes = requireFullOperationMode
    ? ['full', 'unrestricted'] : ['bootstrap-only', 'full', 'unrestricted'];
  if (typeof inspection?.then === 'function' || inspection?.ready !== true
    || !allowedModes.includes(inspection?.operationMode)) {
    throw new Error('autonomous_research_machine_intake_autonomy_fence_invalid');
  }
  return inspection;
}

function assertPendingIntakeProvenanceCurrent(record, now) {
  const intake = record?.intake;
  const admission = record?.admission;
  if (!verifyAutonomousResearchMachineIntakeAdmission(admission, { intake })
    || record?.intakeId !== intake?.intakeId
    || record?.intakeHash !== intake?.intakeHash
    || record?.campaignId !== intake?.campaignId
    || record?.admissionHash !== admission?.autonomousResearchMachineIntakeAdmissionHash
    || record?.sourceKind !== admission?.sourceKind
    || record?.sourceAuthorityHash !== admission?.sourceAuthorityHash) {
    throw new Error('autonomous_research_machine_intake_pending_provenance_invalid');
  }
  if (record.sourceKind !== 'recurring-golden') {
    if (!['machine', 'static-file'].includes(record.sourceKind)
      || intake.launchMode !== 'production-run'
      || intake.recurringGoldenProvenance !== null) {
      throw new Error('autonomous_research_machine_intake_pending_provenance_invalid');
    }
    return 'production-run';
  }
  const provenance = intake.recurringGoldenProvenance;
  const epochStart = Date.parse(provenance?.epochStart || '');
  if (intake.launchMode !== 'golden-bootstrap'
    || provenance?.sourceAuthorityHash !== record.sourceAuthorityHash
    || record.sourceRef !== `${provenance?.templateId}@${provenance?.epochStart}`
    || !Number.isFinite(epochStart)
    || now.getTime() < epochStart
    || now.getTime() >= epochStart + Number(provenance?.epochDurationMs || 0)) {
    throw new Error('autonomous_research_recurring_golden_provenance_not_current');
  }
  return 'golden-bootstrap';
}

export function verifyAutonomousResearchMachineIntakeEnqueueCommit({
  receipt,
  record,
  admission,
  campaignStore,
} = {}) {
  const {
    campaign: _untrustedCampaign,
    autonomousResearchCampaignEnqueueReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  const admissionHash = admission.autonomousResearchMachineIntakeAdmissionHash;
  const statusValid = receipt?.status === 'autonomous_research_campaign_enqueued'
    ? receipt.created === true
    : receipt?.status === 'autonomous_research_campaign_already_enqueued'
      && receipt.created === false;
  if (!exactKeys(receipt, MACHINE_ENQUEUE_RECEIPT_KEYS)
    || receipt?.version !== 1 || receipt?.kind !== 'AutonomousResearchCampaignEnqueueReceipt'
    || !statusValid || receipt.executionStarted !== false
    || receipt.admissionOnly !== true || receipt.executionAuthorized !== false
    || receipt.initialCampaignStatus !== 'paused'
    || receipt.externalActionPerformed !== false
    || receipt.campaignId !== record.campaignId
    || receipt.paperId !== record.intake.paperId
    || receipt.autonomousResearchMachineIntakeHash !== record.intakeHash
    || admissionHash !== record.admissionHash
    || receipt.autonomousResearchMachineIntakeAdmissionHash !== admissionHash
    || !verifyAutonomousResearchMachineIntakeAdmission(
      receipt.autonomousResearchMachineIntakeAdmission,
      { intake: record.intake },
    )
    || receipt.autonomousResearchMachineIntakeAdmission
      .autonomousResearchMachineIntakeAdmissionHash !== admissionHash
    || !SHA256.test(String(receipt.campaignPlanHash || ''))
    || !SHA256.test(String(receipt.autonomousResearchCampaignExecutionAdmissionHash || ''))
    || !SHA256.test(String(receipt.autonomousResearchLoopPreparationReportHash || ''))
    || !admissionPreflightInspectionValid(receipt.admissionPreflightExecutionInspection)
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousResearchCampaignEnqueueReceipt', payload) !== claimedHash) {
    throw new Error('autonomous_research_machine_intake_enqueue_receipt_invalid');
  }
  const persisted = campaignStore.getCampaign(record.campaignId);
  const {
    campaignPlanHash: persistedPlanHash,
    ...persistedPlanPayload
  } = persisted?.spec || {};
  if (!persisted
    || persisted.paperId !== record.intake.paperId
    || persisted.status !== 'paused'
    || persisted.currentPhase !== 'admitted-not-authorized'
    || persisted.spec?.campaignPlanHash !== receipt.campaignPlanHash
    || hashRecord('PaperCampaignPlan', persistedPlanPayload) !== persistedPlanHash
    || persisted.spec?.autonomousResearchMachineIntakeHash !== record.intakeHash
    || persisted.spec?.autonomousResearchMachineIntakeAdmissionHash !== admissionHash
    || persisted.spec?.executionAdmission
      ?.autonomousResearchCampaignExecutionAdmissionHash
        !== receipt.autonomousResearchCampaignExecutionAdmissionHash
    || persisted.spec?.executionAdmission?.initialCampaignStatus !== 'paused'
    || persisted.spec?.executionAdmission?.supervisorDispatchAuthorizationRequired !== true
    || persisted.spec?.autonomousResearchPreparation
      ?.autonomousResearchLoopPreparationReportHash
        !== receipt.autonomousResearchLoopPreparationReportHash
    || persisted.spec?.autonomousResearchPreparation
      ?.autonomousResearchMachineIntakeAdmissionHash !== admissionHash) {
    throw new Error('autonomous_research_machine_intake_campaign_commit_invalid');
  }
  return persisted;
}

export function inspectAutonomousResearchMachineIntakeCampaignBinding({
  campaign,
  record = null,
  requireRecord = false,
} = {}) {
  const plan = campaign?.spec || null;
  const admission = plan?.autonomousResearchMachineIntakeAdmission || null;
  const intake = plan?.autonomousResearchMachineIntake || null;
  const admissionHash = admission?.autonomousResearchMachineIntakeAdmissionHash || null;
  if (!admission && !intake && !plan?.autonomousResearchMachineIntakeAdmissionHash) {
    if (requireRecord) {
      return Object.freeze({
        ready: false,
        machineBound: true,
        reason: 'autonomous_research_machine_intake_campaign_missing',
        admissionHash: record?.admissionHash || null,
      });
    }
    return Object.freeze({ ready: true, machineBound: false, reason: null });
  }
  const { campaignPlanHash, ...planPayload } = plan || {};
  let reason = null;
  if (!verifyAutonomousResearchMachineIntakeAdmission(admission, { intake })
    || campaign?.campaignId !== admission?.campaignId
    || campaign?.paperId !== admission?.paperId
    || plan?.autonomousResearchMachineIntakeHash !== admission?.intakeHash
    || plan?.autonomousResearchMachineIntakeAdmissionHash !== admissionHash
    || plan?.autonomousResearchPreparation
      ?.autonomousResearchMachineIntakeAdmissionHash !== admissionHash
    || !SHA256.test(String(campaignPlanHash || ''))
    || hashRecord('PaperCampaignPlan', planPayload) !== campaignPlanHash) {
    reason = 'autonomous_research_machine_intake_campaign_plan_binding_invalid';
  } else if (requireRecord && (!record
    || record.disposition !== 'enqueued'
    || record.intakeId !== admission.intakeId
    || record.intakeHash !== admission.intakeHash
    || record.campaignId !== admission.campaignId
    || record.admissionHash !== admissionHash
    || record.campaignPlanHash !== campaignPlanHash
    || record.preparationHash !== plan.autonomousResearchPreparation
      ?.autonomousResearchLoopPreparationReportHash)) {
    reason = 'autonomous_research_machine_intake_repository_campaign_binding_invalid';
  }
  return Object.freeze({
    ready: reason === null,
    machineBound: true,
    reason,
    admissionHash,
  });
}

export function createAutonomousResearchMachineIntakeCycleProcessor({
  machineIntake,
  campaignStore,
  clock,
  scheduler,
  ownerId,
  machineIntakeLeaseMs,
  maximumCampaignsPerCycle,
  pollMs,
  signal,
  assertAutonomyCurrent,
  reconcileStateRecoverability = null,
  assertStateRecoverabilityCurrent = null,
} = {}) {
  return async function processMachineIntakes({
    onProgress = null,
    operationMode = 'full',
  } = {}) {
    if (!['full', 'bootstrap-only'].includes(operationMode)) {
      throw new Error('autonomous_research_machine_intake_operation_mode_invalid');
    }
    if (!machineIntake) return Object.freeze({
      configured: false,
      loaded: null,
      pendingCount: 0,
      processedCount: 0,
      results: Object.freeze([]),
    });
    const loadNow = nowDate(clock);
    let loaded;
    try {
      const residentLeaseContext = await onProgress?.({ stage: 'before_machine_intake_load' });
      await reconcileStateRecoverability?.({
        residentLeaseContext,
        action: 'machine_intake_load_quiet_point',
      });
      assertStateRecoverabilityCurrent?.('machine_intake_load_entry');
      assertSynchronousAutonomyCurrent({
        assertAutonomyCurrent,
        residentLeaseContext,
        requireFullOperationMode: operationMode === 'full',
        action: 'machine_intake_load',
      });
      loaded = await machineIntake.loadConfiguredIntakes({
        now: loadNow,
        residentLeaseContext,
        operationMode,
        assertAutonomyCurrent,
        reconcileStateRecoverability,
        assertStateRecoverabilityCurrent,
      });
      await onProgress?.({ stage: 'after_machine_intake_load' });
    } catch (error) {
      if (isResidentReactivationRequired(error)) throw error;
      if (error?.stateRecoverabilityFatal === true
        || error?.stateRecoverabilityDeferred === true) throw error;
      if (error?.authorityEvidenceRenewalFatal === true
        || error?.authorityEvidenceRenewalDeferred === true) throw error;
      return Object.freeze({
        configured: true,
        loaded: null,
        pendingCount: 0,
        processedCount: 0,
        status: 'machine_intake_configuration_or_load_failed',
        error: String(error?.message || error),
        results: Object.freeze([]),
      });
    }
    machineIntake.repository.reconcileExpiredIntakeLeases({ now: loadNow });
    const enqueuedReconciliation = [];
    const enqueued = machineIntake.repository.listEnqueuedIntakes({ limit: 10_000 })
      .filter((record) => operationMode === 'full' || record.sourceKind === 'recurring-golden');
    for (const record of enqueued) {
      const campaign = campaignStore.getCampaign(record.campaignId);
      const inspection = inspectAutonomousResearchMachineIntakeCampaignBinding({
        campaign,
        record,
        requireRecord: true,
      });
      if (inspection.ready) {
        enqueuedReconciliation.push(Object.freeze({
          intakeId: record.intakeId,
          campaignId: record.campaignId,
          status: 'machine_intake_enqueued_binding_verified',
        }));
        continue;
      }
      try {
        machineIntake.repository.markEnqueuedIntakeInvalid({
          intakeId: record.intakeId,
          autonomousResearchMachineIntakeAdmissionHash: record.admissionHash,
          reason: inspection.reason,
          now: loadNow,
        });
        enqueuedReconciliation.push(Object.freeze({
          intakeId: record.intakeId,
          campaignId: record.campaignId,
          status: 'machine_intake_enqueued_binding_invalidated',
          reason: inspection.reason,
        }));
      } catch (error) {
        enqueuedReconciliation.push(Object.freeze({
          intakeId: record.intakeId,
          campaignId: record.campaignId,
          status: 'machine_intake_enqueued_binding_invalidation_failed',
          reason: inspection.reason,
          error: String(error?.message || error),
        }));
      }
    }
    const pending = machineIntake.repository.listPendingIntakes({
      limit: maximumCampaignsPerCycle,
      now: loadNow,
    }).filter((record) => operationMode === 'full' || record.sourceKind === 'recurring-golden');
    const results = [];
    for (const record of pending) {
      if (signal?.aborted) break;
      const lease = machineIntake.repository.tryAcquireIntakeLease({
        intakeId: record.intakeId,
        ownerId,
        leaseMs: machineIntakeLeaseMs,
        now: nowDate(clock),
      });
      if (!lease) {
        results.push(Object.freeze({
          intakeId: record.intakeId,
          status: 'machine_intake_leased',
        }));
        continue;
      }
      let leaseLost = false;
      const intakeController = new AbortController();
      const abortIntake = () => intakeController.abort(
        signal?.reason || 'autonomous_research_supervisor_stopping',
      );
      if (signal?.aborted) abortIntake();
      else signal?.addEventListener?.('abort', abortIntake, { once: true });
      const heartbeat = scheduler.setInterval(() => {
        try {
          const renewed = machineIntake.repository.renewIntakeLease({
            intakeId: record.intakeId,
            ...lease,
            leaseMs: machineIntakeLeaseMs,
            now: nowDate(clock),
          });
          if (!renewed) leaseLost = true;
        } catch { leaseLost = true; }
        if (leaseLost) intakeController.abort('autonomous_research_machine_intake_lease_lost');
      }, Math.max(250, Math.floor(machineIntakeLeaseMs / 3)));
      scheduler.unref?.(heartbeat);
      let enqueued = false;
      try {
        const admission = buildAutonomousResearchMachineIntakeAdmission({
          intake: record.intake,
          sourceKind: record.sourceKind,
          sourceAuthorityHash: record.sourceAuthorityHash,
          topicProducerCapabilityReceipt:
            record.admission?.topicProducerCapabilityReceipt || null,
        });
        const residentLeaseContext = await onProgress?.({
          stage: `before_machine_intake_enqueue:${record.intakeId}`,
        });
        await reconcileStateRecoverability?.({
          residentLeaseContext,
          action: `machine_intake_enqueue_quiet_point:${record.intakeId}`,
        });
        assertStateRecoverabilityCurrent?.(
          `machine_intake_enqueue_entry:${record.intakeId}`,
        );
        const mutationNow = nowDate(clock);
        machineIntake.repository.assertIntakeLease({
          intakeId: record.intakeId,
          ...lease,
          now: mutationNow,
        });
        const launchMode = assertPendingIntakeProvenanceCurrent(record, mutationNow);
        assertSynchronousAutonomyCurrent({
          assertAutonomyCurrent,
          residentLeaseContext,
          requireFullOperationMode: launchMode === 'production-run',
          action: launchMode === 'production-run'
            ? 'production_machine_intake_enqueue' : 'recurring_golden_machine_intake_enqueue',
        });
        const receipt = await machineIntake.enqueueIntake({
          intake: record.intake,
          machineIntakeAdmission: admission,
          intakeLease: Object.freeze({ intakeId: record.intakeId, ...lease }),
          residentLeaseContext,
          assertAutonomyCurrent,
          signal: intakeController.signal,
          now: mutationNow,
        });
        await onProgress?.({
          stage: `after_machine_intake_enqueue:${record.intakeId}`,
        });
        if (leaseLost) throw new Error('autonomous_research_machine_intake_lease_lost');
        verifyAutonomousResearchMachineIntakeEnqueueCommit({
          receipt,
          record,
          admission,
          campaignStore,
        });
        const persisted = machineIntake.repository.markIntakeEnqueued({
          intakeId: record.intakeId,
          ...lease,
          campaignPlanHash: receipt?.campaignPlanHash,
          autonomousResearchLoopPreparationReportHash:
            receipt?.autonomousResearchLoopPreparationReportHash,
          autonomousResearchMachineIntakeAdmissionHash:
            admission.autonomousResearchMachineIntakeAdmissionHash,
          now: nowDate(clock),
        });
        enqueued = true;
        results.push(Object.freeze({
          intakeId: record.intakeId,
          campaignId: record.campaignId,
          status: 'machine_intake_enqueued',
          campaignPlanHash: persisted.campaignPlanHash,
          preparationHash: persisted.preparationHash,
          admissionHash: persisted.admissionHash,
        }));
      } catch (error) {
        if (isResidentReactivationRequired(error)) throw error;
        if (error?.stateRecoverabilityFatal === true
          || error?.stateRecoverabilityDeferred === true) throw error;
        if (error?.authorityEvidenceRenewalFatal === true
          || error?.authorityEvidenceRenewalDeferred === true) throw error;
        if (!leaseLost) {
          try {
            machineIntake.repository.deferIntake({
              intakeId: record.intakeId,
              ...lease,
              error: String(error?.message || error),
              retryAfterMs: Math.max(1000, pollMs),
              now: nowDate(clock),
            });
            enqueued = true;
          } catch { /* lease loss leaves the next owner authoritative */ }
        }
        results.push(Object.freeze({
          intakeId: record.intakeId,
          campaignId: record.campaignId,
          status: leaseLost ? 'machine_intake_lease_lost' : 'machine_intake_deferred',
          error: String(error?.message || error),
        }));
      } finally {
        scheduler.clearInterval(heartbeat);
        signal?.removeEventListener?.('abort', abortIntake);
        if (!enqueued && !leaseLost) {
          try {
            machineIntake.repository.releaseIntakeLease({
              intakeId: record.intakeId,
              ...lease,
            });
          } catch { /* expired leases are recovered by the next mutating cycle */ }
        }
      }
    }
    return Object.freeze({
      configured: true,
      loaded,
      enqueuedReconciliation: Object.freeze(enqueuedReconciliation),
      pendingCount: pending.length,
      processedCount: results.length,
      results: Object.freeze(results),
    });
  };
}
