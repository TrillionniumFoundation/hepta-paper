import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_SAMPLE_EXPORT_STATUS_VERSION = 1;

export const READ_ONLY_SAMPLE_EXPORT_STATUS = Object.freeze({
  READY: 'ready_readonly_sample_export',
  BLOCKED: 'blocked_readonly_sample_export',
});

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes) || null,
  };
}

function safeFalseSafety(extra = {}) {
  return {
    executesExternalAction: false,
    uploads: false,
    submits: false,
    sendsMessages: false,
    acceptsDelivery: false,
    pays: false,
    deploys: false,
    fetchesChannelState: false,
    appliesLocalStateTransition: false,
    grantsExecutionPermission: false,
    readyForExecution: false,
    ...extra,
  };
}

function unsafeSafetyRecord(record = null) {
  const unsafeKeys = [
    'executesExternalAction',
    'uploads',
    'submits',
    'sendsMessages',
    'acceptsDelivery',
    'pays',
    'deploys',
    'fetchesChannelState',
    'appliesLocalStateTransition',
    'grantsExecutionPermission',
    'readyForExecution',
  ];
  return unsafeKeys.some((key) => record?.[key] === true || record?.safety?.[key] === true);
}

const REQUIRED_HUMAN_FEEDBACK_SAMPLE_SOURCES = Object.freeze(['zbj', 'epwk', 'hepta']);

function humanFeedbackCoverageBlockers(sampleSummary = {}) {
  const coverage = sampleSummary.humanFeedback || null;
  const blockers = [];
  if (!coverage) {
    blockers.push(issue('human_feedback_sample_coverage_missing', 'Read-only sample export requires explicit human-feedback sample coverage.'));
    return blockers;
  }
  const sampleCount = Number(coverage.sampleCount || 0);
  const bySource = coverage.bySource || {};
  const missingSources = (coverage.requiredSources || REQUIRED_HUMAN_FEEDBACK_SAMPLE_SOURCES)
    .filter((source) => Number(bySource[source] || 0) < 1);
  if (sampleCount < REQUIRED_HUMAN_FEEDBACK_SAMPLE_SOURCES.length || missingSources.length) {
    blockers.push(issue('human_feedback_sample_source_coverage_required', missingSources.join(', ') || `sampleCount=${sampleCount}`));
  }
  if (Number(coverage.contractReadyCount || 0) !== sampleCount) {
    blockers.push(issue('human_feedback_sample_contract_validation_required', `ready=${coverage.contractReadyCount || 0}, total=${sampleCount}`));
  }
  if (Number(coverage.customerFacingReadyCount || 0) !== sampleCount) {
    blockers.push(issue('human_feedback_sample_customer_facing_validation_required', `ready=${coverage.customerFacingReadyCount || 0}, total=${sampleCount}`));
  }
  return blockers;
}

