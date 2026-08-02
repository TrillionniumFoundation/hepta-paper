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
  const expectedConfigurationHash = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH || '',
  ).trim() || null;
  const expectedDescriptorHash = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH || '',
  ).trim() || null;
  const configuration = configPath
    ? readAutonomousSubmissionPortalConfiguration({
      configPath,
      expectedConfigurationHash,
    }) : null;
  const publicConfigPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG || '',
  ).trim();
  let publicConfiguration = null;
  if (configuration && publicConfigPath) {
    publicConfiguration = readAutonomousSubmissionPortalPublicConfiguration({
      configPath: publicConfigPath,
      expectedConfigurationHash,
      expectedDescriptorHash,
    });
    const derived = deriveAutonomousSubmissionPortalPublicConfiguration({ configuration });
    if (!expectedConfigurationHash
      || JSON.stringify(publicConfiguration) !== JSON.stringify(derived)) {
      throw new Error('autonomous_submission_portal_public_private_binding_invalid');
    }
  }
  const portal = configuration ? createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    expectedConfigurationHash,
    expectedDescriptorHash,
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
