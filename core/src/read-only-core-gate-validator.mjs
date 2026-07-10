import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_CORE_GATE_VALIDATION_VERSION = 1;

export const READ_ONLY_CORE_GATE_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_readonly_core_gate_validation',
  FAIL: 'fail_readonly_core_gate_validation',
});

export const READ_ONLY_CORE_GATE_REQUIRED_STEPS = Object.freeze([
  'node_check_src',
  'fixture_json_parse',
  'selftest',
  'export_samples',
  'validate_samples',
]);

const READ_ONLY_CORE_GATE_PASS_STATUS = 'pass_readonly_core_gate';
const READ_ONLY_CORE_GATE_FAIL_STATUS = 'fail_readonly_core_gate';

const REQUIRED_REPORT_FILE_KEYS = Object.freeze([
  'json',
  'markdown',
  'timestampedJson',
  'timestampedMarkdown',
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

function arrayEquals(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function hashValue(report) {
  return report?.gateHash || null;
}

export function computeReadOnlyCoreGateHash(report = {}) {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  return digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    ok: report.ok,
    stepCount: report.stepCount,
    failedSteps: Array.isArray(report.failedSteps) ? report.failedSteps : null,
    steps: steps.map((step) => ({
      name: step.name,
      ok: step.ok,
      fileCount: step.fileCount || null,
      exitCode: step.exitCode ?? null,
      failures: step.failures || null,
      summaryStatus: step.summary?.status || null,
      summaryOk: step.summary?.ok ?? null,
    })),
    safety: report.safety || null,
  });
}

function validateReportFiles(reportFiles, blockers, requireReportFiles) {
  if (requireReportFiles !== true) return;
  if (!reportFiles || typeof reportFiles !== 'object' || Array.isArray(reportFiles)) {
    blockers.push(issue('report_files_missing', 'Gate report is missing reportFiles.'));
    return;
  }
  const missing = REQUIRED_REPORT_FILE_KEYS.filter((key) => !reportFiles[key]);
  if (missing.length > 0) {
    blockers.push(issue('report_files_missing', `Missing report file keys: ${missing.join(', ')}.`));
  }
  if (reportFiles.json && reportFiles.json !== 'reports/read-only-core-gate-latest.json') {
    blockers.push(issue('report_files_latest_json_mismatch', `Expected reports/read-only-core-gate-latest.json, got ${reportFiles.json}.`));
  }
  if (reportFiles.markdown && reportFiles.markdown !== 'reports/read-only-core-gate-latest.md') {
    blockers.push(issue('report_files_latest_markdown_mismatch', `Expected reports/read-only-core-gate-latest.md, got ${reportFiles.markdown}.`));
  }
  if (reportFiles.timestampedJson && !/^reports\/read-only-core-gate-\d{8}T\d{6}Z\.json$/.test(reportFiles.timestampedJson)) {
    blockers.push(issue('report_files_timestamped_json_invalid', `Invalid timestamped JSON path: ${reportFiles.timestampedJson}.`));
  }
  if (reportFiles.timestampedMarkdown && !/^reports\/read-only-core-gate-\d{8}T\d{6}Z\.md$/.test(reportFiles.timestampedMarkdown)) {
    blockers.push(issue('report_files_timestamped_markdown_invalid', `Invalid timestamped Markdown path: ${reportFiles.timestampedMarkdown}.`));
  }
}

export function validateReadOnlyCoreGateReport({
  report = null,
  actor = 'design-production-core.readonly-core-gate-validator',
  generatedAt = null,
  requireReportFiles = true,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    blockers.push(issue('gate_report_missing', 'Read-only core gate report is required.'));
  }

  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const failedSteps = Array.isArray(report?.failedSteps) ? report.failedSteps : [];
  const actualFailedSteps = steps.filter((step) => step?.ok !== true).map((step) => step?.name);
  const stepNames = steps.map((step) => step?.name).filter(Boolean);

  if (report && report.version !== 1) {
    blockers.push(issue('gate_report_version_unsupported', `Expected report version 1, got ${report.version}.`));
  }
  if (report && report.kind !== 'ReadOnlyCoreGateReport') {
    blockers.push(issue('gate_report_kind_mismatch', `Expected ReadOnlyCoreGateReport, got ${report.kind || 'missing'}.`));
  }
  if (report && typeof report.ok !== 'boolean') {
    blockers.push(issue('gate_report_ok_type_invalid', 'Gate report ok must be boolean.'));
  }
  if (report && !Array.isArray(report.steps)) {
    blockers.push(issue('steps_missing', 'Gate report must contain a steps array.'));
  }
  if (report && !Array.isArray(report.failedSteps)) {
    blockers.push(issue('failed_steps_missing', 'Gate report must contain a failedSteps array.'));
  }
  if (report && Number(report.stepCount) !== steps.length) {
    blockers.push(issue('step_count_mismatch', `stepCount=${report.stepCount}, steps.length=${steps.length}.`));
  }

  const missingSteps = READ_ONLY_CORE_GATE_REQUIRED_STEPS.filter((name) => !stepNames.includes(name));
  if (missingSteps.length > 0) {
    blockers.push(issue('required_steps_missing', `Missing gate steps: ${missingSteps.join(', ')}.`));
  }
  if (!arrayEquals(failedSteps, actualFailedSteps)) {
    blockers.push(issue('failed_steps_mismatch', `Expected failedSteps ${JSON.stringify(actualFailedSteps)}, got ${JSON.stringify(failedSteps)}.`));
  }

  if (report?.ok === true && report.status !== READ_ONLY_CORE_GATE_PASS_STATUS) {
    blockers.push(issue('gate_status_ok_mismatch', `ok=true requires ${READ_ONLY_CORE_GATE_PASS_STATUS}, got ${report.status}.`));
  }
  if (report?.ok === false && report.status !== READ_ONLY_CORE_GATE_FAIL_STATUS) {
    blockers.push(issue('gate_status_fail_mismatch', `ok=false requires ${READ_ONLY_CORE_GATE_FAIL_STATUS}, got ${report.status}.`));
  }

  const recomputedGateHash = report && typeof report === 'object' && !Array.isArray(report)
    ? computeReadOnlyCoreGateHash(report)
    : null;
  const actualGateHash = hashValue(report);
  if (report && !actualGateHash) {
    blockers.push(issue('gate_hash_missing', 'Gate report must include gateHash.'));
  } else if (actualGateHash && recomputedGateHash && actualGateHash !== recomputedGateHash) {
    blockers.push(issue('gate_hash_mismatch', `Expected ${recomputedGateHash}, got ${actualGateHash}.`));
  }
  if (report && !report.gateHash) {
    blockers.push(issue('gate_hash_alias_missing', 'Gate report must include gateHash.'));
  }
  if (report && !report.hash) {
    blockers.push(issue('gate_generic_hash_missing', 'Gate report must include hash.'));
  }
  if (report?.gateHash && report?.hash && report.gateHash !== report.hash) {
    blockers.push(issue('gate_hash_alias_mismatch', `gateHash ${report.gateHash} does not match hash ${report.hash}.`));
  }

  validateReportFiles(report?.reportFiles, blockers, requireReportFiles);

  const unsafePaths = unsafeSafetyPaths([
    { path: 'report', record: report },
    { path: 'report.safety', record: report?.safety },
    ...steps.map((step, index) => ({ path: `steps[${index}].summary.safety`, record: step?.summary?.safety })),
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_core_gate_report_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  if (actualFailedSteps.length > 0) {
    warnings.push(issue('gate_failed_steps_present', `${actualFailedSteps.length} gate steps failed.`, 'warning'));
  }

  const status = blockers.length
    ? READ_ONLY_CORE_GATE_VALIDATION_STATUS.FAIL
    : READ_ONLY_CORE_GATE_VALIDATION_STATUS.PASS;
  const validation = {
    version: READ_ONLY_CORE_GATE_VALIDATION_VERSION,
    kind: 'ReadOnlyCoreGateValidationReport',
    actor: normalizeText(actor) || 'design-production-core.readonly-core-gate-validator',
    status,
    ok: status === READ_ONLY_CORE_GATE_VALIDATION_STATUS.PASS,
    metrics: {
      stepCount: Number(report?.stepCount || 0),
      actualStepCount: steps.length,
      failedStepCount: failedSteps.length,
      actualFailedStepCount: actualFailedSteps.length,
      requiredStepCount: READ_ONLY_CORE_GATE_REQUIRED_STEPS.length,
      reportFileCount: report?.reportFiles && typeof report.reportFiles === 'object'
        ? Object.keys(report.reportFiles).length
        : 0,
    },
    hashChecks: {
      gateHash: report?.gateHash || null,
      hash: report?.hash || null,
      recomputedGateHash,
    },
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyCoreGateValidation: true,
      validatesReportOnly: true,
      recomputesGateHashOnly: true,
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

export function summarizeReadOnlyCoreGateValidations(reports = []) {
  const byStatus = {};
  let passCount = 0;
  let failCount = 0;
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    if (report.ok === true) passCount += 1;
    if ((report.blockers || []).length > 0) failCount += 1;
  }
  return {
    version: READ_ONLY_CORE_GATE_VALIDATION_VERSION,
    count: reports.length,
    passCount,
    failCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyCoreGateValidationSummary: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
      readyForExecution: reports.some((report) => report.safety?.readyForExecution === true),
    }),
  };
}
