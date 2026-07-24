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

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUBJECT_KIND = 'ExternalPrincipalIdentityAttestationSubject';
const SIGNER_ROLE = 'external_principal_identity_attestor';
const MAXIMUM_CONFIG_BYTES = 1024 * 1024;
const CONFIGURATION_KEYS = Object.freeze([
  'authorityEnvelope', 'configurationHash', 'kind', 'maximumLifetimeMs',
  'signerKeyIds', 'signerRole', 'status', 'subject', 'trustStore',
  'trustStoreHash', 'version',
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

export function buildAutonomousResearchAuthorIdentityConfiguration({
  subject,
  authorityEnvelope,
  trustStore,
  signerKeyIds,
  signerRole = SIGNER_ROLE,
  maximumLifetimeMs = 15 * 60 * 1000,
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
  if (!expectedKeyIds || !lifetime || signerRole !== SIGNER_ROLE || !trust.ready
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
  const payload = {
    version: 1,
    kind: 'AutonomousResearchAuthorIdentityConfiguration',
    status: 'autonomous_research_author_identity_configured',
    subject,
    authorityEnvelope: envelope,
    trustStore: trust.canonicalTrustStore,
    trustStoreHash: trust.trustStoreHash,
    signerKeyIds: expectedKeyIds,
    signerRole: SIGNER_ROLE,
    maximumLifetimeMs: lifetime,
  };
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('AutonomousResearchAuthorIdentityConfiguration', payload),
  });
}

export function verifyAutonomousResearchAuthorIdentityConfiguration(configuration) {
  if (!hasExactObjectKeys(configuration, CONFIGURATION_KEYS)) return false;
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
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size < 1 || stat.size > MAXIMUM_CONFIG_BYTES
      || (stat.mode & 0o022) !== 0) throw new Error('invalid');
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch {
    throw new Error('autonomous_research_author_identity_configuration_file_invalid');
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
