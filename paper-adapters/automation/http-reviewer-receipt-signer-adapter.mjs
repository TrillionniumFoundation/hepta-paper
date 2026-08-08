import { assertReviewerReceiptSignerPort } from '../../paper-ports/reviewer-receipt-signer-port.mjs';
import {
  buildCryptographicSignedReviewerReceipt,
  REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
  REVIEWER_RECEIPT_SIGNER_ROLE,
  REVIEWER_RECEIPT_SIGNING_SUBJECT_KIND,
  verifySignedReviewerReceipt,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import {
  evaluateExternalPrincipalIdentitySeparation,
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  buildReviewerReceiptSigningRecoveryOutcome,
} from '../../paper-domain/research/external-operation-recovery-outcome-contract.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
  assertPinnedExternalEvidenceVerificationReceipt,
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  createExternalPrincipalIdentityAttestationBundleCodec,
} from '../authority/external-principal-identity-attestation-bundle-codec.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resolveOpaqueRuntimeCredential } from './opaque-runtime-credential-file.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const CONFIG_KEYS_V1 = Object.freeze([
  'configurationHash', 'endpoint', 'kind', 'serviceId', 'serviceIdentityHash',
  'signerIdentityHash', 'timeoutMs', 'tokenEnvironmentVariable', 'version',
]);
const CONFIG_KEYS_V2 = Object.freeze([
  ...CONFIG_KEYS_V1,
  'identityAttestationBundle', 'receiptMaximumLifetimeMs', 'receiptSignerKeyIds',
  'receiptSignerRole', 'receiptTrustStore', 'receiptTrustStoreHash',
]);
const CONFIG_KEYS_V3 = Object.freeze([
  ...CONFIG_KEYS_V2,
  'lookupEndpoint', 'resumeEndpoint',
]);
const IDENTITY_ATTESTOR_ROLE = 'external_principal_identity_attestor';
const reviewerSignerIdentityAttestationBundleCodec =
  createExternalPrincipalIdentityAttestationBundleCodec({
    bundleKind: 'ReviewerSignerIdentityAttestationBundle',
    signerRole: IDENTITY_ATTESTOR_ROLE,
    invalidBundleError: 'reviewer_signer_identity_attestation_bundle_invalid',
  });

function requestAbortError(signal, code) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(code);
  error.name = 'AbortError';
  return error;
}

