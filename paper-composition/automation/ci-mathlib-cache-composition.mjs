import {
  CI_MATHLIB_CACHE_USAGE,
  prepareCiMathlibCacheAdapter,
} from '../../paper-adapters/research-verify/ci-mathlib-cache-repository.mjs';

export { CI_MATHLIB_CACHE_USAGE };

export function prepareCiMathlibCache(options = {}) {
  if (!options.workspaceRoot) {
    throw new Error('ci_mathlib_cache_workspace_root_required');
  }
  return prepareCiMathlibCacheAdapter({
    ...options,
    workspaceRoot: String(options.workspaceRoot),
  });
}
