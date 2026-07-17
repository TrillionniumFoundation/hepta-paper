import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutomationReadinessSideEffectInspection,
} from '../../paper-domain/automation/automation-readiness-side-effect-inspection.mjs';
import {
  verifyAutonomousResearchSupervisorExternalActionAttemptReceipt,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function compactAutonomousResearchSupervisorOutcome(report) {
  if (!report) return null;
  const suppliedExternalActionReceipts = report.supervisorExternalActionReceipts;
  if (suppliedExternalActionReceipts !== undefined
    && (!Array.isArray(suppliedExternalActionReceipts)
      || suppliedExternalActionReceipts.length > 4
      || !suppliedExternalActionReceipts.every((receipt) =>
        verifyAutonomousResearchSupervisorExternalActionAttemptReceipt(receipt)))) {
    throw new Error('autonomous_research_supervisor_external_action_receipts_invalid');
  }
  const externalActionReceipts = Object.freeze(
    (suppliedExternalActionReceipts || []).map((receipt) =>
      Object.freeze(JSON.parse(JSON.stringify(receipt)))),
  );
  return Object.freeze({
    status: report.status || null,
    campaignStatus: report.campaign?.status || null,
    externalQualificationStatus: report.externalQualification?.status || null,
    campaignFullyQualified: report.campaignFullyQualified === true,
    fullAutomaticResearchWritingReady: report.fullAutomaticResearchWritingReady === true,
    reportHash: report.autonomousResearchCampaignExecutionReportHash || null,
    externalActionReceipts,
  });
}

export function buildAutonomousResearchDispatchFailureOutcome(error) {
  const fallback = Object.freeze({ status: 'supervisor_dispatch_failed' });
  const inspection = error?.automationReadinessSideEffectInspection;
  if (!verifyAutomationReadinessSideEffectInspection(inspection)) return fallback;
  let serialized;
  try { serialized = JSON.stringify(inspection); } catch { return fallback; }
  if (Buffer.byteLength(serialized) > 48 * 1024) return fallback;
  const snapshot = JSON.parse(serialized);
  if (!verifyAutomationReadinessSideEffectInspection(snapshot)) return fallback;
  return Object.freeze({
    status: 'supervisor_dispatch_failed',
    readinessAttemptReceipt: Object.freeze(snapshot),
  });
}

function verifiedPendingIntakeResult(value) {
  return value?.status === 'machine_intake_enqueued'
    && typeof value.intakeId === 'string' && value.intakeId.length > 0
    && typeof value.campaignId === 'string' && value.campaignId.length > 0
    && SHA256.test(String(value.campaignPlanHash || ''))
    && SHA256.test(String(value.preparationHash || ''))
    && SHA256.test(String(value.admissionHash || ''));
}

function pendingIntakeReconciliationBlocker(result) {
  const pendingCount = result?.pendingCount;
  const processedCount = result?.processedCount;
  const results = result?.results;
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0
    || !Number.isSafeInteger(processedCount) || processedCount < 0
    || !Array.isArray(results) || processedCount !== results.length
    || processedCount > pendingCount) {
    return 'autonomous_research_machine_intake_pending_reconciliation_invalid';
  }
  if (processedCount !== pendingCount) {
    return 'autonomous_research_machine_intake_pending_reconciliation_incomplete';
  }
  const unsuccessful = results.find((item) => !verifiedPendingIntakeResult(item));
  if (!unsuccessful) return null;
  if (unsuccessful?.status === 'machine_intake_leased') {
    return 'autonomous_research_machine_intake_pending_lease_held';
  }
  if (unsuccessful?.status === 'machine_intake_not_due'
    || unsuccessful?.status === 'not_due_or_leased') {
    return 'autonomous_research_machine_intake_pending_not_due';
  }
  return 'autonomous_research_machine_intake_pending_processing_unsuccessful';
}

export function buildAutonomousResearchStartupReconciliationReceipt({
  ownerId,
  reconciliation,
  fullyAutonomousPrerequisiteReceipt = null,
  reconciledAt,
} = {}) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorStartupReconciliationReceipt',
    ownerId,
    reconciliation,
    fullyAutonomousPrerequisiteReceipt,
    reconciledAt,
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorStartupReconciliationReceiptHash: hashRecord(
      'AutonomousResearchSupervisorStartupReconciliationReceipt',
      payload,
    ),
  });
}

