import fs from 'node:fs';
import path from 'node:path';
import { assertPriorArtRetrievalPort } from '../../paper-ports/prior-art-retrieval-port.mjs';
import {
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  buildPriorArtAuthorityTrustConfiguration,
  buildPriorArtIndependentReviewAuthoritySubjectV2,
  buildPriorArtRetrievalAuthoritySubjectV2,
  verifyPriorArtAuthorityVerificationBundle,
} from '../../paper-domain/research/prior-art-authority-verification-contract.mjs';
import {
  evaluateExternalPrincipalIdentitySeparation,
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  normalizePriorArtQueryPlan,
  priorArtQueryPlanHash as computePriorArtQueryPlanHash,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import { resolveOpaqueRuntimeCredential } from './opaque-runtime-credential-file.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const CONFIG_KEYS_V1 = Object.freeze([
  'configurationHash', 'endpoint', 'kind', 'serviceId', 'serviceIdentityHash',
  'timeoutMs', 'tokenEnvironmentVariable', 'version',
]);
const CONFIG_KEYS_V2 = Object.freeze([
  ...CONFIG_KEYS_V1,
  'identityMaximumLifetimeMs', 'identitySignerKeyIds', 'identitySignerRole',
  'identityTrustStore', 'identityTrustStoreHash',
  'independentReviewMaximumLifetimeMs', 'independentReviewSignerKeyIds',
  'independentReviewSignerRole', 'independentReviewTrustStore',
  'independentReviewTrustStoreHash',
  'retrievalMaximumLifetimeMs', 'retrievalSignerKeyIds', 'retrievalSignerRole',
  'retrievalTrustStore', 'retrievalTrustStoreHash',
  'signatureVerificationPolicyHash', 'trustSetHash',
]);
const RESPONSE_KEYS_V2 = Object.freeze([
  'externalActionPerformed', 'independentReviewAuthorityEnvelope',
  'priorArtEvidenceReceipt', 'requestHash', 'retrievalAuthorityEnvelope',
  'retrievalIdentityAttestation', 'retrievalIdentityAuthorityEnvelope',
  'reviewerIdentityAttestation', 'reviewerIdentityAuthorityEnvelope',
  'serviceId', 'serviceIdentityHash',
]);
const RETRIEVAL_SIGNER_ROLE = 'prior_art_retrieval_service';
const REVIEW_SIGNER_ROLE = 'prior_art_independent_reviewer';
const IDENTITY_SIGNER_ROLE = 'external_principal_identity_attestor';
const EVIDENCE_PROFILE_V2 = 'structured-ranked-deduplicated-v2';
const RETRIEVAL_SUBJECT_KIND = 'PriorArtRetrievalAuthoritySubjectV2';
const REVIEW_SUBJECT_KIND = 'PriorArtIndependentReviewAuthoritySubjectV2';
const IDENTITY_SUBJECT_KIND = 'ExternalPrincipalIdentityAttestationSubject';
const DISTINCT_IDENTITY_FIELDS = Object.freeze([
  'credentialRoot', 'host', 'process', 'providerAccount', 'signerSpki', 'trustDomain',
]);

export {
  buildPriorArtIndependentReviewAuthoritySubjectV2,
  buildPriorArtRetrievalAuthoritySubjectV2,
};

function canonicalExpectedKeyIds(value) {
  const selected = [...new Set((Array.isArray(value) ? value : []).map(String))].sort();
  return selected.length === 1 && SAFE_ID.test(selected[0])
    ? Object.freeze(selected) : null;
}

function canonicalLifetime(value) {
  const selected = Number(value);
  return Number.isSafeInteger(selected) && selected >= 1_000
    && selected <= 24 * 60 * 60 * 1000 ? selected : null;
}

