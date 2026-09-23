import {
  loadAutomationReadinessDeploymentEnvironment,
} from '../../paper-adapters/automation/deployment-environment-file.mjs';

export function composeAutomationReadinessDeploymentEnvironment(options = {}) {
  return loadAutomationReadinessDeploymentEnvironment(options);
}
