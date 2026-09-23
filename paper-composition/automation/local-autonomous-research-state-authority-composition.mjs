import {
  createLocalAutonomousResearchStateAuthority,
} from '../../paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs';
import {
  requestLocalAutonomousResearchStateAuthority,
  startLocalAutonomousResearchStateAuthorityServer,
} from '../../paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs';

export function composeLocalAutonomousResearchStateAuthorityRuntime() {
  return Object.freeze({
    createAuthority: createLocalAutonomousResearchStateAuthority,
    requestAuthority: requestLocalAutonomousResearchStateAuthority,
    startServer: startLocalAutonomousResearchStateAuthorityServer,
  });
}
