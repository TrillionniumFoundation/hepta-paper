import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PROCESS_IDENTITY_KEYS = Object.freeze(['deepLearning', 'pde']);
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'keyId', 'role', 'value']);

export const GPU_SCIENTIFIC_CAMPAIGN_AUTHORITY_MAXIMUM_LIFETIME_MS =
  31 * 24 * 60 * 60 * 1_000;

export function isGpuScientificCampaignDeviceSelector(value) {
  return GPU_UUID.test(String(value || ''));
}

export function requiredHash(value, code) {
  const selected = String(value || '').toLowerCase();
  if (!SHA256.test(selected)) throw new Error(code);
  return selected;
}

export function requiredId(value, code) {
  const selected = String(value || '').trim();
  if (!SAFE_ID.test(selected)) throw new Error(code);
  return selected;
}

function canonicalTimestamp(value, code) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value) {
    throw new Error(code);
  }
  return milliseconds;
}

export function compileTimeWindow({
  signedAt,
  validFrom = signedAt,
  expiresAt,
  observedAt = null,
} = {}) {
  const signedAtMs = canonicalTimestamp(
    signedAt,
    'gpu_scientific_campaign_authority_time_window_invalid',
  );
  const validFromMs = canonicalTimestamp(
    validFrom,
    'gpu_scientific_campaign_authority_time_window_invalid',
  );
  const expiresAtMs = canonicalTimestamp(
    expiresAt,
    'gpu_scientific_campaign_authority_time_window_invalid',
  );
  const observedAtMs = observedAt === null ? null : canonicalTimestamp(
    observedAt,
    'gpu_scientific_campaign_authority_time_window_invalid',
  );
  if (signedAtMs > validFromMs || validFromMs >= expiresAtMs
    || expiresAtMs - signedAtMs
      > GPU_SCIENTIFIC_CAMPAIGN_AUTHORITY_MAXIMUM_LIFETIME_MS
    || (observedAtMs !== null && observedAtMs > signedAtMs)) {
    throw new Error('gpu_scientific_campaign_authority_time_window_invalid');
  }
  return Object.freeze({ signedAt, validFrom, expiresAt });
}

function validSignature(value) {
  if (!hasExactObjectKeys(value, SIGNATURE_KEYS)
    || value.algorithm !== 'ed25519'
    || !SAFE_ID.test(String(value.keyId || ''))
    || !SAFE_ID.test(String(value.role || ''))
    || !BASE64.test(String(value.value || ''))) return false;
  try {
    const bytes = Buffer.from(value.value, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === value.value;
  } catch {
    return false;
  }
}

export function compileSignatures(signatures, role) {
  if (!Array.isArray(signatures) || signatures.length > 1
    || signatures.some((signature) => (
      !validSignature(signature) || signature.role !== role
    ))) {
    throw new Error('gpu_scientific_campaign_authority_signature_invalid');
  }
  return Object.freeze(signatures.map((signature) => Object.freeze({
    algorithm: 'ed25519',
    keyId: signature.keyId,
    role: signature.role,
    value: signature.value,
  })));
}

export function processIdentityHashes(value, code) {
  if (!hasExactObjectKeys(value, PROCESS_IDENTITY_KEYS)) {
    throw new Error(code);
  }
  const selected = Object.freeze({
    deepLearning: requiredHash(value.deepLearning, code),
    pde: requiredHash(value.pde, code),
  });
  if (selected.deepLearning === selected.pde) throw new Error(code);
  return selected;
}
