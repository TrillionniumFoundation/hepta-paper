import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

/*
 * This is an intentionally separate readiness profile for a single operator
 * running the system on a private host.  It is not a relaxed version of the
 * distribution/release profile: it changes the scope of the claim.  Controls
 * that only protect publication or third-party distribution are explicitly
 * recorded as not applicable, while local provenance, data integrity,
 * credential isolation, and scientific replay remain mandatory.
 */

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const PROFILE_ID = 'personal-self-hosted-v1';
const PROFILE_KIND = 'PersonalSelfHostedProductionProfile';
const MAXIMUM_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

export const PERSONAL_SELF_HOSTED_PROFILE_ID = PROFILE_ID;

export const PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS = Object.freeze([
  'independent-external-authority-roles',
  'hardware-kms-hsm',
  'offhost-worm-custody',
  'venue-portal-live-submission',
  'oci-registry-attestation',
  'kubernetes-release-digest',
].sort());

export const PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS = Object.freeze([
  'exact-code-provenance',
  'formal-operational-zero-skipped',
  'local-author-review-session-separation',
  'credential-and-runtime-boundary',
  'database-inventory-and-schema',
  'database-restore-drill',
  'online-anti-rollback',
  'enabled-scientific-oracles',
  'local-slo-alert-policy',
].sort());

const NOT_APPLICABLE_REASONS = Object.freeze({
  'independent-external-authority-roles':
    'no-external-authority-or-multi-operator-release-claim',
  'hardware-kms-hsm': 'no-distributed-release-signing-key-is-used',
  'offhost-worm-custody': 'private-single-host-scope-with-local-backup-contract',
  'venue-portal-live-submission': 'no-external-submission-or-publishing-action',
  'oci-registry-attestation': 'no-oci-registry-distribution',
  'kubernetes-release-digest': 'no-kubernetes-deployment',
});

const LOCAL_CONTROL_DEFINITIONS = Object.freeze({
  'exact-code-provenance': Object.freeze({
    evidenceKind: 'LocalExactCodeProvenanceEvidence',
    description: 'Clean worktree and exact commit/tree/content binding.',
  }),
  'formal-operational-zero-skipped': Object.freeze({
    evidenceKind: 'LocalFormalOperationalEvidence',
    description: 'Formal operational test receipt has no skipped, failed, or todo tests.',
  }),
  'local-author-review-session-separation': Object.freeze({
    evidenceKind: 'LocalAuthorReviewerSeparationEvidence',
    description: 'Author and reviewer are fresh isolated local sessions, even when one user operates both.',
  }),
  'credential-and-runtime-boundary': Object.freeze({
    evidenceKind: 'LocalCredentialRuntimeBoundaryEvidence',
    description: 'Secrets are absent from artifacts and runtime files are owner-controlled.',
  }),
  'database-inventory-and-schema': Object.freeze({
    evidenceKind: 'LocalDatabaseInventoryEvidence',
    description: 'All declared local databases exist, pass immutable inspection, and match schema contracts.',
  }),
  'database-restore-drill': Object.freeze({
    evidenceKind: 'LocalDatabaseRestoreEvidence',
    description: 'A local restore drill was executed and its receipt is current.',
  }),
  'online-anti-rollback': Object.freeze({
    evidenceKind: 'LocalOnlineAntiRollbackEvidence',
    description: 'Online mutation markers and the local integrity pin prevent rollback/equivocation.',
  }),
  'enabled-scientific-oracles': Object.freeze({
    evidenceKind: 'LocalScientificOracleEvidence',
    description: 'Every enabled CPU/GPU scientific capability has deterministic replay and an error budget.',
  }),
  'local-slo-alert-policy': Object.freeze({
    evidenceKind: 'LocalSloAlertEvidence',
    description: 'Local runtime SLOs and missing-data alerts are configured and exercised.',
  }),
});

const PROFILE_SCOPE = Object.freeze({
  operatorCardinality: 'single-user',
  distributionMode: 'private-local-only',
  commercialDistribution: false,
  externalActions: false,
});

