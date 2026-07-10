import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonIfExists } from './utils.mjs';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalAuthorityJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function authoritySigningPayload(document = {}) {
  const { signature: _signature, signatures: _signatures, ...payload } = document || {};
  return Buffer.from(canonicalAuthorityJson(payload), 'utf8');
}

export function signAuthorityDocument(document, {
  privateKeyPem,
  keyId,
  role,
} = {}) {
  if (!privateKeyPem || !keyId || !role) {
    throw new Error('signAuthorityDocument requires privateKeyPem, keyId, and role');
  }
  const value = crypto.sign(null, authoritySigningPayload(document), privateKeyPem).toString('base64');
  return {
    ...document,
    signatures: [
      ...(Array.isArray(document?.signatures) ? document.signatures : []),
      {
        keyId: String(keyId),
        role: String(role),
        algorithm: 'ed25519',
        value,
      },
    ],
  };
}

export async function loadAuthorityTrustStore({ runtimeRoot, trustStoreOverride = null } = {}) {
  if (trustStoreOverride) return trustStoreOverride;
  if (!runtimeRoot) return null;
  return readJsonIfExists(path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'));
}

function trustKeyMap(trustStore = null) {
  return new Map(
    (Array.isArray(trustStore?.keys) ? trustStore.keys : [])
      .filter((key) => key?.keyId)
      .map((key) => [String(key.keyId), key]),
  );
}

export function verifyAuthoritySignatures({
  document,
  trustStore,
  requiredRoles = [],
  minSignatures = null,
  requireDistinctSubjects = true,
} = {}) {
  const blockers = [];
  if (trustStore?.version !== 1 || trustStore?.kind !== 'AuthorityTrustStore') {
    blockers.push('authority_trust_store_missing_or_invalid');
  }
  const signatures = Array.isArray(document?.signatures) ? document.signatures : [];
  const requiredSignatureCount = minSignatures === null
    ? Math.max(1, requiredRoles.length)
    : Math.max(1, Number(minSignatures) || 1);
  if (signatures.length < requiredSignatureCount) blockers.push('authority_signatures_missing');
  const keys = trustKeyMap(trustStore);
  const seenKeyIds = new Set();
  const verifiedSignatures = [];
  const payload = authoritySigningPayload(document);
  for (const signature of signatures) {
    const keyId = String(signature?.keyId || '');
    const role = String(signature?.role || '');
    const signatureBlockers = [];
    if (!keyId) signatureBlockers.push('signature_key_id_missing');
    if (!role) signatureBlockers.push('signature_role_missing');
    if (signature?.algorithm !== 'ed25519') signatureBlockers.push('signature_algorithm_not_ed25519');
    if (seenKeyIds.has(keyId)) signatureBlockers.push('duplicate_signature_key_id');
    seenKeyIds.add(keyId);
    const trustedKey = keys.get(keyId) || null;
    if (!trustedKey) signatureBlockers.push('signature_key_not_trusted');
    if (trustedKey?.status !== 'active') signatureBlockers.push('signature_key_not_active');
    if (trustedKey?.algorithm !== 'ed25519') signatureBlockers.push('trusted_key_algorithm_not_ed25519');
    if (trustedKey?.privateKeyPem || /PRIVATE KEY/.test(String(trustedKey?.publicKeyPem || ''))) {
      signatureBlockers.push('private_key_material_forbidden_in_trust_store');
    }
    if (!Array.isArray(trustedKey?.roles) || !trustedKey.roles.includes(role)) {
      signatureBlockers.push('signature_role_not_authorized_for_key');
    }
    let cryptographicallyVerified = false;
    if (!signatureBlockers.length) {
      try {
        cryptographicallyVerified = crypto.verify(
          null,
          payload,
          trustedKey.publicKeyPem,
          Buffer.from(String(signature.value || ''), 'base64'),
        );
      } catch {
        cryptographicallyVerified = false;
      }
      if (!cryptographicallyVerified) signatureBlockers.push('authority_signature_invalid');
    }
    blockers.push(...signatureBlockers.map((blocker) => `${keyId || 'unknown'}:${blocker}`));
    if (!signatureBlockers.length) {
      verifiedSignatures.push({
        keyId,
        role,
        subjectId: String(trustedKey.subjectId || keyId),
        organization: trustedKey.organization || null,
        cryptographicallyVerified,
      });
    }
  }
  const verifiedRoles = new Set(verifiedSignatures.map((item) => item.role));
  for (const role of requiredRoles) {
    if (!verifiedRoles.has(role)) blockers.push(`required_authority_role_missing:${role}`);
  }
  if (verifiedSignatures.length < requiredSignatureCount) blockers.push('verified_authority_signature_count_insufficient');
  const verifiedSubjects = new Set(verifiedSignatures.map((item) => item.subjectId));
  if (requireDistinctSubjects && verifiedSignatures.length > 1 && verifiedSubjects.size !== verifiedSignatures.length) {
    blockers.push('authority_signers_must_be_distinct_subjects');
  }
  return {
    status: blockers.length ? 'authority_signatures_blocked' : 'authority_signatures_verified',
    cryptographicSignaturesVerified: blockers.length === 0,
    requiredRoles: [...requiredRoles],
    requiredSignatureCount,
    verifiedSignatures,
    verifiedRoles: [...verifiedRoles].sort(),
    verifiedSubjectIds: [...verifiedSubjects].sort(),
    blockers: [...new Set(blockers)],
  };
}

export function verifyAuthorityTimeWindow({
  signedAt,
  validFrom = null,
  expiresAt,
  now = new Date(),
  maximumLifetimeMs = null,
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const signedAtMs = Date.parse(String(signedAt || ''));
  const validFromMs = Date.parse(String(validFrom || signedAt || ''));
  const expiresAtMs = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(signedAtMs)) blockers.push('authority_signed_at_invalid');
  if (!Number.isFinite(validFromMs)) blockers.push('authority_valid_from_invalid');
  if (!Number.isFinite(expiresAtMs)) blockers.push('authority_expires_at_invalid');
  if (Number.isFinite(validFromMs) && nowMs < validFromMs) blockers.push('authority_not_yet_valid');
  if (Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs) blockers.push('authority_expired');
  if (Number.isFinite(signedAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs <= signedAtMs) {
    blockers.push('authority_expiry_not_after_signature');
  }
  if (maximumLifetimeMs !== null
    && Number.isFinite(signedAtMs)
    && Number.isFinite(expiresAtMs)
    && expiresAtMs - signedAtMs > maximumLifetimeMs) {
    blockers.push('authority_lifetime_exceeds_policy');
  }
  return {
    valid: blockers.length === 0,
    signedAt: Number.isFinite(signedAtMs) ? new Date(signedAtMs).toISOString() : null,
    validFrom: Number.isFinite(validFromMs) ? new Date(validFromMs).toISOString() : null,
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    blockers,
  };
}
