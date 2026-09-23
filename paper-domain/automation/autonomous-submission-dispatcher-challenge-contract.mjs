import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE =
  'autonomous-submission-dispatcher-cycle-signer';
export const AUTONOMOUS_SUBMISSION_PORTAL_READINESS_CANARY_SUBJECT_KIND =
  'AutonomousSubmissionPortalReadinessCanaryReceipt';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/;

function time(value, code) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(code);
  }
  return parsed;
}

function count(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

export function buildAutonomousSubmissionDispatcherChallenge({
  planHash,
  idempotencyKey,
  portalId,
  portalConfigurationHash,
  portalDescriptorHash,
  challengedAt,
  expiresAt,
} = {}) {
  const challenged = time(challengedAt,
    'autonomous_submission_dispatcher_challenge_time_invalid');
  const expires = time(expiresAt,
    'autonomous_submission_dispatcher_challenge_expiry_invalid');
  if (!SHA256.test(String(planHash || ''))
    || !SHA256.test(String(idempotencyKey || ''))
    || !IDENTIFIER.test(String(portalId || ''))
    || !SHA256.test(String(portalConfigurationHash || ''))
    || !SHA256.test(String(portalDescriptorHash || ''))
    || expires <= challenged) {
    throw new Error('autonomous_submission_dispatcher_challenge_binding_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherChallenge',
    status: 'autonomous_submission_dispatcher_challenge_pending',
    planHash,
    idempotencyKey,
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    challengedAt,
    expiresAt,
  });
  return Object.freeze({
    ...payload,
    challengeHash: hashRecord('AutonomousSubmissionDispatcherChallenge', payload),
  });
}

export function verifyAutonomousSubmissionDispatcherChallenge(challenge, {
  now,
  expectedPlanHash = null,
  expectedIdempotencyKey = null,
  expectedPortalId = null,
  expectedPortalConfigurationHash = null,
  expectedPortalDescriptorHash = null,
} = {}) {
  try {
    if (now === undefined || now === null || !Number.isFinite(new Date(now).getTime())) {
      return false;
    }
    const { challengeHash, ...payload } = challenge || {};
    const rebuilt = buildAutonomousSubmissionDispatcherChallenge(payload);
    return rebuilt.challengeHash === challengeHash
      && Date.parse(rebuilt.challengedAt) <= new Date(now).getTime()
      && Date.parse(rebuilt.expiresAt) > new Date(now).getTime()
      && (!expectedPlanHash || rebuilt.planHash === expectedPlanHash)
      && (!expectedIdempotencyKey || rebuilt.idempotencyKey === expectedIdempotencyKey)
      && (!expectedPortalId || rebuilt.portalId === expectedPortalId)
      && (!expectedPortalConfigurationHash
        || rebuilt.portalConfigurationHash === expectedPortalConfigurationHash)
      && (!expectedPortalDescriptorHash
        || rebuilt.portalDescriptorHash === expectedPortalDescriptorHash);
  } catch { return false; }
}

export function buildAutonomousSubmissionPortalReadinessCanaryRequest({
  challenge,
  nonce,
  requestedAt,
} = {}) {
  time(requestedAt, 'autonomous_submission_portal_canary_time_invalid');
  if (!verifyAutonomousSubmissionDispatcherChallenge(challenge, {
    now: new Date(requestedAt),
  }) || !IDENTIFIER.test(String(nonce || ''))) {
    throw new Error('autonomous_submission_portal_canary_request_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalReadinessCanaryRequest',
    challengeHash: challenge.challengeHash,
    portalId: challenge.portalId,
    portalConfigurationHash: challenge.portalConfigurationHash,
    portalDescriptorHash: challenge.portalDescriptorHash,
    nonce,
    requestedAt,
  });
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousSubmissionPortalReadinessCanaryRequest', payload),
  });
}

export function buildAutonomousSubmissionPortalReadinessCanaryReceipt({
  request,
  serviceIdentityHash,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
  externalActionPerformed,
  observedAt,
  expiresAt,
} = {}) {
  const observed = time(observedAt, 'autonomous_submission_portal_canary_time_invalid');
  const expires = time(expiresAt, 'autonomous_submission_portal_canary_expiry_invalid');
  const { requestHash, ...requestPayload } = request || {};
  if (hashRecord('AutonomousSubmissionPortalReadinessCanaryRequest', requestPayload)
      !== requestHash
    || expires <= observed
    || externalActionPerformed !== false
    || ![
      serviceIdentityHash,
      portalAccountIdentityHash,
      portalTrustDomainIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))) {
    throw new Error('autonomous_submission_portal_canary_receipt_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalReadinessCanaryReceipt',
    status: 'autonomous_submission_portal_readiness_verified',
    requestHash,
    challengeHash: request.challengeHash,
    portalId: request.portalId,
    portalConfigurationHash: request.portalConfigurationHash,
    portalDescriptorHash: request.portalDescriptorHash,
    serviceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    externalActionPerformed: false,
    observedAt,
    expiresAt,
  });
  return Object.freeze({
    ...payload,
    canaryReceiptHash: hashRecord(
      'AutonomousSubmissionPortalReadinessCanaryReceipt', payload,
    ),
  });
}