function trustPolicy({ trustStore, role, expectedKeyIds }) {
  const selectedKeyIds = canonicalExpectedKeyIds(expectedKeyIds);
  const inspection = inspectPinnedExternalEvidenceTrustStore(trustStore, {
    requiredRole: role,
    expectedKeyIds: selectedKeyIds,
  });
  if (!selectedKeyIds || !inspection.ready) {
    throw new Error('prior_art_service_trust_configuration_invalid');
  }
  const selectedKeys = inspection.keys.filter((key) => selectedKeyIds.includes(key.keyId));
  if (selectedKeys.length !== 1) {
    throw new Error('prior_art_service_trust_configuration_invalid');
  }
  return Object.freeze({
    trustStore: inspection.canonicalTrustStore,
    trustStoreHash: inspection.trustStoreHash,
    signerKeyIds: selectedKeyIds,
    signerPublicKeySpkiHashes: Object.freeze(
      selectedKeys.map((key) => key.publicKeySpkiHash).sort(),
    ),
  });
}

function assertDisjointSignerAuthorities(policies) {
  const seen = new Set();
  for (const policy of policies) {
    for (const spkiHash of policy.signerPublicKeySpkiHashes) {
      if (seen.has(spkiHash)) {
        throw new Error('prior_art_service_signer_authorities_not_distinct');
      }
      seen.add(spkiHash);
    }
  }
}

export function buildPriorArtServiceConfiguration({
  version = 1,
  serviceId,
  endpoint,
  serviceIdentityHash,
  tokenEnvironmentVariable,
  timeoutMs = 120_000,
  retrievalTrustStore = null,
  retrievalSignerKeyIds = [],
  retrievalSignerRole = RETRIEVAL_SIGNER_ROLE,
  retrievalMaximumLifetimeMs = 5 * 60 * 1000,
  independentReviewTrustStore = null,
  independentReviewSignerKeyIds = [],
  independentReviewSignerRole = REVIEW_SIGNER_ROLE,
  independentReviewMaximumLifetimeMs = 5 * 60 * 1000,
  identityTrustStore = null,
  identitySignerKeyIds = [],
  identitySignerRole = IDENTITY_SIGNER_ROLE,
  identityMaximumLifetimeMs = 5 * 60 * 1000,
} = {}) {
  let url;
  try { url = new URL(String(endpoint || '')); }
  catch { throw new Error('prior_art_service_endpoint_invalid'); }
  if (![1, 2].includes(Number(version))
    || url.protocol !== 'https:'
    || !SAFE_ID.test(String(serviceId || ''))
    || !SHA256.test(String(serviceIdentityHash || '').toLowerCase())
    || !/^[A-Z][A-Z0-9_]{1,127}$/.test(String(tokenEnvironmentVariable || ''))
    || !Number.isSafeInteger(Number(timeoutMs)) || Number(timeoutMs) < 1_000
    || Number(timeoutMs) > 10 * 60 * 1000) {
    throw new Error('prior_art_service_configuration_invalid');
  }
  const payload = {
    version: Number(version),
    kind: 'PriorArtServiceConfiguration',
    serviceId: String(serviceId),
    endpoint: url.toString(),
    serviceIdentityHash: String(serviceIdentityHash).toLowerCase(),
    tokenEnvironmentVariable: String(tokenEnvironmentVariable),
    timeoutMs: Number(timeoutMs),
  };
  if (Number(version) === 2) {
    if (retrievalSignerRole !== RETRIEVAL_SIGNER_ROLE
      || independentReviewSignerRole !== REVIEW_SIGNER_ROLE
      || identitySignerRole !== IDENTITY_SIGNER_ROLE) {
      throw new Error('prior_art_service_signer_role_invalid');
    }
    const retrieval = trustPolicy({
      trustStore: retrievalTrustStore,
      role: RETRIEVAL_SIGNER_ROLE,
      expectedKeyIds: retrievalSignerKeyIds,
    });
    const review = trustPolicy({
      trustStore: independentReviewTrustStore,
      role: REVIEW_SIGNER_ROLE,
      expectedKeyIds: independentReviewSignerKeyIds,
    });
    const identity = trustPolicy({
      trustStore: identityTrustStore,
      role: IDENTITY_SIGNER_ROLE,
      expectedKeyIds: identitySignerKeyIds,
    });
    assertDisjointSignerAuthorities([retrieval, review, identity]);
    const retrievalLifetime = canonicalLifetime(retrievalMaximumLifetimeMs);
    const reviewLifetime = canonicalLifetime(independentReviewMaximumLifetimeMs);
    const identityLifetime = canonicalLifetime(identityMaximumLifetimeMs);
    if (!retrievalLifetime || !reviewLifetime || !identityLifetime) {
      throw new Error('prior_art_service_signer_lifetime_invalid');
    }
    const authorityTrustConfiguration = buildPriorArtAuthorityTrustConfiguration({
      retrievalTrustStore: retrieval.trustStore,
      retrievalTrustStoreHash: retrieval.trustStoreHash,
      retrievalSignerKeyIds: retrieval.signerKeyIds,
      retrievalMaximumLifetimeMs: retrievalLifetime,
      independentReviewTrustStore: review.trustStore,
      independentReviewTrustStoreHash: review.trustStoreHash,
      independentReviewSignerKeyIds: review.signerKeyIds,
      independentReviewMaximumLifetimeMs: reviewLifetime,
      identityTrustStore: identity.trustStore,
      identityTrustStoreHash: identity.trustStoreHash,
      identitySignerKeyIds: identity.signerKeyIds,
      identityMaximumLifetimeMs: identityLifetime,
    });
    Object.assign(payload, {
      retrievalTrustStore: retrieval.trustStore,
      retrievalTrustStoreHash: retrieval.trustStoreHash,
      retrievalSignerKeyIds: retrieval.signerKeyIds,
      retrievalSignerRole: RETRIEVAL_SIGNER_ROLE,
      retrievalMaximumLifetimeMs: retrievalLifetime,
      independentReviewTrustStore: review.trustStore,
      independentReviewTrustStoreHash: review.trustStoreHash,
      independentReviewSignerKeyIds: review.signerKeyIds,
      independentReviewSignerRole: REVIEW_SIGNER_ROLE,
      independentReviewMaximumLifetimeMs: reviewLifetime,
      identityTrustStore: identity.trustStore,
      identityTrustStoreHash: identity.trustStoreHash,
      identitySignerKeyIds: identity.signerKeyIds,
      identitySignerRole: IDENTITY_SIGNER_ROLE,
      identityMaximumLifetimeMs: identityLifetime,
      trustSetHash: authorityTrustConfiguration.trustSetHash,
      signatureVerificationPolicyHash:
        authorityTrustConfiguration.signatureVerificationPolicyHash,
    });
  }
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('PriorArtServiceConfiguration', payload),
  });
}

