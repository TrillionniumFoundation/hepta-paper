export {
  buildAutonomousResearchIntakeRotationIntentTemplate,
  verifyAutonomousResearchIntakeRotationIntent,
} from '../../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs';

let authorizationProvider = null;
let externalDocumentsProvider = null;

export function installAutonomousResearchMachineIntakeRotationAuthorizationTestDouble(
  provider,
) {
  if (typeof provider !== 'function') throw new TypeError('authorization provider required');
  authorizationProvider = provider;
}

export function loadAutonomousResearchIntakeRotationAuthorization(input = {}) {
  if (!authorizationProvider) throw new Error('rotation authorization test double not installed');
  return authorizationProvider(input);
}

export function installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(
  provider,
) {
  if (typeof provider !== 'function') throw new TypeError('external authority provider required');
  externalDocumentsProvider = provider;
}

export function loadAutonomousResearchMachineIntakeExternalAuthorityDocuments(input = {}) {
  if (!externalDocumentsProvider) throw new Error('external authority test double not installed');
  return externalDocumentsProvider(input);
}
