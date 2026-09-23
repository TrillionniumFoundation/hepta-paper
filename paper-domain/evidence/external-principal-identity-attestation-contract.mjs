import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SUBJECT_KEYS = Object.freeze([
  'assuranceProfile', 'attestedAt', 'challengeHash', 'credentialRootIdentityHash',
  'expiresAt', 'hostIdentityHash', 'kind', 'principalId', 'processIdentityHash',
  'provider', 'providerAccountIdentityHash', 'serviceId', 'signerPublicKeySpkiHash',
  'trustDomainIdentityHash', 'version',
]);
const DISTINCT_FIELDS = Object.freeze({
  signerSpki: 'signerPublicKeySpkiHash',
  providerAccount: 'providerAccountIdentityHash',
  credentialRoot: 'credentialRootIdentityHash',
  host: 'hostIdentityHash',
  process: 'processIdentityHash',
  trustDomain: 'trustDomainIdentityHash',
});
const ASSURANCE_PROFILES = new Set([
  'operator-attested-external-principal-v1',
  'pinned-provider-account-attestation-v1',
  'pinned-provider-account-and-platform-attestation-v1',
]);

function canonicalInstant(value) {
  const candidate = String(value || '');
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate
    ? candidate : null;
}

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function identifier(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

export function buildExternalPrincipalIdentityAttestationSubject({
  serviceId,
  principalId,
  provider,
  providerAccountIdentityHash,
  credentialRootIdentityHash,
  hostIdentityHash,
  processIdentityHash,
  trustDomainIdentityHash,
  signerPublicKeySpkiHash,
  challengeHash,
  assuranceProfile,
  attestedAt,
  expiresAt,
} = {}) {
  const selectedAttestedAt = canonicalInstant(attestedAt);
  const selectedExpiresAt = canonicalInstant(expiresAt);
  const payload = {
    version: 1,
    kind: 'ExternalPrincipalIdentityAttestationSubject',
    serviceId: identifier(serviceId),
    principalId: identifier(principalId),
    provider: identifier(provider),
    providerAccountIdentityHash: sha(providerAccountIdentityHash),
    credentialRootIdentityHash: sha(credentialRootIdentityHash),
    hostIdentityHash: sha(hostIdentityHash),
    processIdentityHash: sha(processIdentityHash),
    trustDomainIdentityHash: sha(trustDomainIdentityHash),
    signerPublicKeySpkiHash: sha(signerPublicKeySpkiHash),
    challengeHash: sha(challengeHash),
    assuranceProfile: String(assuranceProfile || ''),
    attestedAt: selectedAttestedAt,
    expiresAt: selectedExpiresAt,
  };
  if (Object.values(payload).some((value) => value === null)
    || !ASSURANCE_PROFILES.has(payload.assuranceProfile)
    || Date.parse(payload.expiresAt) <= Date.parse(payload.attestedAt)) {
    throw new Error('external_principal_identity_attestation_subject_invalid');
  }
  return Object.freeze({
    ...payload,
    externalPrincipalIdentityAttestationSubjectHash: hashRecord(
      'ExternalPrincipalIdentityAttestationSubject', payload,
    ),
  });
}

export function verifyExternalPrincipalIdentityAttestationSubject(subject, {
  now = null,
  maximumLifetimeMs = 24 * 60 * 60 * 1000,
  requirePlatformAttestation = false,
} = {}) {
  const {
    externalPrincipalIdentityAttestationSubjectHash: claimedHash,
    ...payload
  } = subject || {};
  if (!hasExactObjectKeys(payload, SUBJECT_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('ExternalPrincipalIdentityAttestationSubject', payload) !== claimedHash) {
    return false;
  }
  let rebuilt;
  try { rebuilt = buildExternalPrincipalIdentityAttestationSubject(subject); }
  catch { return false; }
  if (JSON.stringify(rebuilt) !== JSON.stringify(subject)
    || !Number.isSafeInteger(maximumLifetimeMs) || maximumLifetimeMs < 1
    || Date.parse(subject.expiresAt) - Date.parse(subject.attestedAt) > maximumLifetimeMs
    || (requirePlatformAttestation
      && subject.assuranceProfile
        !== 'pinned-provider-account-and-platform-attestation-v1')) return false;
  if (now !== null) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
    if (!Number.isFinite(nowMs) || nowMs < Date.parse(subject.attestedAt)
      || nowMs >= Date.parse(subject.expiresAt)) return false;
  }
  return true;
}

export function evaluateExternalPrincipalIdentitySeparation({
  candidate,
  references = [],
  requiredDistinctFields = Object.keys(DISTINCT_FIELDS),
  now = null,
  requirePlatformAttestation = false,
} = {}) {
  const blockers = [];
  const selectedFields = [...new Set((Array.isArray(requiredDistinctFields)
    ? requiredDistinctFields : []).map(String))].sort();
  if (!verifyExternalPrincipalIdentityAttestationSubject(candidate, {
    now,
    requirePlatformAttestation,
  })) blockers.push('external_principal_identity_candidate_invalid');
  if (!Array.isArray(references) || references.length < 1
    || references.some((reference) => !verifyExternalPrincipalIdentityAttestationSubject(
      reference, { now, requirePlatformAttestation },
    ))) blockers.push('external_principal_identity_reference_invalid');
  if (!selectedFields.length
    || selectedFields.some((field) => !Object.hasOwn(DISTINCT_FIELDS, field))) {
    blockers.push('external_principal_identity_distinct_field_invalid');
  }
  if (blockers.length === 0) {
    for (const [ordinal, reference] of references.entries()) {
      for (const field of selectedFields) {
        const property = DISTINCT_FIELDS[field];
        if (candidate[property] === reference[property]) {
          blockers.push(`external_principal_identity_not_distinct:${field}:${ordinal}`);
        }
      }
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'ExternalPrincipalIdentitySeparationReceipt',
    status: uniqueBlockers.length
      ? 'external_principal_identity_separation_blocked'
      : 'external_principal_identity_separation_verified',
    candidateIdentitySubjectHash:
      candidate?.externalPrincipalIdentityAttestationSubjectHash || null,
    referenceIdentitySubjectHashes: Object.freeze((Array.isArray(references) ? references : [])
      .map((reference) => reference?.externalPrincipalIdentityAttestationSubjectHash || null)),
    requiredDistinctFields: Object.freeze(selectedFields),
    platformAttestationRequired: requirePlatformAttestation === true,
    identityIndependenceReady: uniqueBlockers.length === 0,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    externalPrincipalIdentitySeparationReceiptHash: hashRecord(
      'ExternalPrincipalIdentitySeparationReceipt', payload,
    ),
  });
}