export function readPriorArtServiceConfiguration({
  configPath,
  expectedConfigurationHash = null,
} = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let parsed;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size < 1 || stat.size > 1024 * 1024
      || (stat.mode & 0o022) !== 0) {
      throw new Error('invalid');
    }
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch { throw new Error('prior_art_service_configuration_file_invalid'); }
  const expectedKeys = parsed?.version === 2 ? CONFIG_KEYS_V2 : CONFIG_KEYS_V1;
  if (!hasExactObjectKeys(parsed, expectedKeys)) {
    throw new Error('prior_art_service_configuration_shape_invalid');
  }
  const rebuilt = buildPriorArtServiceConfiguration(parsed);
  if (JSON.stringify(rebuilt) !== JSON.stringify(parsed)) {
    throw new Error('prior_art_service_configuration_verification_failed');
  }
  if (expectedConfigurationHash !== null
    && (!SHA256.test(String(expectedConfigurationHash || '').toLowerCase())
      || rebuilt.configurationHash
        !== String(expectedConfigurationHash).toLowerCase())) {
    throw new Error('prior_art_service_configuration_pin_mismatch');
  }
  return rebuilt;
}

function assertIdentityAuthority({
  subject,
  envelope,
  selected,
  now,
} = {}) {
  if (!verifyExternalPrincipalIdentityAttestationSubject(subject, {
    now,
    requirePlatformAttestation: true,
  })) {
    throw new Error('prior_art_external_identity_attestation_invalid');
  }
  return assertPinnedExternalEvidenceEnvelope({
    envelope,
    subjectKind: IDENTITY_SUBJECT_KIND,
    subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
    trustStore: selected.identityTrustStore,
    requiredRole: selected.identitySignerRole,
    expectedKeyIds: selected.identitySignerKeyIds,
    now,
    maximumLifetimeMs: selected.identityMaximumLifetimeMs,
  });
}

