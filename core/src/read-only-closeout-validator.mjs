import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_CLOSEOUT_VALIDATION_VERSION = 1;

export const READ_ONLY_CLOSEOUT_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_readonly_closeout_validation',
  FAIL: 'fail_readonly_closeout_validation',
});

const READ_ONLY_CLOSEOUT_READY_STATUS = 'ready_readonly_closeout_summary';
const READ_ONLY_CLOSEOUT_BLOCKED_STATUS = 'blocked_readonly_closeout_summary';

const REQUIRED_REPORT_FILE_KEYS = Object.freeze([
  'json',
  'markdown',
  'timestampedJson',
  'timestampedMarkdown',
]);

const REQUIRED_HASH_KEYS = Object.freeze([
  'gateHash',
  'recomputedGateHash',
  'gateValidationHash',
  'sampleValidationHash',
  'dashboardSnapshotHash',
  'exportStatusHash',
]);

const REQUIRED_METRIC_KEYS = Object.freeze([
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

const UNSAFE_KEYS = Object.freeze([
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
]);

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

function unsafeValue(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function unsafeSafetyPaths(records = []) {
  const paths = [];
  for (const { path, record } of records) {
    if (!record || typeof record !== 'object') continue;
    for (const key of UNSAFE_KEYS) {
      if (unsafeValue(record[key])) {
        paths.push(`${path}.${key}`);
      }
    }
  }
  return paths;
}

function hashValue(summary) {
  return summary?.summaryHash || null;
}

export function computeReadOnlyCloseoutSummaryHash(summary = {}) {
  return digest({
    version: summary.version,
    kind: summary.kind,
    actor: summary.actor,
    status: summary.status,
    ok: summary.ok,
    readyForDashboard: summary.readyForDashboard,
    metrics: summary.metrics || null,
    hashes: summary.hashes || null,
    artifacts: summary.artifacts || null,
    blockers: Array.isArray(summary.blockers) ? summary.blockers : null,
    warnings: Array.isArray(summary.warnings) ? summary.warnings : null,
    safety: summary.safety || null,
  });
}

function validateReportFiles(reportFiles, blockers, requireReportFiles) {
  if (requireReportFiles !== true) return;
  if (!reportFiles || typeof reportFiles !== 'object' || Array.isArray(reportFiles)) {
    blockers.push(issue('report_files_missing', 'Closeout summary is missing reportFiles.'));
    return;
  }
  const missing = REQUIRED_REPORT_FILE_KEYS.filter((key) => !reportFiles[key]);
  if (missing.length > 0) {
    blockers.push(issue('report_files_missing', `Missing report file keys: ${missing.join(', ')}.`));
  }
  if (reportFiles.json && reportFiles.json !== 'reports/read-only-closeout-latest.json') {
    blockers.push(issue('report_files_latest_json_mismatch', `Expected reports/read-only-closeout-latest.json, got ${reportFiles.json}.`));
  }
  if (reportFiles.markdown && reportFiles.markdown !== 'reports/read-only-closeout-latest.md') {
    blockers.push(issue('report_files_latest_markdown_mismatch', `Expected reports/read-only-closeout-latest.md, got ${reportFiles.markdown}.`));
  }
  if (reportFiles.timestampedJson && !/^reports\/read-only-closeout-\d{8}T\d{6}Z\.json$/.test(reportFiles.timestampedJson)) {
    blockers.push(issue('report_files_timestamped_json_invalid', `Invalid timestamped JSON path: ${reportFiles.timestampedJson}.`));
  }
  if (reportFiles.timestampedMarkdown && !/^reports\/read-only-closeout-\d{8}T\d{6}Z\.md$/.test(reportFiles.timestampedMarkdown)) {
    blockers.push(issue('report_files_timestamped_markdown_invalid', `Invalid timestamped Markdown path: ${reportFiles.timestampedMarkdown}.`));
  }
}

export function validateReadOnlyCloseoutSummary({
  summary = null,
  actor = 'design-production-core.readonly-closeout-validator',
  generatedAt = null,
  requireReportFiles = true,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    blockers.push(issue('closeout_summary_missing', 'Read-only closeout summary is required.'));
  }

  const closeoutBlockers = Array.isArray(summary?.blockers) ? summary.blockers : [];
  const closeoutWarnings = Array.isArray(summary?.warnings) ? summary.warnings : [];
  const hashes = summary?.hashes && typeof summary.hashes === 'object' ? summary.hashes : {};

  if (summary && summary.version !== 1) {
    blockers.push(issue('closeout_summary_version_unsupported', `Expected summary version 1, got ${summary.version}.`));
  }
  if (summary && summary.kind !== 'ReadOnlyCloseoutSummary') {
    blockers.push(issue('closeout_summary_kind_mismatch', `Expected ReadOnlyCloseoutSummary, got ${summary.kind || 'missing'}.`));
  }
  if (summary && typeof summary.ok !== 'boolean') {
    blockers.push(issue('closeout_summary_ok_type_invalid', 'Closeout summary ok must be boolean.'));
  }
  if (summary && typeof summary.readyForDashboard !== 'boolean') {
    blockers.push(issue('closeout_summary_ready_type_invalid', 'Closeout summary readyForDashboard must be boolean.'));
  }
  if (summary?.ok === true && summary.status !== READ_ONLY_CLOSEOUT_READY_STATUS) {
    blockers.push(issue('closeout_status_ok_mismatch', `ok=true requires ${READ_ONLY_CLOSEOUT_READY_STATUS}, got ${summary.status}.`));
  }
  if (summary?.ok === false && summary.status !== READ_ONLY_CLOSEOUT_BLOCKED_STATUS) {
    blockers.push(issue('closeout_status_blocked_mismatch', `ok=false requires ${READ_ONLY_CLOSEOUT_BLOCKED_STATUS}, got ${summary.status}.`));
  }
  if (summary?.readyForDashboard !== summary?.ok) {
    blockers.push(issue('closeout_ready_ok_mismatch', 'readyForDashboard must match ok.'));
  }
  if (summary?.ok === true && closeoutBlockers.length > 0) {
    blockers.push(issue('closeout_ok_with_blockers', 'Ready closeout summaries must not contain blockers.'));
  }

  if (!summary?.metrics || typeof summary.metrics !== 'object' || Array.isArray(summary.metrics)) {
    blockers.push(issue('closeout_metrics_missing', 'Closeout summary metrics are required.'));
  } else {
    const missingMetrics = REQUIRED_METRIC_KEYS.filter((key) => !(key in summary.metrics));
    if (missingMetrics.length > 0) {
      blockers.push(issue('closeout_metrics_missing', `Missing closeout metric keys: ${missingMetrics.join(', ')}.`));
    }
    if (Number(summary.metrics.gateStepCount || 0) < 1) {
      blockers.push(issue('closeout_gate_step_count_invalid', 'Closeout summary gateStepCount must be positive.'));
    }
    if (Number(summary.metrics.dispatchTotalHandoffs || 0) !== Number(summary.metrics.dispatchReadyHandoffs || 0) + Number(summary.metrics.dispatchBlockedHandoffs || 0)) {
      blockers.push(issue('closeout_dispatch_handoff_count_mismatch', `dispatchTotalHandoffs ${summary.metrics.dispatchTotalHandoffs} does not match ready+blocked.`));
    }
    if (Number(summary.metrics.dispatchApprovalProvenanceBoundHandoffs || 0) !== Number(summary.metrics.dispatchTotalHandoffs || 0)) {
      blockers.push(issue('closeout_dispatch_approval_provenance_hash_coverage_mismatch', `dispatchApprovalProvenanceBoundHandoffs ${summary.metrics.dispatchApprovalProvenanceBoundHandoffs} does not match dispatchTotalHandoffs ${summary.metrics.dispatchTotalHandoffs}.`));
    }
    if (Number(summary.metrics.gateValidationBlockers || 0) !== 0 && summary.ok === true) {
      blockers.push(issue('closeout_ready_with_gate_validation_blockers', 'Ready closeout summary cannot have gate validation blockers.'));
    }
  }

  const missingHashes = REQUIRED_HASH_KEYS.filter((key) => !hashes[key]);
  if (missingHashes.length > 0) {
    blockers.push(issue('closeout_hashes_missing', `Missing closeout hash keys: ${missingHashes.join(', ')}.`));
  }
  if (hashes.gateHash && hashes.recomputedGateHash && hashes.gateHash !== hashes.recomputedGateHash) {
    blockers.push(issue('closeout_gate_hash_mismatch', `gateHash ${hashes.gateHash} does not match recomputedGateHash ${hashes.recomputedGateHash}.`));
  }

  const recomputedSummaryHash = summary && typeof summary === 'object' && !Array.isArray(summary)
    ? computeReadOnlyCloseoutSummaryHash(summary)
    : null;
  const actualSummaryHash = hashValue(summary);
	  if (summary && !actualSummaryHash) {
	    blockers.push(issue('closeout_summary_hash_missing', 'Closeout summary must include summaryHash.'));
	  } else if (actualSummaryHash && recomputedSummaryHash && actualSummaryHash !== recomputedSummaryHash) {
	    blockers.push(issue('closeout_summary_hash_mismatch', `Expected ${recomputedSummaryHash}, got ${actualSummaryHash}.`));
	  }
	  if (summary && !summary.summaryHash) {
	    blockers.push(issue('closeout_summary_hash_alias_missing', 'Closeout summary must include summaryHash.'));
	  }
	  if (summary && !summary.hash) {
	    blockers.push(issue('closeout_summary_generic_hash_missing', 'Closeout summary must include hash.'));
	  }
	  if (summary?.summaryHash && summary?.hash && summary.summaryHash !== summary.hash) {
	    blockers.push(issue('closeout_summary_hash_alias_mismatch', `summaryHash ${summary.summaryHash} does not match hash ${summary.hash}.`));
	  }

  if (!summary?.artifacts || typeof summary.artifacts !== 'object' || Array.isArray(summary.artifacts)) {
    blockers.push(issue('closeout_artifacts_missing', 'Closeout summary artifacts are required.'));
  } else {
    if (!summary.artifacts.gateReportFiles?.json || !summary.artifacts.gateReportFiles?.markdown) {
      blockers.push(issue('closeout_gate_report_files_missing', 'Closeout artifacts must include gate report JSON and Markdown paths.'));
    }
    if (!summary.artifacts.sampleReport) {
      blockers.push(issue('closeout_sample_report_missing', 'Closeout artifacts must include the sample report path.'));
    }
  }

  validateReportFiles(summary?.reportFiles, blockers, requireReportFiles);

  const unsafePaths = unsafeSafetyPaths([
    { path: 'summary', record: summary },
    { path: 'summary.safety', record: summary?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_closeout_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  if (closeoutWarnings.length > 0) {
    warnings.push(issue('closeout_warnings_present', `${closeoutWarnings.length} closeout warnings are present.`, 'warning'));
  }

  const status = blockers.length
    ? READ_ONLY_CLOSEOUT_VALIDATION_STATUS.FAIL
    : READ_ONLY_CLOSEOUT_VALIDATION_STATUS.PASS;
  const validation = {
    version: READ_ONLY_CLOSEOUT_VALIDATION_VERSION,
    kind: 'ReadOnlyCloseoutValidationReport',
    actor: normalizeText(actor) || 'design-production-core.readonly-closeout-validator',
    status,
    ok: status === READ_ONLY_CLOSEOUT_VALIDATION_STATUS.PASS,
    metrics: {
      gateStepCount: Number(summary?.metrics?.gateStepCount || 0),
      failedStepCount: Number(summary?.metrics?.failedStepCount || 0),
      publicApiModules: Number(summary?.metrics?.publicApiModules || 0),
      sampleCount: Number(summary?.metrics?.sampleCount || 0),
      dispatchTotalHandoffs: Number(summary?.metrics?.dispatchTotalHandoffs || 0),
      dispatchReadyHandoffs: Number(summary?.metrics?.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(summary?.metrics?.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(summary?.metrics?.dispatchApprovalProvenanceBoundHandoffs || 0),
      dashboardWarningCount: Number(summary?.metrics?.dashboardWarningCount || 0),
      unknownOperatorHintCount: Number(summary?.metrics?.unknownOperatorHintCount || 0),
      closeoutBlockerCount: closeoutBlockers.length,
      closeoutWarningCount: closeoutWarnings.length,
      reportFileCount: summary?.reportFiles && typeof summary.reportFiles === 'object'
        ? Object.keys(summary.reportFiles).length
        : 0,
    },
    hashChecks: {
      summaryHash: summary?.summaryHash || null,
      hash: summary?.hash || null,
      recomputedSummaryHash,
      gateHash: hashes.gateHash || null,
      recomputedGateHash: hashes.recomputedGateHash || null,
      gateValidationHash: hashes.gateValidationHash || null,
      sampleValidationHash: hashes.sampleValidationHash || null,
      dashboardSnapshotHash: hashes.dashboardSnapshotHash || null,
      exportStatusHash: hashes.exportStatusHash || null,
    },
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyCloseoutValidation: true,
      validatesReportOnly: true,
      recomputesSummaryHashOnly: true,
      localReportOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const validationHash = digest({
    version: validation.version,
    kind: validation.kind,
    actor: validation.actor,
    status: validation.status,
    ok: validation.ok,
    metrics: validation.metrics,
    hashChecks: validation.hashChecks,
    blockers: validation.blockers,
    warnings: validation.warnings,
    safety: validation.safety,
  });
  return {
    ...validation,
    validationHash,
    hash: validationHash,
  };
}

export function summarizeReadOnlyCloseoutValidations(reports = []) {
  const byStatus = {};
  let passCount = 0;
  let failCount = 0;
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    if (report.ok === true) passCount += 1;
    if ((report.blockers || []).length > 0) failCount += 1;
  }
  return {
    version: READ_ONLY_CLOSEOUT_VALIDATION_VERSION,
    count: reports.length,
    passCount,
    failCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyCloseoutValidationSummary: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
      readyForExecution: reports.some((report) => report.safety?.readyForExecution === true),
    }),
  };
}