export function verifyAutonomousSubmissionPortalReadinessCanaryReceipt(receipt, {
  request,
  now,
} = {}) {
  try {
    const { canaryReceiptHash, ...payload } = receipt || {};
    const rebuilt = buildAutonomousSubmissionPortalReadinessCanaryReceipt({
      ...payload,
      request,
    });
    const observedNow = new Date(now).getTime();
    return Number.isFinite(observedNow)
      && rebuilt.canaryReceiptHash === canaryReceiptHash
      && rebuilt.requestHash === request.requestHash
      && Date.parse(rebuilt.observedAt) <= observedNow
      && Date.parse(rebuilt.expiresAt) > observedNow;
  } catch { return false; }
}

export function buildAutonomousSubmissionPortalReadinessCanaryEvidence({
  challenge,
  request,
  receipt,
  authorityEnvelope,
} = {}) {
  let rebuiltRequest;
  try {
    rebuiltRequest = buildAutonomousSubmissionPortalReadinessCanaryRequest({
      challenge,
      nonce: request?.nonce,
      requestedAt: request?.requestedAt,
    });
  } catch {
    throw new Error('autonomous_submission_portal_canary_evidence_invalid');
  }
  if (rebuiltRequest.requestHash !== request?.requestHash
    || !verifyAutonomousSubmissionPortalReadinessCanaryReceipt(receipt, {
      request: rebuiltRequest,
      now: new Date(receipt?.observedAt),
    })
    || authorityEnvelope?.subjectKind
      !== AUTONOMOUS_SUBMISSION_PORTAL_READINESS_CANARY_SUBJECT_KIND
    || authorityEnvelope?.subjectHash !== receipt?.canaryReceiptHash
    || !Array.isArray(authorityEnvelope?.signatures)) {
    throw new Error('autonomous_submission_portal_canary_evidence_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalReadinessCanaryEvidence',
    request: Object.freeze(request),
    receipt: Object.freeze(receipt),
    authorityEnvelope: Object.freeze(authorityEnvelope),
  });
  return Object.freeze({
    ...payload,
    canaryEvidenceHash: hashRecord(
      'AutonomousSubmissionPortalReadinessCanaryEvidence', payload,
    ),
  });
}

