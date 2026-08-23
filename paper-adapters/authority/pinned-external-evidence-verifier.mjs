import crypto from 'node:crypto';
import {
  immutableAuthoritySigningPayload,
  verifyImmutableEd25519AuthorityDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const ENVELOPE_KEYS = Object.freeze([
  'expiresAt', 'kind', 'signatures', 'signedAt', 'subjectHash', 'subjectKind', 'version',
]);
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'keyId', 'role', 'value']);
const VERIFICATION_RECEIPT_HASH_FIELD =
  'pinnedExternalEvidenceVerificationReceiptHash';
const verifiedReceiptCapabilities = new WeakSet();

function canonicalInstant(value) {
  const candidate = String(value || '');
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate
    ? candidate : null;
}

function canonicalNow(value) {
  const selected = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(selected.getTime())) {
    throw new Error('pinned_external_evidence_clock_invalid');
  }
  return selected;
}

function canonicalTrustKey(key) {
  const allowed = new Set([
    'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'organization', 'publicKeyPem',
    'revokedAt', 'roles', 'status', 'subjectId',
  ]);
  if (!key || typeof key !== 'object' || Array.isArray(key)
    || Object.keys(key).some((field) => !allowed.has(field))) {
    throw new Error('pinned_external_evidence_trust_key_invalid');
  }
  const roles = [...new Set((Array.isArray(key.roles) ? key.roles : []).map(String))].sort();
  const effectiveFrom = key.effectiveFrom === undefined || key.effectiveFrom === null
    ? null : canonicalInstant(key.effectiveFrom);
  const expiresAt = key.expiresAt === undefined || key.expiresAt === null
    ? null : canonicalInstant(key.expiresAt);
  const revokedAt = key.revokedAt === undefined || key.revokedAt === null
    ? null : canonicalInstant(key.revokedAt);
  if (!SAFE_ID.test(String(key.keyId || '')) || !SAFE_ID.test(String(key.subjectId || ''))
    || key.algorithm !== 'ed25519' || key.status !== 'active' || roles.length < 1
    || roles.some((role) => !SAFE_ID.test(role)) || key.privateKeyPem
    || /PRIVATE KEY/.test(String(key.publicKeyPem || ''))
    || (key.effectiveFrom !== undefined && key.effectiveFrom !== null && !effectiveFrom)
    || (key.expiresAt !== undefined && key.expiresAt !== null && !expiresAt)
    || (key.revokedAt !== undefined && key.revokedAt !== null && !revokedAt)
    || (effectiveFrom && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveFrom))) {
    throw new Error('pinned_external_evidence_trust_key_invalid');
  }
  let publicKey;
  try { publicKey = crypto.createPublicKey(String(key.publicKeyPem || '')); }
  catch { throw new Error('pinned_external_evidence_trust_key_invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('pinned_external_evidence_trust_key_not_ed25519');
  }
  const publicKeySpkiHash = hashBytes(publicKey.export({ type: 'spki', format: 'der' }));
  return Object.freeze({
    keyId: String(key.keyId),
    subjectId: String(key.subjectId),
    organization: key.organization === undefined || key.organization === null
      ? null : String(key.organization),
    algorithm: 'ed25519',
    publicKeyPem: String(key.publicKeyPem),
    roles: Object.freeze(roles),
    status: 'active',
    effectiveFrom,
    expiresAt,
    revokedAt,
    publicKeySpkiHash,
  });
}

export function inspectPinnedExternalEvidenceTrustStore(trustStore, {
  requiredRole = null,
  expectedKeyIds = null,
} = {}) {
  const blockers = [];
  let keys = [];
  if (trustStore?.version !== 1 || trustStore?.kind !== 'AuthorityTrustStore'
    || !Array.isArray(trustStore?.keys) || trustStore.keys.length < 1
    || trustStore.keys.length > 256) {
    blockers.push('pinned_external_evidence_trust_store_invalid');
  } else {
    try { keys = trustStore.keys.map(canonicalTrustKey); }
    catch (error) { blockers.push(error?.message || 'pinned_external_evidence_trust_key_invalid'); }
  }
  const keyIds = keys.map((key) => key.keyId);
  const spkiHashes = keys.map((key) => key.publicKeySpkiHash);
  if (new Set(keyIds).size !== keyIds.length) {
    blockers.push('pinned_external_evidence_trust_key_id_duplicate');
  }
  if (new Set(spkiHashes).size !== spkiHashes.length) {
    blockers.push('pinned_external_evidence_trust_key_spki_duplicate');
  }
  const role = requiredRole === null ? null : String(requiredRole || '');
  if (role !== null && (!SAFE_ID.test(role)
    || !keys.some((key) => key.roles.includes(role)))) {
    blockers.push('pinned_external_evidence_trust_role_missing');
  }
  const expected = expectedKeyIds === null ? null
    : [...new Set((Array.isArray(expectedKeyIds) ? expectedKeyIds : []).map(String))].sort();
  if (expected !== null && (expected.length < 1
    || expected.some((keyId) => !keys.some((key) => key.keyId === keyId)))) {
    blockers.push('pinned_external_evidence_expected_key_missing');
  }
  const canonicalStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: Object.freeze([...keys].sort((left, right) => left.keyId.localeCompare(right.keyId))
      .map(({ publicKeySpkiHash: _spki, ...key }) => Object.freeze(key))),
  });
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    version: 1,
    kind: 'PinnedExternalEvidenceTrustStoreInspection',
    status: uniqueBlockers.length
      ? 'pinned_external_evidence_trust_store_blocked'
      : 'pinned_external_evidence_trust_store_ready',
    ready: uniqueBlockers.length === 0,
    cryptographicAuthorityReady: uniqueBlockers.length === 0,
    requiredRole: role,
    expectedKeyIds: expected === null ? null : Object.freeze(expected),
    trustStoreHash: uniqueBlockers.length
      ? null : hashRecord('PinnedExternalEvidenceTrustStore', canonicalStore),
    keys: Object.freeze(keys),
    canonicalTrustStore: uniqueBlockers.length ? null : canonicalStore,
    blockers: uniqueBlockers,
  });
}

