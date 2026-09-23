import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAXIMUM_DOCUMENT_BYTES = 4 * 1024 * 1024;

export function observeImmutableSignedBundleStartupTime() {
  return new Date();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, canonicalValue(value[key])]));
}

export function immutableAuthoritySigningPayload(document = {}) {
  const { signature: _signature, signatures: _signatures, ...payload } = document || {};
  return Buffer.from(JSON.stringify(canonicalValue(payload)), 'utf8');
}

export function readImmutableJsonDocument(filePath, {
  maximumBytes = MAXIMUM_DOCUMENT_BYTES,
} = {}) {
  const selectedPath = path.resolve(String(filePath || ''));
  if (!path.isAbsolute(selectedPath) || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1 || maximumBytes > MAXIMUM_DOCUMENT_BYTES) {
    throw new Error('immutable_signed_json_document_path_or_limit_invalid');
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      selectedPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < 2 || before.size > maximumBytes) {
      throw new Error('immutable_signed_json_document_file_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs) {
      throw new Error('immutable_signed_json_document_changed_during_read');
    }
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('immutable_signed_json_document_not_object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('immutable_signed_json_document_parse_invalid');
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function trustKeyMap(trustStore) {
  if (!trustStore || trustStore.version !== 1 || trustStore.kind !== 'AuthorityTrustStore'
    || !Array.isArray(trustStore.keys) || trustStore.keys.length < 1
    || trustStore.keys.length > 256) {
    throw new Error('immutable_signed_json_trust_store_invalid');
  }
  const entries = trustStore.keys.map((key) => {
    const keyId = String(key?.keyId || '');
    if (!keyId || key?.algorithm !== 'ed25519' || key?.status !== 'active'
      || !Array.isArray(key?.roles) || key.roles.length < 1
      || key.privateKeyPem || /PRIVATE KEY/.test(String(key?.publicKeyPem || ''))) {
      throw new Error('immutable_signed_json_trust_key_invalid');
    }
    let publicKey = null;
    try { publicKey = crypto.createPublicKey(String(key.publicKeyPem || '')); }
    catch { throw new Error('immutable_signed_json_trust_key_invalid'); }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('immutable_signed_json_trust_key_not_ed25519');
    }
    return [keyId, Object.freeze({ key, publicKey })];
  });
  if (new Set(entries.map(([keyId]) => keyId)).size !== entries.length) {
    throw new Error('immutable_signed_json_trust_key_duplicate');
  }
  return new Map(entries);
}

export function verifyImmutableEd25519AuthorityDocument({
  document,
  trustStore,
  requiredRole,
  now = new Date(),
  maximumLifetimeMs = null,
} = {}) {
  const role = String(requiredRole || '');
  const signedAtMs = Date.parse(String(document?.signedAt || ''));
  const expiresAtMs = Date.parse(String(document?.expiresAt || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  if (!role || !Number.isFinite(nowMs) || !Number.isFinite(signedAtMs)
    || !Number.isFinite(expiresAtMs) || signedAtMs > nowMs || expiresAtMs <= nowMs
    || expiresAtMs <= signedAtMs
    || (maximumLifetimeMs !== null && (!Number.isSafeInteger(maximumLifetimeMs)
      || maximumLifetimeMs < 1 || expiresAtMs - signedAtMs > maximumLifetimeMs))) {
    throw new Error('immutable_signed_json_authority_time_window_invalid');
  }
  const keys = trustKeyMap(trustStore);
  const signatures = document?.signatures;
  if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > 16) {
    throw new Error('immutable_signed_json_authority_signature_missing');
  }
  const payload = immutableAuthoritySigningPayload(document);
  const seen = new Set();
  const verified = [];
  for (const signature of signatures) {
    if (!signature || typeof signature !== 'object' || Array.isArray(signature)
      || Object.keys(signature).sort().join('\0')
        !== ['algorithm', 'keyId', 'role', 'value'].join('\0')) {
      throw new Error('immutable_signed_json_authority_signature_invalid');
    }
    const keyId = String(signature?.keyId || '');
    const signatureRole = String(signature?.role || '');
    const trusted = keys.get(keyId);
    if (!keyId || seen.has(keyId) || signatureRole !== role
      || signature?.algorithm !== 'ed25519' || !trusted
      || !trusted.key.roles.includes(role)) {
      throw new Error('immutable_signed_json_authority_signature_invalid');
    }
    seen.add(keyId);
    let valid = false;
    try {
      const encoded = String(signature.value || '');
      const value = Buffer.from(encoded, 'base64');
      valid = value.length === 64 && value.toString('base64') === encoded
        && crypto.verify(null, payload, trusted.publicKey, value);
    } catch { valid = false; }
    if (!valid) throw new Error('immutable_signed_json_authority_signature_invalid');
    verified.push(Object.freeze({
      keyId,
      role,
      subjectId: String(trusted.key.subjectId || keyId),
      publicKeySpkiHash: `sha256:${crypto.createHash('sha256')
        .update(trusted.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex')}`,
    }));
  }
  return Object.freeze({
    signatureVerified: true,
    signedAt: new Date(signedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    verifiedSignatures: Object.freeze(verified),
  });
}

export function readImmutableSignedBundleConfiguration({
  bundlePathEnvironmentVariable,
  trustStorePathEnvironmentVariable,
  environment = process.env,
} = {}) {
  const bundlePath = String(environment?.[bundlePathEnvironmentVariable] || '').trim();
  const trustStorePath = String(environment?.[trustStorePathEnvironmentVariable] || '').trim();
  if (!bundlePath && !trustStorePath) return null;
  if (!bundlePath || !trustStorePath) {
    throw new Error('immutable_signed_json_bundle_configuration_incomplete');
  }
  return Object.freeze({
    bundle: readImmutableJsonDocument(bundlePath),
    trustStore: readImmutableJsonDocument(trustStorePath, { maximumBytes: 1024 * 1024 }),
    source: 'external-startup-signed-bundle-v1',
  });
}
