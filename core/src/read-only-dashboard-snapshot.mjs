import {
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  normalizeText,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_DASHBOARD_SNAPSHOT_VERSION = 1;

export const READ_ONLY_DASHBOARD_SNAPSHOT_STATUS = Object.freeze({
  READY: 'ready_readonly_dashboard_snapshot',
  BLOCKED: 'blocked_readonly_dashboard_snapshot',
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

function unsafeSafetyRecords(records = []) {
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
  return records.filter((record) => unsafeKeys.some((key) => record?.[key] === true || record?.safety?.[key] === true));
}

const REQUIRED_HUMAN_FEEDBACK_SAMPLE_SOURCES = Object.freeze(['zbj', 'epwk', 'hepta']);
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isSha256Hash(value) {
  return SHA256_HASH_PATTERN.test(normalizeText(value || ''));
}

function humanFeedbackCoverageBlockers(summary = {}) {
  const coverage = summary.humanFeedback || null;
  const blockers = [];
  if (!coverage) {
    blockers.push(issue('human_feedback_sample_coverage_missing', 'Read-only dashboard requires explicit human-feedback sample coverage.'));
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

function compactSample(sample = {}) {
  const packageRole = canonicalPackageRole(sample.packageRole || sample.workflowProfile?.packageRole || '') || null;
  const reviewType = canonicalPackageRole(sample.reviewType || sample.workflowProfile?.reviewType || '') || null;
  const role = canonicalPackageRole(sample.role || sample.workflowProfile?.role || '') || null;
  return {
    source: normalizeText(sample.source) || null,
    taskKey: normalizeText(sample.taskKey) || null,
    productLineId: canonicalProductLineIdOrNull(sample.productLineId),
    workflowId: canonicalProductLineIdOrNull(sample.workflowProfile?.workflowId || sample.workflowId),
    ...(packageRole ? { packageRole } : {}),
    ...(reviewType ? { reviewType } : {}),
    ...(role ? { role } : {}),
    planOnlyStatus: normalizeText(sample.planOnly?.status || sample.planOnlyStatus) || null,
    validationOk: sample.validation?.ok === true || sample.validationOk === true,
  };
}

function canonicalProductCountMap(counts = {}) {
  const normalizedCounts = {};
  for (const [key, value] of Object.entries(counts || {})) {
    const canonicalKey = canonicalProductLineId(key) || 'unknown';
    const count = Number.isFinite(Number(value)) ? Number(value) : 0;
    normalizedCounts[canonicalKey] = (normalizedCounts[canonicalKey] || 0) + count;
  }
  return normalizedCounts;
}

function dispatchApprovalProvenanceBoundHandoffs(dispatchReadiness = {}) {
  const reports = Array.isArray(dispatchReadiness.reports) ? dispatchReadiness.reports : [];
  return reports.filter((report) => isSha256Hash(report.approvalProvenanceHash)).length;
}

export function buildReadOnlyDashboardSnapshot({
  sampleSummary = null,
  controlPlane = null,
  samples = [],
  actor = 'design-production-core.readonly-dashboard-snapshot',
  generatedAt = null,
} = {}) {
  const dispatchReadiness = controlPlane?.dispatchReadiness || {};
  const dispatchDashboardStatus = dispatchReadiness.dashboardStatus || null;
  const dispatchMetrics = dispatchDashboardStatus?.metrics || {};
  const operatorHintSummary = dispatchReadiness.operatorHintSummary || {};
  const blockers = [];
  const warnings = [];

  if (!sampleSummary) {
    blockers.push(issue('sample_summary_missing', 'Dashboard snapshot requires a read-only sample summary.'));
  } else if (sampleSummary.validationOk !== true) {
    blockers.push(issue('sample_validation_not_ok', 'Sample summary validation must pass before dashboard-ready export.'));
  }
  if (sampleSummary) {
    blockers.push(...humanFeedbackCoverageBlockers(sampleSummary));
  }

  if (!dispatchDashboardStatus) {
    blockers.push(issue('dispatch_dashboard_status_missing', 'Dashboard snapshot requires dispatch readiness dashboard status.'));
  } else if (dispatchDashboardStatus.readyForDashboard !== true) {
    blockers.push(issue('dispatch_dashboard_status_not_ready', dispatchDashboardStatus.status));
  }

  if (unsafeSafetyRecords([controlPlane, dispatchDashboardStatus, operatorHintSummary]).length > 0) {
    blockers.push(issue('readonly_dashboard_input_claims_external_action', 'Dashboard inputs must remain read-only and non-executing.'));
  }

  const planOnlyBlocked = Number(sampleSummary?.planOnlyBlocked || 0);
  const blockedHandoffs = Number(dispatchMetrics.blockedHandoffs || 0);
  const readyHandoffs = Number(dispatchMetrics.readyHandoffs || 0);
  const totalHandoffs = readyHandoffs + blockedHandoffs;
  const unknownOperatorHintCount = Number(dispatchMetrics.unknownOperatorHintCount || operatorHintSummary.unknownCount || 0);
  const approvalProvenanceBoundHandoffs = dispatchApprovalProvenanceBoundHandoffs(dispatchReadiness);

  if (planOnlyBlocked > 0) {
    warnings.push(issue('plan_only_blocked_samples_present', `${planOnlyBlocked} read-only samples have plan-only blockers.`, 'warning'));
  }
  if (blockedHandoffs > 0) {
    warnings.push(issue('blocked_dispatch_handoffs_present', `${blockedHandoffs} dispatch handoffs are blocked and should stay visible.`, 'warning'));
  }
  if (unknownOperatorHintCount > 0) {
    blockers.push(issue('unknown_operator_hints_present', `${unknownOperatorHintCount} operator hint codes did not resolve through the catalog.`));
  }
  if (totalHandoffs > 0 && approvalProvenanceBoundHandoffs !== totalHandoffs) {
    blockers.push(issue(
      'dispatch_approval_provenance_hash_coverage_required',
      `${approvalProvenanceBoundHandoffs}/${totalHandoffs} dispatch handoffs expose approvalProvenanceHash.`,
    ));
  }

  const status = blockers.length
    ? READ_ONLY_DASHBOARD_SNAPSHOT_STATUS.BLOCKED
    : READ_ONLY_DASHBOARD_SNAPSHOT_STATUS.READY;

  const snapshot = {
    version: READ_ONLY_DASHBOARD_SNAPSHOT_VERSION,
    kind: 'ReadOnlyDashboardSnapshot',
    actor: normalizeText(actor) || 'design-production-core.readonly-dashboard-snapshot',
    status,
    readyForDashboard: status === READ_ONLY_DASHBOARD_SNAPSHOT_STATUS.READY,
    metrics: {
      sampleCount: Number(sampleSummary?.sampleCount || 0),
      planOnlyBlocked,
      averageCoverage: Number(sampleSummary?.averageCoverage || 0),
      averageRouteConfidence: Number(sampleSummary?.averageRouteConfidence || 0),
      humanFeedbackSamples: Number(sampleSummary?.humanFeedback?.sampleCount || 0),
      humanFeedbackContractReady: Number(sampleSummary?.humanFeedback?.contractReadyCount || 0),
      humanFeedbackCustomerFacingReady: Number(sampleSummary?.humanFeedback?.customerFacingReadyCount || 0),
      dispatchReadyHandoffs: readyHandoffs,
      dispatchBlockedHandoffs: blockedHandoffs,
      dispatchApprovalProvenanceBoundHandoffs: approvalProvenanceBoundHandoffs,
      operatorHintCount: Number(dispatchMetrics.operatorHintCount || operatorHintSummary.count || 0),
      operatorHintCatalogCount: Number(dispatchMetrics.operatorHintCatalogCount || operatorHintSummary.catalogCount || 0),
      unknownOperatorHintCount,
    },
    summaries: {
      bySource: sampleSummary?.bySource || {},
      byProductLine: canonicalProductCountMap(sampleSummary?.byProductLine),
      byWorkflowProfile: canonicalProductCountMap(sampleSummary?.byWorkflowProfile),
      byPlanOnlyStatus: sampleSummary?.byPlanOnlyStatus || {},
      humanFeedbackBySource: sampleSummary?.humanFeedback?.bySource || {},
      dispatchByStatus: dispatchReadiness.summary?.byStatus || {},
      dispatchByChannel: dispatchReadiness.summary?.byChannel || {},
      operatorHintsByCode: operatorHintSummary.byCode || {},
    },
    samples: (samples || []).map(compactSample),
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyDashboardSnapshot: true,
      dashboardDisplayOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const snapshotHash = digest({
    version: snapshot.version,
    kind: snapshot.kind,
    actor: snapshot.actor,
    status: snapshot.status,
    readyForDashboard: snapshot.readyForDashboard,
    metrics: snapshot.metrics,
    summaries: snapshot.summaries,
    samples: snapshot.samples,
    blockers: snapshot.blockers,
    warnings: snapshot.warnings,
    safety: snapshot.safety,
  });
  return {
    ...snapshot,
    snapshotHash,
    hash: snapshotHash,
  };
}

export function summarizeReadOnlyDashboardSnapshots(snapshots = []) {
  const byStatus = {};
  let readyCount = 0;
  let blockedCount = 0;
  for (const snapshot of snapshots || []) {
    byStatus[snapshot.status] = (byStatus[snapshot.status] || 0) + 1;
    if (snapshot.readyForDashboard === true) readyCount += 1;
    if ((snapshot.blockers || []).length > 0) blockedCount += 1;
  }
  return {
    version: READ_ONLY_DASHBOARD_SNAPSHOT_VERSION,
    count: snapshots.length,
    readyCount,
    blockedCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyDashboardSnapshotSummary: true,
      executesExternalAction: snapshots.some((snapshot) => snapshot.safety?.executesExternalAction === true),
      fetchesChannelState: snapshots.some((snapshot) => snapshot.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: snapshots.some((snapshot) => snapshot.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: snapshots.some((snapshot) => snapshot.safety?.grantsExecutionPermission === true),
      readyForExecution: snapshots.some((snapshot) => snapshot.safety?.readyForExecution === true),
    }),
  };
}
