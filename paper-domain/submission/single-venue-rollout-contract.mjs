import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  getJournalSubmissionTargetProfile,
} from './journal-submission-target-registry.mjs';
import {
  getSubmissionConnectorFamily,
} from './submission-connector-family-registry.mjs';

/*
 * A rollout plan is deliberately narrower than a portal qualification
 * registry.  The registry may describe many candidates; this record is the
 * cut-over fence for exactly one target.  It is safe to persist and exchange
 * without putting a portal token, cookie, private key, or authorization
 * document in the plan.  A separate authority verifier must validate the
 * human receipt before a live-commit permit can be built.
 */

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const MAXIMUM_PLAN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAXIMUM_PERMIT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN_CREDENTIAL_KEY = /(?:token|secret|password|private.?key|credential|cookie|api.?key|authorization.?header)/i;

export const SINGLE_VENUE_ROLLOUT_OPERATIONS = Object.freeze([
  'createDraft',
  'discoverProfile',
  'fillMetadata',
  'getReceipt',
  'getStatus',
  'preview',
  'reconcile',
  'uploadAssets',
  'validate',
]);

const PLAN_KEYS = Object.freeze([
  'attestationHashes',
  'baseTargetProfileHash',
  'connectorFamily',
  'enabledOperations',
  'expiresAt',
  'externalActionPerformed',
  'generation',
  'humanSingleUseAuthorizationRequired',
  'issuedAt',
  'kind',
  'liveCommitAuthorized',
  'liveCommitEnabled',
  'manualAuthorizationScope',
  'portalBindingHash',
  'portalConfigurationHash',
  'portalDescriptorHash',
  'portalOriginHash',
  'predecessorPlanHash',
  'productionQualified',
  'rollbackRequired',
  'rollbackWindowExpiresAt',
  'rolloutId',
  'sandboxCanaryEvidenceHash',
  'sandboxCanaryExternalActionPerformed',
  'singleVenueConstraint',
  'status',
  'targetInstanceId',
  'venueId',
  'version',
]);

const PERMIT_KEYS = Object.freeze([
  'authorizationReceiptHash',
  'authorizationSubjectHash',
  'authorizationVerifierEvidenceHash',
  'authorizerSubjectIds',
  'consumed',
  'expiresAt',
  'externalActionPerformed',
  'issuedAt',
  'kind',
  'manualAuthorizationScope',
  'nonce',
  'planHash',
  'rollbackPlanHash',
  'singleUse',
  'status',
  'targetInstanceId',
  'venueId',
  'version',
]);

const CONSUMPTION_KEYS = Object.freeze([
  'authorizationReceiptHash',
  'consumed',
  'consumedAt',
  'externalActionPerformed',
  'kind',
  'manualAuthorizationScope',
  'nonce',
  'permitHash',
  'planHash',
  'rollbackPlanHash',
  'sideEffectReservationRequired',
  'status',
  'targetInstanceId',
  'venueId',
  'version',
]);

const ROLLBACK_REQUEST_KEYS = Object.freeze([
  'externalActionPerformed',
  'kind',
  'planHash',
  'reason',
  'requestedAt',
  'requestedBy',
  'rollbackTargetPlanHash',
  'status',
  'targetInstanceId',
  'venueId',
  'version',
]);

const ROLLBACK_RECEIPT_KEYS = Object.freeze([
  'appliedAt',
  'externalActionPerformed',
  'kind',
  'planHash',
  'reason',
  'requestedAt',
  'requestedBy',
  'resultingPlanHash',
  'rollbackApplied',
  'rollbackRequestHash',
  'status',
  'targetInstanceId',
  'venueId',
  'version',
]);

const CONFIG_KEYS = Object.freeze([
  'configurationHash',
  'credentialsPresent',
  'enabled',
  'externalActionPerformed',
  'humanSingleUseAuthorizationRequired',
  'kind',
  'liveCommitEnabled',
  'portalBindingHash',
  'portalConfigurationHash',
  'portalDescriptorHash',
  'productionReady',
  'sandboxCanaryExternalActionPerformed',
  'sandboxCanaryRequired',
  'status',
  'targetInstanceId',
  'venueId',
  'version',
]);

