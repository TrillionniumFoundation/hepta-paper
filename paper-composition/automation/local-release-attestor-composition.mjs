import {
  preflightLocalReleaseAttestorDaemonConfigurationPair,
  startLocalReleaseAttestorDaemon,
} from '../../paper-adapters/build-package/local-release-attestor-runtime.mjs';
import {
  requestLocalReleaseAttestor,
} from '../../paper-adapters/build-package/local-release-attestor-socket.mjs';

export function composeLocalReleaseAttestorRuntime() {
  return Object.freeze({
    requestAttestation: requestLocalReleaseAttestor,
    preflightDaemonConfigurationPair:
      preflightLocalReleaseAttestorDaemonConfigurationPair,
    startDaemon: startLocalReleaseAttestorDaemon,
  });
}