const PROFILE_PAYLOAD = Object.freeze({
  version: 1,
  kind: PROFILE_KIND,
  profileId: PROFILE_ID,
  scope: PROFILE_SCOPE,
  notApplicableControls: Object.freeze(PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS.map(
    (controlId) => Object.freeze({
      controlId,
      reason: NOT_APPLICABLE_REASONS[controlId],
    }),
  )),
  requiredLocalControls: Object.freeze(PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS.map(
    (controlId) => Object.freeze({
      controlId,
      evidenceKind: LOCAL_CONTROL_DEFINITIONS[controlId].evidenceKind,
      description: LOCAL_CONTROL_DEFINITIONS[controlId].description,
    }),
  )),
  scientificCapabilities: Object.freeze({
    cpu: Object.freeze({
      defaultEnabled: true,
      requiredEvidence: Object.freeze([
        'deterministic-replay', 'error-budget', 'model-data-checkpoint-ir',
      ]),
    }),
    gpu: Object.freeze({
      defaultEnabled: false,
      optInEnvironment: 'HEPTA_PERSONAL_GPU_ENABLED',
      requiredEvidence: Object.freeze([
        'same-device-replay', 'deterministic-replay',
        'error-budget', 'model-data-checkpoint-ir',
      ]),
    }),
  }),
  prohibitedActions: Object.freeze([
    'external-submission',
    'publication-claim',
    'multi-operator-release',
    'distribution-from-personal-profile',
  ]),
});

export const PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE = Object.freeze({
  ...PROFILE_PAYLOAD,
  profileHash: hashRecord(PROFILE_KIND, PROFILE_PAYLOAD),
});

function canonicalInstant(value) {
  const selected = String(value || '');
  const milliseconds = Date.parse(selected);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === selected
    ? selected : null;
}

function exactArray(value, predicate) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every(predicate);
}

function profilePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { profileHash: _profileHash, ...payload } = value;
  return payload;
}

function validProfileShape(value) {
  if (!hasExactObjectKeys(value, [
    'kind', 'notApplicableControls', 'profileHash', 'profileId',
    'prohibitedActions', 'requiredLocalControls', 'scope',
    'scientificCapabilities', 'version',
  ]) || value.version !== 1 || value.kind !== PROFILE_KIND
    || value.profileId !== PROFILE_ID || !SHA256.test(String(value.profileHash || ''))
    || !hasExactObjectKeys(value.scope, [
      'commercialDistribution', 'distributionMode', 'externalActions', 'operatorCardinality',
    ])
    || value.scope.operatorCardinality !== 'single-user'
    || value.scope.distributionMode !== 'private-local-only'
    || value.scope.commercialDistribution !== false
    || value.scope.externalActions !== false
    || !exactArray(value.prohibitedActions, (item) => typeof item === 'string' && item.length > 0)
    || !hasExactObjectKeys(value.scientificCapabilities, ['cpu', 'gpu'])) return false;
  const validNa = (item) => hasExactObjectKeys(item, ['controlId', 'reason'])
    && PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS.includes(item.controlId)
    && item.reason === NOT_APPLICABLE_REASONS[item.controlId];
  const validLocal = (item) => hasExactObjectKeys(item, ['controlId', 'description', 'evidenceKind'])
    && PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS.includes(item.controlId)
    && item.evidenceKind === LOCAL_CONTROL_DEFINITIONS[item.controlId].evidenceKind
    && item.description === LOCAL_CONTROL_DEFINITIONS[item.controlId].description;
  const validScientific = (item, capability) => hasExactObjectKeys(item, [
    'defaultEnabled', 'requiredEvidence', ...(capability === 'gpu' ? ['optInEnvironment'] : []),
  ])
    && typeof item.defaultEnabled === 'boolean'
    && (capability === 'cpu' || item.optInEnvironment === 'HEPTA_PERSONAL_GPU_ENABLED')
    && exactArray(item.requiredEvidence, (entry) => typeof entry === 'string' && entry.length > 0);
  return exactArray(value.notApplicableControls, validNa)
    && JSON.stringify(value.notApplicableControls.map((item) => item.controlId).sort())
      === JSON.stringify(PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS)
    && exactArray(value.requiredLocalControls, validLocal)
    && JSON.stringify(value.requiredLocalControls.map((item) => item.controlId).sort())
      === JSON.stringify(PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS)
    && validScientific(value.scientificCapabilities.cpu, 'cpu')
    && validScientific(value.scientificCapabilities.gpu, 'gpu');
}

