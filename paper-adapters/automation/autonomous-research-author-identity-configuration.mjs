import fs from 'node:fs';
import path from 'node:path';
import {
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  openPinnedRegularFileSync,
  samePinnedFileIdentity,
} from '../runtime/pinned-file-reader.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUBJECT_KIND = 'ExternalPrincipalIdentityAttestationSubject';
const SIGNER_ROLE = 'external_principal_identity_attestor';
const MAXIMUM_CONFIG_BYTES = 1024 * 1024;
const CONFIGURATION_V1_KEYS = Object.freeze([
  'authorityEnvelope', 'configurationHash', 'kind', 'maximumLifetimeMs',
  'signerKeyIds', 'signerRole', 'status', 'subject', 'trustStore',
  'trustStoreHash', 'version',
]);
const CONFIGURATION_V2_KEYS = Object.freeze([
  ...CONFIGURATION_V1_KEYS,
  'identityPolicy',
]);
const IDENTITY_POLICY_KEYS = Object.freeze([
  'assuranceProfile', 'credentialRootIdentityHash', 'kind',
  'platformAttestationRequired', 'principalId', 'provider',
  'providerAccountIdentityHash', 'serviceId', 'signerPublicKeySpkiHash',
  'trustDomainIdentityHash', 'version',
]);

function canonicalKeyIds(values) {
  const selected = [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
  return selected.length >= 1 && selected.length <= 4
    && selected.every((value) => SAFE_ID.test(value)) ? Object.freeze(selected) : null;
}

function canonicalLifetime(value) {
  const selected = Number(value);
  return Number.isSafeInteger(selected) && selected >= 1_000
    && selected <= 24 * 60 * 60 * 1000 ? selected : null;
}

export function buildAutonomousResearchAuthorIdentityPolicy({
  subject,
} = {}) {
  if (!verifyExternalPrincipalIdentityAttestationSubject(subject, {
    requirePlatformAttestation: true,
  })) {
    throw new Error('autonomous_research_author_identity_policy_subject_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchAuthorIdentityPolicy',
    serviceId: subject.serviceId,
    principalId: subject.principalId,
    provider: subject.provider,
    providerAccountIdentityHash: subject.providerAccountIdentityHash,
    credentialRootIdentityHash: subject.credentialRootIdentityHash,
    trustDomainIdentityHash: subject.trustDomainIdentityHash,
    signerPublicKeySpkiHash: subject.signerPublicKeySpkiHash,
    assuranceProfile: subject.assuranceProfile,
    platformAttestationRequired: true,
  });
}

function stableIdentityPolicy(value, subject) {
  const derived = buildAutonomousResearchAuthorIdentityPolicy({ subject });
  const selected = value ?? derived;
  if (!hasExactObjectKeys(selected, IDENTITY_POLICY_KEYS)
    || JSON.stringify(selected) !== JSON.stringify(derived)) {
    throw new Error('autonomous_research_author_identity_policy_binding_invalid');
  }
  return derived;
}

export function buildAutonomousResearchAuthorIdentityConfiguration({
  version = 1,
  subject,
  authorityEnvelope,
  trustStore,
  signerKeyIds,
  signerRole = SIGNER_ROLE,
  maximumLifetimeMs = 15 * 60 * 1000,
  identityPolicy = null,
} = {}) {
  const expectedKeyIds = canonicalKeyIds(signerKeyIds);
  const lifetime = canonicalLifetime(maximumLifetimeMs);
  const trust = inspectPinnedExternalEvidenceTrustStore(trustStore, {
    requiredRole: signerRole,
    expectedKeyIds,
  });
  let envelope = null;
  try { envelope = buildPinnedExternalEvidenceEnvelope(authorityEnvelope); }
  catch { /* rejected below */ }
  if (![1, 2].includes(version)
    || !expectedKeyIds || !lifetime || signerRole !== SIGNER_ROLE || !trust.ready
    || !verifyExternalPrincipalIdentityAttestationSubject(subject, {
      maximumLifetimeMs: lifetime,
      requirePlatformAttestation: true,
    })
    || !envelope || JSON.stringify(envelope) !== JSON.stringify(authorityEnvelope)
    || envelope.subjectKind !== SUBJECT_KIND
    || envelope.subjectHash
      !== subject.externalPrincipalIdentityAttestationSubjectHash) {
    throw new Error('autonomous_research_author_identity_configuration_invalid');
  }
  const selectedIdentityPolicy = version === 2
    ? stableIdentityPolicy(identityPolicy, subject) : null;
  const common = {
    version,
    kind: 'AutonomousResearchAuthorIdentityConfiguration',
    status: 'autonomous_research_author_identity_configured',
    trustStoreHash: trust.trustStoreHash,
    signerKeyIds: expectedKeyIds,
    signerRole: SIGNER_ROLE,
    maximumLifetimeMs: lifetime,
  };
  const identity = version === 2 ? {
    ...common,
    identityPolicy: selectedIdentityPolicy,
  } : {
    ...common,
    subject,
    authorityEnvelope: envelope,
    trustStore: trust.canonicalTrustStore,
  };
  const configurationHash = hashRecord(
    'AutonomousResearchAuthorIdentityConfiguration',
    identity,
  );
  const payload = version === 2 ? {
    ...common,
    identityPolicy: selectedIdentityPolicy,
    subject,
    authorityEnvelope: envelope,
    trustStore: trust.canonicalTrustStore,
  } : identity;
  return Object.freeze({
    ...payload,
    configurationHash,
  });
}

export function verifyAutonomousResearchAuthorIdentityConfiguration(configuration) {
  const keys = configuration?.version === 2
    ? CONFIGURATION_V2_KEYS : CONFIGURATION_V1_KEYS;
  if (!hasExactObjectKeys(configuration, keys)) return false;
  try {
    return JSON.stringify(buildAutonomousResearchAuthorIdentityConfiguration(configuration))
      === JSON.stringify(configuration);
  } catch { return false; }
}

export function readAutonomousResearchAuthorIdentityConfiguration({
  configPath,
  expectedConfigurationHash = null,
} = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let parsed;
  let pinned = null;
  try {
    const resolved = fs.realpathSync(candidate);
    if (resolved !== candidate) throw new Error('invalid');
    pinned = openPinnedRegularFileSync(candidate, {
      errorCode: 'autonomous_research_author_identity_configuration_file_invalid',
    });
    const stat = pinned.opened;
    const currentUid = BigInt(
      typeof process.getuid === 'function' ? process.getuid() : Number(stat.uid),
    );
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || stat.size < 1n || stat.size > BigInt(MAXIMUM_CONFIG_BYTES)
      || (stat.mode & 0o022n) !== 0n
      || (stat.uid !== 0n && stat.uid !== currentUid)) throw new Error('invalid');
    const bytes = fs.readFileSync(pinned.descriptor);
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (BigInt(bytes.length) !== stat.size
      || !samePinnedFileIdentity(stat, after)
      || !samePinnedFileIdentity(
        after,
        fs.lstatSync(candidate, { bigint: true }),
      )) throw new Error('invalid');
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('autonomous_research_author_identity_configuration_file_invalid');
  } finally {
    if (pinned?.descriptor !== undefined) fs.closeSync(pinned.descriptor);
  }
  if (!verifyAutonomousResearchAuthorIdentityConfiguration(parsed)) {
    throw new Error('autonomous_research_author_identity_configuration_verification_failed');
  }
  if (expectedConfigurationHash !== null
    && (!SHA256.test(String(expectedConfigurationHash || '').toLowerCase())
      || parsed.configurationHash !== String(expectedConfigurationHash).toLowerCase())) {
    throw new Error('autonomous_research_author_identity_configuration_pin_mismatch');
  }
  return parsed;
}