function sha(value, code) {
  const selected = String(value || '').toLowerCase();
  if (!SHA256.test(selected)) throw new Error(code);
  return selected;
}

function optionalSha(value, code) {
  if (value === null || value === undefined) return null;
  return sha(value, code);
}

function safeId(value, code) {
  const selected = String(value || '').trim();
  if (!SAFE_ID.test(selected)) throw new Error(code);
  return selected;
}

function canonicalInstant(value, code) {
  const selected = String(value || '');
  const milliseconds = Date.parse(selected);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== selected) {
    throw new Error(code);
  }
  return selected;
}

function assertCredentialFree(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || value === undefined
    || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CREDENTIAL_KEY.test(key)) {
      throw new Error('single_venue_rollout_credential_material_forbidden');
    }
    assertCredentialFree(child, seen, depth + 1);
  }
}

export function assertSingleVenueSelection(targetVenueIds) {
  if (!Array.isArray(targetVenueIds) || targetVenueIds.length !== 1
    || !SAFE_ID.test(String(targetVenueIds[0] || ''))) {
    throw new Error('single_venue_rollout_exactly_one_venue_required');
  }
  return String(targetVenueIds[0]);
}

function targetAndFamily({ venueId, baseTargetProfileHash, connectorFamily } = {}) {
  const target = getJournalSubmissionTargetProfile(String(venueId || ''));
  const family = getSubmissionConnectorFamily(String(connectorFamily || ''));
  if (target.journalSubmissionTargetProfileHash
      !== String(baseTargetProfileHash || '').toLowerCase()
    || !target.candidateConnectorFamilies.includes(family.connectorFamily)
    || target.adapterImplemented !== true) {
    throw new Error('single_venue_rollout_target_binding_invalid');
  }
  return Object.freeze({ target, family });
}

function operationSet(operations, family) {
  if (!Array.isArray(operations) || operations.length < 1
    || new Set(operations).size !== operations.length) {
    throw new Error('single_venue_rollout_operations_invalid');
  }
  const selected = [...operations].map(String).sort();
  if (selected.includes('commit')
    || selected.some((operation) => !SINGLE_VENUE_ROLLOUT_OPERATIONS.includes(operation)
      || family.capabilities[operation] !== true)) {
    throw new Error('single_venue_rollout_commit_or_operation_forbidden');
  }
  return Object.freeze(selected);
}

function attestationSet(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 16) {
    throw new Error('single_venue_rollout_attestations_invalid');
  }
  const selected = [...new Set(values.map((value) => sha(
    value,
    'single_venue_rollout_attestation_hash_invalid',
  )))].sort();
  if (selected.length !== values.length) {
    throw new Error('single_venue_rollout_attestations_duplicate');
  }
  return Object.freeze(selected);
}