export function buildReadOnlySampleExportStatus({
  sampleSummary = null,
  dashboardSnapshot = null,
  actor = 'design-production-core.readonly-sample-export-status',
  generatedAt = null,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!sampleSummary) {
    blockers.push(issue('sample_summary_missing', 'Read-only sample export status requires a sample summary.'));
  } else if (sampleSummary.validationOk !== true) {
    blockers.push(issue('sample_validation_not_ok', 'Sample validation must pass before read-only export can be marked ok.'));
  }
  if (sampleSummary) {
    blockers.push(...humanFeedbackCoverageBlockers(sampleSummary));
  }

  if (!dashboardSnapshot) {
    blockers.push(issue('dashboard_snapshot_missing', 'Read-only sample export status requires a dashboard snapshot.'));
  } else if (dashboardSnapshot.readyForDashboard !== true) {
    blockers.push(issue('dashboard_snapshot_not_ready', dashboardSnapshot.status));
  }

  if (unsafeSafetyRecord(sampleSummary)) {
    blockers.push(issue('sample_summary_unsafe', 'Sample summary input must remain read-only and non-executing.'));
  }
  if (unsafeSafetyRecord(dashboardSnapshot)) {
    blockers.push(issue('dashboard_snapshot_unsafe', 'Dashboard snapshot input must remain read-only and non-executing.'));
  }

  const planOnlyBlocked = Number(sampleSummary?.planOnlyBlocked || 0);
  const dashboardWarnings = Array.isArray(dashboardSnapshot?.warnings) ? dashboardSnapshot.warnings.length : 0;
  const dashboardBlockers = Array.isArray(dashboardSnapshot?.blockers) ? dashboardSnapshot.blockers.length : 0;

  if (planOnlyBlocked > 0) {
    warnings.push(issue('plan_only_blocked_samples_present', `${planOnlyBlocked} read-only samples have plan-only blockers.`, 'warning'));
  }
  if (dashboardWarnings > 0) {
    warnings.push(issue('dashboard_snapshot_warnings_present', `${dashboardWarnings} dashboard snapshot warnings should remain visible.`, 'warning'));
  }
  if (dashboardBlockers > 0) {
    warnings.push(issue('dashboard_snapshot_blockers_present', `${dashboardBlockers} dashboard snapshot blockers were carried into export status.`, 'warning'));
  }

  const status = blockers.length
    ? READ_ONLY_SAMPLE_EXPORT_STATUS.BLOCKED
    : READ_ONLY_SAMPLE_EXPORT_STATUS.READY;
  const exportStatus = {
    version: READ_ONLY_SAMPLE_EXPORT_STATUS_VERSION,
    kind: 'ReadOnlySampleExportStatus',
    actor: normalizeText(actor) || 'design-production-core.readonly-sample-export-status',
    status,
    ok: status === READ_ONLY_SAMPLE_EXPORT_STATUS.READY,
    readyForExport: status === READ_ONLY_SAMPLE_EXPORT_STATUS.READY,
    metrics: {
      sampleCount: Number(sampleSummary?.sampleCount || 0),
      planOnlyBlocked,
      validationOk: sampleSummary?.validationOk === true,
      humanFeedbackSamples: Number(sampleSummary?.humanFeedback?.sampleCount || 0),
      humanFeedbackContractReady: Number(sampleSummary?.humanFeedback?.contractReadyCount || 0),
      humanFeedbackCustomerFacingReady: Number(sampleSummary?.humanFeedback?.customerFacingReadyCount || 0),
      dashboardReady: dashboardSnapshot?.readyForDashboard === true,
      dashboardWarningCount: dashboardWarnings,
      dashboardBlockerCount: dashboardBlockers,
      dispatchBlockedHandoffs: Number(dashboardSnapshot?.metrics?.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(dashboardSnapshot?.metrics?.dispatchApprovalProvenanceBoundHandoffs || 0),
      unknownOperatorHintCount: Number(dashboardSnapshot?.metrics?.unknownOperatorHintCount || 0),
    },
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlySampleExportStatus: true,
      exportStatusOnly: true,
      dashboardSnapshotMustBeReady: true,
      sampleValidationMustPass: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const statusHash = digest({
    version: exportStatus.version,
    kind: exportStatus.kind,
    actor: exportStatus.actor,
    status: exportStatus.status,
    ok: exportStatus.ok,
    readyForExport: exportStatus.readyForExport,
    metrics: exportStatus.metrics,
    blockers: exportStatus.blockers,
    warnings: exportStatus.warnings,
    safety: exportStatus.safety,
  });
  return {
    ...exportStatus,
    statusHash,
    hash: statusHash,
  };
}

export function summarizeReadOnlySampleExportStatuses(statuses = []) {
  const byStatus = {};
  let readyCount = 0;
  let blockedCount = 0;
  for (const status of statuses || []) {
    byStatus[status.status] = (byStatus[status.status] || 0) + 1;
    if (status.ok === true || status.readyForExport === true) readyCount += 1;
    if ((status.blockers || []).length > 0) blockedCount += 1;
  }
  return {
    version: READ_ONLY_SAMPLE_EXPORT_STATUS_VERSION,
    count: statuses.length,
    readyCount,
    blockedCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlySampleExportStatusSummary: true,
      executesExternalAction: statuses.some((status) => status.safety?.executesExternalAction === true),
      fetchesChannelState: statuses.some((status) => status.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: statuses.some((status) => status.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: statuses.some((status) => status.safety?.grantsExecutionPermission === true),
      readyForExecution: statuses.some((status) => status.safety?.readyForExecution === true),
    }),
  };
}
