import {
  isolatedVerificationCodeProvenance,
  isolatedVerificationCodeProvenanceMatches,
} from './isolated-verification-receipt-contract.mjs';

const SUPPORTED_MODES = Object.freeze(['test', 'ci', 'release']);

export { isolatedVerificationCodeProvenanceMatches };

export function inspectIsolatedVerificationPreflight({
  mode,
  codeProvenance = null,
  declaredReleaseCommit = null,
} = {}) {
  const normalizedMode = String(mode || '');
  const blockers = [];
  if (!SUPPORTED_MODES.includes(normalizedMode)) {
    blockers.push(`isolated_verification_mode_unsupported:${normalizedMode || 'missing'}`);
  }
  if (normalizedMode === 'release' && codeProvenance?.treeDirty !== false) {
    blockers.push('release_verification_clean_worktree_required');
  }
  if (normalizedMode === 'release') {
    try {
      isolatedVerificationCodeProvenance(codeProvenance);
    } catch {
      blockers.push('release_verification_exact_code_provenance_required');
    }
  }
  if (normalizedMode === 'release'
    && declaredReleaseCommit !== null
    && declaredReleaseCommit !== undefined
    && String(declaredReleaseCommit) !== codeProvenance?.commit) {
    blockers.push('release_verification_declared_commit_mismatch');
  }
  return Object.freeze({
    version: 1,
    kind: 'IsolatedVerificationPreflightReport',
    status: blockers.length
      ? 'isolated_verification_preflight_blocked'
      : 'isolated_verification_preflight_ready',
    mode: normalizedMode,
    treeDirty: codeProvenance?.treeDirty ?? null,
    blockers: Object.freeze(blockers),
  });
}