export function verifyPersonalSelfHostedProductionProfile(value) {
  if (!validProfileShape(value)) return false;
  const payload = profilePayload(value);
  return hashRecord(PROFILE_KIND, payload) === value.profileHash;
}

function validHash(value) {
  return SHA256.test(String(value || ''));
}

function controlEvidence(value, controlId, nowMs) {
  const definition = LOCAL_CONTROL_DEFINITIONS[controlId];
  if (!definition || !value || typeof value !== 'object' || Array.isArray(value)
    || !hasExactObjectKeys(value, ['details', 'evidenceHash', 'observedAt', 'source', 'status'])
    || value.status !== 'verified'
    || value.source !== 'local-observation'
    || !validHash(value.evidenceHash)) {
    return `personal_self_hosted_control_not_verified:${controlId}`;
  }
  const { evidenceHash, ...evidencePayload } = value;
  if (hashRecord('PersonalSelfHostedLocalEvidence', evidencePayload) !== evidenceHash) {
    return `personal_self_hosted_control_evidence_hash_invalid:${controlId}`;
  }
  const observedAt = canonicalInstant(value.observedAt);
  if (!observedAt || nowMs - Date.parse(observedAt) > MAXIMUM_EVIDENCE_AGE_MS
    || Date.parse(observedAt) > nowMs) {
    return `personal_self_hosted_control_evidence_stale:${controlId}`;
  }
  const details = value.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return `personal_self_hosted_control_details_missing:${controlId}`;
  }
  const requirements = {
    'exact-code-provenance': details.clean === true
      && GIT_OBJECT_ID.test(String(details.commit || ''))
      && GIT_OBJECT_ID.test(String(details.commitTree || ''))
      && validHash(details.repositoryContentHash),
    'formal-operational-zero-skipped': details.zeroSkipped === true
      && Number(details.pass) > 0 && details.fail === 0 && details.skipped === 0
      && details.todo === 0 && GIT_OBJECT_ID.test(String(details.commit || '')),
    'local-author-review-session-separation': details.freshSessionSeparationVerified === true
      && validHash(details.authorSessionHash) && validHash(details.reviewerSessionHash)
      && details.authorSessionHash !== details.reviewerSessionHash,
    'credential-and-runtime-boundary': details.privateKeyMaterialAbsent === true
      && details.secretLeakScanPassed === true && details.runtimeOwnerOnly === true,
    'database-inventory-and-schema': details.inventoryReady === true
      && Number(details.databaseCount) > 0 && Number(details.databaseCount)
        === Number(details.databaseReadyCount),
    'database-restore-drill': details.restoreDrillReady === true
      && validHash(details.restoreReceiptHash),
    'online-anti-rollback': details.antiRollbackReady === true
      && validHash(details.integrityPinHash),
    'enabled-scientific-oracles': details.enabledCapabilitiesReady === true
      && Array.isArray(details.enabledCapabilities)
      && details.enabledCapabilities.includes('cpu'),
    'local-slo-alert-policy': details.alertPolicyConfigured === true
      && details.missingDataAlertsExercised === true,
  }[controlId];
  return requirements
    ? null : `personal_self_hosted_control_requirement_not_met:${controlId}`;
}

