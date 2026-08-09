import {
  RELEASE_ENVIRONMENT_ACTIONS,
  RELEASE_ENVIRONMENT_ELAN_HOME,
  RELEASE_ENVIRONMENT_LAUNCHER,
  RELEASE_ENVIRONMENT_ROOT,
  assertProductionReleaseEntrypoint,
  buildReleaseActionCommand,
  buildReleaseEnvironment,
  inspectProductionReleaseEnvironment,
  inspectReleaseEnvironmentLauncherBoundary,
  parseReleaseEnvironmentArguments,
  releaseEnvironmentUsage,
  replaceProcessEnvironment,
  runReleaseAction,
} from '../../paper-adapters/runtime/release-environment-entrypoint.mjs';

export {
  RELEASE_ENVIRONMENT_ACTIONS,
  RELEASE_ENVIRONMENT_ELAN_HOME,
  RELEASE_ENVIRONMENT_LAUNCHER,
  RELEASE_ENVIRONMENT_ROOT,
  buildReleaseActionCommand,
  buildReleaseEnvironment,
  inspectReleaseEnvironmentLauncherBoundary,
  parseReleaseEnvironmentArguments,
  releaseEnvironmentUsage,
  replaceProcessEnvironment,
  runReleaseAction,
};

export function inspectComposedProductionReleaseEnvironment({
  action,
  entrypointPath,
  inspectReleaseState,
}) {
  if (typeof inspectReleaseState !== 'function') {
    throw new Error('release_environment_state_inspector_required');
  }
  assertProductionReleaseEntrypoint(entrypointPath);
  const releaseStateSnapshot = inspectReleaseState({
    workspaceRoot: RELEASE_ENVIRONMENT_ROOT,
  });
  return inspectProductionReleaseEnvironment({
    action,
    entrypointPath,
    releaseStateSnapshot,
  });
}
