import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  verifyAutonomousSubmissionReceipt,
} from './autonomous-submission-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const STATES = new Set([
  'prepared',
  'dispatching',
  'completed',
  'explicit_failure',
  'uncertain',
]);
const RESOLUTIONS = new Set([
  'local-intent-persisted',
  'initial-dispatch',
  'remote-authoritative-not-found-redrive',
  'remote-confirmed-completed',
  'remote-confirmed-explicit-failure',
  'remote-outcome-uncertain',
]);
const REDRIVE_PREVIOUS_STATES = new Set(['dispatching', 'uncertain']);
const PORTAL_LOOKUP_OUTCOME_KEYS = Object.freeze([
  'externalActionPerformed', 'idempotencyKey', 'kind', 'observedAt',
  'portalAccountIdentityHash', 'portalConfigurationHash', 'portalId',
  'portalTrustDomainIdentityHash', 'requestHash', 'serviceIdentityHash',
  'status', 'version',
]);

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function plainFailure(value) {
  if (value === null || value === undefined) return null;
  const code = String(value.code || '').slice(0, 256);
  const httpStatus = value.httpStatus === null || value.httpStatus === undefined
    ? null : Number(value.httpStatus);
  if (!code || (httpStatus !== null
    && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) {
    throw new Error('autonomous_submission_delivery_failure_invalid');
  }
  return Object.freeze({ code, httpStatus });
}

function expectedFlags(state) {
  return Object.freeze({
    requestAttempted: state !== 'prepared',
    externalActionPerformed: state === 'completed',
    externalActionMayHaveOccurred: ['dispatching', 'completed', 'uncertain'].includes(state),
    lookupRequired: ['dispatching', 'uncertain'].includes(state),
    redrivePermitted: state === 'prepared',
    terminal: ['completed', 'explicit_failure'].includes(state),
  });
}

export function autonomousSubmissionOutboxMessageId(request, { requestVerifier } = {}) {
  if (requestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || requestVerifier.verify(request) !== true) {
    throw new Error('autonomous_submission_delivery_request_invalid');
  }
  return `autonomous-submission:${request.idempotencyKey}`;
}

export function autonomousSubmissionSideEffectReservationHash(request, { requestVerifier } = {}) {
  if (requestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || requestVerifier.verify(request) !== true) {
    throw new Error('autonomous_submission_delivery_request_invalid');
  }
  return hashRecord('AutonomousSubmissionSideEffectReservation', {
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    immutableCampaignPackageOutputHash: request.immutableCampaignPackageOutputHash,
    venueId: request.venueId,
    venueProfileHash: request.venueProfileHash,
    submissionMetadataReceiptHash: request.submissionMetadataReceiptHash,
    portalConfigurationHash: request.portalConfigurationHash,
  });
}

export function buildAutonomousSubmissionAuthoritativeNotFoundReceipt({
  request,
  portalId,
  portalConfigurationHash,
  serviceIdentityHash,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
} = {}) {
  if (!SHA256.test(String(request?.requestHash || ''))
    || !SHA256.test(String(request?.idempotencyKey || ''))
    || !SAFE_ID.test(String(portalId || ''))
    || request?.portalConfigurationHash !== portalConfigurationHash
    || ![
      portalConfigurationHash,
      serviceIdentityHash,
      portalAccountIdentityHash,
      portalTrustDomainIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))) {
    throw new Error('autonomous_submission_authoritative_not_found_receipt_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionAuthoritativeNotFoundReceipt',
    status: 'autonomous_submission_portal_authoritative_not_found',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    portalId: String(portalId),
    portalConfigurationHash,
    serviceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    authenticatedTransport: 'https-bearer-idempotency-lookup-v1',
    authoritative: true,
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousSubmissionAuthoritativeNotFoundReceiptHash: hashRecord(
      'AutonomousSubmissionAuthoritativeNotFoundReceipt', payload,
    ),
  });
}

