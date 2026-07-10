import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_RELEASE_ARCHIVE_VERSION = 1;

export const READ_ONLY_RELEASE_ARCHIVE_STATUS = Object.freeze({
  READY: 'ready_readonly_release_archive',
  BLOCKED: 'blocked_readonly_release_archive',
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

export function buildReadOnlyReleaseArchiveManifest({
  releaseVerificationBundle = null,
  releaseVerificationValidation = null,
  packageName = 'design-production-core',
  packageVersion = '0.0.0',
  actor = 'design-production-core.readonly-release-archive',
  generatedAt = null,
  reportFiles = null,
  readErrors = [],
} = {}) {
  const blockers = [];
  const warnings = [];

  for (const readError of readErrors || []) {
    if (readError) blockers.push(issue('release_archive_input_read_failed', readError));
  }

  if (!releaseVerificationBundle || typeof releaseVerificationBundle !== 'object' || Array.isArray(releaseVerificationBundle)) {
    blockers.push(issue('release_verification_bundle_missing', 'Release archive requires a release verification bundle.'));
  } else if (releaseVerificationBundle.ok !== true || releaseVerificationBundle.status !== 'ready_readonly_release_verification') {
    blockers.push(issue('release_verification_bundle_not_ready', releaseVerificationBundle.status));
  }

  if (!releaseVerificationValidation || typeof releaseVerificationValidation !== 'object' || Array.isArray(releaseVerificationValidation)) {
    blockers.push(issue('release_verification_validation_missing', 'Release archive requires a release verification validation report.'));
  } else if (releaseVerificationValidation.ok !== true || releaseVerificationValidation.status !== 'pass_readonly_release_verification_validation') {
    blockers.push(issue('release_verification_validation_not_ok', releaseVerificationValidation.status));
  }

  const currentVerificationHash = requiredSemanticHash(
    blockers,
    releaseVerificationBundle,
    'verificationHash',
    'release_archive_verification_hash_alias_required',
    'release_archive_verification_generic_hash_required',
    'release_archive_verification_hash_alias_mismatch',
    'Release verification bundle',
  );
  const currentValidationHash = requiredSemanticHash(
    blockers,
    releaseVerificationValidation,
    'validationHash',
    'release_archive_validation_hash_alias_required',
    'release_archive_validation_generic_hash_required',
    'release_archive_validation_hash_alias_mismatch',
    'Release verification validation',
  );
  const validationVerificationHash = releaseVerificationValidation?.hashChecks?.verificationHash || null;
  const validationRecomputedVerificationHash = releaseVerificationValidation?.hashChecks?.recomputedVerificationHash || null;
  requireHash(blockers, currentVerificationHash, 'release_archive_verification_hash_missing', 'Release archive requires the source release verification hash.');
  requireHash(blockers, currentValidationHash, 'release_archive_validation_hash_missing', 'Release archive requires the release verification validation report hash.');
  requireHash(blockers, validationVerificationHash, 'release_archive_validation_verification_hash_missing', 'Release verification validation must bind the source verification hash.');
  requireHash(blockers, validationRecomputedVerificationHash, 'release_archive_validation_recomputed_verification_hash_missing', 'Release verification validation must carry the recomputed verification hash.');
  if (currentVerificationHash && validationVerificationHash && currentVerificationHash !== validationVerificationHash) {
    blockers.push(issue('release_archive_verification_hash_mismatch', `verification ${currentVerificationHash} != validation ${validationVerificationHash}.`));
  }
  if (currentVerificationHash && validationRecomputedVerificationHash && currentVerificationHash !== validationRecomputedVerificationHash) {
    blockers.push(issue('release_archive_recomputed_verification_hash_mismatch', `verification ${currentVerificationHash} != recomputed ${validationRecomputedVerificationHash}.`));
  }

  const hashFields = [
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
    const bundleHash = releaseVerificationBundle?.hashes?.[key] || null;
    const validationCheckHash = releaseVerificationValidation?.hashChecks?.[key] || null;
    if (!bundleHash) {
      blockers.push(issue('release_archive_bundle_hash_missing', `Release verification bundle must bind ${key}.`));
    } else if (!validationCheckHash) {
      blockers.push(issue('release_archive_validation_hash_check_missing', `Release verification validation must bind ${key}.`));
    } else if (bundleHash !== validationCheckHash) {
      blockers.push(issue('release_archive_hash_chain_mismatch', `${key}: verification ${bundleHash} != validation ${validationCheckHash}.`));
    }
  }

  const unsafePaths = unsafeSafetyPaths([
    { path: 'releaseVerificationBundle', record: releaseVerificationBundle },
    { path: 'releaseVerificationBundle.safety', record: releaseVerificationBundle?.safety },
    { path: 'releaseVerificationValidation', record: releaseVerificationValidation },
    { path: 'releaseVerificationValidation.safety', record: releaseVerificationValidation?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_release_archive_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  const bundleWarnings = Array.isArray(releaseVerificationBundle?.warnings) ? releaseVerificationBundle.warnings : [];
  const validationWarnings = Array.isArray(releaseVerificationValidation?.warnings) ? releaseVerificationValidation.warnings : [];
  if (bundleWarnings.length > 0) {
    warnings.push(issue('release_verification_warnings_present', `${bundleWarnings.length} release verification warnings are present.`, 'warning'));
  }
  if (validationWarnings.length > 0) {
    warnings.push(issue('release_verification_validation_warnings_present', `${validationWarnings.length} release verification validation warnings are present.`, 'warning'));
  }

  const checks = [
    check('release_verification_ready', releaseVerificationBundle?.ok === true, releaseVerificationBundle?.status, currentVerificationHash),
    check('release_verification_validation_passed', releaseVerificationValidation?.ok === true, releaseVerificationValidation?.status, currentValidationHash),
    check('verification_hash_bound', currentVerificationHash && currentVerificationHash === validationVerificationHash, null, currentVerificationHash),
    check('recomputed_verification_hash_bound', currentVerificationHash && currentVerificationHash === validationRecomputedVerificationHash, null, validationRecomputedVerificationHash),
  ];

  const status = blockers.length
    ? READ_ONLY_RELEASE_ARCHIVE_STATUS.BLOCKED
    : READ_ONLY_RELEASE_ARCHIVE_STATUS.READY;

  const manifest = {
    version: READ_ONLY_RELEASE_ARCHIVE_VERSION,
    kind: 'ReadOnlyReleaseArchiveManifest',
    actor: normalizeText(actor) || 'design-production-core.readonly-release-archive',
    package: {
      name: normalizeText(packageName) || releaseVerificationBundle?.package?.name || 'design-production-core',
      version: normalizeText(packageVersion) || releaseVerificationBundle?.package?.version || '0.0.0',
    },
    status,
    ok: status === READ_ONLY_RELEASE_ARCHIVE_STATUS.READY,
    readyForDashboard: status === READ_ONLY_RELEASE_ARCHIVE_STATUS.READY,
    readyForArchive: status === READ_ONLY_RELEASE_ARCHIVE_STATUS.READY,
    metrics: {
      gateStepCount: Number(releaseVerificationBundle?.metrics?.gateStepCount || 0),
      failedStepCount: Number(releaseVerificationBundle?.metrics?.failedStepCount || 0),
      sourceFileCount: Number(releaseVerificationBundle?.metrics?.sourceFileCount || 0),
      fixtureFileCount: Number(releaseVerificationBundle?.metrics?.fixtureFileCount || 0),
      publicApiModules: Number(releaseVerificationBundle?.metrics?.publicApiModules || 0),
      sampleCount: Number(releaseVerificationBundle?.metrics?.sampleCount || 0),
      dispatchTotalHandoffs: Number(releaseVerificationBundle?.metrics?.dispatchTotalHandoffs || 0),
      dispatchReadyHandoffs: Number(releaseVerificationBundle?.metrics?.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(releaseVerificationBundle?.metrics?.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(releaseVerificationBundle?.metrics?.dispatchApprovalProvenanceBoundHandoffs || 0),
      operatorHintCount: Number(releaseVerificationBundle?.metrics?.operatorHintCount || 0),
      unknownOperatorHintCount: Number(releaseVerificationBundle?.metrics?.unknownOperatorHintCount || 0),
      dashboardWarningCount: Number(releaseVerificationBundle?.metrics?.dashboardWarningCount || 0),
      dashboardBlockerCount: Number(releaseVerificationBundle?.metrics?.dashboardBlockerCount || 0),
      exportStatusBlockerCount: Number(releaseVerificationBundle?.metrics?.exportStatusBlockerCount || 0),
      releaseVerificationWarningCount: bundleWarnings.length,
      validationWarningCount: validationWarnings.length,
      checkCount: checks.length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
    },
    hashes: {
      verificationHash: currentVerificationHash,
      releaseVerificationValidationHash: currentValidationHash,
      healthHash: releaseVerificationBundle?.hashes?.healthHash || null,
      releaseHealthValidationHash: releaseVerificationBundle?.hashes?.releaseHealthValidationHash || null,
      gateHash: releaseVerificationBundle?.hashes?.gateHash || null,
      gateValidationHash: releaseVerificationBundle?.hashes?.gateValidationHash || null,
      closeoutSummaryHash: releaseVerificationBundle?.hashes?.closeoutSummaryHash || null,
      closeoutValidationHash: releaseVerificationBundle?.hashes?.closeoutValidationHash || null,
      sampleValidationHash: releaseVerificationBundle?.hashes?.sampleValidationHash || null,
      dashboardSnapshotHash: releaseVerificationBundle?.hashes?.dashboardSnapshotHash || null,
      exportStatusHash: releaseVerificationBundle?.hashes?.exportStatusHash || null,
    },
    artifacts: {
      releaseVerificationReportFiles: releaseVerificationBundle?.artifacts?.releaseVerificationReportFiles || null,
      releaseArchiveReportFiles: reportFiles || null,
    },
    checks,
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyReleaseArchiveManifest: true,
      archiveManifestOnly: true,
      localReportOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const archiveHash = digest({
    version: manifest.version,
    kind: manifest.kind,
    actor: manifest.actor,
    package: manifest.package,
    status: manifest.status,
    ok: manifest.ok,
    readyForDashboard: manifest.readyForDashboard,
    readyForArchive: manifest.readyForArchive,
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
    archiveHash,
    hash: archiveHash,
  };
}

export function summarizeReadOnlyReleaseArchiveManifests(manifests = []) {
  const byStatus = {};
  let readyCount = 0;
  let blockedCount = 0;
  for (const manifest of manifests || []) {
    byStatus[manifest.status] = (byStatus[manifest.status] || 0) + 1;
    if (manifest.ok === true || manifest.readyForArchive === true) readyCount += 1;
    if ((manifest.blockers || []).length > 0) blockedCount += 1;
  }
  return {
    version: READ_ONLY_RELEASE_ARCHIVE_VERSION,
    count: manifests.length,
    readyCount,
    blockedCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyReleaseArchiveSummary: true,
      executesExternalAction: manifests.some((manifest) => manifest.safety?.executesExternalAction === true),
      fetchesChannelState: manifests.some((manifest) => manifest.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: manifests.some((manifest) => manifest.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: manifests.some((manifest) => manifest.safety?.grantsExecutionPermission === true),
      readyForExecution: manifests.some((manifest) => manifest.safety?.readyForExecution === true),
    }),
  };
}
