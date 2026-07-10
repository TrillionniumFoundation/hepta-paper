import { digest } from './hash-utils.mjs';

export const READ_ONLY_REPORT_CHAIN_VERSION = 1;

export const READ_ONLY_REPORT_CHAIN_STAGE_IDS = Object.freeze({
  SAMPLE_DASHBOARD: 'sample_dashboard',
  CORE_GATE: 'core_gate',
  CLOSEOUT: 'closeout',
  RELEASE_HEALTH: 'release_health',
  RELEASE_VERIFICATION: 'release_verification',
  RELEASE_ARCHIVE: 'release_archive',
  ARCHIVE_CLOSEOUT: 'archive_closeout',
});

export const READ_ONLY_REPORT_CHAIN_MODULE_BINDINGS = Object.freeze([
  Object.freeze({
    moduleId: 'read-only-control-summary',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.SAMPLE_DASHBOARD,
    role: 'builder',
    exportIds: Object.freeze(['buildDispatchReadinessControlSamples']),
  }),
  Object.freeze({
    moduleId: 'read-only-dashboard-snapshot',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.SAMPLE_DASHBOARD,
    role: 'builder',
    exportIds: Object.freeze(['buildReadOnlyDashboardSnapshot', 'summarizeReadOnlyDashboardSnapshots']),
  }),
  Object.freeze({
    moduleId: 'read-only-sample-export-status',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.SAMPLE_DASHBOARD,
    role: 'builder',
    exportIds: Object.freeze(['buildReadOnlySampleExportStatus', 'summarizeReadOnlySampleExportStatuses']),
  }),
  Object.freeze({
    moduleId: 'read-only-sample-export-validator',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.SAMPLE_DASHBOARD,
    role: 'validator',
    exportIds: Object.freeze(['validateReadOnlySampleExportPayload', 'summarizeReadOnlySampleExportValidations']),
  }),
  Object.freeze({
    moduleId: 'read-only-core-gate-validator',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.CORE_GATE,
    role: 'validator',
    exportIds: Object.freeze(['validateReadOnlyCoreGateReport', 'summarizeReadOnlyCoreGateValidations']),
  }),
  Object.freeze({
    moduleId: 'read-only-closeout-summary',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.CLOSEOUT,
    role: 'builder',
    exportIds: Object.freeze(['buildReadOnlyCloseoutSummary', 'summarizeReadOnlyCloseoutSummaries']),
  }),
  Object.freeze({
    moduleId: 'read-only-closeout-validator',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.CLOSEOUT,
    role: 'validator',
    exportIds: Object.freeze(['validateReadOnlyCloseoutSummary', 'summarizeReadOnlyCloseoutValidations']),
  }),
  Object.freeze({
    moduleId: 'read-only-release-health-manifest',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_HEALTH,
    role: 'builder',
    exportIds: Object.freeze(['buildReadOnlyReleaseHealthManifest', 'summarizeReadOnlyReleaseHealthManifests']),
  }),
  Object.freeze({
    moduleId: 'read-only-release-health-validator',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_HEALTH,
    role: 'validator',
    exportIds: Object.freeze(['validateReadOnlyReleaseHealthManifest', 'summarizeReadOnlyReleaseHealthValidations']),
  }),
  Object.freeze({
    moduleId: 'read-only-release-verification-bundle',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_VERIFICATION,
    role: 'builder',
    exportIds: Object.freeze(['buildReadOnlyReleaseVerificationBundle', 'summarizeReadOnlyReleaseVerificationBundles']),
  }),
  Object.freeze({
    moduleId: 'read-only-release-verification-validator',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_VERIFICATION,
    role: 'validator',
    exportIds: Object.freeze(['validateReadOnlyReleaseVerificationBundle', 'summarizeReadOnlyReleaseVerificationValidations']),
  }),
  Object.freeze({
    moduleId: 'read-only-release-archive-manifest',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_ARCHIVE,
    role: 'builder',
    exportIds: Object.freeze(['buildReadOnlyReleaseArchiveManifest', 'summarizeReadOnlyReleaseArchiveManifests']),
  }),
  Object.freeze({
    moduleId: 'read-only-release-archive-validator',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_ARCHIVE,
    role: 'validator',
    exportIds: Object.freeze(['validateReadOnlyReleaseArchiveManifest', 'summarizeReadOnlyReleaseArchiveValidations']),
  }),
  Object.freeze({
    moduleId: 'read-only-release-archive-closeout-bundle',
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.ARCHIVE_CLOSEOUT,
    role: 'builder',
    exportIds: Object.freeze(['buildReadOnlyReleaseArchiveCloseoutBundle', 'summarizeReadOnlyReleaseArchiveCloseoutBundles']),
  }),
]);