function signerBoundToIdentity(verificationReceipt, identitySubject) {
  return verificationReceipt?.verifiedPublicKeySpkiHashes?.length === 1
    && verificationReceipt.verifiedPublicKeySpkiHashes[0]
      === identitySubject?.signerPublicKeySpkiHash;
}

function buildAuthorityBundle({
  selected,
  authorityTrustConfiguration,
  requestHash,
  receipt,
  retrievalSubject,
  retrievalEnvelope,
  retrievalVerification,
  reviewSubject,
  reviewEnvelope,
  reviewVerification,
  generatorIdentityAttestation,
  generatorIdentityEnvelope,
  generatorIdentityVerification,
  retrievalIdentityAttestation,
  retrievalIdentityEnvelope,
  retrievalIdentityVerification,
  reviewerIdentityAttestation,
  reviewerIdentityEnvelope,
  reviewerIdentityVerification,
  retrievalIdentitySeparation,
  reviewerIdentitySeparation,
} = {}) {
  const payload = {
    version: 1,
    kind: 'PriorArtRetrievalAuthorityVerificationBundle',
    status: 'prior_art_retrieval_authority_verified',
    requestHash,
    configurationHash: selected.configurationHash,
    trustSetHash: selected.trustSetHash,
    signatureVerificationPolicyHash: selected.signatureVerificationPolicyHash,
    authorityTrustConfigurationHash:
      authorityTrustConfiguration.priorArtAuthorityTrustConfigurationHash,
    priorArtEvidenceReceiptHash: receipt.priorArtEvidenceReceiptHash,
    retrievalSubject,
    retrievalEnvelope,
    retrievalVerification,
    independentReviewSubject: reviewSubject,
    independentReviewEnvelope: reviewEnvelope,
    independentReviewVerification: reviewVerification,
    generatorIdentityAttestation,
    generatorIdentityEnvelope,
    generatorIdentityVerification,
    retrievalIdentityAttestation,
    retrievalIdentityEnvelope,
    retrievalIdentityVerification,
    reviewerIdentityAttestation,
    reviewerIdentityEnvelope,
    reviewerIdentityVerification,
    retrievalIdentitySeparation,
    reviewerIdentitySeparation,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    externalActionPerformed: true,
  };
  return Object.freeze({
    ...payload,
    priorArtRetrievalAuthorityVerificationBundleHash: hashRecord(
      'PriorArtRetrievalAuthorityVerificationBundle', payload,
    ),
  });
}

