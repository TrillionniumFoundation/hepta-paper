import { digest } from '../../workflow-kernel/record-hash.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

export const PAPER_CORE_VERSION = 1;
export const PAPER_SEMANTIC_IDENTITY_VERSION = 2;

export const PAPER_MANIFEST_STATUS = Object.freeze({
  READY: 'ready_for_adapter',
  BLOCKED: 'blocked_manifest',
});

export const PAPER_RUN_RECEIPT_STATUS = Object.freeze({
  DRY_RUN_RECORDED: 'dry_run_recorded',
  BLOCKED: 'blocked_run',
});

export function normalizedId(value, fallback) {
  return normalizeText(value) || fallback;
}

export function normalizeRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: normalizeText(item) };
    return {
      kind: normalizeText(item?.kind || 'path') || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: normalizeText(item?.hash || '') || null,
      notes: normalizeText(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

export function hashPaperRecord(kind, payload = {}) {
  return digest({ version: PAPER_CORE_VERSION, kind, payload });
}

const OBSERVATION_METADATA_FIELDS = new Set([
  'createdAt',
  'observedAt',
  'recordedAt',
  'verifiedAt',
  'semanticIdentityVersion',
  'semanticIdentityHash',
]);

function semanticPayload(value) {
  if (Array.isArray(value)) return value.map(semanticPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !OBSERVATION_METADATA_FIELDS.has(key))
    .map(([key, item]) => [key, semanticPayload(item)]));
}

// v2 is deliberately separate from persisted v1 record hashes. Observation
// metadata stays on the record but cannot make identical business facts acquire
// different semantic identities.
export function hashPaperSemanticIdentity(kind, payload = {}) {
  return digest({
    version: PAPER_SEMANTIC_IDENTITY_VERSION,
    policy: 'paper-semantic-identity-v2',
    kind,
    payload: semanticPayload(payload),
  });
}

export function verifyPaperRecordHash({ kind, payload = {}, recordHash } = {}) {
  const {
    semanticIdentityVersion: _semanticIdentityVersion,
    semanticIdentityHash: _semanticIdentityHash,
    ...v1Payload
  } = payload || {};
  return Object.freeze({
    version: 1,
    policy: 'paper-record-v1',
    valid: typeof recordHash === 'string' && recordHash === hashPaperRecord(kind, v1Payload),
  });
}
