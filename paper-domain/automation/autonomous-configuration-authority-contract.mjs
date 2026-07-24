import {
  immutableAuthoritySigningPayload,
  verifyImmutableEd25519AuthorityDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const PROOF_KEYS = Object.freeze([
  'authorityEnvelope', 'configurationHash', 'expectedKeyIds', 'kind',
  'maximumLifetimeMs', 'requiredRole', 'signatureVerificationPolicyHash',
  'subjectHash', 'subjectKind', 'trustSetHash', 'trustStore', 'version',
]);

function ids(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) return null;
  const selected = values.map((value) => String(value || ''));
  if (selected.some((value) => !SAFE_ID.test(value))
    || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected].sort());
}

function canonicalObservedAt(value) {
  const candidate = String(value || '');
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate
    ? candidate : null;
}

function authorityConfigurationPayload({
  subjectKind,
  subjectHash,
  requiredRole,
  expectedKeyIds,
  trustStore,
  authorityEnvelope,
  maximumLifetimeMs,
} = {}) {
  const selectedKeyIds = ids(expectedKeyIds);
  const lifetime = Number(maximumLifetimeMs);
  if (!SAFE_ID.test(String(subjectKind || '')) || !SHA256.test(String(subjectHash || ''))
    || !SAFE_ID.test(String(requiredRole || '')) || !selectedKeyIds
    || !trustStore || typeof trustStore !== 'object' || Array.isArray(trustStore)
    || !authorityEnvelope || typeof authorityEnvelope !== 'object'
    || !Number.isSafeInteger(lifetime) || lifetime < 1
    || lifetime > 31 * 24 * 60 * 60 * 1_000) {
    throw new Error('autonomous_configuration_authority_input_invalid');
  }
  return Object.freeze({
    subjectKind: String(subjectKind),
    subjectHash: String(subjectHash),
    requiredRole: String(requiredRole),
    expectedKeyIds: selectedKeyIds,
    trustStore,
    authorityEnvelope,
    maximumLifetimeMs: lifetime,
  });
}

function verifySignature(payload, observedAt) {
  if (payload.authorityEnvelope?.subjectKind !== payload.subjectKind
    || payload.authorityEnvelope?.subjectHash !== payload.subjectHash) {
    throw new Error('autonomous_configuration_authority_subject_binding_invalid');
  }
  const result = verifyImmutableEd25519AuthorityDocument({
    document: payload.authorityEnvelope,
    trustStore: payload.trustStore,
    requiredRole: payload.requiredRole,
    now: new Date(observedAt),
    maximumLifetimeMs: payload.maximumLifetimeMs,
  });
  const verifiedKeyIds = result.verifiedSignatures.map((signature) => signature.keyId).sort();
  if (JSON.stringify(verifiedKeyIds) !== JSON.stringify(payload.expectedKeyIds)) {
    throw new Error('autonomous_configuration_authority_key_binding_invalid');
  }
  return result;
}

export function buildAutonomousConfigurationAuthorityProof(input = {}, {
  observedAt,
} = {}) {
  const selectedObservedAt = canonicalObservedAt(observedAt);
  if (!selectedObservedAt) throw new Error('autonomous_configuration_authority_clock_invalid');
  const authority = authorityConfigurationPayload(input);
  verifySignature(authority, selectedObservedAt);
  const trustSetHash = hashRecord('AutonomousConfigurationAuthorityTrustSet', {
    trustStore: authority.trustStore,
    expectedKeyIds: authority.expectedKeyIds,
    requiredRole: authority.requiredRole,
  });
  const signatureVerificationPolicyHash = hashRecord(
    'AutonomousConfigurationSignatureVerificationPolicy',
    {
      policy: 'canonical-json-ed25519-exact-key-set-v1',
      subjectKind: authority.subjectKind,
      requiredRole: authority.requiredRole,
      maximumLifetimeMs: authority.maximumLifetimeMs,
    },
  );
  const configurationHash = hashRecord('AutonomousConfigurationAuthorityConfiguration', {
    ...authority,
    trustSetHash,
    signatureVerificationPolicyHash,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousConfigurationAuthorityProof',
    ...authority,
    trustSetHash,
    signatureVerificationPolicyHash,
    configurationHash,
  });
}

export function verifyAutonomousConfigurationAuthorityProof(proof, {
  subjectKind,
  subjectHash,
  requiredRole,
  observedAt,
  expectedConfigurationHash = null,
} = {}) {
  if (!hasExactObjectKeys(proof, PROOF_KEYS)) return false;
  let rebuilt = null;
  try {
    rebuilt = buildAutonomousConfigurationAuthorityProof(proof, { observedAt });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(proof)
    && (subjectKind === undefined || subjectKind === proof.subjectKind)
    && (subjectHash === undefined || subjectHash === proof.subjectHash)
    && (requiredRole === undefined || requiredRole === proof.requiredRole)
    && (expectedConfigurationHash === null
      || expectedConfigurationHash === proof.configurationHash);
}

export function autonomousConfigurationAuthoritySigningPayload(envelope) {
  return immutableAuthoritySigningPayload(envelope);
}
