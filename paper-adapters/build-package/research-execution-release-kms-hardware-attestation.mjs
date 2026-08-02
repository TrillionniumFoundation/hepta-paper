import {
  RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS,
  RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
  verifyResearchExecutionReleaseKmsHardwareAttestationSubject,
} from '../../paper-domain/automation/research-execution-release-kms-hardware-attestation-contract.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
  verifyPinnedExternalEvidenceEnvelope,
} from '../authority/pinned-external-evidence-verifier.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 ._():/-]{0,191}$/;
const SUBJECT_KIND = 'ResearchExecutionReleaseKmsHardwareAttestationSubject';
const BUNDLE_KIND = 'ResearchExecutionReleaseKmsHardwareAttestationBundle';
const BUNDLE_KEYS = Object.freeze([
  'authorityEnvelope', 'bundleHash', 'kind', 'maximumLifetimeMs', 'signerKeyIds',
  'signerRole', 'subject', 'trustStore', 'trustStoreHash', 'version',
]);
const EXPECTED_SUBJECT_FIELDS = Object.freeze([
  'activeKeyId', 'activeKeyVersion', 'activePublicKeySpkiHash',
  'backendDescriptorHash', 'backendId', 'backendVersion', 'challengeHash',
  'credentialGenerationIdentityHash', 'keyResourceIdentityHash', 'kmsProvider',
  'providerAccountIdentityHash', 'trustSetHash',
]);

