import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_RELEASE_HEALTH_VERSION = 1;

export const READ_ONLY_RELEASE_HEALTH_STATUS = Object.freeze({
  READY: 'ready_readonly_release_health',
  BLOCKED: 'blocked_readonly_release_health',
});

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

function check(name, ok, status = null, hash = null, notes = null) {
  return {
    name,
    ok: ok === true,
    status: status || null,
    hash: hash || null,
    notes: normalizeText(notes) || null,
  };
}

function requireHash(blockers, value, code, notes) {
  if (!value) blockers.push(issue(code, notes));
}

export function buildReadOnlyReleaseHealthManifest({
  gateReport = null,
  gateValidation = null,
  closeoutSummary = null,
  closeoutValidation = null,
  packageName = 'design-production-core',
  packageVersion = '0.0.0',
  actor = 'design-production-core.readonly-release-health',
  generatedAt = null,
  reportFiles = null,
  readErrors = [],
} = {}) {
  const blockers = [];
  const warnings = [];

  for (const readError of readErrors || []) {
    if (readError) blockers.push(issue('release_health_input_read_failed', readError));
  }

  if (!gateReport || typeof gateReport !== 'object' || Array.isArray(gateReport)) {
    blockers.push(issue('gate_report_missing', 'Release health requires a read-only core gate report.'));
  } else if (gateReport.ok !== true) {
    blockers.push(issue('gate_report_not_ok', gateReport.status));
  }

  if (!gateValidation || typeof gateValidation !== 'object' || Array.isArray(gateValidation)) {
    blockers.push(issue('gate_validation_missing', 'Release health requires a gate validation report.'));
  } else if (gateValidation.ok !== true) {
    blockers.push(issue('gate_validation_not_ok', gateValidation.status));
  }

  if (!closeoutSummary || typeof closeoutSummary !== 'object' || Array.isArray(closeoutSummary)) {
    blockers.push(issue('closeout_summary_missing', 'Release health requires a closeout summary.'));
  } else if (closeoutSummary.ok !== true || closeoutSummary.readyForDashboard !== true) {
    blockers.push(issue('closeout_summary_not_ready', closeoutSummary.status));
  }

  if (!closeoutValidation || typeof closeoutValidation !== 'object' || Array.isArray(closeoutValidation)) {
    blockers.push(issue('closeout_validation_missing', 'Release health requires a closeout validation report.'));
  } else if (closeoutValidation.ok !== true) {
    blockers.push(issue('closeout_validation_not_ok', closeoutValidation.status));
  }

  const currentGateHash = requiredSemanticHash(
    blockers,
    gateReport,
    'gateHash',
    'release_gate_hash_alias_required',
    'release_gate_generic_hash_required',
    'release_gate_hash_alias_mismatch',
    'Gate report',
  );
  const currentGateValidationHash = requiredSemanticHash(
    blockers,
    gateValidation,
    'validationHash',
    'release_gate_validation_hash_alias_required',
    'release_gate_validation_generic_hash_required',
    'release_gate_validation_hash_alias_mismatch',
    'Gate validation',
  );
  const currentCloseoutHash = requiredSemanticHash(
    blockers,
    closeoutSummary,
    'summaryHash',
    'release_closeout_summary_hash_alias_required',
    'release_closeout_summary_generic_hash_required',
    'release_closeout_summary_hash_alias_mismatch',
    'Closeout summary',
  );
  const currentCloseoutValidationHash = requiredSemanticHash(
    blockers,
    closeoutValidation,
    'validationHash',
    'release_closeout_validation_hash_alias_required',
    'release_closeout_validation_generic_hash_required',
    'release_closeout_validation_hash_alias_mismatch',
    'Closeout validation',
  );
  const gateValidationGateHash = gateValidation?.hashChecks?.gateHash || null;
  const gateValidationRecomputedGateHash = gateValidation?.hashChecks?.recomputedGateHash || null;
  const closeoutGateHash = closeoutSummary?.hashes?.gateHash || null;
  const closeoutGateValidationHash = closeoutSummary?.hashes?.gateValidationHash || null;
  const closeoutSampleValidationHash = closeoutSummary?.hashes?.sampleValidationHash || null;
  const closeoutDashboardSnapshotHash = closeoutSummary?.hashes?.dashboardSnapshotHash || null;
  const closeoutExportStatusHash = closeoutSummary?.hashes?.exportStatusHash || null;
  const closeoutValidationSummaryHash = closeoutValidation?.hashChecks?.summaryHash || null;
  const closeoutValidationRecomputedSummaryHash = closeoutValidation?.hashChecks?.recomputedSummaryHash || null;

  requireHash(blockers, currentGateHash, 'release_gate_hash_missing', 'Release health requires the source gate hash.');
  requireHash(blockers, currentGateValidationHash, 'release_gate_validation_hash_missing', 'Release health requires the gate validation report hash.');
  requireHash(blockers, gateValidationGateHash, 'release_gate_validation_gate_hash_missing', 'Gate validation must bind the source gate hash.');
  requireHash(blockers, gateValidationRecomputedGateHash, 'release_gate_validation_recomputed_hash_missing', 'Gate validation must carry the recomputed gate hash.');
  requireHash(blockers, currentCloseoutHash, 'release_closeout_summary_hash_missing', 'Release health requires the closeout summary hash.');
  requireHash(blockers, currentCloseoutValidationHash, 'release_closeout_validation_hash_missing', 'Release health requires the closeout validation report hash.');
  requireHash(blockers, closeoutGateHash, 'release_closeout_gate_hash_missing', 'Closeout summary must bind the source gate hash.');
  requireHash(blockers, closeoutGateValidationHash, 'release_closeout_gate_validation_hash_missing', 'Closeout summary must bind the gate validation hash.');
  requireHash(blockers, closeoutSampleValidationHash, 'release_closeout_sample_validation_hash_missing', 'Closeout summary must bind the sample validation hash.');
  requireHash(blockers, closeoutDashboardSnapshotHash, 'release_closeout_dashboard_snapshot_hash_missing', 'Closeout summary must bind the dashboard snapshot hash.');
  requireHash(blockers, closeoutExportStatusHash, 'release_closeout_export_status_hash_missing', 'Closeout summary must bind the export status hash.');
  requireHash(blockers, closeoutValidationSummaryHash, 'release_closeout_validation_summary_hash_missing', 'Closeout validation must bind the source closeout summary hash.');
  requireHash(blockers, closeoutValidationRecomputedSummaryHash, 'release_closeout_validation_recomputed_hash_missing', 'Closeout validation must carry the recomputed closeout summary hash.');

  if (currentGateHash && gateValidationGateHash && currentGateHash !== gateValidationGateHash) {
    blockers.push(issue('release_gate_validation_hash_mismatch', `gate report ${currentGateHash} != gate validation ${gateValidationGateHash}.`));
  }
  if (currentGateHash && gateValidationRecomputedGateHash && currentGateHash !== gateValidationRecomputedGateHash) {
    blockers.push(issue('release_gate_recomputed_hash_mismatch', `gate report ${currentGateHash} != recomputed ${gateValidationRecomputedGateHash}.`));
  }
  if (currentGateHash && closeoutGateHash && currentGateHash !== closeoutGateHash) {
    blockers.push(issue('release_gate_closeout_hash_mismatch', `gate report ${currentGateHash} != closeout ${closeoutGateHash}.`));
  }
  if (currentGateValidationHash && closeoutGateValidationHash && currentGateValidationHash !== closeoutGateValidationHash) {
    blockers.push(issue('release_gate_validation_closeout_hash_mismatch', `gate validation ${currentGateValidationHash} != closeout ${closeoutGateValidationHash}.`));
  }
  if (currentCloseoutHash && closeoutValidationSummaryHash && currentCloseoutHash !== closeoutValidationSummaryHash) {
    blockers.push(issue('release_closeout_validation_hash_mismatch', `closeout ${currentCloseoutHash} != closeout validation ${closeoutValidationSummaryHash}.`));
  }
  if (currentCloseoutHash && closeoutValidationRecomputedSummaryHash && currentCloseoutHash !== closeoutValidationRecomputedSummaryHash) {
    blockers.push(issue('release_closeout_recomputed_hash_mismatch', `closeout ${currentCloseoutHash} != recomputed ${closeoutValidationRecomputedSummaryHash}.`));
  }

  const unsafePaths = unsafeSafetyPaths([
    { path: 'gateReport', record: gateReport },
    { path: 'gateReport.safety', record: gateReport?.safety },
    { path: 'gateValidation', record: gateValidation },
    { path: 'gateValidation.safety', record: gateValidation?.safety },
    { path: 'closeoutSummary', record: closeoutSummary },
    { path: 'closeoutSummary.safety', record: closeoutSummary?.safety },
    { path: 'closeoutValidation', record: closeoutValidation },
    { path: 'closeoutValidation.safety', record: closeoutValidation?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_release_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  if (Array.isArray(closeoutValidation?.warnings) && closeoutValidation.warnings.length > 0) {
    warnings.push(issue('closeout_validation_warnings_present', `${closeoutValidation.warnings.length} closeout validation warnings are present.`, 'warning'));
  }
  if (Array.isArray(gateValidation?.warnings) && gateValidation.warnings.length > 0) {
    warnings.push(issue('gate_validation_warnings_present', `${gateValidation.warnings.length} gate validation warnings are present.`, 'warning'));
  }
  if (Number(closeoutSummary?.metrics?.sampleValidationWarnings || 0) > 0) {
    warnings.push(issue('sample_validation_warnings_present', `${closeoutSummary.metrics.sampleValidationWarnings} sample validation warnings are present.`, 'warning'));
  }
  if (Number(closeoutSummary?.metrics?.planOnlyBlocked || 0) > 0) {
    warnings.push(issue('plan_only_blocked_samples_present', `${closeoutSummary.metrics.planOnlyBlocked} plan-only samples are blocked.`, 'warning'));
  }
  if (Number(closeoutSummary?.metrics?.dispatchBlockedHandoffs || 0) > 0) {
    warnings.push(issue('dispatch_blocked_handoffs_present', `${closeoutSummary.metrics.dispatchBlockedHandoffs} dispatch handoffs are blocked and remain visible in release health.`, 'warning'));
  }

  const checks = [
    check('gate_report_passed', gateReport?.ok === true, gateReport?.status, currentGateHash),
    check('gate_validation_passed', gateValidation?.ok === true, gateValidation?.status, currentGateValidationHash),
    check('closeout_summary_ready', closeoutSummary?.ok === true && closeoutSummary?.readyForDashboard === true, closeoutSummary?.status, currentCloseoutHash),
    check('closeout_validation_passed', closeoutValidation?.ok === true, closeoutValidation?.status, currentCloseoutValidationHash),
    check('gate_hash_chain_bound', blockers.every((blocker) => !String(blocker.code).includes('gate')), null, currentGateHash),
    check('closeout_hash_chain_bound', blockers.every((blocker) => !String(blocker.code).includes('closeout')), null, currentCloseoutHash),
  ];

  const status = blockers.length
    ? READ_ONLY_RELEASE_HEALTH_STATUS.BLOCKED
    : READ_ONLY_RELEASE_HEALTH_STATUS.READY;

  const manifest = {
    version: READ_ONLY_RELEASE_HEALTH_VERSION,
    kind: 'ReadOnlyReleaseHealthManifest',
    actor: normalizeText(actor) || 'design-production-core.readonly-release-health',
    package: {
      name: normalizeText(packageName) || 'design-production-core',
      version: normalizeText(packageVersion) || '0.0.0',
    },
    status,
    ok: status === READ_ONLY_RELEASE_HEALTH_STATUS.READY,
    readyForDashboard: status === READ_ONLY_RELEASE_HEALTH_STATUS.READY,
    metrics: {
      gateStepCount: Number(closeoutSummary?.metrics?.gateStepCount || gateReport?.stepCount || 0),
      failedStepCount: Number(closeoutSummary?.metrics?.failedStepCount || gateReport?.failedSteps?.length || 0),
      sourceFileCount: Number(closeoutSummary?.metrics?.sourceFileCount || 0),
      fixtureFileCount: Number(closeoutSummary?.metrics?.fixtureFileCount || 0),
      publicApiModules: Number(closeoutSummary?.metrics?.publicApiModules || 0),
      sampleCount: Number(closeoutSummary?.metrics?.sampleCount || 0),
      planOnlyBlocked: Number(closeoutSummary?.metrics?.planOnlyBlocked || 0),
      dispatchTotalHandoffs: Number(closeoutSummary?.metrics?.dispatchTotalHandoffs || 0),
      dispatchReadyHandoffs: Number(closeoutSummary?.metrics?.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(closeoutSummary?.metrics?.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(closeoutSummary?.metrics?.dispatchApprovalProvenanceBoundHandoffs || 0),
      operatorHintCount: Number(closeoutSummary?.metrics?.operatorHintCount || 0),
      unknownOperatorHintCount: Number(closeoutSummary?.metrics?.unknownOperatorHintCount || 0),
      dashboardWarningCount: Number(closeoutSummary?.metrics?.dashboardWarningCount || 0),
      dashboardBlockerCount: Number(closeoutSummary?.metrics?.dashboardBlockerCount || 0),
      exportStatusBlockerCount: Number(closeoutSummary?.metrics?.exportStatusBlockerCount || 0),
      blockerCount: blockers.length,
      warningCount: warnings.length,
    },
	    hashes: {
	      gateHash: currentGateHash,
	      gateValidationHash: currentGateValidationHash,
	      closeoutSummaryHash: currentCloseoutHash,
	      closeoutValidationHash: currentCloseoutValidationHash,
	      sampleValidationHash: closeoutSampleValidationHash,
	      dashboardSnapshotHash: closeoutDashboardSnapshotHash,
	      exportStatusHash: closeoutExportStatusHash,
	    },
    artifacts: {
      gateReportFiles: gateReport?.reportFiles || closeoutSummary?.artifacts?.gateReportFiles || null,
      closeoutReportFiles: closeoutSummary?.reportFiles || null,
      sampleReport: closeoutSummary?.artifacts?.sampleReport || null,
      releaseHealthReportFiles: reportFiles || null,
    },
    checks,
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyReleaseHealthManifest: true,
      dashboardHealthOnly: true,
      localReportOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const healthHash = digest({
    version: manifest.version,
    kind: manifest.kind,
    actor: manifest.actor,
    package: manifest.package,
    status: manifest.status,
    ok: manifest.ok,
    readyForDashboard: manifest.readyForDashboard,
    metrics: manifest.metrics,
    hashes: manifest.hashes,
    artifacts: manifest.artifacts,
    checks: manifest.checks,
    blockers: manifest.blockers,
    warnings: manifest.warnings,
    safety: manifest.safety,
  });
  return {
    ...manifest,
    healthHash,
    hash: healthHash,
  };
}

export function summarizeReadOnlyReleaseHealthManifests(manifests = []) {
  const byStatus = {};
  let readyCount = 0;
  let blockedCount = 0;
  for (const manifest of manifests || []) {
    byStatus[manifest.status] = (byStatus[manifest.status] || 0) + 1;
    if (manifest.ok === true || manifest.readyForDashboard === true) readyCount += 1;
    if ((manifest.blockers || []).length > 0) blockedCount += 1;
  }
  return {
    version: READ_ONLY_RELEASE_HEALTH_VERSION,
    count: manifests.length,
    readyCount,
    blockedCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyReleaseHealthSummary: true,
      executesExternalAction: manifests.some((manifest) => manifest.safety?.executesExternalAction === true),
      fetchesChannelState: manifests.some((manifest) => manifest.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: manifests.some((manifest) => manifest.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: manifests.some((manifest) => manifest.safety?.grantsExecutionPermission === true),
      readyForExecution: manifests.some((manifest) => manifest.safety?.readyForExecution === true),
    }),
  };
}