function canonicalKeyIds(values) {
  const selected = [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
  return selected.length >= 1 && selected.length <= 4
    && selected.every((value) => SAFE_ID.test(value)) ? Object.freeze(selected) : null;
}

export function reviewerReceiptSignerCryptographicIdentityHash({
  receiptTrustStoreHash,
  receiptSignerKeyIds,
  receiptSignerRole = REVIEWER_RECEIPT_SIGNER_ROLE,
} = {}) {
  const keyIds = canonicalKeyIds(receiptSignerKeyIds);
  if (!SHA256.test(String(receiptTrustStoreHash || '')) || !keyIds
    || receiptSignerRole !== REVIEWER_RECEIPT_SIGNER_ROLE) {
    throw new Error('reviewer_receipt_signer_cryptographic_identity_invalid');
  }
  return hashRecord('ReviewerReceiptSignerCryptographicIdentity', {
    receiptTrustStoreHash,
    receiptSignerKeyIds: keyIds,
    receiptSignerRole,
  });
}

export function buildReviewerSignerIdentityAttestationBundle({
  subject,
  authorityEnvelope,
  trustStore,
  signerKeyIds,
  signerRole = IDENTITY_ATTESTOR_ROLE,
  maximumLifetimeMs = 15 * 60 * 1000,
} = {}) {
  return reviewerSignerIdentityAttestationBundleCodec.build({
    subject,
    authorityEnvelope,
    trustStore,
    signerKeyIds,
    signerRole,
    maximumLifetimeMs,
  });
}

export function verifyReviewerSignerIdentityAttestationBundle(bundle) {
  return reviewerSignerIdentityAttestationBundleCodec.verify(bundle);
}

export function buildReviewerReceiptSignerServiceConfiguration({
  version = 1,
  serviceId,
  endpoint,
  serviceIdentityHash,
  signerIdentityHash = null,
  tokenEnvironmentVariable,
  timeoutMs = 60_000,
  receiptTrustStore = null,
  receiptSignerKeyIds = [],
  receiptSignerRole = REVIEWER_RECEIPT_SIGNER_ROLE,
  receiptMaximumLifetimeMs = 15 * 60 * 1000,
  identityAttestationBundle = null,
  lookupEndpoint = null,
  resumeEndpoint = null,
} = {}) {
  let url;
  try { url = new URL(String(endpoint || '')); }
  catch { throw new Error('reviewer_receipt_signer_endpoint_invalid'); }
  if (![1, 2, 3].includes(Number(version)) || url.protocol !== 'https:'
    || !SAFE_ID.test(String(serviceId || ''))
    || !SHA256.test(String(serviceIdentityHash || '').toLowerCase())
    || !/^[A-Z][A-Z0-9_]{1,127}$/.test(String(tokenEnvironmentVariable || ''))
    || !Number.isSafeInteger(Number(timeoutMs)) || Number(timeoutMs) < 1_000
    || Number(timeoutMs) > 10 * 60 * 1000) {
    throw new Error('reviewer_receipt_signer_service_configuration_invalid');
  }
  const payload = {
    version: Number(version),
    kind: 'ReviewerReceiptSignerServiceConfiguration',
    serviceId: String(serviceId),
    endpoint: url.toString(),
    serviceIdentityHash: String(serviceIdentityHash).toLowerCase(),
    signerIdentityHash: null,
    tokenEnvironmentVariable: String(tokenEnvironmentVariable),
    timeoutMs: Number(timeoutMs),
  };
  if (Number(version) === 1) {
    const selectedSignerIdentityHash = String(signerIdentityHash || '').toLowerCase();
    if (!SHA256.test(selectedSignerIdentityHash)) {
      throw new Error('reviewer_receipt_signer_service_configuration_invalid');
    }
    payload.signerIdentityHash = selectedSignerIdentityHash;
  } else {
    const expectedKeyIds = canonicalKeyIds(receiptSignerKeyIds);
    const trust = inspectPinnedExternalEvidenceTrustStore(receiptTrustStore, {
      requiredRole: receiptSignerRole,
      expectedKeyIds,
    });
    if (!expectedKeyIds || receiptSignerRole !== REVIEWER_RECEIPT_SIGNER_ROLE
      || !trust.ready || !Number.isSafeInteger(Number(receiptMaximumLifetimeMs))
      || Number(receiptMaximumLifetimeMs) < 1_000
      || Number(receiptMaximumLifetimeMs) > 24 * 60 * 60 * 1000) {
      throw new Error('reviewer_receipt_signer_trust_configuration_invalid');
    }
    const derivedSignerIdentityHash = reviewerReceiptSignerCryptographicIdentityHash({
      receiptTrustStoreHash: trust.trustStoreHash,
      receiptSignerKeyIds: expectedKeyIds,
      receiptSignerRole,
    });
    if (signerIdentityHash !== null && signerIdentityHash !== undefined
      && String(signerIdentityHash).toLowerCase() !== derivedSignerIdentityHash) {
      throw new Error('reviewer_receipt_signer_identity_binding_invalid');
    }
    let identityBundle = null;
    if (identityAttestationBundle !== null) {
      identityBundle = buildReviewerSignerIdentityAttestationBundle(identityAttestationBundle);
    }
    Object.assign(payload, {
      signerIdentityHash: derivedSignerIdentityHash,
      receiptTrustStore: trust.canonicalTrustStore,
      receiptTrustStoreHash: trust.trustStoreHash,
      receiptSignerKeyIds: expectedKeyIds,
      receiptSignerRole: REVIEWER_RECEIPT_SIGNER_ROLE,
      receiptMaximumLifetimeMs: Number(receiptMaximumLifetimeMs),
      identityAttestationBundle: identityBundle,
    });
    if (Number(version) === 3) {
      let lookupUrl;
      let resumeUrl;
      try {
        lookupUrl = new URL(String(lookupEndpoint || ''));
        resumeUrl = new URL(String(resumeEndpoint || ''));
      } catch {
        throw new Error('reviewer_receipt_signer_recovery_endpoint_invalid');
      }
      if (lookupUrl.protocol !== 'https:' || resumeUrl.protocol !== 'https:') {
        throw new Error('reviewer_receipt_signer_recovery_endpoint_invalid');
      }
      Object.assign(payload, {
        lookupEndpoint: lookupUrl.toString(),
        resumeEndpoint: resumeUrl.toString(),
      });
    }
  }
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('ReviewerReceiptSignerServiceConfiguration', payload),
  });
}

