import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';
import { validateReadOnlyCoreGateReport } from './read-only-core-gate-validator.mjs';

export const READ_ONLY_CLOSEOUT_SUMMARY_VERSION = 1;

export const READ_ONLY_CLOSEOUT_SUMMARY_STATUS = Object.freeze({
  READY: 'ready_readonly_closeout_summary',
  BLOCKED: 'blocked_readonly_closeout_summary',
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
    'externalActions',
    'providerSpend',
    'modelSpend',
    'livePrepare',
    'liveSubmit',
    'liveUpload',
    'acceptance',
    'payment',
    'deployment',
    'customerMessage',
  ];
  return unsafeKeys.some((key) => record?.[key] === true || record?.safety?.[key] === true);
}

function stepByName(gateReport, name) {
  return (Array.isArray(gateReport?.steps) ? gateReport.steps : []).find((step) => step.name === name) || null;
}

function gateReportFiles(gateReport) {
  return gateReport?.reportFiles && typeof gateReport.reportFiles === 'object'
    ? gateReport.reportFiles
    : {};
}

function finiteNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number != null) return number;
  }
  return 0;
}

function requiredSemanticHash(blockers, record, semanticKey, aliasCode, genericCode, mismatchCode, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const semanticHash = normalizeText(record[semanticKey]) || null;
  const genericHash = normalizeText(record.hash) || null;
  if (!semanticHash) blockers.push(issue(aliasCode, `${label} must preserve ${semanticKey}.`));
  if (!genericHash) blockers.push(issue(genericCode, `${label} must preserve generic hash.`));
  if (semanticHash && genericHash && semanticHash !== genericHash) {
    blockers.push(issue(mismatchCode, `${semanticKey} ${semanticHash} != hash ${genericHash}.`));
  }
  return semanticHash;
}

function requiredSampleValidationHash(blockers, validateSamples, hashKey, code, label) {
  const value = normalizeText(validateSamples?.hashChecks?.[hashKey] || '') || null;
  if (!value) blockers.push(issue(code, `${label} must be preserved by sample validation hashChecks.`));
  return value;
}

function dashboardSignalMetrics(exportSamples = {}, validateSamples = {}) {
  const validationMetrics = validateSamples?.metrics || {};
  const dashboardStatus = exportSamples?.dashboardStatus || {};
  const dashboardSnapshot = exportSamples?.dashboardSnapshot || {};
  const exportStatus = exportSamples?.exportStatus || {};
  const dispatchReadyHandoffs = firstFiniteNumber(
    validationMetrics.dispatchReadyHandoffs,
    dashboardStatus.readyHandoffs,
  );
  const dispatchBlockedHandoffs = firstFiniteNumber(
    validationMetrics.dispatchBlockedHandoffs,
    dashboardStatus.blockedHandoffs,
  );
  return {
    dispatchTotalHandoffs: firstFiniteNumber(
      validationMetrics.dispatchTotalHandoffs,
      dashboardStatus.totalHandoffs,
      dispatchReadyHandoffs + dispatchBlockedHandoffs,
    ),
    dispatchReadyHandoffs,
    dispatchBlockedHandoffs,
    dispatchApprovalProvenanceBoundHandoffs: firstFiniteNumber(
      validationMetrics.dispatchApprovalProvenanceBoundHandoffs,
      dashboardSnapshot.metrics?.dispatchApprovalProvenanceBoundHandoffs,
    ),
    operatorHintCount: firstFiniteNumber(
      validationMetrics.operatorHintCount,
      dashboardStatus.operatorHintCount,
    ),
    unknownOperatorHintCount: firstFiniteNumber(
      validationMetrics.unknownOperatorHintCount,
      dashboardStatus.unknownOperatorHintCount,
    ),
    dashboardWarningCount: firstFiniteNumber(
      validationMetrics.dashboardWarningCount,
      dashboardSnapshot.warnings,
    ),
    dashboardBlockerCount: firstFiniteNumber(
      validationMetrics.dashboardBlockerCount,
      dashboardSnapshot.blockers,
    ),
    exportStatusBlockerCount: firstFiniteNumber(
      validationMetrics.exportStatusBlockerCount,
      exportStatus.blockers,
    ),
  };
}

