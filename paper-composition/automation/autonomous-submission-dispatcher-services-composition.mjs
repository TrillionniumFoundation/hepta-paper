import {
  createHttpAutonomousSubmissionPortalAdapter,
  readAutonomousSubmissionPortalConfiguration,
} from '../../paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
  deriveAutonomousSubmissionPortalPublicConfiguration,
  readAutonomousSubmissionPortalPublicConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';

export function composeAutonomousSubmissionDispatcherServices({
  environment = process.env,
  autonomousSubmissionRequestVerifier,
  autonomousSubmissionPortalDispatchCapability,
} = {}) {
  const configPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG || '',
  ).trim();
  const configuration = configPath
    ? readAutonomousSubmissionPortalConfiguration({ configPath }) : null;
  const publicConfigPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG || '',
  ).trim();
  let publicConfiguration = null;
  if (configuration && publicConfigPath) {
    const expectedConfigurationHash = String(
      environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH || '',
    ).trim();
    publicConfiguration = readAutonomousSubmissionPortalPublicConfiguration({
      configPath: publicConfigPath,
      expectedConfigurationHash,
    });
    const derived = deriveAutonomousSubmissionPortalPublicConfiguration({ configuration });
    if (!expectedConfigurationHash
      || JSON.stringify(publicConfiguration) !== JSON.stringify(derived)) {
      throw new Error('autonomous_submission_portal_public_private_binding_invalid');
    }
  }
  const portal = configuration ? createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment,
    submissionRequestVerifier: autonomousSubmissionRequestVerifier,
    dispatchCapability: autonomousSubmissionPortalDispatchCapability,
  }) : null;
  return Object.freeze({
    autonomousSubmissionPortal: portal,
    portalDescriptorHash: publicConfiguration
      ? autonomousSubmissionPortalPublicDescriptorHash(publicConfiguration) : null,
    autonomousSubmissionRequestVerifier,
  });
}
