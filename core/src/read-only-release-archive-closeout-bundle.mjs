import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_VERSION = 1;

export const READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_STATUS = Object.freeze({
  READY: 'ready_readonly_release_archive_closeout',
  BLOCKED: 'blocked_readonly_release_archive_closeout',
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

export function buildReadOnlyReleaseArchiveCloseoutBundle({
  releaseArchiveManifest = null,
  releaseArchiveValidation = null,
  packageName = 'design-production-core',
  packageVersion = '0.0.0',
  actor = 'design-production-core.readonly-release-archive-closeout',
  generatedAt = null,
  reportFiles = null,
  readErrors = [],
} = {}) {
  const blockers = [];
  const warnings = [];

  for (const readError of readErrors || []) {
    if (readError) blockers.push(issue('release_archive_closeout_input_read_failed', readError));
  }

  if (!releaseArchiveManifest || typeof releaseArchiveManifest !== 'object' || Array.isArray(releaseArchiveManifest)) {
    blockers.push(issue('release_archive_manifest_missing', 'Release archive closeout requires a release archive manifest.'));
  } else if (releaseArchiveManifest.ok !== true || releaseArchiveManifest.status !== 'ready_readonly_release_archive') {
    blockers.push(issue('release_archive_manifest_not_ready', releaseArchiveManifest.status));
  }

  if (!releaseArchiveValidation || typeof releaseArchiveValidation !== 'object' || Array.isArray(releaseArchiveValidation)) {
    blockers.push(issue('release_archive_validation_missing', 'Release archive closeout requires a release archive validation report.'));
  } else if (releaseArchiveValidation.ok !== true || releaseArchiveValidation.status !== 'pass_readonly_release_archive_validation') {
    blockers.push(issue('release_archive_validation_not_ok', releaseArchiveValidation.status));
  }

  const currentArchiveHash = requiredSemanticHash(
    blockers,
    releaseArchiveManifest,
    'archiveHash',
    'release_archive_closeout_archive_hash_alias_required',
    'release_archive_closeout_archive_generic_hash_required',
    'release_archive_closeout_archive_hash_alias_mismatch',
    'Release archive manifest',
  );
  const currentValidationHash = requiredSemanticHash(
    blockers,
    releaseArchiveValidation,
    'validationHash',
    'release_archive_closeout_validation_hash_alias_required',
    'release_archive_closeout_validation_generic_hash_required',
    'release_archive_closeout_validation_hash_alias_mismatch',
    'Release archive validation',
  );
  const validationArchiveHash = releaseArchiveValidation?.hashChecks?.archiveHash || null;
  const validationRecomputedArchiveHash = releaseArchiveValidation?.hashChecks?.recomputedArchiveHash || null;
  requireHash(blockers, currentArchiveHash, 'release_archive_closeout_archive_hash_missing', 'Release archive closeout requires the source archive hash.');
  requireHash(blockers, currentValidationHash, 'release_archive_closeout_validation_hash_missing', 'Release archive closeout requires the archive validation report hash.');
  requireHash(blockers, validationArchiveHash, 'release_archive_closeout_validation_archive_hash_missing', 'Release archive validation must bind the source archive hash.');
  requireHash(blockers, validationRecomputedArchiveHash, 'release_archive_closeout_validation_recomputed_archive_hash_missing', 'Release archive validation must carry the recomputed archive hash.');
  if (currentArchiveHash && validationArchiveHash && currentArchiveHash !== validationArchiveHash) {
    blockers.push(issue('release_archive_closeout_archive_hash_mismatch', `archive ${currentArchiveHash} != validation ${validationArchiveHash}.`));
  }
  if (currentArchiveHash && validationRecomputedArchiveHash && currentArchiveHash !== validationRecomputedArchiveHash) {
    blockers.push(issue('release_archive_closeout_recomputed_archive_hash_mismatch', `archive ${currentArchiveHash} != recomputed ${validationRecomputedArchiveHash}.`));
  }

  const hashFields = [
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
  ];
  for (const key of hashFields) {
    const manifestHash = releaseArchiveManifest?.hashes?.[key] || null;
    const validationCheckHash = releaseArchiveValidation?.hashChecks?.[key] || null;
    if (!manifestHash) {
      blockers.push(issue('release_archive_closeout_manifest_hash_missing', `Release archive manifest must bind ${key}.`));
    } else if (!validationCheckHash) {
      blockers.push(issue('release_archive_closeout_validation_hash_check_missing', `Release archive validation must bind ${key}.`));
    } else if (manifestHash !== validationCheckHash) {
      blockers.push(issue('release_archive_closeout_hash_chain_mismatch', `${key}: archive ${manifestHash} != validation ${validationCheckHash}.`));
    }
  }

  const unsafePaths = unsafeSafetyPaths([
    { path: 'releaseArchiveManifest', record: releaseArchiveManifest },
    { path: 'releaseArchiveManifest.safety', record: releaseArchiveManifest?.safety },
    { path: 'releaseArchiveValidation', record: releaseArchiveValidation },
    { path: 'releaseArchiveValidation.safety', record: releaseArchiveValidation?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_release_archive_closeout_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  const manifestWarnings = Array.isArray(releaseArchiveManifest?.warnings) ? releaseArchiveManifest.warnings : [];
  const validationWarnings = Array.isArray(releaseArchiveValidation?.warnings) ? releaseArchiveValidation.warnings : [];
  if (manifestWarnings.length > 0) {
    warnings.push(issue('release_archive_warnings_present', `${manifestWarnings.length} release archive warnings are present.`, 'warning'));
  }
  if (validationWarnings.length > 0) {
    warnings.push(issue('release_archive_validation_warnings_present', `${validationWarnings.length} release archive validation warnings are present.`, 'warning'));
  }

  const checks = [
    check('release_archive_manifest_ready', releaseArchiveManifest?.ok === true, releaseArchiveManifest?.status, currentArchiveHash),
    check('release_archive_validation_passed', releaseArchiveValidation?.ok === true, releaseArchiveValidation?.status, currentValidationHash),
    check('archive_hash_bound', currentArchiveHash && currentArchiveHash === validationArchiveHash, null, currentArchiveHash),
    check('recomputed_archive_hash_bound', currentArchiveHash && currentArchiveHash === validationRecomputedArchiveHash, null, validationRecomputedArchiveHash),
  ];

  const status = blockers.length
    ? READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_STATUS.BLOCKED
    : READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_STATUS.READY;

  const bundle = {
    version: READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_VERSION,
    kind: 'ReadOnlyReleaseArchiveCloseoutBundle',
    actor: normalizeText(actor) || 'design-production-core.readonly-release-archive-closeout',
    package: {
      name: normalizeText(packageName) || releaseArchiveManifest?.package?.name || 'design-production-core',
      version: normalizeText(packageVersion) || releaseArchiveManifest?.package?.version || '0.0.0',
    },
    status,
    ok: status === READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_STATUS.READY,
    readyForDashboard: status === READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_STATUS.READY,
    readyForArchive: status === READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_STATUS.READY,
    metrics: {
      gateStepCount: Number(releaseArchiveManifest?.metrics?.gateStepCount || 0),
      failedStepCount: Number(releaseArchiveManifest?.metrics?.failedStepCount || 0),
      sourceFileCount: Number(releaseArchiveManifest?.metrics?.sourceFileCount || 0),
      fixtureFileCount: Number(releaseArchiveManifest?.metrics?.fixtureFileCount || 0),
      publicApiModules: Number(releaseArchiveManifest?.metrics?.publicApiModules || 0),
      sampleCount: Number(releaseArchiveManifest?.metrics?.sampleCount || 0),
      dispatchTotalHandoffs: Number(releaseArchiveManifest?.metrics?.dispatchTotalHandoffs || 0),
      dispatchReadyHandoffs: Number(releaseArchiveManifest?.metrics?.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(releaseArchiveManifest?.metrics?.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(releaseArchiveManifest?.metrics?.dispatchApprovalProvenanceBoundHandoffs || 0),
      operatorHintCount: Number(releaseArchiveManifest?.metrics?.operatorHintCount || 0),
      unknownOperatorHintCount: Number(releaseArchiveManifest?.metrics?.unknownOperatorHintCount || 0),
      dashboardWarningCount: Number(releaseArchiveManifest?.metrics?.dashboardWarningCount || 0),
      dashboardBlockerCount: Number(releaseArchiveManifest?.metrics?.dashboardBlockerCount || 0),
      exportStatusBlockerCount: Number(releaseArchiveManifest?.metrics?.exportStatusBlockerCount || 0),
      releaseArchiveWarningCount: manifestWarnings.length,
      validationWarningCount: validationWarnings.length,
      checkCount: checks.length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
    },
    hashes: {
      archiveHash: currentArchiveHash,
      releaseArchiveValidationHash: currentValidationHash,
      verificationHash: releaseArchiveManifest?.hashes?.verificationHash || null,
      releaseVerificationValidationHash: releaseArchiveManifest?.hashes?.releaseVerificationValidationHash || null,
      healthHash: releaseArchiveManifest?.hashes?.healthHash || null,
      releaseHealthValidationHash: releaseArchiveManifest?.hashes?.releaseHealthValidationHash || null,
      gateHash: releaseArchiveManifest?.hashes?.gateHash || null,
      gateValidationHash: releaseArchiveManifest?.hashes?.gateValidationHash || null,
      closeoutSummaryHash: releaseArchiveManifest?.hashes?.closeoutSummaryHash || null,
      closeoutValidationHash: releaseArchiveManifest?.hashes?.closeoutValidationHash || null,
      sampleValidationHash: releaseArchiveManifest?.hashes?.sampleValidationHash || null,
      dashboardSnapshotHash: releaseArchiveManifest?.hashes?.dashboardSnapshotHash || null,
      exportStatusHash: releaseArchiveManifest?.hashes?.exportStatusHash || null,
    },
    artifacts: {
      releaseArchiveReportFiles: releaseArchiveManifest?.artifacts?.releaseArchiveReportFiles || null,
      releaseArchiveCloseoutReportFiles: reportFiles || null,
    },
    checks,
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyReleaseArchiveCloseoutBundle: true,
      dashboardArchiveCloseoutOnly: true,
      localReportOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const archiveCloseoutHash = digest({
    version: bundle.version,
    kind: bundle.kind,
    actor: bundle.actor,
    package: bundle.package,
    status: bundle.status,
    ok: bundle.ok,
    readyForDashboard: bundle.readyForDashboard,
    readyForArchive: bundle.readyForArchive,
    metrics: bundle.metrics,
    hashes: bundle.hashes,
    artifacts: bundle.artifacts,
    checks: bundle.checks,
    blockers: bundle.blockers,
    warnings: bundle.warnings,
    safety: bundle.safety,
  });
  return {
    ...bundle,
    archiveCloseoutHash,
    hash: archiveCloseoutHash,
  };
}

export function summarizeReadOnlyReleaseArchiveCloseoutBundles(bundles = []) {
  const byStatus = {};
  let readyCount = 0;
  let blockedCount = 0;
  for (const bundle of bundles || []) {
    byStatus[bundle.status] = (byStatus[bundle.status] || 0) + 1;
    if (bundle.ok === true || bundle.readyForArchive === true) readyCount += 1;
    if ((bundle.blockers || []).length > 0) blockedCount += 1;
  }
  return {
    version: READ_ONLY_RELEASE_ARCHIVE_CLOSEOUT_VERSION,
    count: bundles.length,
    readyCount,
    blockedCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyReleaseArchiveCloseoutSummary: true,
      executesExternalAction: bundles.some((bundle) => bundle.safety?.executesExternalAction === true),
      fetchesChannelState: bundles.some((bundle) => bundle.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: bundles.some((bundle) => bundle.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: bundles.some((bundle) => bundle.safety?.grantsExecutionPermission === true),
      readyForExecution: bundles.some((bundle) => bundle.safety?.readyForExecution === true),
    }),
  };
}