export function buildAutonomousSubmissionDispatcherCycleReceipt({
  challenge,
  cyclePlanHash,
  dispatcherPrincipalId,
  dispatcherIdentityConfigurationHash,
  processIdentityHash,
  portalId,
  portalConfigurationHash,
  portalDescriptorHash,
  portalBindingVerified,
  portalVerifierReady,
  portalIdentityIndependenceReady,
  portalFullProductionReady,
  livePortalCanaryVerified,
  livePortalCanaryReceiptHash,
  livePortalCanaryVerificationReceiptHash,
  livePortalCanaryVerificationVerifiedAt,
  livePortalCanaryAuthorityIndependentFromDispatcher,
  livePortalCanaryExternalActionPerformed,
  livePortalCanaryEvidence,
  cutoverId,
  handoffInstanceNonce,
  handoffDatabaseIdentityHash,
  nativeStoreInaccessibleOrReadOnlyVerified,
  handoffStoreWriteVerified,
  storageLayoutHash,
  inspectedHandoffCount,
  completedHandoffCount,
  pendingHandoffCount,
  explicitFailureCount,
  networkActionPerformed,
  startedAt,
  signedAt,
  expiresAt,
} = {}) {
  if (!verifyAutonomousSubmissionDispatcherChallenge(challenge, {
    now: new Date(signedAt),
  })) throw new Error('autonomous_submission_dispatcher_cycle_challenge_invalid');
  const started = time(startedAt, 'autonomous_submission_dispatcher_cycle_time_invalid');
  const signed = time(signedAt, 'autonomous_submission_dispatcher_cycle_time_invalid');
  const expires = time(expiresAt, 'autonomous_submission_dispatcher_cycle_expiry_invalid');
  const canaryVerificationVerified = livePortalCanaryVerified === true
    ? time(
      livePortalCanaryVerificationVerifiedAt,
      'autonomous_submission_dispatcher_cycle_canary_verification_time_invalid',
    ) : null;
  if (signed < started || expires <= signed
    || !SHA256.test(String(cyclePlanHash || ''))
    || !IDENTIFIER.test(String(dispatcherPrincipalId || ''))
    || !IDENTIFIER.test(String(portalId || ''))
    || !IDENTIFIER.test(String(cutoverId || ''))
    || !IDENTIFIER.test(String(handoffInstanceNonce || ''))
    || ![
      dispatcherIdentityConfigurationHash, processIdentityHash,
      portalConfigurationHash, portalDescriptorHash,
      handoffDatabaseIdentityHash, storageLayoutHash,
    ].every((value) => SHA256.test(String(value || '')))
    || (livePortalCanaryVerified === true && ![
      livePortalCanaryReceiptHash,
      livePortalCanaryVerificationReceiptHash,
    ].every((value) => SHA256.test(String(value || ''))))) {
    throw new Error('autonomous_submission_dispatcher_cycle_binding_invalid');
  }
  let canonicalCanaryEvidence = null;
  if (livePortalCanaryEvidence !== null && livePortalCanaryEvidence !== undefined) {
    canonicalCanaryEvidence = buildAutonomousSubmissionPortalReadinessCanaryEvidence({
      challenge,
      request: livePortalCanaryEvidence.request,
      receipt: livePortalCanaryEvidence.receipt,
      authorityEnvelope: livePortalCanaryEvidence.authorityEnvelope,
    });
    if (canonicalCanaryEvidence.canaryEvidenceHash
        !== livePortalCanaryEvidence.canaryEvidenceHash
      || canonicalCanaryEvidence.receipt.canaryReceiptHash
        !== livePortalCanaryReceiptHash
      || (canaryVerificationVerified !== null
        && (canaryVerificationVerified
            < Date.parse(canonicalCanaryEvidence.receipt.observedAt)
          || canaryVerificationVerified > signed))) {
      throw new Error('autonomous_submission_dispatcher_cycle_canary_evidence_invalid');
    }
  }
  const counts = Object.freeze({
    inspectedHandoffCount: count(inspectedHandoffCount,
      'autonomous_submission_dispatcher_cycle_count_invalid'),
    completedHandoffCount: count(completedHandoffCount,
      'autonomous_submission_dispatcher_cycle_count_invalid'),
    pendingHandoffCount: count(pendingHandoffCount,
      'autonomous_submission_dispatcher_cycle_count_invalid'),
    explicitFailureCount: count(explicitFailureCount,
      'autonomous_submission_dispatcher_cycle_count_invalid'),
  });
  const ready = portalBindingVerified === true
    && portalId === challenge.portalId
    && portalConfigurationHash === challenge.portalConfigurationHash
    && portalDescriptorHash === challenge.portalDescriptorHash
    && portalVerifierReady === true
    && portalIdentityIndependenceReady === true
    && portalFullProductionReady === true
    && livePortalCanaryVerified === true
    && livePortalCanaryAuthorityIndependentFromDispatcher === true
    && canonicalCanaryEvidence !== null
    && livePortalCanaryExternalActionPerformed === false
    && nativeStoreInaccessibleOrReadOnlyVerified === true
    && handoffStoreWriteVerified === true
    && counts.pendingHandoffCount === 0
    && counts.explicitFailureCount === 0;
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherCycleReceipt',
    status: ready
      ? 'autonomous_submission_dispatcher_cycle_ready'
      : 'autonomous_submission_dispatcher_cycle_blocked',
    ready,
    challengeHash: challenge.challengeHash,
    planHash: challenge.planHash,
    idempotencyKey: challenge.idempotencyKey,
    cyclePlanHash,
    dispatcherPrincipalId,
    dispatcherIdentityConfigurationHash,
    processIdentityHash,
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    portalBindingVerified: portalBindingVerified === true,
    portalVerifierReady: portalVerifierReady === true,
    portalIdentityIndependenceReady: portalIdentityIndependenceReady === true,
    portalFullProductionReady: portalFullProductionReady === true,
    livePortalCanaryVerified: livePortalCanaryVerified === true,
    livePortalCanaryReceiptHash,
    livePortalCanaryVerificationReceiptHash,
    livePortalCanaryVerificationVerifiedAt:
      livePortalCanaryVerified === true ? livePortalCanaryVerificationVerifiedAt : null,
    livePortalCanaryAuthorityIndependentFromDispatcher:
      livePortalCanaryAuthorityIndependentFromDispatcher === true,
    livePortalCanaryExternalActionPerformed:
      livePortalCanaryExternalActionPerformed === true,
    livePortalCanaryEvidence: canonicalCanaryEvidence,
    cutoverId,
    handoffInstanceNonce,
    handoffDatabaseIdentityHash,
    nativeStoreInaccessibleOrReadOnlyVerified:
      nativeStoreInaccessibleOrReadOnlyVerified === true,
    handoffStoreWriteVerified: handoffStoreWriteVerified === true,
    storageLayoutHash,
    ...counts,
    networkActionPerformed: networkActionPerformed === true,
    startedAt,
    signedAt,
    expiresAt,
  });
  return Object.freeze({
    ...payload,
    cycleReceiptHash: hashRecord('AutonomousSubmissionDispatcherCycleReceipt', payload),
  });
}

export function verifyAutonomousSubmissionDispatcherCycleReceipt(receipt, {
  challenge,
  now,
  requireReady = true,
} = {}) {
  try {
    if (now === undefined || now === null || !Number.isFinite(new Date(now).getTime())) {
      return false;
    }
    const { cycleReceiptHash, signatures: _signatures, ...payload } = receipt || {};
    const rebuilt = buildAutonomousSubmissionDispatcherCycleReceipt({
      ...payload,
      challenge,
    });
    return rebuilt.cycleReceiptHash === cycleReceiptHash
      && rebuilt.challengeHash === challenge.challengeHash
      && (requireReady !== true || rebuilt.ready === true)
      && Date.parse(rebuilt.expiresAt) > new Date(now).getTime();
  } catch { return false; }
}
