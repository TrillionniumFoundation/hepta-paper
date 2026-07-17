import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

function canonicalKey(value) {
  const roles = [...new Set((Array.isArray(value?.roles) ? value.roles : []).map(String))].sort();
  return Object.freeze({
    keyId: String(value?.keyId || ''),
    subjectId: String(value?.subjectId || ''),
    organization: value?.organization ? String(value.organization) : null,
    algorithm: String(value?.algorithm || ''),
    publicKeyPem: String(value?.publicKeyPem || ''),
    roles: Object.freeze(roles),
    status: String(value?.status || ''),
    revoked: value?.revoked === true,
    effectiveFrom: value?.effectiveFrom ? new Date(value.effectiveFrom).toISOString() : null,
    expiresAt: value?.expiresAt ? new Date(value.expiresAt).toISOString() : null,
    revokedAt: value?.revokedAt ? new Date(value.revokedAt).toISOString() : null,
  });
}

function keyValid(value) {
  try {
    const key = canonicalKey(value);
    return KEY_ID.test(key.keyId)
      && Boolean(key.subjectId)
      && key.algorithm === 'ed25519'
      && /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(key.publicKeyPem)
      && !/PRIVATE KEY/.test(key.publicKeyPem)
      && key.roles.length > 0
      && key.roles.every((role) => KEY_ID.test(role))
      && ['active', 'inactive', 'revoked', 'expired'].includes(key.status)
      && [key.effectiveFrom, key.expiresAt, key.revokedAt]
        .every((date) => date === null || Number.isFinite(Date.parse(date)));
  } catch { return false; }
}

function recordPayload(record) {
  if (!record || typeof record !== 'object') return null;
  const { publicAuthorityTrustSnapshotHash: _hash, ...payload } = record;
  return payload;
}

export function buildPublicAuthorityTrustSnapshot({ trustStore, referencedKeyIds = [], capturedAt } = {}) {
  const required = [...new Set(referencedKeyIds.map(String).filter(Boolean))].sort();
  const sourceKeys = new Map((Array.isArray(trustStore?.keys) ? trustStore.keys : [])
    .filter((key) => key?.keyId).map((key) => [String(key.keyId), key]));
  if (trustStore?.version !== 1 || trustStore?.kind !== 'AuthorityTrustStore'
    || required.some((keyId) => !sourceKeys.has(keyId))) {
    throw new Error('public_authority_trust_snapshot_source_invalid');
  }
  const keys = required.map((keyId) => canonicalKey({
    ...sourceKeys.get(keyId),
    effectiveFrom: sourceKeys.get(keyId)?.effectiveFrom || sourceKeys.get(keyId)?.validFrom || null,
    revoked: sourceKeys.get(keyId)?.revoked === true
      || sourceKeys.get(keyId)?.status === 'revoked'
      || Boolean(sourceKeys.get(keyId)?.revokedAt),
  }));
  const payload = {
    version: 1,
    kind: 'CampaignReleasePublicAuthorityTrustSnapshot',
    status: 'public_authority_trust_snapshot_ready',
    sourceTrustStoreVersion: 1,
    sourceTrustStoreKind: 'AuthorityTrustStore',
    scope: 'minimum-referenced-public-keys-v1',
    requiredRole: 'dataset_harness_operator',
    referencedKeyIds: Object.freeze(required),
    keys: Object.freeze(keys),
    capturedAt: new Date(capturedAt).toISOString(),
    privateKeysIncluded: false,
    credentialsIncluded: false,
    hostAbsolutePathsIncluded: false,
    assurance: 'release-bound-frozen-public-trust-material-v1',
    externalActionPerformed: false,
  };
  const snapshot = Object.freeze({
    ...payload,
    publicAuthorityTrustSnapshotHash: hashRecord('CampaignReleasePublicAuthorityTrustSnapshot', payload),
  });
  const verification = verifyPublicAuthorityTrustSnapshot(snapshot, { requiredKeyIds: required });
  if (!verification.valid) throw new Error(`public_authority_trust_snapshot_invalid:${verification.blockers.join(',')}`);
  return snapshot;
}

export function verifyPublicAuthorityTrustSnapshot(snapshot, { requiredKeyIds = [], capturedAt = null } = {}) {
  const blockers = [];
  const payload = recordPayload(snapshot);
  if (snapshot?.version !== 1 || snapshot?.kind !== 'CampaignReleasePublicAuthorityTrustSnapshot'
    || snapshot?.status !== 'public_authority_trust_snapshot_ready'
    || snapshot?.sourceTrustStoreVersion !== 1 || snapshot?.sourceTrustStoreKind !== 'AuthorityTrustStore'
    || snapshot?.scope !== 'minimum-referenced-public-keys-v1'
    || snapshot?.requiredRole !== 'dataset_harness_operator'
    || snapshot?.privateKeysIncluded !== false || snapshot?.credentialsIncluded !== false
    || snapshot?.hostAbsolutePathsIncluded !== false || snapshot?.externalActionPerformed !== false
    || snapshot?.assurance !== 'release-bound-frozen-public-trust-material-v1') {
    blockers.push('public_authority_trust_snapshot_shape_invalid');
  }
  if (!payload || !SHA256.test(String(snapshot?.publicAuthorityTrustSnapshotHash || ''))
    || hashRecord('CampaignReleasePublicAuthorityTrustSnapshot', payload) !== snapshot?.publicAuthorityTrustSnapshotHash) {
    blockers.push('public_authority_trust_snapshot_hash_invalid');
  }
  if (!Number.isFinite(Date.parse(String(snapshot?.capturedAt || '')))
    || (capturedAt && new Date(snapshot.capturedAt).toISOString() !== new Date(capturedAt).toISOString())) {
    blockers.push('public_authority_trust_snapshot_time_invalid');
  }
  const keys = Array.isArray(snapshot?.keys) ? snapshot.keys : [];
  const ids = keys.map((key) => key?.keyId);
  const declaredIds = Array.isArray(snapshot?.referencedKeyIds) ? snapshot.referencedKeyIds.map(String) : [];
  const required = [...new Set(requiredKeyIds.map(String).filter(Boolean))].sort();
  if (!keys.every(keyValid) || new Set(ids).size !== ids.length
    || JSON.stringify(ids) !== JSON.stringify([...ids].sort())
    || JSON.stringify(declaredIds) !== JSON.stringify([...new Set(ids)].sort())
    || (required.length > 0 && JSON.stringify(declaredIds) !== JSON.stringify(required))) {
    blockers.push('public_authority_trust_snapshot_keys_invalid');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}

export function publicTrustStoreFromSnapshot(snapshot) {
  const verification = verifyPublicAuthorityTrustSnapshot(snapshot);
  if (!verification.valid) return null;
  return Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: Object.freeze(snapshot.keys.map((key) => Object.freeze({ ...key }))),
  });
}