export function verifyReviewerReceiptSignerServiceConfiguration(configuration) {
  const keys = configuration?.version === 3
    ? CONFIG_KEYS_V3 : configuration?.version === 2 ? CONFIG_KEYS_V2 : CONFIG_KEYS_V1;
  if (!hasExactObjectKeys(configuration, keys)) return false;
  try {
    return JSON.stringify(buildReviewerReceiptSignerServiceConfiguration(configuration))
      === JSON.stringify(configuration);
  } catch { return false; }
}

export function createHttpReviewerReceiptSignerAdapter({
  configuration,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  clock = { now: () => new Date() },
} = {}) {
  const selected = buildReviewerReceiptSignerServiceConfiguration(configuration);
  const token = resolveOpaqueRuntimeCredential({
    environment,
    variableName: selected.tokenEnvironmentVariable,
  });
  if (!token || typeof fetchImpl !== 'function') {
    throw new Error('reviewer_receipt_signer_runtime_credentials_missing');
  }
  let identityAttestationVerificationReceipt = null;
  let identityAttestationSubject = null;
  if (selected.version >= 2 && selected.identityAttestationBundle) {
    const bundle = selected.identityAttestationBundle;
    const now = clock.now();
    if (!verifyExternalPrincipalIdentityAttestationSubject(bundle.subject, {
      now,
      maximumLifetimeMs: bundle.maximumLifetimeMs,
      requirePlatformAttestation: true,
    })) {
      throw new Error('reviewer_signer_identity_attestation_expired_or_invalid');
    }
    identityAttestationVerificationReceipt = assertPinnedExternalEvidenceEnvelope({
      envelope: bundle.authorityEnvelope,
      subjectKind: REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
      subjectHash: bundle.subject.externalPrincipalIdentityAttestationSubjectHash,
      trustStore: bundle.trustStore,
      requiredRole: bundle.signerRole,
      expectedKeyIds: bundle.signerKeyIds,
      now,
      maximumLifetimeMs: bundle.maximumLifetimeMs,
    });
    const receiptTrust = inspectPinnedExternalEvidenceTrustStore(
      selected.receiptTrustStore,
      { requiredRole: selected.receiptSignerRole, expectedKeyIds: selected.receiptSignerKeyIds },
    );
    const receiptSignerSpkiHashes = receiptTrust.keys
      .filter((key) => selected.receiptSignerKeyIds.includes(key.keyId))
      .map((key) => key.publicKeySpkiHash);
    if (bundle.subject.serviceId !== selected.serviceId
      || !receiptSignerSpkiHashes.includes(bundle.subject.signerPublicKeySpkiHash)) {
      throw new Error('reviewer_signer_identity_attestation_binding_invalid');
    }
    identityAttestationSubject = bundle.subject;
  }
  const trustSetHash = selected.version >= 2
    ? hashRecord('ReviewerReceiptSignerTrustSet', {
      receiptTrustStoreHash: selected.receiptTrustStoreHash,
      identityTrustStoreHash: selected.identityAttestationBundle?.trustStoreHash || null,
    }) : null;
  const signatureVerificationPolicyHash = selected.version >= 2
    ? hashRecord('ReviewerReceiptSignatureVerificationPolicy', {
      policy: 'pinned-canonical-json-ed25519-v1',
      receiptSignerRole: selected.receiptSignerRole,
      receiptSignerKeyIds: selected.receiptSignerKeyIds,
      receiptMaximumLifetimeMs: selected.receiptMaximumLifetimeMs,
    }) : null;
  const verificationCoreMatches = (embedded, fresh) => [
    'status', 'verificationPolicy', 'subjectKind', 'subjectHash', 'requiredRole',
    'trustStoreHash', 'envelopeHash', 'signedAt', 'expiresAt',
  ].every((field) => embedded?.[field] === fresh?.[field])
    && JSON.stringify(embedded?.verifiedKeyIds) === JSON.stringify(fresh?.verifiedKeyIds)
    && JSON.stringify(embedded?.verifiedSubjectIds)
      === JSON.stringify(fresh?.verifiedSubjectIds)
    && JSON.stringify(embedded?.verifiedPublicKeySpkiHashes)
      === JSON.stringify(fresh?.verifiedPublicKeySpkiHashes);
  const verifyCryptographicReceipt = ({
    receipt,
    expected = {},
    identityReferenceSigners = [],
    identityReferenceAuthorities = [],
    now = clock.now(),
  } = {}) => {
    if (selected.version < 2 || receipt?.version !== 2
      || receipt?.signerIdentityHash !== selected.signerIdentityHash) return false;
    let freshSignatureVerification;
    try {
      freshSignatureVerification = assertPinnedExternalEvidenceEnvelope({
        envelope: receipt.authorityEnvelope,
        subjectKind: REVIEWER_RECEIPT_SIGNING_SUBJECT_KIND,
        subjectHash: receipt.subjectHash,
        trustStore: selected.receiptTrustStore,
        requiredRole: selected.receiptSignerRole,
        expectedKeyIds: selected.receiptSignerKeyIds,
        now,
        maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
      });
    } catch { return false; }
    if (!verificationCoreMatches(
      receipt.signatureVerificationReceipt,
      freshSignatureVerification,
    )) return false;

    if (selected.identityAttestationBundle) {
      const bundle = selected.identityAttestationBundle;
      let freshIdentityVerification;
      try {
        freshIdentityVerification = assertPinnedExternalEvidenceEnvelope({
          envelope: bundle.authorityEnvelope,
          subjectKind: REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
          subjectHash: bundle.subject.externalPrincipalIdentityAttestationSubjectHash,
          trustStore: bundle.trustStore,
          requiredRole: bundle.signerRole,
          expectedKeyIds: bundle.signerKeyIds,
          now,
          maximumLifetimeMs: bundle.maximumLifetimeMs,
        });
      } catch { return false; }
      if (!verifyExternalPrincipalIdentityAttestationSubject(bundle.subject, {
        now,
        maximumLifetimeMs: bundle.maximumLifetimeMs,
        requirePlatformAttestation: true,
      }) || bundle.subject.principalId !== receipt.principalId
        || JSON.stringify(receipt.identityAttestationSubject)
        !== JSON.stringify(bundle.subject)
        || JSON.stringify(receipt.identityAttestationAuthorityEnvelope)
          !== JSON.stringify(bundle.authorityEnvelope)
        || !verificationCoreMatches(
          receipt.identityAttestationVerificationReceipt,
          freshIdentityVerification,
        )) return false;
      const references = [];
      for (const referenceAuthority of identityReferenceAuthorities) {
        try {
          if (!verifyExternalPrincipalIdentityAttestationSubject(
            referenceAuthority?.subject,
            { now, requirePlatformAttestation: true },
          )) return false;
          assertPinnedExternalEvidenceVerificationReceipt(
            referenceAuthority?.verificationReceipt,
            {
              subjectKind: REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
              subjectHash: referenceAuthority.subject
                .externalPrincipalIdentityAttestationSubjectHash,
              requiredRole: IDENTITY_ATTESTOR_ROLE,
            },
          );
          references.push(referenceAuthority.subject);
        } catch { return false; }
      }
      for (const referenceSigner of identityReferenceSigners) {
        try {
          if (referenceSigner === null || referenceSigner === undefined
            || referenceSigner.serviceId === selected.serviceId
            || !verifyExternalPrincipalIdentityAttestationSubject(
              referenceSigner.identityAttestationSubject,
              { now, requirePlatformAttestation: true },
            )) return false;
          assertPinnedExternalEvidenceVerificationReceipt(
            referenceSigner.identityAttestationVerificationReceipt,
            {
              subjectKind: REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
              subjectHash: referenceSigner.identityAttestationSubject
                .externalPrincipalIdentityAttestationSubjectHash,
              requiredRole: IDENTITY_ATTESTOR_ROLE,
            },
          );
          references.push(referenceSigner.identityAttestationSubject);
        } catch { return false; }
      }
      const separation = evaluateExternalPrincipalIdentitySeparation({
        candidate: bundle.subject,
        references,
        now,
        requirePlatformAttestation: true,
      });
      if (!separation.identityIndependenceReady
        || JSON.stringify(separation) !== JSON.stringify(receipt.identitySeparationReceipt)) {
        return false;
      }
    } else if (receipt.identityIndependenceReady !== false
      || receipt.identityAttestationSubject !== null
      || receipt.identitySeparationReceipt !== null) return false;

    return verifySignedReviewerReceipt(receipt, expected, {
      // All authority documents and identity references were independently
      // reverified above against this adapter's pinned configuration.
      cryptographicVerifier: () => true,
    });
  };
  const signingContext = ({ subjectHash, principal } = {}) => {
    if (!SHA256.test(String(subjectHash || ''))
      || principal?.signerIdentityHash !== selected.signerIdentityHash) {
      throw new Error('reviewer_receipt_signer_request_invalid');
    }
    if (identityAttestationSubject && (
      identityAttestationSubject.principalId !== principal.principalId
      || identityAttestationSubject.provider !== principal.provider
      || identityAttestationSubject.providerAccountIdentityHash
        !== principal.providerAccountIdentityHash
      || identityAttestationSubject.credentialRootIdentityHash
        !== principal.credentialRootIdentityHash
      || identityAttestationSubject.trustDomainIdentityHash
        !== principal.trustDomainIdentityHash
    )) {
      throw new Error('reviewer_receipt_signer_principal_identity_binding_invalid');
    }
    const requestPayload = Object.freeze({
      version: selected.version,
      kind: 'ReviewerReceiptSigningRequest',
      subjectHash,
      principalId: principal.principalId,
      principalDescriptorHash: principal.principalDescriptorHash,
      researchPrincipalPoolHash: principal.researchPrincipalPoolHash || null,
    });
    return Object.freeze({
      subjectHash,
      principal,
      requestPayload,
      requestHash: hashRecord('ReviewerReceiptSigningRequest', requestPayload),
    });
  };
  const receiptFromDocument = (document, context, {
    operationId = null,
    idempotencyKey = null,
  } = {}) => {
    const { subjectHash, principal, requestHash } = context;
    if (document?.requestHash !== requestHash
      || document?.serviceId !== selected.serviceId
      || document?.serviceIdentityHash !== selected.serviceIdentityHash
      || document?.externalActionPerformed !== true
      || (selected.version === 3
        && (document?.operationStatus !== 'completed'
          || document?.operationId !== operationId
          || document?.idempotencyKey !== idempotencyKey))) {
      throw new Error('reviewer_receipt_signer_response_invalid');
    }
    if (selected.version === 3) {
      verifyRecoveryOutcome(document, context, {
        operationId,
        idempotencyKey,
        resultHash: subjectHash,
      });
    }
    if (selected.version === 1) {
      const receipt = document?.signedReviewerReceipt;
      if (!verifySignedReviewerReceipt(receipt, {
        subjectHash,
        principalId: principal.principalId,
        principalDescriptorHash: principal.principalDescriptorHash,
        researchPrincipalPoolHash: principal.researchPrincipalPoolHash,
        signerIdentityHash: selected.signerIdentityHash,
      })) throw new Error('reviewer_receipt_signer_response_invalid');
      return Object.freeze(receipt);
    }
    const signatureVerificationReceipt = assertPinnedExternalEvidenceEnvelope({
      envelope: document?.authorityEnvelope,
      subjectKind: REVIEWER_RECEIPT_SIGNING_SUBJECT_KIND,
      subjectHash,
      trustStore: selected.receiptTrustStore,
      requiredRole: selected.receiptSignerRole,
      expectedKeyIds: selected.receiptSignerKeyIds,
      now: clock.now(),
      maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
    });
    const receipt = buildCryptographicSignedReviewerReceipt({
      subjectHash,
      principalId: principal.principalId,
      principalDescriptorHash: principal.principalDescriptorHash,
      researchPrincipalPoolHash: principal.researchPrincipalPoolHash,
      signerIdentityHash: selected.signerIdentityHash,
      authorityEnvelope: document.authorityEnvelope,
      signatureVerificationReceipt,
      identityAttestationSubject,
      identityAttestationAuthorityEnvelope:
        selected.identityAttestationBundle?.authorityEnvelope || null,
      identityAttestationVerificationReceipt,
      identitySeparationReceipt: principal.identitySeparationReceipt || null,
    }, {
      assertVerificationReceipt:
        assertPinnedExternalEvidenceVerificationReceipt,
      identityReferenceSubjects: principal.identityReferenceSubjects || [],
    });
    if (!verifySignedReviewerReceipt(receipt, {
      subjectHash,
      principalId: principal.principalId,
      principalDescriptorHash: principal.principalDescriptorHash,
      researchPrincipalPoolHash: principal.researchPrincipalPoolHash,
      signerIdentityHash: selected.signerIdentityHash,
    })) throw new Error('reviewer_receipt_signer_response_invalid');
    return Object.freeze(receipt);
  };
  const invokeHttp = async (endpoint, init, signal) => {
    if (signal?.aborted) {
      throw requestAbortError(signal, 'reviewer_receipt_signer_request_aborted');
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
    try {
      if (controller.signal.aborted) {
        throw requestAbortError(signal, 'reviewer_receipt_signer_request_aborted');
      }
      return await fetchImpl(endpoint, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  };
  const recoveryConfigurationIdentityHash = selected.version === 3
    ? hashRecord('ReviewerReceiptSignerRecoveryConfiguration', {
      configurationHash: selected.configurationHash,
      lookupEndpoint: selected.lookupEndpoint,
      resumeEndpoint: selected.resumeEndpoint,
      protocol: 'pinned-signed-lookup-resume-idempotency-v1',
    }) : null;
  const recoveryOutcomeVerificationPolicyHash = selected.version === 3
    ? hashRecord('ReviewerReceiptSigningRecoveryOutcomeVerificationPolicy', {
      receiptTrustStoreHash: selected.receiptTrustStoreHash,
      receiptSignerKeyIds: selected.receiptSignerKeyIds,
      receiptSignerRole: selected.receiptSignerRole,
      receiptMaximumLifetimeMs: selected.receiptMaximumLifetimeMs,
      policy: 'pinned-canonical-json-ed25519-v1',
    }) : null;
  function verifyRecoveryOutcome(document, context, {
    operationId,
    idempotencyKey,
    resultHash,
  }) {
    if (selected.version !== 3
      || document?.operationId !== operationId
      || document?.idempotencyKey !== idempotencyKey
      || document?.requestHash !== context.requestHash
      || document?.serviceId !== selected.serviceId
      || document?.serviceIdentityHash !== selected.serviceIdentityHash) {
      throw new Error('reviewer_receipt_signer_recovery_response_invalid');
    }
    let outcome;
    try {
      outcome = buildReviewerReceiptSigningRecoveryOutcome({
        serviceId: selected.serviceId,
        serviceIdentityHash: selected.serviceIdentityHash,
        operationId,
        idempotencyKey,
        requestHash: context.requestHash,
        operationStatus: document.operationStatus,
        externalActionPerformed: document.externalActionPerformed,
        resultHash,
      });
    } catch {
      throw new Error('reviewer_receipt_signer_recovery_response_invalid');
    }
    assertPinnedExternalEvidenceEnvelope({
      envelope: document?.recoveryAuthorityEnvelope,
      subjectKind: outcome.kind,
      subjectHash: outcome.reviewerReceiptSigningRecoveryOutcomeHash,
      trustStore: selected.receiptTrustStore,
      requiredRole: selected.receiptSignerRole,
      expectedKeyIds: selected.receiptSignerKeyIds,
      now: clock.now(),
      maximumLifetimeMs: selected.receiptMaximumLifetimeMs,
    });
    return outcome;
  }
  const recoveryResolution = async (action, {
    operationId,
    subjectHash,
    principal,
    idempotencyKey,
    signal = null,
  } = {}) => {
    if (selected.version !== 3
      || !SHA256.test(String(operationId || ''))
      || !SHA256.test(String(idempotencyKey || ''))) {
      throw new Error('reviewer_receipt_signer_recovery_request_invalid');
    }
    const context = signingContext({ subjectHash, principal });
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'operation-id': operationId,
    };
    let endpoint = selected.resumeEndpoint;
    let init = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        kind: 'ReviewerReceiptSigningResumeRequest',
        operationId,
        idempotencyKey,
        request: context.requestPayload,
        requestHash: context.requestHash,
      }),
    };
    if (action === 'lookup') {
      endpoint = new URL(selected.lookupEndpoint);
      endpoint.searchParams.set('operationId', operationId);
      endpoint.searchParams.set('idempotencyKey', idempotencyKey);
      endpoint.searchParams.set('requestHash', context.requestHash);
      init = { method: 'GET', headers };
    }
    const response = await invokeHttp(endpoint, init, signal);
    if (!response?.ok) {
      throw new Error(
        `reviewer_receipt_signer_recovery_http_failed:${response?.status || 0}`,
      );
    }
    const document = await response.json();
    if (document?.operationId !== operationId
      || document?.idempotencyKey !== idempotencyKey
      || document?.requestHash !== context.requestHash
      || document?.serviceId !== selected.serviceId
      || document?.serviceIdentityHash !== selected.serviceIdentityHash
      || !['completed', 'in_progress', 'not_found']
        .includes(document?.operationStatus)) {
      throw new Error('reviewer_receipt_signer_recovery_response_invalid');
    }
    if (document.operationStatus !== 'completed') {
      if ((document.signedReviewerReceipt !== null
          && document.signedReviewerReceipt !== undefined)
        || (document.authorityEnvelope !== null
          && document.authorityEnvelope !== undefined)) {
        throw new Error('reviewer_receipt_signer_recovery_response_invalid');
      }
      verifyRecoveryOutcome(document, context, {
        operationId,
        idempotencyKey,
        resultHash: null,
      });
      return Object.freeze({
        status: document.operationStatus,
        receipt: null,
      });
    }
    return Object.freeze({
      status: 'completed',
      receipt: receiptFromDocument(document, context, {
        operationId,
        idempotencyKey,
      }),
    });
  };
  return assertReviewerReceiptSignerPort(Object.freeze({
    version: selected.version === 1 ? 1 : 2,
    configurationVersion: selected.version,
    kind: 'ReviewerReceiptSignerPort',
    serviceId: selected.serviceId,
    signerIdentityHash: selected.signerIdentityHash,
    configurationHash: selected.configurationHash,
    crashRecoveryReady: selected.version === 3,
    recoveryConfigurationIdentityHash,
    recoveryOutcomeCryptographicAuthorityReady: selected.version === 3,
    recoveryOutcomeVerificationPolicyHash,
    cryptographicAuthorityReady: selected.version >= 2,
    identityIndependenceReady: false,
    trustSetHash,
    signatureVerificationPolicyHash,
    identityAttestationSubject,
    identityAttestationVerificationReceipt,
    verifySignedReceipt: verifyCryptographicReceipt,
    async lookup(input) {
      return recoveryResolution('lookup', input);
    },
    async resume(input) {
      return recoveryResolution('resume', input);
    },
    async sign({
      operationId = null,
      subjectHash,
      principal,
      idempotencyKey = null,
      signal = null,
    } = {}) {
      if (selected.version === 3
        && (!SHA256.test(String(operationId || ''))
          || !SHA256.test(String(idempotencyKey || '')))) {
        throw new Error('reviewer_receipt_signer_request_invalid');
      }
      const context = signingContext({ subjectHash, principal });
      const response = await invokeHttp(selected.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(selected.version === 3 ? {
            'idempotency-key': idempotencyKey,
            'operation-id': operationId,
          } : {}),
        },
        body: JSON.stringify({
          ...context.requestPayload,
          requestHash: context.requestHash,
          ...(selected.version === 3 ? { operationId, idempotencyKey } : {}),
        }),
      }, signal);
      if (!response?.ok) {
        throw new Error(`reviewer_receipt_signer_http_failed:${response?.status || 0}`);
      }
      const document = await response.json();
      return receiptFromDocument(document, context, {
        operationId,
        idempotencyKey,
      });
    },
  }));
}
