import crypto from 'node:crypto';

import {
  assertAutonomousSubmissionPortalPort,
} from '../../paper-ports/autonomous-submission-portal-port.mjs';
import {
  verifyLegacyAutonomousSubmissionReceipt,
  verifyAutonomousSubmissionReceipt,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  verifyAutonomousSubmissionPortalLookupOutcome,
} from '../../paper-domain/automation/autonomous-submission-delivery-contract.mjs';
import {
  AUTONOMOUS_SUBMISSION_PORTAL_READINESS_CANARY_SUBJECT_KIND,
  buildAutonomousSubmissionPortalReadinessCanaryEvidence,
  buildAutonomousSubmissionPortalReadinessCanaryRequest,
  verifyAutonomousSubmissionPortalReadinessCanaryReceipt,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
  buildAutonomousSubmissionPortalConfiguration,
  createAutonomousSubmissionPortalDescriptor,
  deriveAutonomousSubmissionPortalPublicConfiguration,
} from './autonomous-submission-portal-public-adapter.mjs';

export {
  buildAutonomousSubmissionPortalConfiguration,
  buildAutonomousSubmissionPortalPublicConfiguration,
  createAutonomousSubmissionPortalDescriptor,
  deriveAutonomousSubmissionPortalPublicConfiguration,
  readAutonomousSubmissionPortalConfiguration,
  readAutonomousSubmissionPortalPublicConfiguration,
} from './autonomous-submission-portal-public-adapter.mjs';
const EXPLICIT_REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 410, 413, 415, 422]);
const PORTAL_LOOKUP_SUBJECT_KIND = 'AutonomousSubmissionPortalLookupOutcome';
const PORTAL_SUBMISSION_RECEIPT_SUBJECT_KIND = 'AutonomousSubmissionReceiptV5';

function portalFailure(code, {
  httpStatus = null,
  outcome = 'uncertain',
  cause = null,
} = {}) {
  const error = new Error(code);
  error.autonomousSubmissionOutcome = outcome;
  error.httpStatus = httpStatus;
  if (cause) error.cause = cause;
  return error;
}

function verifiedReceipt(document, request, selected, submissionRequestVerifier, {
  requireCryptographicAuthority = false,
  clock,
  completedReceiptVerifier = null,
} = {}) {
  const receipt = document?.autonomousSubmissionReceipt;
  if (document?.requestHash !== request.requestHash
    || document?.portalId !== selected.portalId
    || document?.serviceIdentityHash !== selected.serviceIdentityHash
    || document?.portalAccountIdentityHash !== selected.portalAccountIdentityHash
    || document?.portalTrustDomainIdentityHash
      !== selected.portalTrustDomainIdentityHash
    || document?.externalActionPerformed !== true
    || !(requireCryptographicAuthority
      ? verifyLegacyAutonomousSubmissionReceipt(receipt, {
        request,
        requestVerifier: submissionRequestVerifier,
      })
      : verifyAutonomousSubmissionReceipt(receipt, {
        request,
        requestVerifier: submissionRequestVerifier,
      }))
    || receipt.portalAccountIdentityHash !== selected.portalAccountIdentityHash
    || receipt.portalTrustDomainIdentityHash
      !== selected.portalTrustDomainIdentityHash) {
    throw portalFailure('autonomous_submission_portal_response_invalid');
  }
  if (!requireCryptographicAuthority) {
    return Object.freeze({ receipt: Object.freeze(receipt), signatureVerificationReceipt: null });
  }
  const signatureVerificationReceipt = assertPinnedExternalEvidenceEnvelope({
    envelope: document?.authorityEnvelope,
    subjectKind: PORTAL_SUBMISSION_RECEIPT_SUBJECT_KIND,
    subjectHash: receipt.autonomousSubmissionReceiptHash,
    trustStore: selected.receiptTrustStore,
    requiredRole: selected.receiptSignerRole,
    expectedKeyIds: selected.receiptSignerKeyIds,
    now: clock.now(),
    maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
  });
  return Object.freeze({
    receipt: completedReceiptVerifier.wrapVerifiedReceipt({
      request,
      requestVerifier: submissionRequestVerifier,
      legacyReceipt: receipt,
      authorityEnvelope: document.authorityEnvelope,
      signatureVerificationReceipt,
    }),
    signatureVerificationReceipt,
  });
}