export function buildReadOnlyCloseoutSummary({
  gateReport = null,
  gateValidation = null,
  actor = 'design-production-core.readonly-closeout-summary',
  generatedAt = null,
} = {}) {
  const validation = gateValidation || validateReadOnlyCoreGateReport({
    report: gateReport,
    actor: 'design-production-core.readonly-closeout-summary.gate-validation',
    generatedAt,
  });
  const blockers = [];
  const warnings = [];

  if (!gateReport || typeof gateReport !== 'object' || Array.isArray(gateReport)) {
    blockers.push(issue('gate_report_missing', 'Closeout summary requires a read-only core gate report.'));
  } else if (gateReport.ok !== true) {
    blockers.push(issue('gate_report_not_ok', gateReport.status));
  }

  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
    blockers.push(issue('gate_validation_missing', 'Closeout summary requires a gate validation report.'));
  } else if (validation.ok !== true) {
    blockers.push(issue('gate_validation_not_ok', validation.status));
    for (const blocker of validation.blockers || []) {
      blockers.push(issue(`gate_validation_${blocker.code}`, blocker.notes));
    }
  }

  if (unsafeSafetyRecord(gateReport) || unsafeSafetyRecord(validation)) {
    blockers.push(issue('closeout_input_claims_external_action', 'Closeout summary inputs must remain read-only and non-executing.'));
  }

  for (const warning of validation?.warnings || []) {
    warnings.push(issue(`gate_validation_${warning.code}`, warning.notes, 'warning'));
  }

  const selftest = stepByName(gateReport, 'selftest')?.summary || {};
  const exportSamples = stepByName(gateReport, 'export_samples')?.summary || {};
  const validateSamples = stepByName(gateReport, 'validate_samples')?.summary || {};
  const dashboardMetrics = dashboardSignalMetrics(exportSamples, validateSamples);
  const failedSteps = Array.isArray(gateReport?.failedSteps) ? gateReport.failedSteps : [];
  if (dashboardMetrics.dispatchBlockedHandoffs > 0) {
    warnings.push(issue('dispatch_blocked_handoffs_present', `${dashboardMetrics.dispatchBlockedHandoffs} dispatch handoffs are blocked and should stay visible.`, 'warning'));
  }
  const currentGateHash = requiredSemanticHash(
    blockers,
    gateReport,
    'gateHash',
    'closeout_gate_hash_alias_required',
    'closeout_gate_generic_hash_required',
    'closeout_gate_hash_alias_mismatch',
    'Gate report',
  );
  const currentGateValidationHash = requiredSemanticHash(
    blockers,
    validation,
    'validationHash',
    'closeout_gate_validation_hash_alias_required',
    'closeout_gate_validation_generic_hash_required',
    'closeout_gate_validation_hash_alias_mismatch',
    'Gate validation',
  );
  const dashboardSnapshotHash = requiredSampleValidationHash(
    blockers,
    validateSamples,
    'dashboardSnapshotHash',
    'closeout_dashboard_snapshot_hash_required',
    'Dashboard snapshot hash',
  );
  const exportStatusHash = requiredSampleValidationHash(
    blockers,
    validateSamples,
    'exportStatusHash',
    'closeout_export_status_hash_required',
    'Export status hash',
  );
  const status = blockers.length
    ? READ_ONLY_CLOSEOUT_SUMMARY_STATUS.BLOCKED
    : READ_ONLY_CLOSEOUT_SUMMARY_STATUS.READY;

  const summary = {
    version: READ_ONLY_CLOSEOUT_SUMMARY_VERSION,
    kind: 'ReadOnlyCloseoutSummary',
    actor: normalizeText(actor) || 'design-production-core.readonly-closeout-summary',
    status,
    ok: status === READ_ONLY_CLOSEOUT_SUMMARY_STATUS.READY,
    readyForDashboard: status === READ_ONLY_CLOSEOUT_SUMMARY_STATUS.READY,
    metrics: {
      gateStepCount: Number(gateReport?.stepCount || 0),
      failedStepCount: failedSteps.length,
      sourceFileCount: Number(stepByName(gateReport, 'node_check_src')?.fileCount || 0),
      fixtureFileCount: Number(stepByName(gateReport, 'fixture_json_parse')?.fileCount || 0),
      publicApiModules: Number(selftest.publicApiModules || 0),
      sampleCount: Number(exportSamples.samples || validateSamples.metrics?.sampleCount || 0),
      planOnlyBlocked: Number(exportSamples.planOnlyBlocked || validateSamples.metrics?.planOnlyBlocked || 0),
      ...dashboardMetrics,
      gateValidationBlockers: Array.isArray(validation?.blockers) ? validation.blockers.length : 0,
      gateValidationWarnings: Array.isArray(validation?.warnings) ? validation.warnings.length : 0,
      sampleValidationWarnings: Array.isArray(validateSamples.warnings) ? validateSamples.warnings.length : 0,
    },
    hashes: {
      gateHash: currentGateHash,
      recomputedGateHash: validation?.hashChecks?.recomputedGateHash || null,
      gateValidationHash: currentGateValidationHash,
      sampleValidationHash: validateSamples.validationHash || null,
      dashboardSnapshotHash,
      exportStatusHash,
    },
    artifacts: {
      gateReportFiles: gateReportFiles(gateReport),
      sampleReport: exportSamples.report || validateSamples.report || null,
    },
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyCloseoutSummary: true,
      dashboardSummaryOnly: true,
      localReportOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const summaryHash = digest({
    version: summary.version,
    kind: summary.kind,
    actor: summary.actor,
    status: summary.status,
    ok: summary.ok,
    readyForDashboard: summary.readyForDashboard,
    metrics: summary.metrics,
    hashes: summary.hashes,
    artifacts: summary.artifacts,
    blockers: summary.blockers,
    warnings: summary.warnings,
    safety: summary.safety,
  });
  return {
    ...summary,
    summaryHash,
    hash: summaryHash,
  };
}

export function summarizeReadOnlyCloseoutSummaries(summaries = []) {
  const byStatus = {};
  let readyCount = 0;
  let blockedCount = 0;
  for (const summary of summaries || []) {
    byStatus[summary.status] = (byStatus[summary.status] || 0) + 1;
    if (summary.ok === true || summary.readyForDashboard === true) readyCount += 1;
    if ((summary.blockers || []).length > 0) blockedCount += 1;
  }
  return {
    version: READ_ONLY_CLOSEOUT_SUMMARY_VERSION,
    count: summaries.length,
    readyCount,
    blockedCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyCloseoutSummary: true,
      executesExternalAction: summaries.some((summary) => summary.safety?.executesExternalAction === true),
      fetchesChannelState: summaries.some((summary) => summary.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: summaries.some((summary) => summary.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: summaries.some((summary) => summary.safety?.grantsExecutionPermission === true),
      readyForExecution: summaries.some((summary) => summary.safety?.readyForExecution === true),
    }),
  };
}
