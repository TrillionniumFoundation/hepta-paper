import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_RELEASE_HEALTH_VALIDATION_VERSION = 1;

export const READ_ONLY_RELEASE_HEALTH_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_readonly_release_health_validation',
  FAIL: 'fail_readonly_release_health_validation',
});

const READ_ONLY_RELEASE_HEALTH_READY_STATUS = 'ready_readonly_release_health';
const READ_ONLY_RELEASE_HEALTH_BLOCKED_STATUS = 'blocked_readonly_release_health';

const REQUIRED_REPORT_FILE_KEYS = Object.freeze([
  'json',
  'markdown',
  'timestampedJson',
  'timestampedMarkdown',
]);

const REQUIRED_HASH_KEYS = Object.freeze([
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

function hashValue(manifest) {
  return manifest?.healthHash || null;
}

export function computeReadOnlyReleaseHealthHash(manifest = {}) {
  return digest({
    version: manifest.version,
    kind: manifest.kind,
    actor: manifest.actor,
    package: manifest.package || null,
    status: manifest.status,
    ok: manifest.ok,
    readyForDashboard: manifest.readyForDashboard,
    metrics: manifest.metrics || null,
    hashes: manifest.hashes || null,
    artifacts: manifest.artifacts || null,
    checks: Array.isArray(manifest.checks) ? manifest.checks : null,
    blockers: Array.isArray(manifest.blockers) ? manifest.blockers : null,
    warnings: Array.isArray(manifest.warnings) ? manifest.warnings : null,
    safety: manifest.safety || null,
  });
}

function validateReportFiles(reportFiles, blockers, requireReportFiles) {
  if (requireReportFiles !== true) return;
  if (!reportFiles || typeof reportFiles !== 'object' || Array.isArray(reportFiles)) {
    blockers.push(issue('release_health_report_files_missing', 'Release health manifest is missing releaseHealthReportFiles.'));
    return;
  }
  const missing = REQUIRED_REPORT_FILE_KEYS.filter((key) => !reportFiles[key]);
  if (missing.length > 0) {
    blockers.push(issue('release_health_report_files_missing', `Missing release health report file keys: ${missing.join(', ')}.`));
  }
  if (reportFiles.json && reportFiles.json !== 'reports/read-only-release-health-latest.json') {
    blockers.push(issue('release_health_report_files_latest_json_mismatch', `Expected reports/read-only-release-health-latest.json, got ${reportFiles.json}.`));
  }
  if (reportFiles.markdown && reportFiles.markdown !== 'reports/read-only-release-health-latest.md') {
    blockers.push(issue('release_health_report_files_latest_markdown_mismatch', `Expected reports/read-only-release-health-latest.md, got ${reportFiles.markdown}.`));
  }
  if (reportFiles.timestampedJson && !/^reports\/read-only-release-health-\d{8}T\d{6}Z\.json$/.test(reportFiles.timestampedJson)) {
    blockers.push(issue('release_health_report_files_timestamped_json_invalid', `Invalid timestamped JSON path: ${reportFiles.timestampedJson}.`));
  }
  if (reportFiles.timestampedMarkdown && !/^reports\/read-only-release-health-\d{8}T\d{6}Z\.md$/.test(reportFiles.timestampedMarkdown)) {
    blockers.push(issue('release_health_report_files_timestamped_markdown_invalid', `Invalid timestamped Markdown path: ${reportFiles.timestampedMarkdown}.`));
  }
}

export function validateReadOnlyReleaseHealthManifest({
  manifest = null,
  actor = 'design-production-core.readonly-release-health-validator',
  generatedAt = null,
  requireReportFiles = true,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    blockers.push(issue('release_health_manifest_missing', 'Read-only release health manifest is required.'));
  }

  const manifestBlockers = Array.isArray(manifest?.blockers) ? manifest.blockers : [];
  const manifestWarnings = Array.isArray(manifest?.warnings) ? manifest.warnings : [];
  const checks = Array.isArray(manifest?.checks) ? manifest.checks : [];
  const hashes = manifest?.hashes && typeof manifest.hashes === 'object' ? manifest.hashes : {};
  const artifacts = manifest?.artifacts && typeof manifest.artifacts === 'object' ? manifest.artifacts : {};

  if (manifest && manifest.version !== 1) {
    blockers.push(issue('release_health_manifest_version_unsupported', `Expected manifest version 1, got ${manifest.version}.`));
  }
  if (manifest && manifest.kind !== 'ReadOnlyReleaseHealthManifest') {
    blockers.push(issue('release_health_manifest_kind_mismatch', `Expected ReadOnlyReleaseHealthManifest, got ${manifest.kind || 'missing'}.`));
  }
  if (manifest && typeof manifest.ok !== 'boolean') {
    blockers.push(issue('release_health_ok_type_invalid', 'Release health ok must be boolean.'));
  }
  if (manifest && typeof manifest.readyForDashboard !== 'boolean') {
    blockers.push(issue('release_health_ready_type_invalid', 'Release health readyForDashboard must be boolean.'));
  }
  if (manifest?.ok === true && manifest.status !== READ_ONLY_RELEASE_HEALTH_READY_STATUS) {
    blockers.push(issue('release_health_status_ok_mismatch', `ok=true requires ${READ_ONLY_RELEASE_HEALTH_READY_STATUS}, got ${manifest.status}.`));
  }
  if (manifest?.ok === false && manifest.status !== READ_ONLY_RELEASE_HEALTH_BLOCKED_STATUS) {
    blockers.push(issue('release_health_status_blocked_mismatch', `ok=false requires ${READ_ONLY_RELEASE_HEALTH_BLOCKED_STATUS}, got ${manifest.status}.`));
  }
  if (manifest?.readyForDashboard !== manifest?.ok) {
    blockers.push(issue('release_health_ready_ok_mismatch', 'readyForDashboard must match ok.'));
  }
  if (manifest?.ok === true && manifestBlockers.length > 0) {
    blockers.push(issue('release_health_ok_with_blockers', 'Ready release health manifests must not contain blockers.'));
  }

  if (!manifest?.metrics || typeof manifest.metrics !== 'object' || Array.isArray(manifest.metrics)) {
    blockers.push(issue('release_health_metrics_missing', 'Release health metrics are required.'));
  } else {
    const missingMetrics = REQUIRED_METRIC_KEYS.filter((key) => !(key in manifest.metrics));
    if (missingMetrics.length > 0) {
      blockers.push(issue('release_health_metrics_missing', `Missing release health metric keys: ${missingMetrics.join(', ')}.`));
    }
    if (Number(manifest.metrics.gateStepCount || 0) < 1) {
      blockers.push(issue('release_health_gate_step_count_invalid', 'Release health gateStepCount must be positive.'));
    }
    if (Number(manifest.metrics.sourceFileCount || 0) < 1) {
      blockers.push(issue('release_health_source_file_count_invalid', 'Release health sourceFileCount must be positive.'));
    }
    if (Number(manifest.metrics.fixtureFileCount || 0) < 1) {
      blockers.push(issue('release_health_fixture_file_count_invalid', 'Release health fixtureFileCount must be positive.'));
    }
    if (Number(manifest.metrics.publicApiModules || 0) < 1) {
      blockers.push(issue('release_health_public_api_modules_invalid', 'Release health publicApiModules must be positive.'));
    }
    if (Number(manifest.metrics.dispatchTotalHandoffs || 0) !== Number(manifest.metrics.dispatchReadyHandoffs || 0) + Number(manifest.metrics.dispatchBlockedHandoffs || 0)) {
      blockers.push(issue('release_health_dispatch_handoff_count_mismatch', `dispatchTotalHandoffs ${manifest.metrics.dispatchTotalHandoffs} does not match ready+blocked.`));
    }
    if (Number(manifest.metrics.dispatchApprovalProvenanceBoundHandoffs || 0) !== Number(manifest.metrics.dispatchTotalHandoffs || 0)) {
      blockers.push(issue('release_health_dispatch_approval_provenance_hash_coverage_mismatch', `dispatchApprovalProvenanceBoundHandoffs ${manifest.metrics.dispatchApprovalProvenanceBoundHandoffs} does not match dispatchTotalHandoffs ${manifest.metrics.dispatchTotalHandoffs}.`));
    }
    if (Number(manifest.metrics.blockerCount || 0) !== manifestBlockers.length) {
      blockers.push(issue('release_health_blocker_count_mismatch', `Metric blockerCount ${manifest.metrics.blockerCount} does not match blockers ${manifestBlockers.length}.`));
    }
    if (Number(manifest.metrics.warningCount || 0) !== manifestWarnings.length) {
      blockers.push(issue('release_health_warning_count_mismatch', `Metric warningCount ${manifest.metrics.warningCount} does not match warnings ${manifestWarnings.length}.`));
    }
  }

  const missingHashes = REQUIRED_HASH_KEYS.filter((key) => !hashes[key]);
  if (missingHashes.length > 0) {
    blockers.push(issue('release_health_hashes_missing', `Missing release health hash keys: ${missingHashes.join(', ')}.`));
  }

  const recomputedHealthHash = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? computeReadOnlyReleaseHealthHash(manifest)
    : null;
  const actualHealthHash = hashValue(manifest);
	  if (manifest && !actualHealthHash) {
	    blockers.push(issue('release_health_hash_missing', 'Release health manifest must include healthHash.'));
	  } else if (actualHealthHash && recomputedHealthHash && actualHealthHash !== recomputedHealthHash) {
	    blockers.push(issue('release_health_hash_mismatch', `Expected ${recomputedHealthHash}, got ${actualHealthHash}.`));
	  }
	  if (manifest && !manifest.healthHash) {
	    blockers.push(issue('release_health_hash_alias_missing', 'Release health manifest must include healthHash.'));
	  }
	  if (manifest && !manifest.hash) {
	    blockers.push(issue('release_health_generic_hash_missing', 'Release health manifest must include hash.'));
	  }
	  if (manifest?.healthHash && manifest?.hash && manifest.healthHash !== manifest.hash) {
	    blockers.push(issue('release_health_hash_alias_mismatch', `healthHash ${manifest.healthHash} does not match hash ${manifest.hash}.`));
	  }

  if (!manifest?.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) {
    blockers.push(issue('release_health_artifacts_missing', 'Release health artifacts are required.'));
  } else {
    if (!artifacts.gateReportFiles?.json || !artifacts.gateReportFiles?.markdown) {
      blockers.push(issue('release_health_gate_report_files_missing', 'Release health artifacts must include gate report JSON and Markdown paths.'));
    }
    if (!artifacts.closeoutReportFiles?.json || !artifacts.closeoutReportFiles?.markdown) {
      blockers.push(issue('release_health_closeout_report_files_missing', 'Release health artifacts must include closeout report JSON and Markdown paths.'));
    }
    if (!artifacts.sampleReport) {
      blockers.push(issue('release_health_sample_report_missing', 'Release health artifacts must include the read-only sample report path.'));
    }
  }

  validateReportFiles(artifacts.releaseHealthReportFiles, blockers, requireReportFiles);

  if (checks.length === 0) {
    blockers.push(issue('release_health_checks_missing', 'Release health manifest checks are required.'));
  }
  const failedChecks = checks.filter((item) => item?.ok !== true);
  if (manifest?.ok === true && failedChecks.length > 0) {
    blockers.push(issue('release_health_ready_with_failed_checks', `Ready release health manifest has failed checks: ${failedChecks.map((item) => item?.name || 'unnamed').join(', ')}.`));
  }

  const unsafePaths = unsafeSafetyPaths([
    { path: 'manifest', record: manifest },
    { path: 'manifest.safety', record: manifest?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_release_health_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  if (manifestWarnings.length > 0) {
    warnings.push(issue('release_health_warnings_present', `${manifestWarnings.length} release health warnings are present.`, 'warning'));
  }

  const status = blockers.length
    ? READ_ONLY_RELEASE_HEALTH_VALIDATION_STATUS.FAIL
    : READ_ONLY_RELEASE_HEALTH_VALIDATION_STATUS.PASS;
  const validation = {
    version: READ_ONLY_RELEASE_HEALTH_VALIDATION_VERSION,
    kind: 'ReadOnlyReleaseHealthValidationReport',
    actor: normalizeText(actor) || 'design-production-core.readonly-release-health-validator',
    status,
    ok: status === READ_ONLY_RELEASE_HEALTH_VALIDATION_STATUS.PASS,
    metrics: {
      gateStepCount: Number(manifest?.metrics?.gateStepCount || 0),
      failedStepCount: Number(manifest?.metrics?.failedStepCount || 0),
      publicApiModules: Number(manifest?.metrics?.publicApiModules || 0),
      sourceFileCount: Number(manifest?.metrics?.sourceFileCount || 0),
      fixtureFileCount: Number(manifest?.metrics?.fixtureFileCount || 0),
      sampleCount: Number(manifest?.metrics?.sampleCount || 0),
      dispatchTotalHandoffs: Number(manifest?.metrics?.dispatchTotalHandoffs || 0),
      dispatchReadyHandoffs: Number(manifest?.metrics?.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(manifest?.metrics?.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(manifest?.metrics?.dispatchApprovalProvenanceBoundHandoffs || 0),
      dashboardWarningCount: Number(manifest?.metrics?.dashboardWarningCount || 0),
      unknownOperatorHintCount: Number(manifest?.metrics?.unknownOperatorHintCount || 0),
      manifestBlockerCount: manifestBlockers.length,
      manifestWarningCount: manifestWarnings.length,
      checkCount: checks.length,
      reportFileCount: artifacts.releaseHealthReportFiles && typeof artifacts.releaseHealthReportFiles === 'object'
        ? Object.keys(artifacts.releaseHealthReportFiles).length
        : 0,
    },
    hashChecks: {
      healthHash: manifest?.healthHash || null,
      hash: manifest?.hash || null,
      recomputedHealthHash,
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
      readOnlyReleaseHealthValidation: true,
      validatesReportOnly: true,
      recomputesHealthHashOnly: true,
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

export function summarizeReadOnlyReleaseHealthValidations(reports = []) {
  const byStatus = {};
  let passCount = 0;
  let failCount = 0;
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    if (report.ok === true) passCount += 1;
    if ((report.blockers || []).length > 0) failCount += 1;
  }
  return {
    version: READ_ONLY_RELEASE_HEALTH_VALIDATION_VERSION,
    count: reports.length,
    passCount,
    failCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyReleaseHealthValidationSummary: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
      readyForExecution: reports.some((report) => report.safety?.readyForExecution === true),
    }),
  };
}