function canonicalKeyIds(values) {
  const selected = [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
  return selected.length >= 1 && selected.length <= 4
    && selected.every((value) => SAFE_ID.test(value))
    ? Object.freeze(selected) : null;
}

function organizationIdentity(value) {
  return typeof value === 'string' && SAFE_ORGANIZATION.test(value)
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
}

export function buildResearchExecutionReleaseKmsHardwareAttestationBundle({
  subject,
  authorityEnvelope,
  trustStore,
  signerKeyIds,
  signerRole = RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
  maximumLifetimeMs =
    RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS,
} = {}) {
  const expectedKeyIds = canonicalKeyIds(signerKeyIds);
  const trust = inspectPinnedExternalEvidenceTrustStore(trustStore, {
    requiredRole: signerRole,
    expectedKeyIds,
  });
  let canonicalEnvelope = null;
  try {
    canonicalEnvelope = buildPinnedExternalEvidenceEnvelope(authorityEnvelope);
  } catch {
    // Rejected below with one stable bundle error.
  }
  if (!verifyResearchExecutionReleaseKmsHardwareAttestationSubject(subject)
    || !expectedKeyIds
    || signerRole !== RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE
    || !trust.ready
    || !Number.isSafeInteger(Number(maximumLifetimeMs))
    || Number(maximumLifetimeMs) < 1_000
    || Number(maximumLifetimeMs)
      > RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS
    || !canonicalEnvelope
    || JSON.stringify(canonicalEnvelope) !== JSON.stringify(authorityEnvelope)
    || canonicalEnvelope.subjectKind !== SUBJECT_KIND
    || canonicalEnvelope.subjectHash
      !== subject.researchExecutionReleaseKmsHardwareAttestationSubjectHash) {
    throw new Error('research_execution_release_kms_hardware_attestation_bundle_invalid');
  }
  const payload = {
    version: 1,
    kind: BUNDLE_KIND,
    subject,
    authorityEnvelope: canonicalEnvelope,
    trustStore: trust.canonicalTrustStore,
    trustStoreHash: trust.trustStoreHash,
    signerKeyIds: expectedKeyIds,
    signerRole: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
    maximumLifetimeMs: Number(maximumLifetimeMs),
  };
  return Object.freeze({
    ...payload,
    bundleHash: hashRecord(BUNDLE_KIND, payload),
  });
}

export function verifyResearchExecutionReleaseKmsHardwareAttestationBundle(bundle) {
  if (!hasExactObjectKeys(bundle, BUNDLE_KEYS)) return false;
  try {
    return JSON.stringify(
      buildResearchExecutionReleaseKmsHardwareAttestationBundle(bundle),
    ) === JSON.stringify(bundle);
  } catch {
    return false;
  }
}

export function inspectResearchExecutionReleaseKmsHardwareAttestationBundle(bundle, {
  now,
  expected = null,
  expectedTrustStoreHash = null,
  expectedSignerKeyIds = null,
  prohibitedAuthorities = [],
} = {}) {
  const blockers = [];
  if (!verifyResearchExecutionReleaseKmsHardwareAttestationBundle(bundle)) {
    blockers.push('research_execution_release_kms_hardware_attestation_bundle_invalid');
  }
  const selectedExpectedKeyIds = canonicalKeyIds(expectedSignerKeyIds);
  if (expectedSignerKeyIds !== null
    && (!selectedExpectedKeyIds
      || JSON.stringify(selectedExpectedKeyIds)
        !== JSON.stringify(bundle?.signerKeyIds || null))) {
    blockers.push('research_execution_release_kms_hardware_attestation_signer_pin_invalid');
  }
  if (expectedTrustStoreHash !== null
    && (!SHA256.test(String(expectedTrustStoreHash || ''))
      || bundle?.trustStoreHash !== expectedTrustStoreHash)) {
    blockers.push('research_execution_release_kms_hardware_attestation_trust_pin_invalid');
  }
  if (!verifyResearchExecutionReleaseKmsHardwareAttestationSubject(bundle?.subject, {
    now,
    maximumLifetimeMs: bundle?.maximumLifetimeMs,
  })) {
    blockers.push('research_execution_release_kms_hardware_attestation_subject_invalid');
  }
  if (!expected || typeof expected !== 'object'
    || EXPECTED_SUBJECT_FIELDS.some((field) => (
      bundle?.subject?.[field] !== expected[field]
    ))) {
    blockers.push('research_execution_release_kms_hardware_attestation_binding_invalid');
  }
  const verificationReceipt = verifyPinnedExternalEvidenceEnvelope({
    envelope: bundle?.authorityEnvelope,
    subjectKind: SUBJECT_KIND,
    subjectHash:
      bundle?.subject?.researchExecutionReleaseKmsHardwareAttestationSubjectHash,
    trustStore: bundle?.trustStore,
    requiredRole: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
    expectedKeyIds: bundle?.signerKeyIds,
    now,
    maximumLifetimeMs: bundle?.maximumLifetimeMs,
  });
  if (verificationReceipt.cryptographicAuthorityReady !== true) {
    blockers.push('research_execution_release_kms_hardware_attestation_signature_invalid');
  }
  const trust = inspectPinnedExternalEvidenceTrustStore(bundle?.trustStore, {
    requiredRole: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
    expectedKeyIds: bundle?.signerKeyIds,
  });
  const verifiedKeys = trust.ready
    ? trust.keys.filter((key) => (
      verificationReceipt.verifiedKeyIds.includes(key.keyId)
    )) : [];
  const prohibited = Array.isArray(prohibitedAuthorities) ? prohibitedAuthorities : [];
  if (verifiedKeys.length < 1
    || verifiedKeys.some((key) => !organizationIdentity(key.organization))
    || verifiedKeys.some((key) => prohibited.some((authority) => (
      key.publicKeySpkiHash === authority?.publicKeySpkiHash
      || key.subjectId === authority?.subjectId
      || organizationIdentity(key.organization)
        === organizationIdentity(authority?.organization)
    )))) {
    blockers.push(
      'research_execution_release_kms_hardware_attestation_authority_independence_invalid',
    );
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'ResearchExecutionReleaseKmsHardwareAttestationInspection',
    status: uniqueBlockers.length
      ? 'research_execution_release_kms_hardware_attestation_blocked'
      : 'research_execution_release_kms_hardware_attestation_verified',
    hardwareAuthorityReady: uniqueBlockers.length === 0,
    cryptographicAuthorityReady:
      uniqueBlockers.length === 0
      && verificationReceipt.cryptographicAuthorityReady === true,
    authorityIndependent:
      uniqueBlockers.length === 0,
    bundleHash: bundle?.bundleHash || null,
    subjectHash:
      bundle?.subject?.researchExecutionReleaseKmsHardwareAttestationSubjectHash || null,
    trustStoreHash: trust.trustStoreHash,
    envelopeHash: verificationReceipt.envelopeHash,
    verificationReceiptHash:
      verificationReceipt.pinnedExternalEvidenceVerificationReceiptHash,
    verifiedKeyIds: Object.freeze(verifiedKeys.map((key) => key.keyId).sort()),
    verifiedSubjectIds:
      Object.freeze(verifiedKeys.map((key) => key.subjectId).sort()),
    verifiedOrganizations:
      Object.freeze(verifiedKeys.map((key) => key.organization).sort()),
    verifiedPublicKeySpkiHashes:
      Object.freeze(verifiedKeys.map((key) => key.publicKeySpkiHash).sort()),
    kmsProvider: bundle?.subject?.kmsProvider || null,
    providerAccountIdentityHash:
      bundle?.subject?.providerAccountIdentityHash || null,
    keyResourceIdentityHash:
      bundle?.subject?.keyResourceIdentityHash || null,
    credentialGenerationIdentityHash:
      bundle?.subject?.credentialGenerationIdentityHash || null,
    attestedAt: bundle?.subject?.attestedAt || null,
    expiresAt: bundle?.subject?.expiresAt || null,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    researchExecutionReleaseKmsHardwareAttestationInspectionHash: hashRecord(
      'ResearchExecutionReleaseKmsHardwareAttestationInspection',
      payload,
    ),
  });
}