export function inspectAutonomousResearchAuthorIdentity({
  configuration,
  author,
  now = new Date(),
  expectedConfigurationHash = null,
} = {}) {
  const selected = buildAutonomousResearchAuthorIdentityConfiguration(configuration);
  const expectedHash = String(expectedConfigurationHash || '').toLowerCase();
  if (!SHA256.test(expectedHash)) {
    throw new Error('autonomous_research_author_identity_configuration_pin_required');
  }
  if (selected.configurationHash !== expectedHash) {
    throw new Error('autonomous_research_author_identity_configuration_pin_mismatch');
  }
  const subject = selected.subject;
  if (!author?.effectivePrincipalId || !author?.capabilityReceipt
    || !verifyExternalPrincipalIdentityAttestationSubject(subject, {
      now,
      maximumLifetimeMs: selected.maximumLifetimeMs,
      requirePlatformAttestation: true,
    })
    || subject.principalId !== author.effectivePrincipalId
    || subject.provider !== author.capabilityReceipt.provider
    || subject.credentialRootIdentityHash
      !== author.capabilityReceipt.credentialRootIdentityHash) {
    throw new Error('autonomous_research_author_identity_binding_invalid');
  }
  const verificationReceipt = assertPinnedExternalEvidenceEnvelope({
    envelope: selected.authorityEnvelope,
    subjectKind: SUBJECT_KIND,
    subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
    trustStore: selected.trustStore,
    requiredRole: selected.signerRole,
    expectedKeyIds: selected.signerKeyIds,
    now,
    maximumLifetimeMs: selected.maximumLifetimeMs,
  });
  const payload = {
    version: 1,
    kind: 'AutonomousResearchAuthorIdentityInspection',
    status: 'autonomous_research_author_identity_verified',
    ready: true,
    configurationVersion: selected.version,
    stablePolicyPinned: selected.version === 2,
    stableIdentityPolicyHash: selected.version === 2
      ? hashRecord(
        'AutonomousResearchAuthorIdentityPolicy',
        selected.identityPolicy,
      ) : null,
    cryptographicAuthorityReady: true,
    identityIndependenceReferenceReady: true,
    configurationPinned: true,
    expectedConfigurationHash: expectedHash,
    configurationHash: selected.configurationHash,
    subject,
    authorityEnvelope: selected.authorityEnvelope,
    verificationReceipt,
    trustSetHash: hashRecord('AutonomousResearchAuthorIdentityTrustSet', {
      trustStoreHash: selected.trustStoreHash,
      subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
      providerAccountIdentityHash: subject.providerAccountIdentityHash,
      credentialRootIdentityHash: subject.credentialRootIdentityHash,
      signerPublicKeySpkiHash: subject.signerPublicKeySpkiHash,
    }),
    signatureVerificationPolicyHash: hashRecord(
      'AutonomousResearchAuthorIdentitySignatureVerificationPolicy',
      {
        policy: 'pinned-platform-account-canonical-json-ed25519-v1',
        signerRole: selected.signerRole,
        signerKeyIds: selected.signerKeyIds,
        maximumLifetimeMs: selected.maximumLifetimeMs,
      },
    ),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchAuthorIdentityInspectionHash: hashRecord(
      'AutonomousResearchAuthorIdentityInspection', payload,
    ),
  });
}
