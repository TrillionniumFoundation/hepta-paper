import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;
const SUBJECT_KEYS = Object.freeze([
  'activeKeyId', 'activeKeyVersion', 'activePublicKeySpkiHash', 'algorithm',
  'assuranceProfile', 'attestedAt', 'backendDescriptorHash', 'backendId',
  'backendVersion', 'challengeHash', 'credentialGenerationIdentityHash',
  'expiresAt', 'hardwareProtected', 'keyOrigin', 'keyResourceIdentityHash',
  'keyUsage', 'kind', 'kmsProvider', 'privateKeyExportable',
  'providerAccountIdentityHash', 'trustSetHash', 'version',
]);

export const RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE =
  'research_execution_release_kms_hardware_attestor';
export const RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS =
  15 * 60 * 1000;

function canonicalInstant(value) {
  const candidate = String(value || '');
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === candidate
    ? candidate : null;
}

function identifier(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function versionIdentifier(value) {
  const candidate = String(value || '').trim();
  return SAFE_VERSION.test(candidate) ? candidate : null;
}

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

export function buildResearchExecutionReleaseKmsHardwareAttestationSubject({
  kmsProvider,
  providerAccountIdentityHash,
  keyResourceIdentityHash,
  credentialGenerationIdentityHash,
  backendDescriptorHash,
  backendId,
  backendVersion,
  activeKeyId,
  activeKeyVersion,
  activePublicKeySpkiHash,
  trustSetHash,
  challengeHash,
  algorithm = 'ed25519',
  assuranceProfile = 'external-kms-control-plane-hardware-attested-v1',
  hardwareProtected = true,
  privateKeyExportable = false,
  keyOrigin = 'hardware-generated',
  keyUsage = 'sign-verify-only',
  attestedAt,
  expiresAt,
} = {}) {
  const payload = {
    version: 1,
    kind: 'ResearchExecutionReleaseKmsHardwareAttestationSubject',
    kmsProvider: identifier(kmsProvider),
    providerAccountIdentityHash: sha(providerAccountIdentityHash),
    keyResourceIdentityHash: sha(keyResourceIdentityHash),
    credentialGenerationIdentityHash: sha(credentialGenerationIdentityHash),
    backendDescriptorHash: sha(backendDescriptorHash),
    backendId: identifier(backendId),
    backendVersion: versionIdentifier(backendVersion),
    activeKeyId: identifier(activeKeyId),
    activeKeyVersion: versionIdentifier(activeKeyVersion),
    activePublicKeySpkiHash: sha(activePublicKeySpkiHash),
    trustSetHash: sha(trustSetHash),
    challengeHash: sha(challengeHash),
    algorithm: String(algorithm || ''),
    assuranceProfile: String(assuranceProfile || ''),
    hardwareProtected: hardwareProtected === true,
    privateKeyExportable: privateKeyExportable === true,
    keyOrigin: String(keyOrigin || ''),
    keyUsage: String(keyUsage || ''),
    attestedAt: canonicalInstant(attestedAt),
    expiresAt: canonicalInstant(expiresAt),
  };
  if (Object.values(payload).some((value) => value === null)
    || payload.algorithm !== 'ed25519'
    || payload.assuranceProfile
      !== 'external-kms-control-plane-hardware-attested-v1'
    || payload.hardwareProtected !== true
    || payload.privateKeyExportable !== false
    || payload.keyOrigin !== 'hardware-generated'
    || payload.keyUsage !== 'sign-verify-only'
    || Date.parse(payload.expiresAt) <= Date.parse(payload.attestedAt)) {
    throw new Error('research_execution_release_kms_hardware_attestation_subject_invalid');
  }
  return Object.freeze({
    ...payload,
    researchExecutionReleaseKmsHardwareAttestationSubjectHash: hashRecord(
      'ResearchExecutionReleaseKmsHardwareAttestationSubject',
      payload,
    ),
  });
}

export function verifyResearchExecutionReleaseKmsHardwareAttestationSubject(subject, {
  now = null,
  maximumLifetimeMs =
    RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS,
} = {}) {
  const {
    researchExecutionReleaseKmsHardwareAttestationSubjectHash: claimedHash,
    ...payload
  } = subject || {};
  if (!hasExactObjectKeys(payload, SUBJECT_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord(
      'ResearchExecutionReleaseKmsHardwareAttestationSubject',
      payload,
    ) !== claimedHash
    || !Number.isSafeInteger(Number(maximumLifetimeMs))
    || Number(maximumLifetimeMs) < 1_000
    || Number(maximumLifetimeMs)
      > RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS) {
    return false;
  }
  let rebuilt;
  try {
    rebuilt = buildResearchExecutionReleaseKmsHardwareAttestationSubject(subject);
  } catch {
    return false;
  }
  if (JSON.stringify(rebuilt) !== JSON.stringify(subject)
    || Date.parse(subject.expiresAt) - Date.parse(subject.attestedAt)
      > Number(maximumLifetimeMs)) {
    return false;
  }
  if (now !== null) {
    const timestamp = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
    if (!Number.isFinite(timestamp)
      || timestamp < Date.parse(subject.attestedAt)
      || timestamp >= Date.parse(subject.expiresAt)) {
      return false;
    }
  }
  return true;
}