export function buildPinnedExternalEvidenceEnvelope({
  subjectKind,
  subjectHash,
  signedAt,
  expiresAt,
  signatures,
} = {}) {
  const selectedSignedAt = canonicalInstant(signedAt);
  const selectedExpiresAt = canonicalInstant(expiresAt);
  if (!SAFE_ID.test(String(subjectKind || '')) || !SHA256.test(String(subjectHash || ''))
    || !selectedSignedAt || !selectedExpiresAt
    || Date.parse(selectedExpiresAt) <= Date.parse(selectedSignedAt)
    || !Array.isArray(signatures) || signatures.length < 1 || signatures.length > 16
    || signatures.some((signature) => !hasExactObjectKeys(signature, SIGNATURE_KEYS))) {
    throw new Error('pinned_external_evidence_envelope_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'PinnedExternalEvidenceEnvelope',
    subjectKind: String(subjectKind),
    subjectHash: String(subjectHash),
    signedAt: selectedSignedAt,
    expiresAt: selectedExpiresAt,
    signatures: Object.freeze(signatures.map((signature) => Object.freeze({ ...signature }))),
  });
}

export function pinnedExternalEvidenceSigningPayload(envelope) {
  if (!hasExactObjectKeys(envelope, ENVELOPE_KEYS)) {
    throw new Error('pinned_external_evidence_envelope_shape_invalid');
  }
  const rebuilt = buildPinnedExternalEvidenceEnvelope(envelope);
  if (JSON.stringify(rebuilt) !== JSON.stringify(envelope)) {
    throw new Error('pinned_external_evidence_envelope_not_canonical');
  }
  return immutableAuthoritySigningPayload(envelope);
}

function blockedVerificationReceipt({
  subjectKind,
  subjectHash,
  requiredRole,
  trustStoreHash,
  envelopeHash,
  verifiedAt,
  blockers,
} = {}) {
  const payload = {
    version: 1,
    kind: 'PinnedExternalEvidenceVerificationReceipt',
    status: 'pinned_external_evidence_verification_blocked',
    verificationPolicy: 'pinned-canonical-json-ed25519-v1',
    subjectKind: subjectKind || null,
    subjectHash: subjectHash || null,
    requiredRole: requiredRole || null,
    trustStoreHash: trustStoreHash || null,
    envelopeHash: envelopeHash || null,
    verifiedKeyIds: Object.freeze([]),
    verifiedSubjectIds: Object.freeze([]),
    verifiedPublicKeySpkiHashes: Object.freeze([]),
    signedAt: null,
    expiresAt: null,
    verifiedAt,
    cryptographicAuthorityReady: false,
    externalActionPerformed: false,
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    [VERIFICATION_RECEIPT_HASH_FIELD]: hashRecord(
      'PinnedExternalEvidenceVerificationReceipt', payload,
    ),
  });
}

