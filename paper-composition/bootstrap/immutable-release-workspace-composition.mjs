import {
  bindIdentityBoundTemporaryDirectory,
  createNonReentrantCleanup,
  prepareImmutableReleaseWorkspace as prepareImmutableReleaseWorkspaceAdapter,
} from '../../paper-adapters/runtime/immutable-release-workspace-repository.mjs';

export { bindIdentityBoundTemporaryDirectory, createNonReentrantCleanup };

export function prepareImmutableReleaseWorkspace(options = {}) {
  return prepareImmutableReleaseWorkspaceAdapter(options);
}
