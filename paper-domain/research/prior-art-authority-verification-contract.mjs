import {
  verifyImmutableEd25519AuthorityDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  normalizePriorArtQueryPlan,
  priorArtQueryPlanHash as computePriorArtQueryPlanHash,
} from '../automation/research-agenda-ir.mjs';
import {
  evaluateExternalPrincipalIdentitySeparation,
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../evidence/external-principal-identity-attestation-contract.mjs';
import { verifyPriorArtEvidenceReceipt } from './prior-art-evidence-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RETRIEVAL_ROLE = 'prior_art_retrieval_service';
const REVIEW_ROLE = 'prior_art_independent_reviewer';
const IDENTITY_ROLE = 'external_principal_identity_attestor';
const DISTINCT_FIELDS = Object.freeze([
  'credentialRoot', 'host', 'process', 'providerAccount', 'signerSpki', 'trustDomain',
]);

export function buildPriorArtRetrievalAuthoritySubjectV2({
  requestHash,
  serviceId,
  serviceIdentityHash,
  priorArtEvidenceReceiptHash,
  researchAgendaIrHash,
  priorArtQueryPlan,
  priorArtQueryPlanHash,
} = {}) {
  const normalizedQueryPlan = normalizePriorArtQueryPlan(priorArtQueryPlan);
  const computedQueryPlanHash = computePriorArtQueryPlanHash(normalizedQueryPlan);
  const payload = {
    version: 2,
    kind: 'PriorArtRetrievalAuthoritySubjectV2',
    requestHash: String(requestHash || '').toLowerCase(),
    serviceId: String(serviceId || ''),
    serviceIdentityHash: String(serviceIdentityHash || '').toLowerCase(),
    priorArtEvidenceReceiptHash: String(priorArtEvidenceReceiptHash || '').toLowerCase(),
    researchAgendaIrHash: String(researchAgendaIrHash || '').toLowerCase(),
    priorArtQueryPlan: normalizedQueryPlan,
    priorArtQueryPlanHash: String(priorArtQueryPlanHash || '').toLowerCase(),
  };
  if (!SHA256.test(payload.requestHash) || !payload.serviceId
    || !SHA256.test(payload.serviceIdentityHash)
    || !SHA256.test(payload.priorArtEvidenceReceiptHash)
    || !SHA256.test(payload.researchAgendaIrHash)
    || !normalizedQueryPlan
    || payload.priorArtQueryPlanHash !== computedQueryPlanHash) {
    throw new Error('prior_art_retrieval_authority_subject_invalid');
  }
  return Object.freeze({
    ...payload,
    priorArtRetrievalAuthoritySubjectHash: hashRecord(
      'PriorArtRetrievalAuthoritySubjectV2', payload,
    ),
  });
}

export function buildPriorArtIndependentReviewAuthoritySubjectV2({ receipt } = {}) {
  if (!verifyPriorArtEvidenceReceipt(receipt, { requireVerified: true }).valid
    || receipt?.version !== 2
    || receipt?.evidenceProfile !== 'structured-ranked-deduplicated-v2') {
    throw new Error('prior_art_independent_review_authority_subject_invalid');
  }
  const evidencePayload = {
    evidenceProfile: receipt.evidenceProfile,
    paperId: receipt.paperId,
    agendaSelectionReceiptHash: receipt.agendaSelectionReceiptHash,
    researchAgendaIrHash: receipt.researchAgendaIrHash,
    priorArtQueryPlan: receipt.priorArtQueryPlan,
    priorArtQueryPlanHash: receipt.priorArtQueryPlanHash,
    generatorPrincipalId: receipt.generatorPrincipalId,
    queries: receipt.queries,
    works: receipt.works,
    deduplicationReceipt: receipt.deduplicationReceipt,
    rankingReceipts: receipt.rankingReceipts,
    coverageLimitations: receipt.coverageLimitations,
    openWorldCompletenessClaimed: receipt.openWorldCompletenessClaimed,
    scientificNoveltyVerified: receipt.scientificNoveltyVerified,
    createdAt: receipt.createdAt,
  };
  const payload = {
    version: 2,
    kind: 'PriorArtIndependentReviewAuthoritySubjectV2',
    priorArtEvidenceContentHash: hashRecord('PriorArtEvidenceReviewContentV2', evidencePayload),
    paperId: receipt.paperId,
    agendaSelectionReceiptHash: receipt.agendaSelectionReceiptHash,
    generatorPrincipalId: receipt.generatorPrincipalId,
    reviewerPrincipalId: receipt.independentReview.principalId,
    reviewerProviderAccountIdentityHash:
      receipt.independentReview.providerAccountIdentityHash,
    reviewerTrustDomainIdentityHash: receipt.independentReview.trustDomainIdentityHash,
    reviewReceiptHash: receipt.independentReview.reviewReceiptHash,
  };
  return Object.freeze({
    ...payload,
    priorArtIndependentReviewAuthoritySubjectHash: hashRecord(
      'PriorArtIndependentReviewAuthoritySubjectV2', payload,
    ),
  });
}

function policyPayload(configuration) {
  return Object.freeze({
    version: 1,
    kind: 'PriorArtSignatureVerificationPolicy',
    evidenceProfile: 'structured-ranked-deduplicated-v2',
    retrievalSubjectKind: 'PriorArtRetrievalAuthoritySubjectV2',
    retrievalSignerRole: RETRIEVAL_ROLE,
    retrievalSignerKeyIds: configuration.retrievalSignerKeyIds,
    retrievalMaximumLifetimeMs: configuration.retrievalMaximumLifetimeMs,
    independentReviewSubjectKind: 'PriorArtIndependentReviewAuthoritySubjectV2',
    independentReviewSignerRole: REVIEW_ROLE,
    independentReviewSignerKeyIds: configuration.independentReviewSignerKeyIds,
    independentReviewMaximumLifetimeMs: configuration.independentReviewMaximumLifetimeMs,
    identitySubjectKind: 'ExternalPrincipalIdentityAttestationSubject',
    identitySignerRole: IDENTITY_ROLE,
    identitySignerKeyIds: configuration.identitySignerKeyIds,
    identityMaximumLifetimeMs: configuration.identityMaximumLifetimeMs,
    platformAttestationRequired: true,
    requiredDistinctIdentityFields: DISTINCT_FIELDS,
  });
}

export function buildPriorArtAuthorityTrustConfiguration({
  retrievalTrustStore,
  retrievalTrustStoreHash,
  retrievalSignerKeyIds,
  retrievalMaximumLifetimeMs,
  independentReviewTrustStore,
  independentReviewTrustStoreHash,
  independentReviewSignerKeyIds,
  independentReviewMaximumLifetimeMs,
  identityTrustStore,
  identityTrustStoreHash,
  identitySignerKeyIds,
  identityMaximumLifetimeMs,
} = {}) {
  const payload = {
    version: 1,
    kind: 'PriorArtAuthorityTrustConfiguration',
    retrievalTrustStore,
    retrievalTrustStoreHash,
    retrievalSignerKeyIds,
    retrievalSignerRole: RETRIEVAL_ROLE,
    retrievalMaximumLifetimeMs,
    independentReviewTrustStore,
    independentReviewTrustStoreHash,
    independentReviewSignerKeyIds,
    independentReviewSignerRole: REVIEW_ROLE,
    independentReviewMaximumLifetimeMs,
    identityTrustStore,
    identityTrustStoreHash,
    identitySignerKeyIds,
    identitySignerRole: IDENTITY_ROLE,
    identityMaximumLifetimeMs,
  };
  const arraysValid = [
    payload.retrievalSignerKeyIds,
    payload.independentReviewSignerKeyIds,
    payload.identitySignerKeyIds,
  ].every((value) => Array.isArray(value) && value.length === 1);
  const lifetimesValid = [
    payload.retrievalMaximumLifetimeMs,
    payload.independentReviewMaximumLifetimeMs,
    payload.identityMaximumLifetimeMs,
  ].every((value) => Number.isSafeInteger(value) && value >= 1_000
    && value <= 24 * 60 * 60 * 1000);
  const trustHashesValid = [
    ['retrievalTrustStore', 'retrievalTrustStoreHash'],
    ['independentReviewTrustStore', 'independentReviewTrustStoreHash'],
    ['identityTrustStore', 'identityTrustStoreHash'],
  ].every(([store, hash]) => SHA256.test(String(payload[hash] || ''))
    && hashRecord('PinnedExternalEvidenceTrustStore', payload[store]) === payload[hash]);
  if (!arraysValid || !lifetimesValid || !trustHashesValid) {
    throw new Error('prior_art_authority_trust_configuration_invalid');
  }
  const trustSet = {
    retrievalTrustStoreHash: payload.retrievalTrustStoreHash,
    independentReviewTrustStoreHash: payload.independentReviewTrustStoreHash,
    identityTrustStoreHash: payload.identityTrustStoreHash,
  };
  const complete = {
    ...payload,
    trustSetHash: hashRecord('PriorArtServiceTrustSetV2', trustSet),
  };
  complete.signatureVerificationPolicyHash = hashRecord(
    'PriorArtSignatureVerificationPolicy', policyPayload(complete),
  );
  return Object.freeze({
    ...complete,
    priorArtAuthorityTrustConfigurationHash: hashRecord(
      'PriorArtAuthorityTrustConfiguration', complete,
    ),
  });
}

function trustConfigurationValid(configuration) {
  try {
    return JSON.stringify(buildPriorArtAuthorityTrustConfiguration(configuration))
      === JSON.stringify(configuration);
  } catch { return false; }
}

function verifySignedEnvelope({
  envelope,
  subjectKind,
  subjectHash,
  trustStore,
  role,
  expectedKeyIds,
  maximumLifetimeMs,
  localReceipt,
  currentNow = null,
} = {}) {
  if (envelope?.subjectKind !== subjectKind || envelope?.subjectHash !== subjectHash
    || localReceipt?.subjectKind !== subjectKind || localReceipt?.subjectHash !== subjectHash
    || localReceipt?.envelopeHash !== hashRecord('PinnedExternalEvidenceEnvelope', envelope)) {
    return null;
  }
  let verified = null;
  try {
    verified = verifyImmutableEd25519AuthorityDocument({
      document: envelope,
      trustStore,
      requiredRole: role,
      now: currentNow || new Date(localReceipt.verifiedAt),
      maximumLifetimeMs,
    });
  } catch { return null; }
  const keyIds = verified.verifiedSignatures.map((item) => item.keyId).sort();
  if (JSON.stringify(keyIds) !== JSON.stringify(expectedKeyIds)) return null;
  const {
    pinnedExternalEvidenceVerificationReceiptHash: claimedHash,
    ...receiptPayload
  } = localReceipt || {};
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('PinnedExternalEvidenceVerificationReceipt', receiptPayload) !== claimedHash
    || localReceipt?.status !== 'pinned_external_evidence_verified'
    || localReceipt?.cryptographicAuthorityReady !== true
    || JSON.stringify(localReceipt.verifiedKeyIds) !== JSON.stringify(keyIds)
    || JSON.stringify(localReceipt.verifiedPublicKeySpkiHashes)
      !== JSON.stringify(verified.verifiedSignatures
        .map((item) => item.publicKeySpkiHash).sort())) return null;
  return verified;
}

