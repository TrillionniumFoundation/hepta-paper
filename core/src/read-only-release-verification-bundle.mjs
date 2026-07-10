import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_RELEASE_VERIFICATION_VERSION = 1;

export const READ_ONLY_RELEASE_VERIFICATION_STATUS = Object.freeze({
  READY: 'ready_readonly_release_verification',
  BLOCKED: 'blocked_readonly_release_verification',
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

export function buildReadOnlyReleaseVerificationBundle({
  releaseHealthManifest = null,
  releaseHealthValidation = null,
  packageName = 'design-production-core',
  packageVersion = '0.0.0',
  actor = 'design-production-core.readonly-release-verification',
  generatedAt = null,
  reportFiles = null,
  readErrors = [],
} = {}) {
  const blockers = [];
  const warnings = [];

  for (const readError of readErrors || []) {
    if (readError) blockers.push(issue('release_verification_input_read_failed', readError));
  }

  if (!releaseHealthManifest || typeof releaseHealthManifest !== 'object' || Array.isArray(releaseHealthManifest)) {
    blockers.push(issue('release_health_manifest_missing', 'Release verification requires a release health manifest.'));
  } else if (releaseHealthManifest.ok !== true || releaseHealthManifest.status !== 'ready_readonly_release_health') {
    blockers.push(issue('release_health_manifest_not_ready', releaseHealthManifest.status));
  }

  if (!releaseHealthValidation || typeof releaseHealthValidation !== 'object' || Array.isArray(releaseHealthValidation)) {
    blockers.push(issue('release_health_validation_missing', 'Release verification requires a release health validation report.'));
  } else if (releaseHealthValidation.ok !== true || releaseHealthValidation.status !== 'pass_readonly_release_health_validation') {
    blockers.push(issue('release_health_validation_not_ok', releaseHealthValidation.status));
  }

  const currentHealthHash = requiredSemanticHash(
    blockers,
    releaseHealthManifest,
    'healthHash',
    'release_verification_health_hash_alias_required',
    'release_verification_health_generic_hash_required',
    'release_verification_health_hash_alias_mismatch',
    'Release health manifest',
  );
  const currentValidationHash = requiredSemanticHash(
    blockers,
    releaseHealthValidation,
    'validationHash',
    'release_verification_validation_hash_alias_required',
    'release_verification_validation_generic_hash_required',
    'release_verification_validation_hash_alias_mismatch',
    'Release health validation',
  );
  const validationHealthHash = releaseHealthValidation?.hashChecks?.healthHash || null;
  const validationRecomputedHealthHash = releaseHealthValidation?.hashChecks?.recomputedHealthHash || null;
  requireHash(blockers, currentHealthHash, 'release_verification_health_hash_missing', 'Release verification requires the source release health hash.');
  requireHash(blockers, currentValidationHash, 'release_verification_validation_hash_missing', 'Release verification requires the release health validation report hash.');
  requireHash(blockers, validationHealthHash, 'release_verification_validation_health_hash_missing', 'Release health validation must bind the source release health hash.');
  requireHash(blockers, validationRecomputedHealthHash, 'release_verification_validation_recomputed_health_hash_missing', 'Release health validation must carry the recomputed release health hash.');
  if (currentHealthHash && validationHealthHash && currentHealthHash !== validationHealthHash) {
    blockers.push(issue('release_verification_health_hash_mismatch', `manifest ${currentHealthHash} != validation ${validationHealthHash}.`));
  }
  if (currentHealthHash && validationRecomputedHealthHash && currentHealthHash !== validationRecomputedHealthHash) {
    blockers.push(issue('release_verification_recomputed_health_hash_mismatch', `manifest ${currentHealthHash} != recomputed ${validationRecomputedHealthHash}.`));
  }

  const hashFields = [
    'gateHash',
    'gateValidationHash',
    'closeoutSummaryHash',
    'closeoutValidationHash',
    'sampleValidationHash',
    'dashboardSnapshotHash',
    'exportStatusHash',
  ];
  for (const key of hashFields) {
    const manifestHash = releaseHealthManifest?.hashes?.[key] || null;
    const validationCheckHash = releaseHealthValidation?.hashChecks?.[key] || null;
    if (!manifestHash) {
      blockers.push(issue('release_verification_manifest_hash_missing', `Release health manifest must bind ${key}.`));
    } else if (!validationCheckHash) {
      blockers.push(issue('release_verification_validation_hash_check_missing', `Release health validation must bind ${key}.`));
    } else if (manifestHash !== validationCheckHash) {
      blockers.push(issue('release_verification_hash_chain_mismatch', `${key}: manifest ${manifestHash} != validation ${validationCheckHash}.`));
    }
  }

  const unsafePaths = unsafeSafetyPaths([
    { path: 'releaseHealthManifest', record: releaseHealthManifest },
    { path: 'releaseHealthManifest.safety', record: releaseHealthManifest?.safety },
    { path: 'releaseHealthValidation', record: releaseHealthValidation },
    { path: 'releaseHealthValidation.safety', record: releaseHealthValidation?.safety },
  ]);
  if (unsafePaths.length > 0) {
    blockers.push(issue('readonly_release_verification_claims_external_action', `Unsafe claims: ${unsafePaths.join(', ')}.`));
  }

  const manifestWarnings = Array.isArray(releaseHealthManifest?.warnings) ? releaseHealthManifest.warnings : [];
  const validationWarnings = Array.isArray(releaseHealthValidation?.warnings) ? releaseHealthValidation.warnings : [];
  if (manifestWarnings.length > 0) {
    warnings.push(issue('release_health_warnings_present', `${manifestWarnings.length} release health warnings are present.`, 'warning'));
  }
  if (validationWarnings.length > 0) {
    warnings.push(issue('release_health_validation_warnings_present', `${validationWarnings.length} release health validation warnings are present.`, 'warning'));
  }

  const checks = [
    check('release_health_manifest_ready', releaseHealthManifest?.ok === true, releaseHealthManifest?.status, currentHealthHash),
    check('release_health_validation_passed', releaseHealthValidation?.ok === true, releaseHealthValidation?.status, currentValidationHash),
    check('health_hash_bound', currentHealthHash && currentHealthHash === validationHealthHash, null, currentHealthHash),
    check('recomputed_health_hash_bound', currentHealthHash && currentHealthHash === validationRecomputedHealthHash, null, validationRecomputedHealthHash),
  ];

  const status = blockers.length
    ? READ_ONLY_RELEASE_VERIFICATION_STATUS.BLOCKED
    : READ_ONLY_RELEASE_VERIFICATION_STATUS.READY;

  const bundle = {
    version: READ_ONLY_RELEASE_VERIFICATION_VERSION,
    kind: 'ReadOnlyReleaseVerificationBundle',
    actor: normalizeText(actor) || 'design-production-core.readonly-release-verification',
    package: {
      name: normalizeText(packageName) || releaseHealthManifest?.package?.name || 'design-production-core',
      version: normalizeText(packageVersion) || releaseHealthManifest?.package?.version || '0.0.0',
    },
    status,
    ok: status === READ_ONLY_RELEASE_VERIFICATION_STATUS.READY,
    readyForDashboard: status === READ_ONLY_RELEASE_VERIFICATION_STATUS.READY,
    metrics: {
      gateStepCount: Number(releaseHealthManifest?.metrics?.gateStepCount || 0),
      failedStepCount: Number(releaseHealthManifest?.metrics?.failedStepCount || 0),
      sourceFileCount: Number(releaseHealthManifest?.metrics?.sourceFileCount || 0),
      fixtureFileCount: Number(releaseHealthManifest?.metrics?.fixtureFileCount || 0),
      publicApiModules: Number(releaseHealthManifest?.metrics?.publicApiModules || 0),
      sampleCount: Number(releaseHealthManifest?.metrics?.sampleCount || 0),
      dispatchTotalHandoffs: Number(releaseHealthManifest?.metrics?.dispatchTotalHandoffs || 0),
      dispatchReadyHandoffs: Number(releaseHealthManifest?.metrics?.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(releaseHealthManifest?.metrics?.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(releaseHealthManifest?.metrics?.dispatchApprovalProvenanceBoundHandoffs || 0),
      operatorHintCount: Number(releaseHealthManifest?.metrics?.operatorHintCount || 0),
      unknownOperatorHintCount: Number(releaseHealthManifest?.metrics?.unknownOperatorHintCount || 0),
      dashboardWarningCount: Number(releaseHealthManifest?.metrics?.dashboardWarningCount || 0),
      dashboardBlockerCount: Number(releaseHealthManifest?.metrics?.dashboardBlockerCount || 0),
      exportStatusBlockerCount: Number(releaseHealthManifest?.metrics?.exportStatusBlockerCount || 0),
      releaseHealthWarningCount: manifestWarnings.length,
      validationWarningCount: validationWarnings.length,
      checkCount: checks.length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
    },
    hashes: {
      healthHash: currentHealthHash,
      releaseHealthValidationHash: currentValidationHash,
      gateHash: releaseHealthManifest?.hashes?.gateHash || null,
      gateValidationHash: releaseHealthManifest?.hashes?.gateValidationHash || null,
      closeoutSummaryHash: releaseHealthManifest?.hashes?.closeoutSummaryHash || null,
      closeoutValidationHash: releaseHealthManifest?.hashes?.closeoutValidationHash || null,
      sampleValidationHash: releaseHealthManifest?.hashes?.sampleValidationHash || null,
      dashboardSnapshotHash: releaseHealthManifest?.hashes?.dashboardSnapshotHash || null,
      exportStatusHash: releaseHealthManifest?.hashes?.exportStatusHash || null,
    },
    artifacts: {
      releaseHealthReportFiles: releaseHealthManifest?.artifacts?.releaseHealthReportFiles || null,
      releaseVerificationReportFiles: reportFiles || null,
    },
    checks,
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlyReleaseVerificationBundle: true,
      dashboardVerificationOnly: true,
      localReportOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const verificationHash = digest({
    version: bundle.version,
    kind: bundle.kind,
    actor: bundle.actor,
    package: bundle.package,
    status: bundle.status,
    ok: bundle.ok,
    readyForDashboard: bundle.readyForDashboard,
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
    verificationHash,
    hash: verificationHash,
  };
}

export function summarizeReadOnlyReleaseVerificationBundles(bundles = []) {
  const byStatus = {};
  let readyCount = 0;
  let blockedCount = 0;
  for (const bundle of bundles || []) {
    byStatus[bundle.status] = (byStatus[bundle.status] || 0) + 1;
    if (bundle.ok === true || bundle.readyForDashboard === true) readyCount += 1;
    if ((bundle.blockers || []).length > 0) blockedCount += 1;
  }
  return {
    version: READ_ONLY_RELEASE_VERIFICATION_VERSION,
    count: bundles.length,
    readyCount,
    blockedCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlyReleaseVerificationSummary: true,
      executesExternalAction: bundles.some((bundle) => bundle.safety?.executesExternalAction === true),
      fetchesChannelState: bundles.some((bundle) => bundle.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: bundles.some((bundle) => bundle.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: bundles.some((bundle) => bundle.safety?.grantsExecutionPermission === true),
      readyForExecution: bundles.some((bundle) => bundle.safety?.readyForExecution === true),
    }),
  };
}
