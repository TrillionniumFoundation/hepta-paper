import {
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';

const INVALID_OUTPUT = 'codex_openclaw_managed_structured_output_invalid';
const COMPATIBLE_REPORTED_CHECK_KEYS = new Set([
  'check',
  'status',
  'reason',
  'clearedBlocker',
  'surfaceCount',
]);

function validateStringArray(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw runtimeError(INVALID_OUTPUT);
  }
  return Object.freeze(value.map((entry) => entry.trim()));
}

function compatibleReportedCheck(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.keys(entry).some((key) => !COMPATIBLE_REPORTED_CHECK_KEYS.has(key))
    || typeof entry.check !== 'string' || !entry.check.trim()
    || typeof entry.status !== 'string' || !entry.status.trim()
    || (entry.reason !== undefined && typeof entry.reason !== 'string')
    || (entry.clearedBlocker !== undefined
      && typeof entry.clearedBlocker !== 'string')
    || (entry.surfaceCount !== undefined
      && (!Number.isSafeInteger(entry.surfaceCount) || entry.surfaceCount < 0))) {
    throw runtimeError(INVALID_OUTPUT);
  }
  return `${entry.check.trim()} [${entry.status.trim()}]`;
}

function validateReportedChecks(value) {
  if (!Array.isArray(value)) throw runtimeError(INVALID_OUTPUT);
  return Object.freeze(value.map(compatibleReportedCheck));
}

export function validateStructuredResponse(parsed) {
  if (!parsed || typeof parsed.summary !== 'string'
    || !Array.isArray(parsed.edits)) {
    throw runtimeError(INVALID_OUTPUT, { retryable: true });
  }
  const blockers = validateStringArray(parsed.blockers).filter(Boolean);
  const status = parsed.status === 'completed_with_blockers' && blockers.length
    ? 'blocked' : parsed.status;
  if (!['completed', 'blocked'].includes(status)) {
    throw runtimeError(INVALID_OUTPUT, { retryable: true });
  }
  const reportedChecks = validateReportedChecks(
    parsed.checksRun ?? parsed.checks,
  );
  return Object.freeze({ status, blockers, reportedChecks });
}