export const READ_ONLY_REPORT_CHAIN_STAGES = Object.freeze([
  Object.freeze({
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.SAMPLE_DASHBOARD,
    order: 1,
    label: 'Sample export and dashboard readiness',
    packageScriptIds: Object.freeze(['export:samples', 'validate:samples']),
    reportFileIds: Object.freeze(['read-only-samples-latest.json']),
    requiredRoles: Object.freeze(['builder', 'validator']),
  }),
  Object.freeze({
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.CORE_GATE,
    order: 2,
    label: 'Read-only core gate',
    packageScriptIds: Object.freeze(['gate:readonly', 'validate:gate']),
    reportFileIds: Object.freeze(['read-only-core-gate-latest.json']),
    requiredRoles: Object.freeze(['validator']),
  }),
  Object.freeze({
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.CLOSEOUT,
    order: 3,
    label: 'Read-only closeout',
    packageScriptIds: Object.freeze(['summarize:closeout', 'validate:closeout']),
    reportFileIds: Object.freeze(['read-only-closeout-latest.json']),
    requiredRoles: Object.freeze(['builder', 'validator']),
  }),
  Object.freeze({
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_HEALTH,
    order: 4,
    label: 'Read-only release health',
    packageScriptIds: Object.freeze(['release:health', 'validate:release-health']),
    reportFileIds: Object.freeze(['read-only-release-health-latest.json']),
    requiredRoles: Object.freeze(['builder', 'validator']),
  }),
  Object.freeze({
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_VERIFICATION,
    order: 5,
    label: 'Read-only release verification',
    packageScriptIds: Object.freeze(['release:verify', 'validate:release-verification']),
    reportFileIds: Object.freeze(['read-only-release-verification-latest.json']),
    requiredRoles: Object.freeze(['builder', 'validator']),
  }),
  Object.freeze({
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.RELEASE_ARCHIVE,
    order: 6,
    label: 'Read-only release archive',
    packageScriptIds: Object.freeze(['release:archive', 'validate:release-archive']),
    reportFileIds: Object.freeze(['read-only-release-archive-latest.json']),
    requiredRoles: Object.freeze(['builder', 'validator']),
  }),
  Object.freeze({
    stageId: READ_ONLY_REPORT_CHAIN_STAGE_IDS.ARCHIVE_CLOSEOUT,
    order: 7,
    label: 'Read-only release archive closeout',
    packageScriptIds: Object.freeze(['release:archive-closeout']),
    reportFileIds: Object.freeze(['read-only-release-archive-closeout-latest.json']),
    requiredRoles: Object.freeze(['builder']),
  }),
]);

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values || []) {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

const REQUIRED_ARCHIVE_CLOSEOUT_DISPATCH_METRICS = Object.freeze([
  'dispatchTotalHandoffs',
  'dispatchReadyHandoffs',
  'dispatchBlockedHandoffs',
  'dispatchApprovalProvenanceBoundHandoffs',
  'operatorHintCount',
  'unknownOperatorHintCount',
  'dashboardWarningCount',
  'dashboardBlockerCount',
  'exportStatusBlockerCount',
]);

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactDispatchMetrics(metrics = {}) {
  return Object.fromEntries(REQUIRED_ARCHIVE_CLOSEOUT_DISPATCH_METRICS
    .map((key) => [key, numberOrNull(metrics[key])])
    .filter(([, value]) => value !== null));
}

function compactReportBinding(binding = {}) {
  return {
    fileId: binding.fileId || null,
    exists: binding.exists === true,
    ok: binding.ok === true,
    status: binding.status || null,
    hash: binding.hash || null,
    blockerCount: Number(binding.blockerCount || 0),
    metrics: compactDispatchMetrics(binding.metrics || {}),
  };
}

function archiveCloseoutDispatchMetricBlockers(stage, reports) {
  if (stage.stageId !== READ_ONLY_REPORT_CHAIN_STAGE_IDS.ARCHIVE_CLOSEOUT) return [];
  const report = reports[0] || {};
  if (report.exists !== true || report.ok !== true) return [];
  const missingMetricKeys = REQUIRED_ARCHIVE_CLOSEOUT_DISPATCH_METRICS
    .filter((key) => !Number.isFinite(report.metrics?.[key]));
  const blockers = missingMetricKeys.length ? [{
    code: 'read_only_report_chain_archive_closeout_dispatch_metrics_missing',
    stageId: stage.stageId,
    notes: `${stage.stageId} archive closeout must expose dispatch readiness metrics: ${missingMetricKeys.join(', ')}.`,
    missingMetricKeys,
  }] : [];
  const total = report.metrics?.dispatchTotalHandoffs;
  const ready = report.metrics?.dispatchReadyHandoffs;
  const blocked = report.metrics?.dispatchBlockedHandoffs;
  const approvalProvenanceBound = report.metrics?.dispatchApprovalProvenanceBoundHandoffs;
  if (
    Number.isFinite(total)
    && Number.isFinite(ready)
    && Number.isFinite(blocked)
    && total !== ready + blocked
  ) {
    blockers.push({
      code: 'read_only_report_chain_archive_closeout_dispatch_total_mismatch',
      stageId: stage.stageId,
      notes: `${stage.stageId} archive closeout dispatch total must equal ready + blocked handoffs.`,
      dispatchTotalHandoffs: total,
      dispatchReadyHandoffs: ready,
      dispatchBlockedHandoffs: blocked,
    });
  }
  if (
    Number.isFinite(total)
    && Number.isFinite(approvalProvenanceBound)
    && approvalProvenanceBound !== total
  ) {
    blockers.push({
      code: 'read_only_report_chain_archive_closeout_dispatch_approval_provenance_mismatch',
      stageId: stage.stageId,
      notes: `${stage.stageId} archive closeout approval provenance-bound handoffs must equal total handoffs.`,
      dispatchTotalHandoffs: total,
      dispatchApprovalProvenanceBoundHandoffs: approvalProvenanceBound,
    });
  }
  return blockers;
}

function stageRecord(stage, {
  packageScriptIds = [],
  reportBindings = {},
} = {}) {
  const packageScriptSet = new Set(packageScriptIds);
  const moduleBindings = READ_ONLY_REPORT_CHAIN_MODULE_BINDINGS
    .filter((binding) => binding.stageId === stage.stageId)
    .map((binding) => ({ ...binding, exportIds: [...binding.exportIds] }));
  const roles = new Set(moduleBindings.map((binding) => binding.role));
  const missingRoles = stage.requiredRoles.filter((role) => !roles.has(role));
  const missingPackageScriptIds = stage.packageScriptIds.filter((scriptId) => !packageScriptSet.has(scriptId));
  const reports = stage.reportFileIds.map((fileId) => compactReportBinding({
    fileId,
    ...(reportBindings[fileId] || {}),
  }));
  const blockers = [
    ...missingRoles.map((role) => ({
      code: 'read_only_report_chain_stage_role_missing',
      stageId: stage.stageId,
      notes: `${stage.stageId} is missing ${role} module binding.`,
    })),
    ...missingPackageScriptIds.map((scriptId) => ({
      code: 'read_only_report_chain_stage_script_missing',
      stageId: stage.stageId,
      notes: `${stage.stageId} requires package script ${scriptId}.`,
    })),
    ...reports
      .filter((report) => !report.exists)
      .map((report) => ({
        code: 'read_only_report_chain_stage_report_missing',
        stageId: stage.stageId,
        notes: `${stage.stageId} requires latest report ${report.fileId}.`,
      })),
    ...reports
      .filter((report) => report.exists && report.ok === false)
      .map((report) => ({
        code: 'read_only_report_chain_stage_report_not_ok',
        stageId: stage.stageId,
        notes: `${stage.stageId} report ${report.fileId} is not ok: ${report.status || 'unknown'}.`,
      })),
    ...archiveCloseoutDispatchMetricBlockers(stage, reports),
  ];
  return {
    stageId: stage.stageId,
    order: stage.order,
    label: stage.label,
    status: blockers.length ? 'blocked_read_only_report_chain_stage' : 'pass_read_only_report_chain_stage',
    ok: blockers.length === 0,
    packageScriptIds: [...stage.packageScriptIds],
    missingPackageScriptIds,
    reportFileIds: [...stage.reportFileIds],
    reports,
    requiredRoles: [...stage.requiredRoles],
    moduleBindings,
    blockers,
  };
}

export function buildReadOnlyReportChain({
  packageScriptIds = [],
  reportBindings = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const stages = READ_ONLY_REPORT_CHAIN_STAGES.map((stage) => stageRecord(stage, {
    packageScriptIds,
    reportBindings,
  }));
  const archiveCloseoutReport = stages
    .find((stage) => stage.stageId === READ_ONLY_REPORT_CHAIN_STAGE_IDS.ARCHIVE_CLOSEOUT)
    ?.reports?.[0] || {};
  const archiveCloseoutMetrics = archiveCloseoutReport.metrics || {};
  const archiveCloseoutDispatchMetricCount = REQUIRED_ARCHIVE_CLOSEOUT_DISPATCH_METRICS
    .filter((key) => Number.isFinite(archiveCloseoutMetrics[key])).length;
  const readOnlyDispatchMetricsOk = (
    archiveCloseoutDispatchMetricCount === REQUIRED_ARCHIVE_CLOSEOUT_DISPATCH_METRICS.length
    && Number(archiveCloseoutMetrics.dispatchTotalHandoffs)
      === Number(archiveCloseoutMetrics.dispatchReadyHandoffs)
        + Number(archiveCloseoutMetrics.dispatchBlockedHandoffs)
    && Number(archiveCloseoutMetrics.dispatchApprovalProvenanceBoundHandoffs)
      === Number(archiveCloseoutMetrics.dispatchTotalHandoffs)
  );
  const moduleIds = READ_ONLY_REPORT_CHAIN_MODULE_BINDINGS.map((binding) => binding.moduleId);
  const duplicateModuleIds = moduleIds.filter((moduleId, index) => moduleIds.indexOf(moduleId) !== index);
  const blockers = [
    ...duplicateModuleIds.map((moduleId) => ({
      code: 'read_only_report_chain_duplicate_module_binding',
      notes: `${moduleId} is bound more than once.`,
    })),
    ...stages.flatMap((stage) => stage.blockers.map((blocker) => ({
      code: `${stage.stageId}_${blocker.code}`,
      notes: blocker.notes,
    }))),
  ];
  const chain = {
    version: READ_ONLY_REPORT_CHAIN_VERSION,
    kind: 'ReadOnlyReportChain',
    status: blockers.length ? 'blocked_read_only_report_chain' : 'pass_read_only_report_chain',
    ok: blockers.length === 0,
    generatedAt,
    stages,
    moduleBindings: READ_ONLY_REPORT_CHAIN_MODULE_BINDINGS.map((binding) => ({
      ...binding,
      exportIds: [...binding.exportIds],
    })),
    summary: {
      stageCount: stages.length,
      moduleBindingCount: READ_ONLY_REPORT_CHAIN_MODULE_BINDINGS.length,
      passedStages: stages.filter((stage) => stage.ok).length,
      blockedStages: stages.filter((stage) => !stage.ok).length,
      reportFileCount: stages.reduce((sum, stage) => sum + stage.reportFileIds.length, 0),
      packageScriptCount: new Set(stages.flatMap((stage) => stage.packageScriptIds)).size,
      readOnlyDispatchMetricCount: archiveCloseoutDispatchMetricCount,
      expectedReadOnlyDispatchMetricCount: REQUIRED_ARCHIVE_CLOSEOUT_DISPATCH_METRICS.length,
      readOnlyDispatchMetricsOk,
      dispatchTotalHandoffs: archiveCloseoutMetrics.dispatchTotalHandoffs ?? null,
      dispatchReadyHandoffs: archiveCloseoutMetrics.dispatchReadyHandoffs ?? null,
      dispatchBlockedHandoffs: archiveCloseoutMetrics.dispatchBlockedHandoffs ?? null,
      dispatchApprovalProvenanceBoundHandoffs: archiveCloseoutMetrics.dispatchApprovalProvenanceBoundHandoffs ?? null,
      operatorHintCount: archiveCloseoutMetrics.operatorHintCount ?? null,
      unknownOperatorHintCount: archiveCloseoutMetrics.unknownOperatorHintCount ?? null,
      dashboardWarningCount: archiveCloseoutMetrics.dashboardWarningCount ?? null,
      dashboardBlockerCount: archiveCloseoutMetrics.dashboardBlockerCount ?? null,
      exportStatusBlockerCount: archiveCloseoutMetrics.exportStatusBlockerCount ?? null,
      byStageStatus: countBy(stages, (stage) => stage.status),
      byModuleRole: countBy(READ_ONLY_REPORT_CHAIN_MODULE_BINDINGS, (binding) => binding.role),
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
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
    },
  };
  const chainHash = digest({
    version: chain.version,
    kind: chain.kind,
    status: chain.status,
    stages: chain.stages,
    moduleBindings: chain.moduleBindings,
    summary: chain.summary,
    blockers: chain.blockers,
    safety: chain.safety,
  });
  return {
    ...chain,
    chainHash,
    hash: chainHash,
  };
}

export function summarizeReadOnlyReportChain(chain) {
  return {
    version: READ_ONLY_REPORT_CHAIN_VERSION,
    kind: 'ReadOnlyReportChainSummary',
    ok: chain?.ok === true,
    status: chain?.status || 'missing_read_only_report_chain',
    chainHash: chain?.chainHash || null,
    stageCount: chain?.summary?.stageCount || 0,
    moduleBindingCount: chain?.summary?.moduleBindingCount || 0,
    passedStages: chain?.summary?.passedStages || 0,
    blockedStages: chain?.summary?.blockedStages || 0,
    readOnlyDispatchMetricCount: chain?.summary?.readOnlyDispatchMetricCount || 0,
    expectedReadOnlyDispatchMetricCount: chain?.summary?.expectedReadOnlyDispatchMetricCount || 0,
    readOnlyDispatchMetricsOk: chain?.summary?.readOnlyDispatchMetricsOk === true,
    dispatchTotalHandoffs: chain?.summary?.dispatchTotalHandoffs ?? null,
    dispatchReadyHandoffs: chain?.summary?.dispatchReadyHandoffs ?? null,
    dispatchBlockedHandoffs: chain?.summary?.dispatchBlockedHandoffs ?? null,
    dispatchApprovalProvenanceBoundHandoffs: chain?.summary?.dispatchApprovalProvenanceBoundHandoffs ?? null,
    blockerCount: Array.isArray(chain?.blockers) ? chain.blockers.length : 0,
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
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
    },
  };
}
