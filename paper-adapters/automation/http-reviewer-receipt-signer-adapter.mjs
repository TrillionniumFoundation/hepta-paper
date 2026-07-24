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
  assertPinnedExternalEvidenceEnvelope,
  assertPinnedExternalEvidenceVerificationReceipt,
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

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
const IDENTITY_BUNDLE_KEYS = Object.freeze([
  'authorityEnvelope', 'bundleHash', 'kind', 'maximumLifetimeMs', 'signerKeyIds',
  'signerRole', 'subject', 'trustStore', 'trustStoreHash', 'version',
]);
const IDENTITY_ATTESTOR_ROLE = 'external_principal_identity_attestor';

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
  const expectedKeyIds = canonicalKeyIds(signerKeyIds);
  const trust = inspectPinnedExternalEvidenceTrustStore(trustStore, {
    requiredRole: signerRole,
    expectedKeyIds,
  });
  let canonicalEnvelope = null;
  try { canonicalEnvelope = buildPinnedExternalEvidenceEnvelope(authorityEnvelope); }
  catch { /* rejected below */ }
  if (!verifyExternalPrincipalIdentityAttestationSubject(subject)
    || !expectedKeyIds || signerRole !== IDENTITY_ATTESTOR_ROLE || !trust.ready
    || !Number.isSafeInteger(Number(maximumLifetimeMs))
    || Number(maximumLifetimeMs) < 1_000
    || Number(maximumLifetimeMs) > 24 * 60 * 60 * 1000
    || !canonicalEnvelope
    || JSON.stringify(canonicalEnvelope) !== JSON.stringify(authorityEnvelope)
    || canonicalEnvelope.subjectKind !== REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND
    || canonicalEnvelope.subjectHash
      !== subject.externalPrincipalIdentityAttestationSubjectHash) {
    throw new Error('reviewer_signer_identity_attestation_bundle_invalid');
  }
  const payload = {
    version: 1,
    kind: 'ReviewerSignerIdentityAttestationBundle',
    subject,
    authorityEnvelope: canonicalEnvelope,
    trustStore: trust.canonicalTrustStore,
    trustStoreHash: trust.trustStoreHash,
    signerKeyIds: expectedKeyIds,
    signerRole: IDENTITY_ATTESTOR_ROLE,
    maximumLifetimeMs: Number(maximumLifetimeMs),
  };
  return Object.freeze({
    ...payload,
    bundleHash: hashRecord('ReviewerSignerIdentityAttestationBundle', payload),
  });
}

export function verifyReviewerSignerIdentityAttestationBundle(bundle) {
  if (!hasExactObjectKeys(bundle, IDENTITY_BUNDLE_KEYS)) return false;
  try {
    return JSON.stringify(buildReviewerSignerIdentityAttestationBundle(bundle))
      === JSON.stringify(bundle);
  } catch { return false; }
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
} = {}) {
  let url;
  try { url = new URL(String(endpoint || '')); }
  catch { throw new Error('reviewer_receipt_signer_endpoint_invalid'); }
  if (![1, 2].includes(Number(version)) || url.protocol !== 'https:'
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
  }
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('ReviewerReceiptSignerServiceConfiguration', payload),
  });
}

export function verifyReviewerReceiptSignerServiceConfiguration(configuration) {
  const keys = configuration?.version === 2 ? CONFIG_KEYS_V2 : CONFIG_KEYS_V1;
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
  const token = String(environment[selected.tokenEnvironmentVariable] || '');
  if (!token || typeof fetchImpl !== 'function') {
    throw new Error('reviewer_receipt_signer_runtime_credentials_missing');
  }
  let identityAttestationVerificationReceipt = null;
  let identityAttestationSubject = null;
  if (selected.version === 2 && selected.identityAttestationBundle) {
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
  const trustSetHash = selected.version === 2
    ? hashRecord('ReviewerReceiptSignerTrustSet', {
      receiptTrustStoreHash: selected.receiptTrustStoreHash,
      identityTrustStoreHash: selected.identityAttestationBundle?.trustStoreHash || null,
    }) : null;
  const signatureVerificationPolicyHash = selected.version === 2
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
    if (selected.version !== 2 || receipt?.version !== 2
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
  return assertReviewerReceiptSignerPort(Object.freeze({
    version: selected.version,
    kind: 'ReviewerReceiptSignerPort',
    serviceId: selected.serviceId,
    signerIdentityHash: selected.signerIdentityHash,
    configurationHash: selected.configurationHash,
    cryptographicAuthorityReady: selected.version === 2,
    identityIndependenceReady: false,
    trustSetHash,
    signatureVerificationPolicyHash,
    identityAttestationSubject,
    identityAttestationVerificationReceipt,
    verifySignedReceipt: verifyCryptographicReceipt,
    async sign({ subjectHash, principal, signal = null } = {}) {
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
      const requestPayload = {
        version: selected.version,
        kind: 'ReviewerReceiptSigningRequest',
        subjectHash,
        principalId: principal.principalId,
        principalDescriptorHash: principal.principalDescriptorHash,
        researchPrincipalPoolHash: principal.researchPrincipalPoolHash || null,
      };
      const requestHash = hashRecord('ReviewerReceiptSigningRequest', requestPayload);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      let response;
      try {
        response = await fetchImpl(selected.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ...requestPayload, requestHash }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
      }
      if (!response?.ok) {
        throw new Error(`reviewer_receipt_signer_http_failed:${response?.status || 0}`);
      }
      const document = await response.json();
      if (document?.requestHash !== requestHash
        || document?.serviceId !== selected.serviceId
        || document?.serviceIdentityHash !== selected.serviceIdentityHash
        || document?.externalActionPerformed !== true) {
        throw new Error('reviewer_receipt_signer_response_invalid');
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
    },
  }));
}