function expectedPlanPayload(input = {}) {
  assertCredentialFree(input);
  if (Object.hasOwn(input, 'venueIds') || Object.hasOwn(input, 'venues')
    || Object.hasOwn(input, 'targets')) {
    throw new Error('single_venue_rollout_exactly_one_venue_required');
  }
  const {
    rolloutId,
    venueId,
    targetInstanceId,
    baseTargetProfileHash,
    connectorFamily,
    portalOriginHash,
    portalConfigurationHash,
    portalDescriptorHash,
    portalBindingHash,
    sandboxCanaryEvidenceHash,
    sandboxCanaryExternalActionPerformed = false,
    attestationHashes,
    enabledOperations,
    issuedAt,
    expiresAt,
    rollbackWindowExpiresAt = expiresAt,
    generation = 1,
    predecessorPlanHash = null,
  } = input;
  const { family } = targetAndFamily({ venueId, baseTargetProfileHash, connectorFamily });
  const selectedIssuedAt = canonicalInstant(
    issuedAt,
    'single_venue_rollout_issued_at_invalid',
  );
  const selectedExpiresAt = canonicalInstant(
    expiresAt,
    'single_venue_rollout_expires_at_invalid',
  );
  const selectedRollbackExpiry = canonicalInstant(
    rollbackWindowExpiresAt,
    'single_venue_rollout_rollback_window_invalid',
  );
  const issuedMs = Date.parse(selectedIssuedAt);
  const expiresMs = Date.parse(selectedExpiresAt);
  const rollbackExpiryMs = Date.parse(selectedRollbackExpiry);
  if (expiresMs <= issuedMs || expiresMs - issuedMs > MAXIMUM_PLAN_LIFETIME_MS
    || rollbackExpiryMs < issuedMs || rollbackExpiryMs > expiresMs
    || sandboxCanaryExternalActionPerformed !== false
    || !Number.isSafeInteger(Number(generation)) || Number(generation) < 1
    || (Number(generation) === 1 && predecessorPlanHash !== null)
    || (Number(generation) > 1 && !SHA256.test(String(predecessorPlanHash || '')))) {
    throw new Error('single_venue_rollout_temporal_or_generation_policy_invalid');
  }
  const operations = operationSet(enabledOperations, family);
  const payload = {
    version: 1,
    kind: 'SingleVenueSubmissionRolloutPlan',
    status: 'single_venue_submission_rollout_sandbox_only',
    rolloutId: safeId(rolloutId, 'single_venue_rollout_id_invalid'),
    venueId: safeId(venueId, 'single_venue_rollout_venue_invalid'),
    targetInstanceId: safeId(
      targetInstanceId,
      'single_venue_rollout_target_instance_invalid',
    ),
    baseTargetProfileHash: sha(
      baseTargetProfileHash,
      'single_venue_rollout_base_target_hash_invalid',
    ),
    connectorFamily: family.connectorFamily,
    portalOriginHash: sha(portalOriginHash, 'single_venue_rollout_origin_hash_invalid'),
    portalConfigurationHash: sha(
      portalConfigurationHash,
      'single_venue_rollout_configuration_hash_invalid',
    ),
    portalDescriptorHash: sha(
      portalDescriptorHash,
      'single_venue_rollout_descriptor_hash_invalid',
    ),
    portalBindingHash: sha(
      portalBindingHash,
      'single_venue_rollout_binding_hash_invalid',
    ),
    sandboxCanaryEvidenceHash: sha(
      sandboxCanaryEvidenceHash,
      'single_venue_rollout_canary_hash_invalid',
    ),
    sandboxCanaryExternalActionPerformed: false,
    attestationHashes: attestationSet(attestationHashes),
    enabledOperations: operations,
    singleVenueConstraint: true,
    humanSingleUseAuthorizationRequired: true,
    manualAuthorizationScope: 'single-venue-live-commit',
    liveCommitEnabled: false,
    liveCommitAuthorized: false,
    productionQualified: false,
    rollbackRequired: true,
    generation: Number(generation),
    predecessorPlanHash: optionalSha(
      predecessorPlanHash,
      'single_venue_rollout_predecessor_hash_invalid',
    ),
    issuedAt: selectedIssuedAt,
    expiresAt: selectedExpiresAt,
    rollbackWindowExpiresAt: selectedRollbackExpiry,
    externalActionPerformed: false,
  };
  return Object.freeze(payload);
}

export function buildSingleVenueSubmissionRolloutPlan(input = {}) {
  const payload = expectedPlanPayload(input);
  return Object.freeze({
    ...payload,
    singleVenueSubmissionRolloutPlanHash: hashRecord(
      'SingleVenueSubmissionRolloutPlan',
      payload,
    ),
  });
}