export function verifyPriorArtAuthorityVerificationBundle({
  receipt,
  authorityBundle,
  trustConfiguration,
  researchAgendaIrHash = null,
  priorArtQueryPlan = null,
  priorArtQueryPlanHash = null,
  now = null,
} = {}) {
  const currentNow = now === null ? null : new Date(now);
  if (currentNow && !Number.isFinite(currentNow.getTime())) return false;
  if (!trustConfigurationValid(trustConfiguration)) return false;
  const {
    priorArtRetrievalAuthorityVerificationBundleHash: claimedHash,
    ...payload
  } = authorityBundle || {};
  if (!verifyPriorArtEvidenceReceipt(receipt, {
    requireVerified: true,
    researchAgendaIrHash,
    priorArtQueryPlan,
    priorArtQueryPlanHash,
  }).valid
    || receipt?.version !== 2
    || receipt?.evidenceProfile !== 'structured-ranked-deduplicated-v2'
    || authorityBundle?.kind !== 'PriorArtRetrievalAuthorityVerificationBundle'
    || authorityBundle?.status !== 'prior_art_retrieval_authority_verified'
    || authorityBundle?.cryptographicAuthorityReady !== true
    || authorityBundle?.identityIndependenceReady !== true
    || authorityBundle?.priorArtEvidenceReceiptHash !== receipt.priorArtEvidenceReceiptHash
    || authorityBundle?.trustSetHash !== trustConfiguration.trustSetHash
    || authorityBundle?.signatureVerificationPolicyHash
      !== trustConfiguration.signatureVerificationPolicyHash
    || authorityBundle?.authorityTrustConfigurationHash
      !== trustConfiguration.priorArtAuthorityTrustConfigurationHash
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('PriorArtRetrievalAuthorityVerificationBundle', payload) !== claimedHash) {
    return false;
  }
  let retrievalSubject;
  let reviewSubject;
  try {
    retrievalSubject = buildPriorArtRetrievalAuthoritySubjectV2({
      requestHash: authorityBundle.requestHash,
      serviceId: authorityBundle.retrievalSubject?.serviceId,
      serviceIdentityHash: authorityBundle.retrievalSubject?.serviceIdentityHash,
      priorArtEvidenceReceiptHash: receipt.priorArtEvidenceReceiptHash,
      researchAgendaIrHash: authorityBundle.retrievalSubject?.researchAgendaIrHash,
      priorArtQueryPlan: authorityBundle.retrievalSubject?.priorArtQueryPlan,
      priorArtQueryPlanHash: authorityBundle.retrievalSubject?.priorArtQueryPlanHash,
    });
    reviewSubject = buildPriorArtIndependentReviewAuthoritySubjectV2({ receipt });
  } catch { return false; }
  if (retrievalSubject.researchAgendaIrHash !== receipt.researchAgendaIrHash
    || retrievalSubject.priorArtQueryPlanHash !== receipt.priorArtQueryPlanHash
    || JSON.stringify(retrievalSubject.priorArtQueryPlan)
      !== JSON.stringify(receipt.priorArtQueryPlan)
    || JSON.stringify(retrievalSubject) !== JSON.stringify(authorityBundle.retrievalSubject)
    || JSON.stringify(reviewSubject)
      !== JSON.stringify(authorityBundle.independentReviewSubject)) return false;
  const retrievalSignature = verifySignedEnvelope({
    envelope: authorityBundle.retrievalEnvelope,
    subjectKind: retrievalSubject.kind,
    subjectHash: retrievalSubject.priorArtRetrievalAuthoritySubjectHash,
    trustStore: trustConfiguration.retrievalTrustStore,
    role: trustConfiguration.retrievalSignerRole,
    expectedKeyIds: trustConfiguration.retrievalSignerKeyIds,
    maximumLifetimeMs: trustConfiguration.retrievalMaximumLifetimeMs,
    localReceipt: authorityBundle.retrievalVerification,
    currentNow,
  });
  const reviewSignature = verifySignedEnvelope({
    envelope: authorityBundle.independentReviewEnvelope,
    subjectKind: reviewSubject.kind,
    subjectHash: reviewSubject.priorArtIndependentReviewAuthoritySubjectHash,
    trustStore: trustConfiguration.independentReviewTrustStore,
    role: trustConfiguration.independentReviewSignerRole,
    expectedKeyIds: trustConfiguration.independentReviewSignerKeyIds,
    maximumLifetimeMs: trustConfiguration.independentReviewMaximumLifetimeMs,
    localReceipt: authorityBundle.independentReviewVerification,
    currentNow,
  });
  if (!retrievalSignature || !reviewSignature
    || receipt.independentReview.signatureVerificationReceiptHash
      !== authorityBundle.independentReviewVerification.envelopeHash) return false;
  const identityItems = [
    ['generator', authorityBundle.generatorIdentityAttestation,
      authorityBundle.generatorIdentityEnvelope,
      authorityBundle.generatorIdentityVerification],
    ['retrieval', authorityBundle.retrievalIdentityAttestation,
      authorityBundle.retrievalIdentityEnvelope,
      authorityBundle.retrievalIdentityVerification],
    ['reviewer', authorityBundle.reviewerIdentityAttestation,
      authorityBundle.reviewerIdentityEnvelope,
      authorityBundle.reviewerIdentityVerification],
  ];
  for (const [, subject, envelope, localReceipt] of identityItems) {
    if (!verifyExternalPrincipalIdentityAttestationSubject(subject, {
      now: currentNow || new Date(localReceipt?.verifiedAt),
      requirePlatformAttestation: true,
    }) || !verifySignedEnvelope({
      envelope,
      subjectKind: subject?.kind,
      subjectHash: subject?.externalPrincipalIdentityAttestationSubjectHash,
      trustStore: trustConfiguration.identityTrustStore,
      role: trustConfiguration.identitySignerRole,
      expectedKeyIds: trustConfiguration.identitySignerKeyIds,
      maximumLifetimeMs: trustConfiguration.identityMaximumLifetimeMs,
      localReceipt,
      currentNow,
    })) return false;
  }
  const generator = authorityBundle.generatorIdentityAttestation;
  const retrieval = authorityBundle.retrievalIdentityAttestation;
  const reviewer = authorityBundle.reviewerIdentityAttestation;
  if (retrieval.signerPublicKeySpkiHash
      !== retrievalSignature.verifiedSignatures[0]?.publicKeySpkiHash
    || reviewer.signerPublicKeySpkiHash
      !== reviewSignature.verifiedSignatures[0]?.publicKeySpkiHash
    || reviewer.principalId !== receipt.independentReview.principalId
    || reviewer.providerAccountIdentityHash
      !== receipt.independentReview.providerAccountIdentityHash
    || reviewer.trustDomainIdentityHash
      !== receipt.independentReview.trustDomainIdentityHash) return false;
  const separationNow = currentNow
    || new Date(authorityBundle.retrievalVerification.verifiedAt);
  const retrievalSeparation = evaluateExternalPrincipalIdentitySeparation({
    candidate: retrieval,
    references: [generator],
    requiredDistinctFields: DISTINCT_FIELDS,
    now: separationNow,
    requirePlatformAttestation: true,
  });
  const reviewerSeparation = evaluateExternalPrincipalIdentitySeparation({
    candidate: reviewer,
    references: [generator, retrieval],
    requiredDistinctFields: DISTINCT_FIELDS,
    now: separationNow,
    requirePlatformAttestation: true,
  });
  return retrievalSeparation.identityIndependenceReady === true
    && reviewerSeparation.identityIndependenceReady === true
    && JSON.stringify(retrievalSeparation)
      === JSON.stringify(authorityBundle.retrievalIdentitySeparation)
    && JSON.stringify(reviewerSeparation)
      === JSON.stringify(authorityBundle.reviewerIdentitySeparation);
}