function evaluateScientific({ scientific, nowMs }) {
  const blockers = [];
  if (!scientific || typeof scientific !== 'object' || Array.isArray(scientific)
    || !Array.isArray(scientific.enabledCapabilities)
    || !scientific.enabledCapabilities.includes('cpu')
    || scientific.enabledCapabilities.some((item) => !['cpu', 'gpu'].includes(item))) {
    return ['personal_self_hosted_scientific_capability_declaration_invalid'];
  }
  const cpu = scientific.cpu;
  if (!cpu || cpu.status !== 'verified' || cpu.deterministicReplay !== true
    || cpu.errorBudgetVerified !== true || cpu.modelDataCheckpointIrBound !== true
    || !validHash(cpu.evidenceHash) || !canonicalInstant(cpu.observedAt)
    || nowMs - Date.parse(cpu.observedAt) > MAXIMUM_EVIDENCE_AGE_MS) {
    blockers.push('personal_self_hosted_cpu_oracle_not_ready');
  }
  const gpuEnabled = scientific.enabledCapabilities.includes('gpu');
  const gpu = scientific.gpu;
  if (gpuEnabled) {
    if (!gpu || gpu.enabled !== true || gpu.status !== 'verified'
      || gpu.deterministicReplay !== true || gpu.sameDeviceReplay !== true
      || gpu.errorBudgetVerified !== true
      || gpu.modelDataCheckpointIrBound !== true || !validHash(gpu.evidenceHash)
      || !canonicalInstant(gpu.observedAt)
      || nowMs - Date.parse(gpu.observedAt) > MAXIMUM_EVIDENCE_AGE_MS) {
      blockers.push('personal_self_hosted_gpu_oracle_not_ready');
    }
  } else if (!gpu || gpu.enabled !== false
    || typeof gpu.disabledReason !== 'string' || gpu.disabledReason.trim().length < 8) {
    blockers.push('personal_self_hosted_gpu_disabled_reason_required');
  }
  return blockers;
}

export function evaluatePersonalSelfHostedProductionReadiness({
  profile = PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE,
  controls,
  scientific,
  externalControls,
  externalActionsPerformed = false,
  observedAt,
} = {}) {
  if (!verifyPersonalSelfHostedProductionProfile(profile)) {
    throw new Error('personal_self_hosted_profile_invalid');
  }
  const observed = canonicalInstant(observedAt);
  if (!observed) throw new Error('personal_self_hosted_observation_time_invalid');
  const nowMs = Date.parse(observed);
  const blockers = [];
  const controlResults = {};
  for (const definition of profile.requiredLocalControls) {
    const observedControl = controls?.[definition.controlId];
    const blocker = controlEvidence(observedControl, definition.controlId, nowMs);
    controlResults[definition.controlId] = Object.freeze({
      status: blocker ? 'blocked' : 'verified',
      blocker,
      evidenceHash: observedControl?.evidenceHash || null,
      observedAt: observedControl?.observedAt || null,
      details: observedControl?.details || null,
    });
    if (blocker) blockers.push(blocker);
  }
  for (const definition of profile.notApplicableControls) {
    const value = externalControls?.[definition.controlId];
    if (!value || value.status !== 'not_applicable' || value.reason !== definition.reason) {
      blockers.push(`personal_self_hosted_not_applicable_control_unacknowledged:${definition.controlId}`);
    }
  }
  blockers.push(...evaluateScientific({ profile, scientific, nowMs }));
  if (externalActionsPerformed !== false) blockers.push('personal_self_hosted_external_action_forbidden');
  const uniqueBlockers = [...new Set(blockers)].sort();
  const ready = uniqueBlockers.length === 0;
  const payload = Object.freeze({
    version: 1,
    kind: 'PersonalSelfHostedProductionReadiness',
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    status: ready
      ? 'personal_self_hosted_production_ready'
      : 'personal_self_hosted_production_blocked',
    productionScope: 'single-user-private-local-only',
    distributionReady: false,
    externalQualificationRequired: false,
    externalActionsPerformed: false,
    observedAt: observed,
    notApplicableControls: profile.notApplicableControls,
    controlResults: Object.freeze(controlResults),
    scientificCapabilities: scientific,
    blockers: Object.freeze(uniqueBlockers),
  });
  return Object.freeze({
    ...payload,
    personalSelfHostedProductionReadinessHash:
      hashRecord('PersonalSelfHostedProductionReadiness', payload),
  });
}

export const PERSONAL_SELF_HOSTED_PROFILE_CONSTANTS = Object.freeze({
  maxEvidenceAgeMs: MAXIMUM_EVIDENCE_AGE_MS,
  notApplicableReasons: NOT_APPLICABLE_REASONS,
  localControlDefinitions: LOCAL_CONTROL_DEFINITIONS,
});