export function buildAutonomousSubmissionPortalLookupOutcome({
  request,
  portalId,
  portalConfigurationHash,
  serviceIdentityHash,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
  observedAt,
} = {}) {
  if (!SHA256.test(String(request?.requestHash || ''))
    || !SHA256.test(String(request?.idempotencyKey || ''))
    || !SAFE_ID.test(String(portalId || ''))
    || request?.portalConfigurationHash !== portalConfigurationHash
    || ![
      portalConfigurationHash,
      serviceIdentityHash,
      portalAccountIdentityHash,
      portalTrustDomainIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))
    || !canonicalInstant(String(observedAt || ''))) {
    throw new Error('autonomous_submission_portal_lookup_outcome_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalLookupOutcome',
    status: 'autonomous_submission_portal_not_found',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    portalId: String(portalId),
    portalConfigurationHash,
    serviceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    observedAt: String(observedAt),
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousSubmissionPortalLookupOutcomeHash: hashRecord(
      'AutonomousSubmissionPortalLookupOutcome', payload,
    ),
  });
}

export function verifyAutonomousSubmissionPortalLookupOutcome(value, {
  request,
  portalId,
} = {}) {
  const {
    autonomousSubmissionPortalLookupOutcomeHash: claimedHash,
    ...payload
  } = value || {};
  if (!hasExactObjectKeys(payload, PORTAL_LOOKUP_OUTCOME_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousSubmissionPortalLookupOutcome', payload) !== claimedHash) {
    return false;
  }
  try {
    return JSON.stringify(buildAutonomousSubmissionPortalLookupOutcome({
      request,
      portalId,
      portalConfigurationHash: value.portalConfigurationHash,
      serviceIdentityHash: value.serviceIdentityHash,
      portalAccountIdentityHash: value.portalAccountIdentityHash,
      portalTrustDomainIdentityHash: value.portalTrustDomainIdentityHash,
      observedAt: value.observedAt,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function buildCryptographicAutonomousSubmissionAuthoritativeNotFoundReceipt({
  request,
  portalId,
  remoteLookupOutcome,
  authorityEnvelope,
  signatureVerificationReceipt,
} = {}) {
  const outcomeHash = remoteLookupOutcome?.autonomousSubmissionPortalLookupOutcomeHash || null;
  const verificationHash = signatureVerificationReceipt
    ?.pinnedExternalEvidenceVerificationReceiptHash || null;
  const {
    pinnedExternalEvidenceVerificationReceiptHash: _claimedVerificationHash,
    ...verificationPayload
  } = signatureVerificationReceipt || {};
  const authorityEnvelopeHash = authorityEnvelope
    ? hashRecord('PinnedExternalEvidenceEnvelope', authorityEnvelope) : null;
  if (!verifyAutonomousSubmissionPortalLookupOutcome(remoteLookupOutcome, {
    request,
    portalId,
  }) || signatureVerificationReceipt?.kind
      !== 'PinnedExternalEvidenceVerificationReceipt'
    || signatureVerificationReceipt?.status !== 'pinned_external_evidence_verified'
    || signatureVerificationReceipt?.cryptographicAuthorityReady !== true
    || signatureVerificationReceipt?.subjectKind
      !== 'AutonomousSubmissionPortalLookupOutcome'
    || signatureVerificationReceipt?.subjectHash !== outcomeHash
    || signatureVerificationReceipt?.requiredRole !== 'autonomous_submission_portal'
    || signatureVerificationReceipt?.envelopeHash !== authorityEnvelopeHash
    || !SHA256.test(String(verificationHash || ''))
    || hashRecord('PinnedExternalEvidenceVerificationReceipt', verificationPayload)
      !== verificationHash
    || authorityEnvelope?.subjectKind !== 'AutonomousSubmissionPortalLookupOutcome'
    || authorityEnvelope?.subjectHash !== outcomeHash) {
    throw new Error('autonomous_submission_cryptographic_not_found_receipt_invalid');
  }
  const payload = Object.freeze({
    version: 2,
    kind: 'AutonomousSubmissionAuthoritativeNotFoundReceipt',
    status: 'autonomous_submission_portal_authoritative_not_found',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    portalId: String(portalId),
    portalConfigurationHash: remoteLookupOutcome.portalConfigurationHash,
    serviceIdentityHash: remoteLookupOutcome.serviceIdentityHash,
    portalAccountIdentityHash: remoteLookupOutcome.portalAccountIdentityHash,
    portalTrustDomainIdentityHash: remoteLookupOutcome.portalTrustDomainIdentityHash,
    remoteLookupOutcomeHash: outcomeHash,
    remoteLookupOutcome,
    authorityEnvelopeHash,
    authorityEnvelope,
    signatureVerificationReceiptHash: verificationHash,
    signatureVerificationReceipt,
    authenticatedTransport: 'https-bearer-pinned-ed25519-lookup-v2',
    cryptographicAuthorityVerified: true,
    authoritative: true,
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousSubmissionAuthoritativeNotFoundReceiptHash: hashRecord(
      'AutonomousSubmissionAuthoritativeNotFoundReceipt', payload,
    ),
  });
}

export function verifyAutonomousSubmissionAuthoritativeNotFoundReceipt(value, {
  request,
  portalId,
} = {}) {
  if (value?.version === 2) {
    const {
      autonomousSubmissionAuthoritativeNotFoundReceiptHash: claimedHash,
      ...payload
    } = value || {};
    if (!SHA256.test(String(claimedHash || ''))
      || hashRecord('AutonomousSubmissionAuthoritativeNotFoundReceipt', payload)
        !== claimedHash) return false;
    try {
      return JSON.stringify(
        buildCryptographicAutonomousSubmissionAuthoritativeNotFoundReceipt({
          request,
          portalId,
          remoteLookupOutcome: value.remoteLookupOutcome,
          authorityEnvelope: value.authorityEnvelope,
          signatureVerificationReceipt: value.signatureVerificationReceipt,
        }),
      ) === JSON.stringify(value);
    } catch { return false; }
  }
  const {
    autonomousSubmissionAuthoritativeNotFoundReceiptHash: claimedHash,
    ...payload
  } = value || {};
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousSubmissionAuthoritativeNotFoundReceipt', payload)
      !== claimedHash) return false;
  try {
    return JSON.stringify(buildAutonomousSubmissionAuthoritativeNotFoundReceipt({
      request,
      portalId,
      portalConfigurationHash: value.portalConfigurationHash,
      serviceIdentityHash: value.serviceIdentityHash,
      portalAccountIdentityHash: value.portalAccountIdentityHash,
      portalTrustDomainIdentityHash: value.portalTrustDomainIdentityHash,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function buildAutonomousSubmissionDispatchPermit({
  request,
  portalId,
  attempt,
  previousState,
  previousStateReceiptHash,
  dispatchStateReceiptHash,
  resolution,
  authoritativeNotFoundReceiptHash = null,
  onlineMutationSideEffectPermitHash = null,
} = {}) {
  const initial = previousState === AUTONOMOUS_SUBMISSION_DELIVERY_STATES.PREPARED
    && resolution === 'initial-dispatch'
    && authoritativeNotFoundReceiptHash === null;
  const redrive = REDRIVE_PREVIOUS_STATES.has(previousState)
    && resolution === 'remote-authoritative-not-found-redrive'
    && SHA256.test(String(authoritativeNotFoundReceiptHash || ''));
  if (!SHA256.test(String(request?.requestHash || ''))
    || !SHA256.test(String(request?.idempotencyKey || ''))
    || !SHA256.test(String(request?.portalConfigurationHash || ''))
    || !SAFE_ID.test(String(portalId || ''))
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100
    || !SHA256.test(String(previousStateReceiptHash || ''))
    || !SHA256.test(String(dispatchStateReceiptHash || ''))
    || (onlineMutationSideEffectPermitHash !== null
      && !SHA256.test(String(onlineMutationSideEffectPermitHash || '')))
    || (!initial && !redrive)) {
    throw new Error('autonomous_submission_dispatch_permit_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatchPermit',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    portalId: String(portalId),
    portalConfigurationHash: request.portalConfigurationHash,
    attempt,
    previousState,
    previousStateReceiptHash,
    dispatchStateReceiptHash,
    resolution,
    authoritativeNotFoundReceiptHash,
    onlineMutationSideEffectPermitHash,
    singleUse: true,
  });
  return Object.freeze({
    ...payload,
    autonomousSubmissionDispatchPermitHash: hashRecord(
      'AutonomousSubmissionDispatchPermit', payload,
    ),
  });
}

export function verifyAutonomousSubmissionDispatchPermit(value, {
  request,
  portalId,
} = {}) {
  const { autonomousSubmissionDispatchPermitHash: claimedHash, ...payload } = value || {};
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousSubmissionDispatchPermit', payload) !== claimedHash) return false;
  try {
    return JSON.stringify(buildAutonomousSubmissionDispatchPermit({
      request,
      portalId,
      attempt: value.attempt,
      previousState: value.previousState,
      previousStateReceiptHash: value.previousStateReceiptHash,
      dispatchStateReceiptHash: value.dispatchStateReceiptHash,
      resolution: value.resolution,
      authoritativeNotFoundReceiptHash: value.authoritativeNotFoundReceiptHash,
      onlineMutationSideEffectPermitHash: value.onlineMutationSideEffectPermitHash,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function buildAutonomousSubmissionDeliveryStateReceipt({
  request,
  portalId,
  state,
  attempt,
  resolution,
  previousStateReceiptHash = null,
  submissionReceipt = null,
  failure = null,
  recordedAt,
  requestVerifier = null,
  completedReceiptVerifier = null,
} = {}) {
  if (requestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || requestVerifier.verify(request) !== true
    || !SAFE_ID.test(String(portalId || ''))
    || !STATES.has(state)
    || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 100
    || !RESOLUTIONS.has(resolution)
    || (previousStateReceiptHash !== null && !SHA256.test(String(previousStateReceiptHash)))
    || !canonicalInstant(recordedAt)) {
    throw new Error('autonomous_submission_delivery_state_receipt_invalid');
  }
  if ((state === 'prepared') !== (attempt === 0)
    || (state === 'prepared') !== (previousStateReceiptHash === null)
    || (state === 'completed') !== Boolean(submissionReceipt)
    || (state === 'completed' && request?.version === 6
      && submissionReceipt?.version !== 6)
    || (['explicit_failure', 'uncertain'].includes(state)) !== Boolean(failure)
    || (submissionReceipt && !verifyAutonomousSubmissionReceipt(submissionReceipt, {
      request,
      requestVerifier,
      completedReceiptVerifier,
    }))) {
    throw new Error('autonomous_submission_delivery_state_receipt_invalid');
  }
  const normalizedFailure = plainFailure(failure);
  const flags = expectedFlags(state);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDeliveryStateReceipt',
    status: `autonomous_submission_delivery_${state}`,
    messageId: autonomousSubmissionOutboxMessageId(request, { requestVerifier }),
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    campaignId: request.campaignId,
    paperId: request.paperId,
    venueId: request.venueId,
    venueProfileHash: request.venueProfileHash,
    immutableCampaignPackageOutputHash: request.immutableCampaignPackageOutputHash,
    submissionMetadataReceiptHash: request.submissionMetadataReceiptHash,
    portalConfigurationHash: request.portalConfigurationHash,
    portalId: String(portalId),
    state,
    attempt,
    resolution,
    previousStateReceiptHash,
    submissionReceipt: submissionReceipt ? Object.freeze({ ...submissionReceipt }) : null,
    failure: normalizedFailure,
    ...flags,
    recordedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousSubmissionDeliveryStateReceiptHash: hashRecord(
      'AutonomousSubmissionDeliveryStateReceipt', payload,
    ),
  });
}

export function verifyAutonomousSubmissionDeliveryStateReceipt(value, {
  request = null,
  requestVerifier = null,
  completedReceiptVerifier = null,
} = {}) {
  const {
    autonomousSubmissionDeliveryStateReceiptHash: claimedHash,
    ...payload
  } = value || {};
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousSubmissionDeliveryStateReceipt', payload) !== claimedHash
    || requestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || requestVerifier.verify(request) !== true) return false;
  let rebuilt;
  try {
    rebuilt = buildAutonomousSubmissionDeliveryStateReceipt({
      request,
      portalId: value.portalId,
      state: value.state,
      attempt: value.attempt,
      resolution: value.resolution,
      previousStateReceiptHash: value.previousStateReceiptHash,
      submissionReceipt: value.submissionReceipt,
      failure: value.failure,
      recordedAt: value.recordedAt,
      requestVerifier,
      completedReceiptVerifier,
    });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(value);
}

export const AUTONOMOUS_SUBMISSION_DELIVERY_STATES = Object.freeze({
  PREPARED: 'prepared',
  DISPATCHING: 'dispatching',
  COMPLETED: 'completed',
  EXPLICIT_FAILURE: 'explicit_failure',
  UNCERTAIN: 'uncertain',
});
