import { digest } from '../../workflow-kernel/record-hash.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

export const PAPER_CORE_VERSION = 1;

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