export function createHttpAutonomousSubmissionPortalAdapter({
  configuration,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  submissionRequestVerifier,
  dispatchCapability,
  requiredLocalOriginIdentitySubjectHashes = [],
  clock = { now: () => new Date() },
} = {}) {
  const selected = buildAutonomousSubmissionPortalConfiguration(configuration);
  const token = String(environment[selected.tokenEnvironmentVariable] || '');
  if (submissionRequestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || typeof submissionRequestVerifier.verify !== 'function') {
    throw new Error('autonomous_submission_request_verifier_required');
  }
  if (dispatchCapability?.kind
      !== 'AutonomousSubmissionPortalDispatchCapabilityAuthority'
    || typeof dispatchCapability.consumeDispatchPermit !== 'function'
    || typeof dispatchCapability.issueAuthoritativeNotFoundReceipt !== 'function') {
    throw new Error('autonomous_submission_portal_dispatch_capability_required');
  }
  if (!token || typeof fetchImpl !== 'function') {
    throw new Error('autonomous_submission_portal_runtime_credentials_missing');
  }
  const descriptor = createAutonomousSubmissionPortalDescriptor({
    configuration: selected,
    requiredLocalOriginIdentitySubjectHashes,
    clock,
  });
  const cryptographicLookupAuthorityReady = descriptor.cryptographicAuthorityReady;
  const completedReceiptVerifier = descriptor.completedReceiptVerifier;
  const identityInspection = descriptor.identitySeparationInspection;
  const identityIndependenceReady = descriptor.identityIndependenceReady;
  const trustSetHash = descriptor.trustSetHash;
  const signatureVerificationPolicyHash = descriptor.signatureVerificationPolicyHash;
  const portalDescriptorHash = autonomousSubmissionPortalPublicDescriptorHash(
    deriveAutonomousSubmissionPortalPublicConfiguration({ configuration: selected }),
  );
  return assertAutonomousSubmissionPortalPort(Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalPort',
    portalId: selected.portalId,
    configurationHash: selected.configurationHash,
    portalDescriptorHash,
    idempotencyLookupSupported: true,
    singleUseDispatchCapabilityEnforced: true,
    authoritativeLookupCapabilityIssued: cryptographicLookupAuthorityReady,
    signedAuthoritativeLookupSupported: cryptographicLookupAuthorityReady,
    authoritativeNotFoundCryptographicAuthorityReady:
      cryptographicLookupAuthorityReady,
    signedCompletedReceiptSupported: cryptographicLookupAuthorityReady,
    // v2+ verifies the pinned envelope before exposing a successful POST or
    // lookup-completed result. v3 also proves six-dimensional platform identity
    // separation from every signed local-origin identity in its pinned set.
    cryptographicAuthorityReady: cryptographicLookupAuthorityReady,
    identityIndependenceReady,
    evidenceProfile: identityIndependenceReady
      ? 'pinned-signed-independent-submission-portal-v3'
      : 'bounded-submission-portal-v1',
    trustSetHash,
    signatureVerificationPolicyHash,
    identitySeparationInspection: identityInspection,
    completedReceiptVerifier,
    async probeReadiness({ challenge, signal = null } = {}) {
      if (!cryptographicLookupAuthorityReady
        || challenge?.portalId !== selected.portalId
        || challenge?.portalConfigurationHash !== selected.configurationHash
        || challenge?.portalDescriptorHash !== portalDescriptorHash) {
        throw portalFailure('autonomous_submission_portal_canary_binding_invalid');
      }
      const requestedAt = clock.now().toISOString();
      const request = buildAutonomousSubmissionPortalReadinessCanaryRequest({
        challenge,
        nonce: `canary:${crypto.randomUUID()}`,
        requestedAt,
      });
      const endpoint = new URL(selected.endpoint);
      endpoint.searchParams.set('heptaReadinessCanary', 'signed-no-side-effect-v1');
      endpoint.searchParams.set('challengeHash', challenge.challengeHash);
      endpoint.searchParams.set('requestHash', request.requestHash);
      endpoint.searchParams.set('nonce', request.nonce);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      let response;
      try {
        try {
          response = await fetchImpl(endpoint.toString(), {
            method: 'GET',
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
              'x-hepta-readiness-canary': 'signed-no-side-effect-v1',
            },
            signal: controller.signal,
          });
        } catch (error) {
          throw portalFailure('autonomous_submission_portal_canary_transport_failed', {
            cause: error,
          });
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
      }
      if (!response?.ok) {
        throw portalFailure(
          `autonomous_submission_portal_canary_http_failed:${response?.status || 0}`,
          { httpStatus: Number(response?.status || 0) || null },
        );
      }
      let document;
      try { document = await response.json(); }
      catch (error) {
        throw portalFailure('autonomous_submission_portal_canary_response_unreadable', {
          cause: error,
        });
      }
      const receipt = document?.autonomousSubmissionPortalReadinessCanaryReceipt;
      const observedAt = clock.now();
      if (document?.requestHash !== request.requestHash
        || document?.portalId !== selected.portalId
        || document?.serviceIdentityHash !== selected.serviceIdentityHash
        || document?.portalAccountIdentityHash !== selected.portalAccountIdentityHash
        || document?.portalTrustDomainIdentityHash
          !== selected.portalTrustDomainIdentityHash
        || document?.externalActionPerformed !== false
        || receipt?.portalId !== selected.portalId
        || receipt?.portalConfigurationHash !== selected.configurationHash
        || receipt?.portalDescriptorHash !== portalDescriptorHash
        || receipt?.serviceIdentityHash !== selected.serviceIdentityHash
        || receipt?.portalAccountIdentityHash !== selected.portalAccountIdentityHash
        || receipt?.portalTrustDomainIdentityHash
          !== selected.portalTrustDomainIdentityHash
        || Date.parse(receipt?.expiresAt) > Math.min(
          Date.parse(challenge.expiresAt),
          observedAt.getTime() + selected.receiptMaximumLifetimeMs,
        )
        || !verifyAutonomousSubmissionPortalReadinessCanaryReceipt(receipt, {
          request,
          now: observedAt,
        })) {
        throw portalFailure('autonomous_submission_portal_canary_response_invalid');
      }
      const signatureVerificationReceipt = assertPinnedExternalEvidenceEnvelope({
        envelope: document?.authorityEnvelope,
        subjectKind: AUTONOMOUS_SUBMISSION_PORTAL_READINESS_CANARY_SUBJECT_KIND,
        subjectHash: receipt.canaryReceiptHash,
        trustStore: selected.receiptTrustStore,
        requiredRole: selected.receiptSignerRole,
        expectedKeyIds: selected.receiptSignerKeyIds,
        now: observedAt,
        maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
      });
      const evidence = buildAutonomousSubmissionPortalReadinessCanaryEvidence({
        challenge,
        request,
        receipt,
        authorityEnvelope: document.authorityEnvelope,
      });
      return Object.freeze({
        status: 'autonomous_submission_portal_readiness_canary_verified',
        ready: true,
        request,
        receipt: Object.freeze(receipt),
        canaryReceiptHash: receipt.canaryReceiptHash,
        signatureVerificationReceipt,
        evidence,
        pinnedExternalEvidenceVerificationReceiptHash:
          signatureVerificationReceipt.pinnedExternalEvidenceVerificationReceiptHash,
        externalActionPerformed: false,
      });
    },
    async submit({ request, sideEffectPermit, signal = null } = {}) {
      if (submissionRequestVerifier.verify(request) !== true
        || request.portalConfigurationHash !== selected.configurationHash) {
        throw new Error('autonomous_submission_portal_request_invalid');
      }
      dispatchCapability.consumeDispatchPermit({
        permit: sideEffectPermit,
        request,
        portalId: selected.portalId,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      let response;
      try {
        try {
          response = await fetchImpl(selected.endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'idempotency-key': request.idempotencyKey,
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          });
        } catch (error) {
          throw portalFailure('autonomous_submission_portal_transport_uncertain', {
            cause: error,
          });
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
      }
      if (!response?.ok) {
        const httpStatus = Number(response?.status || 0);
        throw portalFailure(`autonomous_submission_portal_http_failed:${httpStatus}`, {
          httpStatus,
          outcome: EXPLICIT_REJECTION_STATUSES.has(httpStatus)
            ? 'explicit_failure' : 'uncertain',
        });
      }
      let document;
      try { document = await response.json(); }
      catch (error) {
        throw portalFailure('autonomous_submission_portal_response_unreadable', { cause: error });
      }
      return verifiedReceipt(document, request, selected, submissionRequestVerifier, {
        requireCryptographicAuthority: cryptographicLookupAuthorityReady,
        clock,
        completedReceiptVerifier,
      }).receipt;
    },
    async lookup({ request, signal = null } = {}) {
      if (submissionRequestVerifier.verify(request) !== true
        || request.portalConfigurationHash !== selected.configurationHash) {
        throw new Error('autonomous_submission_portal_request_invalid');
      }
      const endpoint = new URL(selected.endpoint);
      endpoint.searchParams.set('idempotencyKey', request.idempotencyKey);
      endpoint.searchParams.set('requestHash', request.requestHash);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      let response;
      try {
        try {
          response = await fetchImpl(endpoint.toString(), {
            method: 'GET',
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
              'idempotency-key': request.idempotencyKey,
            },
            signal: controller.signal,
          });
        } catch (error) {
          throw portalFailure('autonomous_submission_portal_lookup_uncertain', { cause: error });
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
      }
      if (Number(response?.status) === 404) {
        throw portalFailure('autonomous_submission_portal_unsigned_not_found', {
          httpStatus: 404,
          outcome: 'uncertain',
        });
      }
      if (!response?.ok) {
        throw portalFailure(
          `autonomous_submission_portal_lookup_http_failed:${response?.status || 0}`,
          { httpStatus: Number(response?.status || 0) || null },
        );
      }
      let document;
      try { document = await response.json(); }
      catch (error) {
        throw portalFailure('autonomous_submission_portal_lookup_response_unreadable', {
          cause: error,
        });
      }
      const remoteLookupOutcome = document?.autonomousSubmissionPortalLookupOutcome || null;
      if (remoteLookupOutcome) {
        if (!cryptographicLookupAuthorityReady
          || document?.requestHash !== request.requestHash
          || document?.portalId !== selected.portalId
          || document?.serviceIdentityHash !== selected.serviceIdentityHash
          || document?.portalAccountIdentityHash !== selected.portalAccountIdentityHash
          || document?.portalTrustDomainIdentityHash
            !== selected.portalTrustDomainIdentityHash
          || document?.externalActionPerformed !== false
          || remoteLookupOutcome.serviceIdentityHash !== selected.serviceIdentityHash
          || remoteLookupOutcome.portalAccountIdentityHash
            !== selected.portalAccountIdentityHash
          || remoteLookupOutcome.portalTrustDomainIdentityHash
            !== selected.portalTrustDomainIdentityHash
          || !verifyAutonomousSubmissionPortalLookupOutcome(remoteLookupOutcome, {
            request,
            portalId: selected.portalId,
          })) {
          throw portalFailure('autonomous_submission_portal_signed_not_found_invalid');
        }
        const signatureVerificationReceipt = assertPinnedExternalEvidenceEnvelope({
          envelope: document?.authorityEnvelope,
          subjectKind: PORTAL_LOOKUP_SUBJECT_KIND,
          subjectHash: remoteLookupOutcome.autonomousSubmissionPortalLookupOutcomeHash,
          trustStore: selected.receiptTrustStore,
          requiredRole: selected.receiptSignerRole,
          expectedKeyIds: selected.receiptSignerKeyIds,
          now: clock.now(),
          maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
        });
        const authoritativeNotFoundReceipt =
          dispatchCapability.issueAuthoritativeNotFoundReceipt({
            request,
            portalId: selected.portalId,
            remoteLookupOutcome,
            authorityEnvelope: document.authorityEnvelope,
            signatureVerificationReceipt,
          });
        return Object.freeze({
          status: 'autonomous_submission_portal_authoritative_not_found',
          requestHash: request.requestHash,
          idempotencyKey: request.idempotencyKey,
          authoritative: true,
          cryptographicAuthorityVerified: true,
          externalActionPerformed: false,
          remoteLookupOutcome,
          signatureVerificationReceipt,
          authoritativeNotFoundReceipt,
        });
      }
      const completed = verifiedReceipt(
        document,
        request,
        selected,
        submissionRequestVerifier,
        {
          requireCryptographicAuthority: cryptographicLookupAuthorityReady,
          clock,
          // The same verifier is reused by the transactional outbox after JSON
          // persistence; no live capability token is persisted.
          completedReceiptVerifier,
        },
      );
      return Object.freeze({
        status: 'autonomous_submission_portal_completed',
        requestHash: request.requestHash,
        idempotencyKey: request.idempotencyKey,
        authoritative: true,
        externalActionPerformed: true,
        cryptographicAuthorityVerified: cryptographicLookupAuthorityReady,
        signatureVerificationReceipt: completed.signatureVerificationReceipt,
        receipt: completed.receipt,
      });
    },
  }));
}