export function buildAutonomousResearchMachineIntakeReconciliationProgress({
  result,
  ownerId,
  now,
} = {}) {
  let reason = null;
  if (result?.configured !== true || !result.loaded) {
    reason = result?.error || 'autonomous_research_machine_intake_not_reconciled';
  } else if (Number(result.loaded.errorCount || 0) !== 0) {
    reason = 'autonomous_research_machine_intake_load_errors_present';
  } else if (!SHA256.test(String(result.loaded.configurationHash || ''))) {
    reason = 'autonomous_research_machine_intake_configuration_hash_missing';
  } else if (result.loaded.topicProducer
    && !SHA256.test(String(
      result.loaded.topicProducerDatasetSnapshot?.datasetSnapshotHash || '',
    ))) {
    reason = 'autonomous_research_topic_producer_dataset_snapshot_hash_missing';
  } else if (result.loaded.topicProducer
    && result.loaded.topicProducer.ready !== true) {
    reason = result.loaded.topicProducer.error
      || result.loaded.topicProducer.status
      || 'autonomous_research_topic_producer_not_currently_ready';
  } else if (!Array.isArray(result.enqueuedReconciliation)) {
    reason = 'autonomous_research_machine_intake_enqueued_reconciliation_invalid';
  } else if (result.enqueuedReconciliation.some((item) =>
    item?.status !== 'machine_intake_enqueued_binding_verified')) {
    reason = 'autonomous_research_machine_intake_enqueued_reconciliation_unsuccessful';
  } else {
    reason = pendingIntakeReconciliationBlocker(result);
  }
  if (reason) return Object.freeze({ ready: false, reason, receipt: null });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorMachineIntakeReconciliationReceipt',
    ownerId,
    machineIntakeConfigurationHash: result.loaded.configurationHash,
    topicProducerDatasetSnapshotHash:
      result.loaded.topicProducerDatasetSnapshot?.datasetSnapshotHash || null,
    machineIntakeCycleResultHash: hashRecord(
      'AutonomousResearchMachineIntakeCycleResult',
      result,
    ),
    reconciledAt: now.toISOString(),
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  return Object.freeze({
    ready: true,
    reason: null,
    receipt: Object.freeze({
      ...payload,
      autonomousResearchSupervisorMachineIntakeReconciliationReceiptHash: hashRecord(
        'AutonomousResearchSupervisorMachineIntakeReconciliationReceipt',
        payload,
      ),
    }),
  });
}

export function buildAutonomousResearchMachineIntakeBlockedCycleReceipt({
  machineIntake,
  reason,
  ownerId,
  startupReconciliation,
  startupReconciliationReceipt,
  now,
} = {}) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorCycleReceipt',
    status: 'autonomous_research_supervisor_machine_intake_reconciliation_blocked',
    ownerId,
    startupReconciliation,
    startupReconciliationReceipt,
    machineIntake,
    machineIntakeReconciliationReceipt: null,
    machineIntakeReconciliationBlocker: reason,
    discoveredCampaignCount: 0,
    processedCampaignCount: 0,
    results: Object.freeze([]),
    observedAt: now.toISOString(),
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorCycleReceiptHash:
      hashRecord('AutonomousResearchSupervisorCycleReceipt', payload),
  });
}

export function buildAutonomousResearchAutonomyBlockedCycleReceipt({
  machineIntake,
  machineIntakeReconciliationReceipt,
  prerequisiteInspection,
  reason,
  ownerId,
  startupReconciliation,
  startupReconciliationReceipt,
  now,
} = {}) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorCycleReceipt',
    status: 'autonomous_research_supervisor_autonomy_fence_blocked',
    ownerId,
    startupReconciliation,
    startupReconciliationReceipt,
    machineIntake,
    machineIntakeReconciliationReceipt,
    autonomyOperationMode: 'blocked',
    fullyAutonomousPrerequisiteReceipt: prerequisiteInspection?.receipt || null,
    fullyAutonomousPrerequisiteBlocker: reason,
    discoveredCampaignCount: 0,
    processedCampaignCount: 0,
    results: Object.freeze([]),
    observedAt: now.toISOString(),
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorCycleReceiptHash:
      hashRecord('AutonomousResearchSupervisorCycleReceipt', payload),
  });
}