export function verifySingleVenueSubmissionRolloutPlan(plan, {
  now = null,
  expectedVenueId = null,
} = {}) {
  const { singleVenueSubmissionRolloutPlanHash: claimedHash, ...payload } = plan || {};
  if (!hasExactObjectKeys(payload, PLAN_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('SingleVenueSubmissionRolloutPlan', payload)
    || payload.singleVenueConstraint !== true
    || payload.status !== 'single_venue_submission_rollout_sandbox_only'
    || payload.sandboxCanaryExternalActionPerformed !== false
    || payload.externalActionPerformed !== false
    || payload.liveCommitEnabled !== false
    || payload.liveCommitAuthorized !== false
    || payload.productionQualified !== false
    || payload.humanSingleUseAuthorizationRequired !== true
    || payload.rollbackRequired !== true
    || (expectedVenueId !== null && payload.venueId !== expectedVenueId)) return false;
  try {
    const rebuilt = buildSingleVenueSubmissionRolloutPlan(payload);
    if (JSON.stringify(rebuilt) !== JSON.stringify(plan)) return false;
  } catch { return false; }
  if (now !== null) {
    let observed;
    try { observed = canonicalInstant(now, 'single_venue_rollout_clock_invalid'); }
    catch { return false; }
    if (Date.parse(observed) < Date.parse(plan.issuedAt)
      || Date.parse(observed) >= Date.parse(plan.expiresAt)) return false;
  }
  return true;
}

export function buildSingleVenueLiveCommitAuthorizationSubject(plan) {
  if (!verifySingleVenueSubmissionRolloutPlan(plan)) {
    throw new Error('single_venue_rollout_plan_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'SingleVenueLiveCommitAuthorizationSubject',
    action: 'reviewed_submit',
    planHash: plan.singleVenueSubmissionRolloutPlanHash,
    venueId: plan.venueId,
    targetInstanceId: plan.targetInstanceId,
    portalBindingHash: plan.portalBindingHash,
    manualAuthorizationScope: plan.manualAuthorizationScope,
  });
  return Object.freeze({
    ...payload,
    singleVenueLiveCommitAuthorizationSubjectHash: hashRecord(
      'SingleVenueLiveCommitAuthorizationSubject',
      payload,
    ),
  });
}

export function buildSingleVenueLiveCommitPermit({
  plan,
  authorizationReceiptHash,
  authorizationSubjectHash,
  nonce,
  authorizerSubjectIds,
  issuedAt,
  expiresAt,
  authorizationVerifierEvidenceHash,
  verifyAuthorizationReceipt,
} = {}) {
  if (!verifySingleVenueSubmissionRolloutPlan(plan, { now: issuedAt })) {
    throw new Error('single_venue_rollout_plan_invalid');
  }
  if (typeof verifyAuthorizationReceipt !== 'function'
    || verifyAuthorizationReceipt({ plan, authorizationReceiptHash, nonce }) !== true) {
    throw new Error('single_venue_rollout_authorization_verifier_required');
  }
  const subject = buildSingleVenueLiveCommitAuthorizationSubject(plan);
  const selectedSubjects = Array.isArray(authorizerSubjectIds)
    ? [...new Set(authorizerSubjectIds.map((value) => safeId(
      value,
      'single_venue_rollout_authorizer_subject_invalid',
    )))].sort() : [];
  if (selectedSubjects.length < 2
    || !SHA256.test(String(authorizationReceiptHash || ''))
    || authorizationSubjectHash !== subject.singleVenueLiveCommitAuthorizationSubjectHash
    || !NONCE.test(String(nonce || ''))
    || !SHA256.test(String(authorizationVerifierEvidenceHash || ''))) {
    throw new Error('single_venue_rollout_authorization_binding_invalid');
  }
  const selectedIssuedAt = canonicalInstant(
    issuedAt,
    'single_venue_rollout_permit_issued_at_invalid',
  );
  const selectedExpiresAt = canonicalInstant(
    expiresAt,
    'single_venue_rollout_permit_expires_at_invalid',
  );
  const issuedMs = Date.parse(selectedIssuedAt);
  const expiresMs = Date.parse(selectedExpiresAt);
  if (expiresMs <= issuedMs
    || expiresMs > Date.parse(plan.expiresAt)
    || expiresMs - issuedMs > MAXIMUM_PERMIT_LIFETIME_MS) {
    throw new Error('single_venue_rollout_permit_time_window_invalid');
  }
  const payload = {
    version: 1,
    kind: 'SingleVenueLiveCommitPermit',
    status: 'single_venue_live_commit_permit_ready',
    planHash: plan.singleVenueSubmissionRolloutPlanHash,
    venueId: plan.venueId,
    targetInstanceId: plan.targetInstanceId,
    manualAuthorizationScope: plan.manualAuthorizationScope,
    authorizationReceiptHash: String(authorizationReceiptHash).toLowerCase(),
    authorizationSubjectHash,
    authorizationVerifierEvidenceHash: String(authorizationVerifierEvidenceHash).toLowerCase(),
    nonce: String(nonce),
    authorizerSubjectIds: Object.freeze(selectedSubjects),
    issuedAt: selectedIssuedAt,
    expiresAt: selectedExpiresAt,
    singleUse: true,
    consumed: false,
    externalActionPerformed: false,
    rollbackPlanHash: plan.singleVenueSubmissionRolloutPlanHash,
  };
  return Object.freeze({
    ...payload,
    singleVenueLiveCommitPermitHash: hashRecord('SingleVenueLiveCommitPermit', payload),
  });
}

export function verifySingleVenueLiveCommitPermit(permit, {
  plan,
  now = null,
} = {}) {
  const { singleVenueLiveCommitPermitHash: claimedHash, ...payload } = permit || {};
  if (!hasExactObjectKeys(payload, PERMIT_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('SingleVenueLiveCommitPermit', payload)
    || payload.status !== 'single_venue_live_commit_permit_ready'
    || payload.singleUse !== true
    || payload.consumed !== false
    || payload.externalActionPerformed !== false
    || payload.manualAuthorizationScope !== 'single-venue-live-commit'
    || !plan
    || payload.planHash !== plan.singleVenueSubmissionRolloutPlanHash
    || payload.rollbackPlanHash !== payload.planHash) return false;
  try {
    const subject = buildSingleVenueLiveCommitAuthorizationSubject(plan);
    if (payload.authorizationSubjectHash
      !== subject.singleVenueLiveCommitAuthorizationSubjectHash) return false;
    canonicalInstant(payload.issuedAt, 'single_venue_rollout_permit_issued_at_invalid');
    canonicalInstant(payload.expiresAt, 'single_venue_rollout_permit_expires_at_invalid');
  } catch { return false; }
  if (now !== null) {
    const observed = new Date(now).getTime();
    if (!Number.isFinite(observed) || observed < Date.parse(payload.issuedAt)
      || observed >= Date.parse(payload.expiresAt)) return false;
  }
  return true;
}

/*
 * Consumption is a pure, hash-bound receipt.  The caller must persist it in
 * the transactional outbox before invoking an external connector.  Passing
 * alreadyConsumed=true is intentionally an error, so replay/rollback code
 * cannot silently reuse a permit.
 */
export function consumeSingleVenueLiveCommitPermit({
  permit,
  plan,
  consumedAt,
  alreadyConsumed = false,
} = {}) {
  if (alreadyConsumed
    || !verifySingleVenueLiveCommitPermit(permit, { plan, now: consumedAt })) {
    throw new Error(alreadyConsumed
      ? 'single_venue_rollout_permit_already_consumed'
      : 'single_venue_rollout_permit_invalid');
  }
  const payload = {
    version: 1,
    kind: 'SingleVenueLiveCommitPermitConsumption',
    status: 'single_venue_live_commit_permit_consumed',
    permitHash: permit.singleVenueLiveCommitPermitHash,
    planHash: plan.singleVenueSubmissionRolloutPlanHash,
    venueId: plan.venueId,
    targetInstanceId: plan.targetInstanceId,
    manualAuthorizationScope: plan.manualAuthorizationScope,
    authorizationReceiptHash: permit.authorizationReceiptHash,
    nonce: permit.nonce,
    consumedAt: canonicalInstant(
      consumedAt,
      'single_venue_rollout_permit_consumed_at_invalid',
    ),
    consumed: true,
    sideEffectReservationRequired: true,
    externalActionPerformed: false,
    rollbackPlanHash: plan.singleVenueSubmissionRolloutPlanHash,
  };
  return Object.freeze({
    ...payload,
    singleVenueLiveCommitPermitConsumptionHash: hashRecord(
      'SingleVenueLiveCommitPermitConsumption',
      payload,
    ),
  });
}

export function verifySingleVenueLiveCommitPermitConsumption(receipt, {
  permit = null,
  plan = null,
} = {}) {
  const {
    singleVenueLiveCommitPermitConsumptionHash: claimedHash,
    ...payload
  } = receipt || {};
  if (!hasExactObjectKeys(payload, CONSUMPTION_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord(
      'SingleVenueLiveCommitPermitConsumption',
      payload,
    )
    || payload.status !== 'single_venue_live_commit_permit_consumed'
    || payload.consumed !== true
    || payload.sideEffectReservationRequired !== true
    || payload.externalActionPerformed !== false) return false;
  if (permit
    && (payload.permitHash !== permit.singleVenueLiveCommitPermitHash
      || payload.authorizationReceiptHash !== permit.authorizationReceiptHash
      || payload.nonce !== permit.nonce)) return false;
  if (plan
    && (payload.planHash !== plan.singleVenueSubmissionRolloutPlanHash
      || payload.venueId !== plan.venueId
      || payload.targetInstanceId !== plan.targetInstanceId)) return false;
  return true;
}

export function buildSingleVenueRollbackRequest({
  plan,
  requestedBy,
  reason,
  requestedAt,
  rollbackTargetPlanHash = plan?.singleVenueSubmissionRolloutPlanHash,
} = {}) {
  if (!verifySingleVenueSubmissionRolloutPlan(plan)) {
    throw new Error('single_venue_rollout_plan_invalid');
  }
  const selectedReason = String(reason || '').trim();
  if (selectedReason.length < 3 || selectedReason.length > 512) {
    throw new Error('single_venue_rollout_rollback_reason_invalid');
  }
  const payload = {
    version: 1,
    kind: 'SingleVenueSubmissionRollbackRequest',
    status: 'single_venue_submission_rollback_requested',
    planHash: plan.singleVenueSubmissionRolloutPlanHash,
    venueId: plan.venueId,
    targetInstanceId: plan.targetInstanceId,
    requestedBy: safeId(
      requestedBy,
      'single_venue_rollout_rollback_requester_invalid',
    ),
    reason: selectedReason,
    rollbackTargetPlanHash: sha(
      rollbackTargetPlanHash,
      'single_venue_rollout_rollback_target_invalid',
    ),
    requestedAt: canonicalInstant(
      requestedAt,
      'single_venue_rollout_rollback_requested_at_invalid',
    ),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    singleVenueRollbackRequestHash: hashRecord(
      'SingleVenueSubmissionRollbackRequest',
      payload,
    ),
  });
}

export function buildSingleVenueRollbackReceipt({
  request,
  applied,
  appliedAt,
  resultingPlanHash,
} = {}) {
  const { singleVenueRollbackRequestHash: requestHash, ...requestPayload } = request || {};
  if (!hasExactObjectKeys(requestPayload, ROLLBACK_REQUEST_KEYS)
    || requestHash !== hashRecord('SingleVenueSubmissionRollbackRequest', requestPayload)
    || typeof applied !== 'boolean') {
    throw new Error('single_venue_rollout_rollback_request_invalid');
  }
  const selectedAppliedAt = canonicalInstant(
    appliedAt,
    'single_venue_rollout_rollback_applied_at_invalid',
  );
  if (Date.parse(selectedAppliedAt) < Date.parse(request.requestedAt)) {
    throw new Error('single_venue_rollout_rollback_time_invalid');
  }
  const payload = {
    version: 1,
    kind: 'SingleVenueSubmissionRollbackReceipt',
    status: applied
      ? 'single_venue_submission_rollback_applied'
      : 'single_venue_submission_rollback_blocked',
    rollbackRequestHash: requestHash,
    planHash: request.planHash,
    venueId: request.venueId,
    targetInstanceId: request.targetInstanceId,
    requestedBy: request.requestedBy,
    reason: request.reason,
    requestedAt: request.requestedAt,
    appliedAt: selectedAppliedAt,
    rollbackApplied: applied,
    resultingPlanHash: sha(
      resultingPlanHash,
      'single_venue_rollout_rollback_result_hash_invalid',
    ),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    singleVenueRollbackReceiptHash: hashRecord(
      'SingleVenueSubmissionRollbackReceipt',
      payload,
    ),
  });
}

export function verifySingleVenueRollbackReceipt(receipt) {
  const { singleVenueRollbackReceiptHash: claimedHash, ...payload } = receipt || {};
  return hasExactObjectKeys(payload, ROLLBACK_RECEIPT_KEYS)
    && SHA256.test(String(claimedHash || ''))
    && claimedHash === hashRecord('SingleVenueSubmissionRollbackReceipt', payload)
    && payload.externalActionPerformed === false
    && typeof payload.rollbackApplied === 'boolean';
}

export const SINGLE_VENUE_ROLLOUT_POLICY = Object.freeze({
  version: 1,
  kind: 'SingleVenueSubmissionRolloutPolicy',
  maximumPlanLifetimeMs: MAXIMUM_PLAN_LIFETIME_MS,
  maximumPermitLifetimeMs: MAXIMUM_PERMIT_LIFETIME_MS,
  exactlyOneVenueRequired: true,
  sandboxCanaryMustBeNoSideEffect: true,
  credentialsPersisted: false,
  liveCommitRequiresHumanSingleUsePermit: true,
  rollbackReceiptRequired: true,
});

/*
 * Checked-in configuration is intentionally an inert template.  Operators
 * must materialize a separately pinned descriptor and binding before a plan
 * can be built; loading this file can therefore never enable a dispatcher.
 */
export function buildSingleVenueSubmissionRolloutConfiguration(input = {}) {
  assertCredentialFree(input);
  const payload = {
    version: 1,
    kind: 'SingleVenueSubmissionRolloutConfiguration',
    status: 'unconfigured_fail_closed',
    enabled: false,
    venueId: null,
    targetInstanceId: null,
    portalConfigurationHash: null,
    portalDescriptorHash: null,
    portalBindingHash: null,
    credentialsPresent: false,
    liveCommitEnabled: false,
    productionReady: false,
    humanSingleUseAuthorizationRequired: true,
    sandboxCanaryRequired: true,
    sandboxCanaryExternalActionPerformed: false,
    externalActionPerformed: false,
  };
  if (Object.keys(input).some((key) => ![''].includes(key))) {
    /* The template has no operator-settable fields.  Rejecting even benign
       overrides avoids a config file that appears enabled by accident. */
    throw new Error('single_venue_rollout_template_override_forbidden');
  }
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord(
      'SingleVenueSubmissionRolloutConfiguration',
      payload,
    ),
  });
}

export function verifySingleVenueSubmissionRolloutConfiguration(value) {
  const { configurationHash: claimedHash, ...payload } = value || {};
  if (!hasExactObjectKeys(payload, CONFIG_KEYS.filter((key) => key !== 'configurationHash'))
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('SingleVenueSubmissionRolloutConfiguration', payload)
    || payload.status !== 'unconfigured_fail_closed'
    || payload.enabled !== false
    || payload.credentialsPresent !== false
    || payload.liveCommitEnabled !== false
    || payload.productionReady !== false
    || payload.humanSingleUseAuthorizationRequired !== true
    || payload.sandboxCanaryRequired !== true
    || payload.sandboxCanaryExternalActionPerformed !== false
    || payload.externalActionPerformed !== false
    || payload.venueId !== null
    || payload.targetInstanceId !== null
    || payload.portalConfigurationHash !== null
    || payload.portalDescriptorHash !== null
    || payload.portalBindingHash !== null) return false;
  return true;
}
