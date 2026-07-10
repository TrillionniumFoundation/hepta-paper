import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_RELEASE_VERIFICATION_VALIDATION_VERSION = 1;

export const READ_ONLY_RELEASE_VERIFICATION_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_readonly_release_verification_validation',
  FAIL: 'fail_readonly_release_verification_validation',
});

const READ_ONLY_RELEASE_VERIFICATION_READY_STATUS = 'ready_readonly_release_verification';
const READ_ONLY_RELEASE_VERIFICATION_BLOCKED_STATUS = 'blocked_readonly_release_verification';

const REQUIRED_RELEASE_VERIFICATION_REPORT_FILE_KEYS = Object.freeze([
  'json',
  'markdown',
  'timestampedJson',
  'timestampedMarkdown',
]);

const REQUIRED_HASH_KEYS = Object.freeze([
  'healthHash',
  'releaseHealthValidationHash',
  'gateHash',
  'gateValidationHash',
  'closeoutSummaryHash',
  'closeoutValidationHash',
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

function verificationHashValue(bundle) {
  return bundle?.verificationHash || null;
}

export function computeReadOnlyReleaseVerificationHash(bundle = {}) {
  return digest({
    version: bundle.version,
    kind: bundle.kind,
    actor: bundle.actor,
    package: bundle.package || null,
    status: bundle.status,
    ok: bundle.ok,
    readyForDashboard: bundle.readyForDashboard,
    metrics: bundle.metrics || null,
    hashes: bundle.hashes || null,
    artifacts: bundle.artifacts || null,
    checks: Array.isArray(bundle.checks) ? bundle.checks : null,
    blockers: Array.isArray(bundle.blockers) ? bundle.blockers : null,
    warnings: Array.isArray(bundle.warnings) ? bundle.warnings : null,
    safety: bundle.safety || null,
  });
}

function validateReleaseVerificationReportFiles(reportFiles, blockers, requireReportFiles) {
  if (requireReportFiles !== true) return;
  if (!reportFiles || typeof reportFiles !== 'object' || Array.isArray(reportFiles)) {
    blockers.push(issue('release_verification_report_files_missing', 'Release verification bundle is missing releaseVerificationReportFiles.'));
    return;
  }
  const missing = REQUIRED_RELEASE_VERIFICATION_REPORT_FILE_KEYS.filter((key) => !reportFiles[key]);
  if (missing.length > 0) {
    blockers.push(issue('release_verification_report_files_missing', `Missing release verification report file keys: ${missing.join(', ')}.`));
  }
  if (reportFiles.json && reportFiles.json !== 'reports/read-only-release-verification-latest.json') {
    blockers.push(issue('release_verification_report_files_latest_json_mismatch', `Expected reports/read-only-release-verification-latest.json, got ${reportFiles.json}.`));
  }
  if (reportFiles.markdown && reportFiles.markdown !== 'reports/read-only-release-verification-latest.md') {
    blockers.push(issue('release_verification_report_files_latest_markdown_mismatch', `Expected reports/read-only-release-verification-latest.md, got ${reportFiles.markdown}.`));
  }
  if (reportFiles.timestampedJson && !/^reports\/read-only-release-verification-\d{8}T\d{6}Z\.json$/.test(reportFiles.timestampedJson)) {
    blockers.push(issue('release_verification_report_files_timestamped_json_invalid', `Invalid timestamped JSON path: ${reportFiles.timestampedJson}.`));
  }
  if (reportFiles.timestampedMarkdown && !/^reports\/read-only-release-verification-\d{8}T\d{6}Z\.md$/.test(reportFiles.timestampedMarkdown)) {
    blockers.push(issue('release_verification_report_files_timestamped_markdown_invalid', `Invalid timestamped Markdown path: ${reportFiles.timestampedMarkdown}.`));
  }
}

export function validateReadOnlyReleaseVerificationBundle({
  bundle = null,
  actor = 'design-production-core.readonly-release-verification-validator',
  generatedAt = null,
  requireReportFiles = true,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    blockers.push(issue('release_verification_bundle_missing', 'Read-only release verification bundle is required.'));
  }

  const bundleBlockers = Array.isArray(bundle?.blockers) ? bundle.blockers : [];
  const bundleWarnings = Array.isArray(bundle?.warnings) ? bundle.warnings : [];
  const checks = Array.isArray(bundle?.checks) ? bundle.checks : [];
  const metrics = bundle?.metrics && typeof bundle.metrics === 'object' ? bundle.metrics : {};
  const hashes = bundle?.hashes && typeof bundle.hashes === 'object' ? bundle.hashes : {};
  const artifacts = bundle?.artifacts && typeof bundle.artifacts === 'object' ? bundle.artifacts : {};

  if (bundle && bundle.version !== 1) {
    blockers.push(issue('release_verification_bundle_version_unsupported', `Expected bundle version 1, got ${bundle.version}.`));
  }
  if (bundle && bundle.kind !== 'ReadOnlyReleaseVerificationBundle') {
    blockers.push(issue('release_verification_bundle_kind_mismatch', `Expected ReadOnlyReleaseVerificationBundle, got ${bundle.kind || 'missing'}.`));
  }
  if (bundle && typeof bundle.ok !== 'boolean') {
    blockers.push(issue('release_verification_ok_type_invalid', 'Release verification ok must be boolean.'));
  }
  if (bundle && typeof bundle.readyForDashboard !== 'boolean') {
    blockers.push(issue('release_verification_ready_type_invalid', 'Release verification readyForDashboard must be boolean.'));
  }
  if (bundle?.ok === true && bundle.status !== READ_ONLY_RELEASE_VERIFICATION_READY_STATUS) {
    blockers.push(issue('release_verification_status_ok_mismatch', `ok=true requires ${READ_ONLY_RELEASE_VERIFICATION_READY_STATUS}, got ${bundle.status}.`));
  }
  if (bundle?.ok === false && bundle.status !== READ_ONLY_RELEASE_VERIFICATION_BLOCKED_STATUS) {
    blockers.push(issue('release_verification_status_blocked_mismatch', `ok=false requires ${READ_ONLY_RELEASE_VERIFICATION_BLOCKED_STATUS}, got ${bundle.status}.`));
  }
  if (bundle?.readyForDashboard !== bundle?.ok) {
    blockers.push(issue('release_verification_ready_ok_mismatch', 'readyForDashboard must match ok.'));
  }
  if (bundle?.ok === true && bundleBlockers.length > 0) {
    blockers.push(issue('release_verification_ok_with_blockers', 'Ready release verification bundles must not contain blockers.'));
  }

  if (!bundle?.metrics || typeof bundle.metrics !== 'object' || Array.isArray(bundle.metrics)) {
    blockers.push(issue('release_verification_metrics_missing', 'Release verification metrics are required.'));
  } else {
    const missingMetrics = REQUIRED_METRIC_KEYS.filter((key) => !(key in metrics));
    if (missingMetrics.length > 0) {
      blockers.push(issue('release_verification_metrics_missing', `Missing release verification metric keys: ${missingMetrics.join(', ')}.`));
    }
    if (Number(metrics.gateStepCount || 0) < 1) {
      blockers.push(issue('release_verification_gate_step_count_invalid', 'Release verification gateStepCount must be positive.'));
    }
    if (Number(metrics.sourceFileCount || 0) < 1) {
      blockers.push(issue('release_verification_source_file_count_invalid', 'Release verification sourceFileCount must be positive.'));
    }
    if (Number(metrics.fixtureFileCount || 0) < 1) {
      blockers.push(issue('release_verification_fixture_file_count_invalid', 'Release verification fixtureFileCount must be positive.'));
    }
    if (Number(metrics.publicApiModules || 0) < 1) {
      blockers.push(issue('release_verification_public_api_modules_invalid', 'Release verification publicApiModules must be positive.'));
    }
    if (Number(metrics.dispatchTotalHandoffs || 0) !== Number(metrics.dispatchReadyHandoffs || 0) + Number(metrics.dispatchBlockedHandoffs || 0)) {
      blockers.push(issue('release_verification_dispatch_handoff_count_mismatch', `dispatchTotalHandoffs ${metrics.dispatchTotalHandoffs} does not match ready+blocked.`));
    }
    if (Number(metrics.dispatchApprovalProvenanceBoundHandoffs || 0) !== Number(metrics.dispatchTotalHandoffs || 0)) {
      blockers.push(issue('release_verification_dispatch_approval_provenance_hash_coverage_mismatch', `dispatchApprovalProvenanceBoundHandoffs ${metrics.dispatchApprovalProvenanceBoundHandoffs} does not match dispatchTotalHandoffs ${metrics.dispatchTotalHandoffs}.`));
    }
    if (Number(metrics.blockerCount || 0) !== bundleBlockers.length) {
      blockers.push(issue('release_verification_blocker_count_mismatch', `Metric blockerCount ${metrics.blockerCount} does not match blockers ${bundleBlockers.length}.`));
    }
    if (Number(metrics.warningCount || 0) !== bundleWarnings.length) {
      blockers.push(issue('release_verification_warning_count_mismatch', `Metric warningCount ${metrics.warningCount} does not match warnings ${bundleWarnings.length}.`));
    }
    if (Number(metrics.checkCount || 0) !== checks.length) {
      blockers.push(issue('release_verification_check_count_mismatch', `Metric checkCount ${metrics.checkCount} does not match checks ${checks.length}.`));
    }
  }

  const missingHashes = REQUIRED_HASH_KEYS.filter((key) => !hashes[key]);
  if (missingHashes.length > 0) {
    blockers.push(issue('release_verification_hashes_missing', `Missing release verification hash keys: ${missingHashes.join(', ')}.`));
  }

  const recomputedVerificationHash = bundle && typeof bundle === 'object' && !Array.isArray(bundle)
    ? computeReadOnlyReleaseVerificationHash(bundle)
    : null;
  const actualVerificationHash = verificationHashValue(bundle);
	  if (bundle && !actualVerificationHash) {
	    blockers.push(issue('release_verification_hash_missing', 'Release verification bundle must include verificationHash.'));
	  } else if (actualVerificationHash && recomputedVerificationHash && actualVerificationHash !== recomputedVerificationHash) {
	    blockers.push(issue('release_verification_hash_mismatch', `Expected ${recomputedVerificationHash}, got ${actualVerificationHash}.`));
	  }
	  if (bundle && !bundle.verificationHash) {
	    blockers.push(issue('release_verification_hash_alias_missing', 'Release verification bundle must include verificationHash.'));
	  }
	  if (bundle && !bundle.hash) {
	    blockers.push(issue('release_verification_generic_hash_missing', 'Release verification bundle must include hash.'));
	  }
	  if (bundle?.verificationHash && bundle?.hash && bundle.verificationHash !== bundle.hash) {
	    blockers.push(issue('release_verification_hash_alias_mismatch', `verificationHash ${bundle.verificationHash} does not match hash ${bundle.hash}.`));
	  }

  if (!bundle?.artifacts || typeof bundle.artifacts !== 'object' || Array.isArray(bundle.artifacts)) {
    blockers.push(issue('release_verification_artifacts_missing', 'Release verification artifacts are required.'));
  } else {
    if (!artifacts.releaseHealthReportFiles?.json || !artifacts.releaseHealthReportFiles?.markdown) {
      blockers.push(issue('release_verification_health_report_files_missing', 'Release verification artifacts must include release health report JSON and Markdown paths.'));
    }
    validateReleaseVerificationReportFiles(artifacts.releaseVerificationReportFiles, blockers, requireReportFiles);
  }

  if (checks.length === 0) {
    blockers.push(issue('release_verification_checks_missing', 'Release verification bundle checks are required.'));
  }
  const failedChecks = checks.filter((item) => item?.ok !== true);
  if (bundle?.ok === true && failedChecks.length > 0) {
    blockers.push(issue('release_verification_ready_with_failed_checks', `Ready release verification bundle has failed checks: ${failedChecks.map((item) => item?.name || 'unnamed').join(', ')}.`));
  }

  const unsafePaths = unsafeSafetyPaths([
    { path: 'bundle', record: bundle },
    { path: 'bundle.safety', record: bundle?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_release_verification_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  if (bundleWarnings.length > 0) {
    warnings.push(issue('release_verification_warnings_present', `${bundleWarnings.length} release verification warnings are present.`, 'warning'));
  }

  const status = blockers.length
    ? READ_ONLY_RELEASE_VERIFICATION_VALIDATION_STATUS.FAIL
    : READ_ONLY_RELEASE_VERIFICATION_VALIDATION_STATUS.PASS;
  const validation = {
    version: READ_ONLY_RELEASE_VERIFICATION_VALIDATION_VERSION,
    kind: 'ReadOnlyReleaseVerificationValidationReport',
    actor: normalizeText(actor) || 'design-production-core.readonly-release-verification-validator',
    status,
    ok: status === READ_ONLY_RELEASE_VERIFICATION_VALIDATION_STATUS.PASS,
    metrics: {
      gateStepCount: Number(metrics.gateStepCount || 0),
      failedStepCount: Number(metrics.failedStepCount || 0),
      publicApiModules: Number(metrics.publicApiModules || 0),
      sourceFileCount: Number(metrics.sourceFileCount || 0),
      fixtureFileCount: Number(metrics.fixtureFileCount || 0),
      sampleCount: Number(metrics.sampleCount || 0),
      dispatchTotalHandoffs: Number(metrics.dispatchTotalHandoffs || 0),
      dispatchReadyHandoffs: Number(metrics.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(metrics.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(metrics.dispatchApprovalProvenanceBoundHandoffs || 0),
      dashboardWarningCount: Number(metrics.dashboardWarningCount || 0),
      unknownOperatorHintCount: Number(metrics.unknownOperatorHintCount || 0),
      bundleBlockerCount: bundleBlockers.length,
      bundleWarningCount: bundleWarnings.length,
      checkCount: checks.length,
      reportFileCount: artifacts.releaseVerificationReportFiles && typeof artifacts.releaseVerificationReportFiles === 'object'
        ? Object.keys(artifacts.releaseVerificationReportFiles).length
        : 0,
    },
    hashChecks: {
      verificationHash: bundle?.verificationHash || null,
      hash: bundle?.hash || null,
      recomputedVerificationHash,
      healthHash: hashes.healthHash || null,
      releaseHealthValidationHash: hashes.releaseHealthValidationHash || null,
      gateHash: hashes.gateHash || null,
      gateValidationHash: hashes.gateValidationHash || null,
      closeoutSummaryHash: hashes.closeoutSummaryHash || null,
      closeoutValidationHash: hashes.closeoutValidationHash || null,
      sampleValidationHash: hashes.sampleValidationHash || null,
      dashboardSnapshotHash: hashes.dashboardSnapshotHash || null,
      exportStatusHash: hashes.exportStatusHash || null,
    },
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyReleaseVerificationValidation: true,
      validatesReportOnly: true,
      recomputesVerificationHashOnly: true,
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

export function summarizeReadOnlyReleaseVerificationValidations(reports = []) {
  const byStatus = {};
  let passCount = 0;
  let failCount = 0;
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    if (report.ok === true) passCount += 1;
    if ((report.blockers || []).length > 0) failCount += 1;
  }
  return {
    version: READ_ONLY_RELEASE_VERIFICATION_VALIDATION_VERSION,
    count: reports.length,
    passCount,
    failCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyReleaseVerificationValidationSummary: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
      readyForExecution: reports.some((report) => report.safety?.readyForExecution === true),
    }),
  };
}
