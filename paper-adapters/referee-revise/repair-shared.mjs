import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

const CLOSED_REFEREE_STATUSES = new Set(['closed', 'resolved', 'applied', 'no_patch_needed']);

export const AGENT_REPAIR_BEGIN = '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_BEGIN';
export const AGENT_REPAIR_END = '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_END';

export function shaDigest(value) {
  return normalizeText(value).toLowerCase().replace(/^sha256:/, '');
}

export function stderrLines(value, limit = 8) {
  return String(value || '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .slice(0, limit);
}

export function issueIsOpen(issue = {}) {
  return !CLOSED_REFEREE_STATUSES.has(normalizeText(issue.status || '').toLowerCase());
}