export function verifyPinnedExternalEvidenceEnvelope({
  envelope,
  subjectKind,
  subjectHash,
  trustStore,
  requiredRole,
  expectedKeyIds = null,
  now = new Date(),
  maximumLifetimeMs = 24 * 60 * 60 * 1000,
} = {}) {
  const observedNow = canonicalNow(now);
  const verifiedAt = observedNow.toISOString();
  const role = String(requiredRole || '');
  const blockers = [];
  const trust = inspectPinnedExternalEvidenceTrustStore(trustStore, {
    requiredRole: role,
    expectedKeyIds,
  });
  blockers.push(...trust.blockers);
  let canonicalEnvelope = null;
  try {
    if (!hasExactObjectKeys(envelope, ENVELOPE_KEYS)) {
      throw new Error('pinned_external_evidence_envelope_shape_invalid');
    }
    canonicalEnvelope = buildPinnedExternalEvidenceEnvelope(envelope);
    if (JSON.stringify(canonicalEnvelope) !== JSON.stringify(envelope)) {
      throw new Error('pinned_external_evidence_envelope_not_canonical');
    }
  } catch (error) {
    blockers.push(error?.message || 'pinned_external_evidence_envelope_invalid');
  }
  if (canonicalEnvelope && (canonicalEnvelope.subjectKind !== subjectKind
    || canonicalEnvelope.subjectHash !== subjectHash)) {
    blockers.push('pinned_external_evidence_subject_binding_invalid');
  }
  const envelopeHash = canonicalEnvelope
    ? hashRecord('PinnedExternalEvidenceEnvelope', canonicalEnvelope) : null;
  let signature = null;
  if (canonicalEnvelope && trust.ready && blockers.length === 0) {
    try {
      signature = verifyImmutableEd25519AuthorityDocument({
        document: canonicalEnvelope,
        trustStore: trust.canonicalTrustStore,
        requiredRole: role,
        now: observedNow,
        maximumLifetimeMs,
      });
    } catch (error) {
      blockers.push(error?.message || 'pinned_external_evidence_signature_invalid');
    }
  }
  const verifiedKeyIds = signature?.verifiedSignatures?.map((item) => item.keyId).sort() || [];
  const expected = expectedKeyIds === null ? null
    : [...new Set(expectedKeyIds.map(String))].sort();
  if (signature && expected !== null
    && JSON.stringify(verifiedKeyIds) !== JSON.stringify(expected)) {
    blockers.push('pinned_external_evidence_signer_key_binding_invalid');
  }
  if (signature) {
    const signedAtMs = Date.parse(signature.signedAt);
    for (const verified of signature.verifiedSignatures) {
      const key = trust.keys.find((candidate) => candidate.keyId === verified.keyId);
      const effectiveFrom = key?.effectiveFrom ? Date.parse(key.effectiveFrom) : null;
      const expiresAt = key?.expiresAt ? Date.parse(key.expiresAt) : null;
      const revokedAt = key?.revokedAt ? Date.parse(key.revokedAt) : null;
      if ((effectiveFrom !== null && signedAtMs < effectiveFrom)
        || (expiresAt !== null && signedAtMs >= expiresAt)
        || (revokedAt !== null && signedAtMs >= revokedAt)) {
        blockers.push('pinned_external_evidence_signer_outside_key_time_window');
      }
    }
  }
  if (blockers.length > 0 || !signature) {
    return blockedVerificationReceipt({
      subjectKind,
      subjectHash,
      requiredRole: role,
      trustStoreHash: trust.trustStoreHash,
      envelopeHash,
      verifiedAt,
      blockers,
    });
  }
  const verifiedPublicKeySpkiHashes = signature.verifiedSignatures.map((item) => (
    item.publicKeySpkiHash
  )).sort();
  const payload = {
    version: 1,
    kind: 'PinnedExternalEvidenceVerificationReceipt',
    status: 'pinned_external_evidence_verified',
    verificationPolicy: 'pinned-canonical-json-ed25519-v1',
    subjectKind,
    subjectHash,
    requiredRole: role,
    trustStoreHash: trust.trustStoreHash,
    envelopeHash,
    verifiedKeyIds: Object.freeze(verifiedKeyIds),
    verifiedSubjectIds: Object.freeze(signature.verifiedSignatures
      .map((item) => item.subjectId).sort()),
    verifiedPublicKeySpkiHashes: Object.freeze(verifiedPublicKeySpkiHashes),
    signedAt: signature.signedAt,
    expiresAt: signature.expiresAt,
    verifiedAt,
    cryptographicAuthorityReady: true,
    externalActionPerformed: false,
    blockers: Object.freeze([]),
  };
  const receipt = Object.freeze({
    ...payload,
    [VERIFICATION_RECEIPT_HASH_FIELD]: hashRecord(
      'PinnedExternalEvidenceVerificationReceipt', payload,
    ),
  });
  verifiedReceiptCapabilities.add(receipt);
  return receipt;
}

export function assertPinnedExternalEvidenceVerificationReceipt(receipt, {
  subjectKind = null,
  subjectHash = null,
  requiredRole = null,
} = {}) {
  const { [VERIFICATION_RECEIPT_HASH_FIELD]: claimedHash, ...payload } = receipt || {};
  if (!receipt || !verifiedReceiptCapabilities.has(receipt)
    || receipt.status !== 'pinned_external_evidence_verified'
    || receipt.cryptographicAuthorityReady !== true
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('PinnedExternalEvidenceVerificationReceipt', payload) !== claimedHash
    || (subjectKind !== null && receipt.subjectKind !== subjectKind)
    || (subjectHash !== null && receipt.subjectHash !== subjectHash)
    || (requiredRole !== null && receipt.requiredRole !== requiredRole)) {
    throw new Error('pinned_external_evidence_verification_capability_invalid');
  }
  return receipt;
}

export function assertPinnedExternalEvidenceEnvelope(input = {}) {
  const receipt = verifyPinnedExternalEvidenceEnvelope(input);
  return assertPinnedExternalEvidenceVerificationReceipt(receipt, {
    subjectKind: input.subjectKind,
    subjectHash: input.subjectHash,
    requiredRole: input.requiredRole,
  });
}
