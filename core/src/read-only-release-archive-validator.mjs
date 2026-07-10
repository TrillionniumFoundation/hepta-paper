import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_RELEASE_ARCHIVE_VALIDATION_VERSION = 1;

export const READ_ONLY_RELEASE_ARCHIVE_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_readonly_release_archive_validation',
  FAIL: 'fail_readonly_release_archive_validation',
});

const READ_ONLY_RELEASE_ARCHIVE_READY_STATUS = 'ready_readonly_release_archive';
const READ_ONLY_RELEASE_ARCHIVE_BLOCKED_STATUS = 'blocked_readonly_release_archive';

const REQUIRED_RELEASE_ARCHIVE_REPORT_FILE_KEYS = Object.freeze([
  'json',
  'markdown',
  'timestampedJson',
  'timestampedMarkdown',
]);

const REQUIRED_HASH_KEYS = Object.freeze([
  'verificationHash',
  'releaseVerificationValidationHash',
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

function archiveHashValue(manifest) {
  return manifest?.archiveHash || null;
}

export function computeReadOnlyReleaseArchiveHash(manifest = {}) {
  return digest({
    version: manifest.version,
    kind: manifest.kind,
    actor: manifest.actor,
    package: manifest.package || null,
    status: manifest.status,
    ok: manifest.ok,
    readyForDashboard: manifest.readyForDashboard,
    readyForArchive: manifest.readyForArchive,
    metrics: manifest.metrics || null,
    hashes: manifest.hashes || null,
    artifacts: manifest.artifacts || null,
    checks: Array.isArray(manifest.checks) ? manifest.checks : null,
    blockers: Array.isArray(manifest.blockers) ? manifest.blockers : null,
    warnings: Array.isArray(manifest.warnings) ? manifest.warnings : null,
    safety: manifest.safety || null,
  });
}

function validateReleaseArchiveReportFiles(reportFiles, blockers, requireReportFiles) {
  if (requireReportFiles !== true) return;
  if (!reportFiles || typeof reportFiles !== 'object' || Array.isArray(reportFiles)) {
    blockers.push(issue('release_archive_report_files_missing', 'Release archive manifest is missing releaseArchiveReportFiles.'));
    return;
  }
  const missing = REQUIRED_RELEASE_ARCHIVE_REPORT_FILE_KEYS.filter((key) => !reportFiles[key]);
  if (missing.length > 0) {
    blockers.push(issue('release_archive_report_files_missing', `Missing release archive report file keys: ${missing.join(', ')}.`));
  }
  if (reportFiles.json && reportFiles.json !== 'reports/read-only-release-archive-latest.json') {
    blockers.push(issue('release_archive_report_files_latest_json_mismatch', `Expected reports/read-only-release-archive-latest.json, got ${reportFiles.json}.`));
  }
  if (reportFiles.markdown && reportFiles.markdown !== 'reports/read-only-release-archive-latest.md') {
    blockers.push(issue('release_archive_report_files_latest_markdown_mismatch', `Expected reports/read-only-release-archive-latest.md, got ${reportFiles.markdown}.`));
  }
  if (reportFiles.timestampedJson && !/^reports\/read-only-release-archive-\d{8}T\d{6}Z\.json$/.test(reportFiles.timestampedJson)) {
    blockers.push(issue('release_archive_report_files_timestamped_json_invalid', `Invalid timestamped JSON path: ${reportFiles.timestampedJson}.`));
  }
  if (reportFiles.timestampedMarkdown && !/^reports\/read-only-release-archive-\d{8}T\d{6}Z\.md$/.test(reportFiles.timestampedMarkdown)) {
    blockers.push(issue('release_archive_report_files_timestamped_markdown_invalid', `Invalid timestamped Markdown path: ${reportFiles.timestampedMarkdown}.`));
  }
}

export function validateReadOnlyReleaseArchiveManifest({
  manifest = null,
  actor = 'design-production-core.readonly-release-archive-validator',
  generatedAt = null,
  requireReportFiles = true,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    blockers.push(issue('release_archive_manifest_missing', 'Read-only release archive manifest is required.'));
  }

  const manifestBlockers = Array.isArray(manifest?.blockers) ? manifest.blockers : [];
  const manifestWarnings = Array.isArray(manifest?.warnings) ? manifest.warnings : [];
  const checks = Array.isArray(manifest?.checks) ? manifest.checks : [];
  const metrics = manifest?.metrics && typeof manifest.metrics === 'object' ? manifest.metrics : {};
  const hashes = manifest?.hashes && typeof manifest.hashes === 'object' ? manifest.hashes : {};
  const artifacts = manifest?.artifacts && typeof manifest.artifacts === 'object' ? manifest.artifacts : {};

  if (manifest && manifest.version !== 1) {
    blockers.push(issue('release_archive_manifest_version_unsupported', `Expected manifest version 1, got ${manifest.version}.`));
  }
  if (manifest && manifest.kind !== 'ReadOnlyReleaseArchiveManifest') {
    blockers.push(issue('release_archive_manifest_kind_mismatch', `Expected ReadOnlyReleaseArchiveManifest, got ${manifest.kind || 'missing'}.`));
  }
  if (manifest && typeof manifest.ok !== 'boolean') {
    blockers.push(issue('release_archive_ok_type_invalid', 'Release archive ok must be boolean.'));
  }
  if (manifest && typeof manifest.readyForDashboard !== 'boolean') {
    blockers.push(issue('release_archive_ready_dashboard_type_invalid', 'Release archive readyForDashboard must be boolean.'));
  }
  if (manifest && typeof manifest.readyForArchive !== 'boolean') {
    blockers.push(issue('release_archive_ready_archive_type_invalid', 'Release archive readyForArchive must be boolean.'));
  }
  if (manifest?.ok === true && manifest.status !== READ_ONLY_RELEASE_ARCHIVE_READY_STATUS) {
    blockers.push(issue('release_archive_status_ok_mismatch', `ok=true requires ${READ_ONLY_RELEASE_ARCHIVE_READY_STATUS}, got ${manifest.status}.`));
  }
  if (manifest?.ok === false && manifest.status !== READ_ONLY_RELEASE_ARCHIVE_BLOCKED_STATUS) {
    blockers.push(issue('release_archive_status_blocked_mismatch', `ok=false requires ${READ_ONLY_RELEASE_ARCHIVE_BLOCKED_STATUS}, got ${manifest.status}.`));
  }
  if (manifest?.readyForDashboard !== manifest?.ok) {
    blockers.push(issue('release_archive_ready_dashboard_ok_mismatch', 'readyForDashboard must match ok.'));
  }
  if (manifest?.readyForArchive !== manifest?.ok) {
    blockers.push(issue('release_archive_ready_archive_ok_mismatch', 'readyForArchive must match ok.'));
  }
  if (manifest?.ok === true && manifestBlockers.length > 0) {
    blockers.push(issue('release_archive_ok_with_blockers', 'Ready release archive manifests must not contain blockers.'));
  }

  if (!manifest?.metrics || typeof manifest.metrics !== 'object' || Array.isArray(manifest.metrics)) {
    blockers.push(issue('release_archive_metrics_missing', 'Release archive metrics are required.'));
  } else {
    const missingMetrics = REQUIRED_METRIC_KEYS.filter((key) => !(key in metrics));
    if (missingMetrics.length > 0) {
      blockers.push(issue('release_archive_metrics_missing', `Missing release archive metric keys: ${missingMetrics.join(', ')}.`));
    }
    if (Number(metrics.gateStepCount || 0) < 1) {
      blockers.push(issue('release_archive_gate_step_count_invalid', 'Release archive gateStepCount must be positive.'));
    }
    if (Number(metrics.sourceFileCount || 0) < 1) {
      blockers.push(issue('release_archive_source_file_count_invalid', 'Release archive sourceFileCount must be positive.'));
    }
    if (Number(metrics.fixtureFileCount || 0) < 1) {
      blockers.push(issue('release_archive_fixture_file_count_invalid', 'Release archive fixtureFileCount must be positive.'));
    }
    if (Number(metrics.publicApiModules || 0) < 1) {
      blockers.push(issue('release_archive_public_api_modules_invalid', 'Release archive publicApiModules must be positive.'));
    }
    if (Number(metrics.dispatchTotalHandoffs || 0) !== Number(metrics.dispatchReadyHandoffs || 0) + Number(metrics.dispatchBlockedHandoffs || 0)) {
      blockers.push(issue('release_archive_dispatch_handoff_count_mismatch', `dispatchTotalHandoffs ${metrics.dispatchTotalHandoffs} does not match ready+blocked.`));
    }
    if (Number(metrics.dispatchApprovalProvenanceBoundHandoffs || 0) !== Number(metrics.dispatchTotalHandoffs || 0)) {
      blockers.push(issue('release_archive_dispatch_approval_provenance_hash_coverage_mismatch', `dispatchApprovalProvenanceBoundHandoffs ${metrics.dispatchApprovalProvenanceBoundHandoffs} does not match dispatchTotalHandoffs ${metrics.dispatchTotalHandoffs}.`));
    }
    if (Number(metrics.blockerCount || 0) !== manifestBlockers.length) {
      blockers.push(issue('release_archive_blocker_count_mismatch', `Metric blockerCount ${metrics.blockerCount} does not match blockers ${manifestBlockers.length}.`));
    }
    if (Number(metrics.warningCount || 0) !== manifestWarnings.length) {
      blockers.push(issue('release_archive_warning_count_mismatch', `Metric warningCount ${metrics.warningCount} does not match warnings ${manifestWarnings.length}.`));
    }
    if (Number(metrics.checkCount || 0) !== checks.length) {
      blockers.push(issue('release_archive_check_count_mismatch', `Metric checkCount ${metrics.checkCount} does not match checks ${checks.length}.`));
    }
  }

  const missingHashes = REQUIRED_HASH_KEYS.filter((key) => !hashes[key]);
  if (missingHashes.length > 0) {
    blockers.push(issue('release_archive_hashes_missing', `Missing release archive hash keys: ${missingHashes.join(', ')}.`));
  }

  const recomputedArchiveHash = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? computeReadOnlyReleaseArchiveHash(manifest)
    : null;
  const actualArchiveHash = archiveHashValue(manifest);
	  if (manifest && !actualArchiveHash) {
	    blockers.push(issue('release_archive_hash_missing', 'Release archive manifest must include archiveHash.'));
	  } else if (actualArchiveHash && recomputedArchiveHash && actualArchiveHash !== recomputedArchiveHash) {
	    blockers.push(issue('release_archive_hash_mismatch', `Expected ${recomputedArchiveHash}, got ${actualArchiveHash}.`));
	  }
	  if (manifest && !manifest.archiveHash) {
	    blockers.push(issue('release_archive_hash_alias_missing', 'Release archive manifest must include archiveHash.'));
	  }
	  if (manifest && !manifest.hash) {
	    blockers.push(issue('release_archive_generic_hash_missing', 'Release archive manifest must include hash.'));
	  }
	  if (manifest?.archiveHash && manifest?.hash && manifest.archiveHash !== manifest.hash) {
	    blockers.push(issue('release_archive_hash_alias_mismatch', `archiveHash ${manifest.archiveHash} does not match hash ${manifest.hash}.`));
	  }

  if (!manifest?.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) {
    blockers.push(issue('release_archive_artifacts_missing', 'Release archive artifacts are required.'));
  } else {
    if (!artifacts.releaseVerificationReportFiles?.json || !artifacts.releaseVerificationReportFiles?.markdown) {
      blockers.push(issue('release_archive_verification_report_files_missing', 'Release archive artifacts must include release verification report JSON and Markdown paths.'));
    }
    validateReleaseArchiveReportFiles(artifacts.releaseArchiveReportFiles, blockers, requireReportFiles);
  }

  if (checks.length === 0) {
    blockers.push(issue('release_archive_checks_missing', 'Release archive manifest checks are required.'));
  }
  const failedChecks = checks.filter((item) => item?.ok !== true);
  if (manifest?.ok === true && failedChecks.length > 0) {
    blockers.push(issue('release_archive_ready_with_failed_checks', `Ready release archive manifest has failed checks: ${failedChecks.map((item) => item?.name || 'unnamed').join(', ')}.`));
  }

  const unsafePaths = unsafeSafetyPaths([
    { path: 'manifest', record: manifest },
    { path: 'manifest.safety', record: manifest?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_release_archive_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  if (manifestWarnings.length > 0) {
    warnings.push(issue('release_archive_warnings_present', `${manifestWarnings.length} release archive warnings are present.`, 'warning'));
  }

  const status = blockers.length
    ? READ_ONLY_RELEASE_ARCHIVE_VALIDATION_STATUS.FAIL
    : READ_ONLY_RELEASE_ARCHIVE_VALIDATION_STATUS.PASS;
  const validation = {
    version: READ_ONLY_RELEASE_ARCHIVE_VALIDATION_VERSION,
    kind: 'ReadOnlyReleaseArchiveValidationReport',
    actor: normalizeText(actor) || 'design-production-core.readonly-release-archive-validator',
    status,
    ok: status === READ_ONLY_RELEASE_ARCHIVE_VALIDATION_STATUS.PASS,
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
      archiveBlockerCount: manifestBlockers.length,
      archiveWarningCount: manifestWarnings.length,
      checkCount: checks.length,
      reportFileCount: artifacts.releaseArchiveReportFiles && typeof artifacts.releaseArchiveReportFiles === 'object'
        ? Object.keys(artifacts.releaseArchiveReportFiles).length
        : 0,
    },
    hashChecks: {
      archiveHash: manifest?.archiveHash || null,
      hash: manifest?.hash || null,
      recomputedArchiveHash,
      verificationHash: hashes.verificationHash || null,
      releaseVerificationValidationHash: hashes.releaseVerificationValidationHash || null,
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
      readOnlyReleaseArchiveValidation: true,
      validatesReportOnly: true,
      recomputesArchiveHashOnly: true,
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

export function summarizeReadOnlyReleaseArchiveValidations(reports = []) {
  const byStatus = {};
  let passCount = 0;
  let failCount = 0;
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    if (report.ok === true) passCount += 1;
    if ((report.blockers || []).length > 0) failCount += 1;
  }
  return {
    version: READ_ONLY_RELEASE_ARCHIVE_VALIDATION_VERSION,
    count: reports.length,
    passCount,
    failCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyReleaseArchiveValidationSummary: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
      readyForExecution: reports.some((report) => report.safety?.readyForExecution === true),
    }),
  };
}