export function createHttpPriorArtRetrievalAdapter({
  configuration,
  expectedConfigurationHash = null,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  clock = { now: () => new Date() },
} = {}) {
  const selected = buildPriorArtServiceConfiguration(configuration);
  const normalizedExpectedConfigurationHash = expectedConfigurationHash === null
    ? null : String(expectedConfigurationHash || '').toLowerCase();
  if (normalizedExpectedConfigurationHash !== null
    && (!SHA256.test(normalizedExpectedConfigurationHash)
      || selected.configurationHash !== normalizedExpectedConfigurationHash)) {
    throw new Error('prior_art_service_configuration_pin_mismatch');
  }
  const configurationPinned = normalizedExpectedConfigurationHash !== null;
  const authorityTrustConfiguration = selected.version === 2
    ? buildPriorArtAuthorityTrustConfiguration(selected) : null;
  const token = resolveOpaqueRuntimeCredential({
    environment,
    variableName: selected.tokenEnvironmentVariable,
  });
  if (!token || typeof fetchImpl !== 'function'
    || typeof clock?.now !== 'function') {
    throw new Error('prior_art_service_runtime_credentials_missing');
  }
  const authorityBundles = new WeakMap();
  return assertPriorArtRetrievalPort(Object.freeze({
    version: 1,
    kind: 'PriorArtRetrievalPort',
    serviceId: selected.serviceId,
    configurationHash: selected.configurationHash,
    configurationPinned,
    fullProductionReady: selected.version === 2 && configurationPinned,
    evidenceProfile: selected.version === 2
      ? EVIDENCE_PROFILE_V2 : 'structured-receipt-v1',
    cryptographicAuthorityReady: selected.version === 2,
    identityIndependenceReady: selected.version === 2,
    trustSetHash: selected.version === 2 ? selected.trustSetHash : null,
    signatureVerificationPolicyHash: selected.version === 2
      ? selected.signatureVerificationPolicyHash : null,
    authorityTrustConfigurationHash: selected.version === 2
      ? authorityTrustConfiguration.priorArtAuthorityTrustConfigurationHash : null,
    authorityFor(receipt) {
      const authority = authorityBundles.get(receipt);
      if (!authority) throw new Error('prior_art_retrieval_authority_capability_invalid');
      return authority;
    },
    authorityTrustConfiguration() {
      if (!authorityTrustConfiguration) {
        throw new Error('prior_art_authority_trust_configuration_unavailable');
      }
      return authorityTrustConfiguration;
    },
    verifyAuthority(receipt) {
      const authority = authorityBundles.get(receipt);
      const {
        priorArtRetrievalAuthorityVerificationBundleHash: claimedHash,
        ...payload
      } = authority || {};
      if (!authority || authority.priorArtEvidenceReceiptHash
          !== receipt?.priorArtEvidenceReceiptHash
        || authority.configurationHash !== selected.configurationHash
        || authority.trustSetHash !== selected.trustSetHash
        || authority.signatureVerificationPolicyHash
          !== selected.signatureVerificationPolicyHash
        || authority.authorityTrustConfigurationHash
          !== authorityTrustConfiguration?.priorArtAuthorityTrustConfigurationHash
        || hashRecord('PriorArtRetrievalAuthorityVerificationBundle', payload)
          !== claimedHash) {
        throw new Error('prior_art_retrieval_authority_capability_invalid');
      }
      return authority;
    },
    verifyAuthorityBundle(receipt, authorityBundle) {
      const stored = authorityBundles.get(receipt);
      if (stored !== authorityBundle
        || !verifyPriorArtAuthorityVerificationBundle({
          receipt,
          authorityBundle,
          trustConfiguration: authorityTrustConfiguration,
          researchAgendaIrHash: stored?.retrievalSubject?.researchAgendaIrHash,
          priorArtQueryPlan: stored?.retrievalSubject?.priorArtQueryPlan,
          priorArtQueryPlanHash: stored?.retrievalSubject?.priorArtQueryPlanHash,
        })) {
        throw new Error('prior_art_retrieval_authority_bundle_invalid');
      }
      return authorityBundle;
    },
    async retrieve({
      paperId,
      objective,
      protocolFamily,
      agendaSelectionReceiptHash,
      researchAgendaIrHash = null,
      priorArtQueryPlan = null,
      generatorPrincipalId,
      generatorIdentityAttestation = null,
      generatorIdentityAuthorityEnvelope = null,
      createdAt,
      signal = null,
    } = {}) {
      const now = clock.now();
      const normalizedResearchAgendaIrHash = String(researchAgendaIrHash || '').toLowerCase();
      const normalizedQueryPlan = normalizePriorArtQueryPlan(priorArtQueryPlan);
      const queryPlanHash = computePriorArtQueryPlanHash(normalizedQueryPlan);
      let generatorIdentityVerification = null;
      if (selected.version === 2) {
        if (!SHA256.test(normalizedResearchAgendaIrHash)
          || !normalizedQueryPlan || !queryPlanHash) {
          throw new Error('prior_art_retrieval_agenda_query_plan_binding_invalid');
        }
        if (generatorIdentityAttestation?.principalId !== generatorPrincipalId) {
          throw new Error('prior_art_generator_identity_binding_invalid');
        }
        generatorIdentityVerification = assertIdentityAuthority({
          subject: generatorIdentityAttestation,
          envelope: generatorIdentityAuthorityEnvelope,
          selected,
          now,
        });
      }
      const requestPayload = {
        version: selected.version,
        kind: 'PriorArtRetrievalRequest',
        paperId,
        objective,
        protocolFamily,
        agendaSelectionReceiptHash,
        generatorPrincipalId,
        ...(selected.version === 2 ? {
          researchAgendaIrHash: normalizedResearchAgendaIrHash,
          priorArtQueryPlan: normalizedQueryPlan,
          priorArtQueryPlanHash: queryPlanHash,
          generatorIdentityAttestationSubjectHash:
            generatorIdentityAttestation.externalPrincipalIdentityAttestationSubjectHash,
        } : {}),
        createdAt,
      };
      const requestHash = hashRecord('PriorArtRetrievalRequest', requestPayload);
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
      if (!response?.ok) throw new Error(`prior_art_service_http_failed:${response?.status || 0}`);
      const document = await response.json();
      const receipt = document?.priorArtEvidenceReceipt;
      const verification = verifyPriorArtEvidenceReceipt(receipt, {
        paperId,
        agendaSelectionReceiptHash,
        researchAgendaIrHash: selected.version === 2
          ? normalizedResearchAgendaIrHash : null,
        priorArtQueryPlan: selected.version === 2 ? normalizedQueryPlan : null,
        priorArtQueryPlanHash: selected.version === 2 ? queryPlanHash : null,
        requireVerified: true,
      });
      if (document?.requestHash !== requestHash
        || document?.serviceId !== selected.serviceId
        || document?.serviceIdentityHash !== selected.serviceIdentityHash
        || document?.externalActionPerformed !== true
        || !verification.valid) {
        throw new Error('prior_art_service_response_invalid');
      }
      if (selected.version === 1) return Object.freeze(receipt);
      if (!hasExactObjectKeys(document, RESPONSE_KEYS_V2)
        || receipt?.version !== 2 || receipt?.evidenceProfile !== EVIDENCE_PROFILE_V2) {
        throw new Error('prior_art_service_v2_response_invalid');
      }
      const retrievalSubject = buildPriorArtRetrievalAuthoritySubjectV2({
        requestHash,
        serviceId: selected.serviceId,
        serviceIdentityHash: selected.serviceIdentityHash,
        priorArtEvidenceReceiptHash: receipt.priorArtEvidenceReceiptHash,
        researchAgendaIrHash: normalizedResearchAgendaIrHash,
        priorArtQueryPlan: normalizedQueryPlan,
        priorArtQueryPlanHash: queryPlanHash,
      });
      const retrievalVerification = assertPinnedExternalEvidenceEnvelope({
        envelope: document.retrievalAuthorityEnvelope,
        subjectKind: RETRIEVAL_SUBJECT_KIND,
        subjectHash: retrievalSubject.priorArtRetrievalAuthoritySubjectHash,
        trustStore: selected.retrievalTrustStore,
        requiredRole: selected.retrievalSignerRole,
        expectedKeyIds: selected.retrievalSignerKeyIds,
        now,
        maximumLifetimeMs: selected.retrievalMaximumLifetimeMs,
      });
      const reviewSubject = buildPriorArtIndependentReviewAuthoritySubjectV2({ receipt });
      const reviewVerification = assertPinnedExternalEvidenceEnvelope({
        envelope: document.independentReviewAuthorityEnvelope,
        subjectKind: REVIEW_SUBJECT_KIND,
        subjectHash: reviewSubject.priorArtIndependentReviewAuthoritySubjectHash,
        trustStore: selected.independentReviewTrustStore,
        requiredRole: selected.independentReviewSignerRole,
        expectedKeyIds: selected.independentReviewSignerKeyIds,
        now,
        maximumLifetimeMs: selected.independentReviewMaximumLifetimeMs,
      });
      if (receipt.independentReview.signatureVerificationReceiptHash
          !== reviewVerification.envelopeHash) {
        throw new Error('prior_art_independent_review_envelope_binding_invalid');
      }
      const retrievalIdentityVerification = assertIdentityAuthority({
        subject: document.retrievalIdentityAttestation,
        envelope: document.retrievalIdentityAuthorityEnvelope,
        selected,
        now,
      });
      const reviewerIdentityVerification = assertIdentityAuthority({
        subject: document.reviewerIdentityAttestation,
        envelope: document.reviewerIdentityAuthorityEnvelope,
        selected,
        now,
      });
      const retrievalIdentity = document.retrievalIdentityAttestation;
      const reviewerIdentity = document.reviewerIdentityAttestation;
      if (retrievalIdentity.serviceId !== selected.serviceId
        || reviewerIdentity.principalId !== receipt.independentReview.principalId
        || reviewerIdentity.providerAccountIdentityHash
          !== receipt.independentReview.providerAccountIdentityHash
        || reviewerIdentity.trustDomainIdentityHash
          !== receipt.independentReview.trustDomainIdentityHash
        || !signerBoundToIdentity(retrievalVerification, retrievalIdentity)
        || !signerBoundToIdentity(reviewVerification, reviewerIdentity)) {
        throw new Error('prior_art_external_identity_binding_invalid');
      }
      const retrievalIdentitySeparation = evaluateExternalPrincipalIdentitySeparation({
        candidate: retrievalIdentity,
        references: [generatorIdentityAttestation],
        requiredDistinctFields: DISTINCT_IDENTITY_FIELDS,
        now,
        requirePlatformAttestation: true,
      });
      const reviewerIdentitySeparation = evaluateExternalPrincipalIdentitySeparation({
        candidate: reviewerIdentity,
        references: [generatorIdentityAttestation, retrievalIdentity],
        requiredDistinctFields: DISTINCT_IDENTITY_FIELDS,
        now,
        requirePlatformAttestation: true,
      });
      if (!retrievalIdentitySeparation.identityIndependenceReady
        || !reviewerIdentitySeparation.identityIndependenceReady
        || new Set([
          generatorIdentityAttestation.principalId,
          retrievalIdentity.principalId,
          reviewerIdentity.principalId,
        ]).size !== 3) {
        throw new Error('prior_art_external_identity_independence_invalid');
      }
      const authority = buildAuthorityBundle({
        selected,
        authorityTrustConfiguration,
        requestHash,
        receipt,
        retrievalSubject,
        retrievalEnvelope: document.retrievalAuthorityEnvelope,
        retrievalVerification,
        reviewSubject,
        reviewEnvelope: document.independentReviewAuthorityEnvelope,
        reviewVerification,
        generatorIdentityAttestation,
        generatorIdentityEnvelope: generatorIdentityAuthorityEnvelope,
        generatorIdentityVerification,
        retrievalIdentityAttestation: retrievalIdentity,
        retrievalIdentityEnvelope: document.retrievalIdentityAuthorityEnvelope,
        retrievalIdentityVerification,
        reviewerIdentityAttestation: reviewerIdentity,
        reviewerIdentityEnvelope: document.reviewerIdentityAuthorityEnvelope,
        reviewerIdentityVerification,
        retrievalIdentitySeparation,
        reviewerIdentitySeparation,
      });
      authorityBundles.set(receipt, authority);
      return Object.freeze(receipt);
    },
  }));
}
