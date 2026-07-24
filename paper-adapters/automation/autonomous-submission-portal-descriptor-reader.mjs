import {
  readAutonomousSubmissionPortalConfiguration,
  readAutonomousSubmissionPortalPublicConfiguration,
} from './autonomous-submission-portal-public-adapter.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function readConfiguredAutonomousSubmissionPortalDescriptorConfiguration({
  environment = process.env,
  allowPrivateConfigurationFallback = false,
  rejectPortalCredential = true,
} = {}) {
  const publicConfigPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG || '',
  ).trim();
  if (publicConfigPath) {
    const expectedConfigurationHash = String(
      environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH || '',
    ).trim();
    if (!expectedConfigurationHash) {
      throw new Error('autonomous_submission_portal_public_configuration_pin_required');
    }
    const configuration = readAutonomousSubmissionPortalPublicConfiguration({
      configPath: publicConfigPath,
      expectedConfigurationHash,
    });
    const portalCredentialPresent = Object.keys(environment).some((name) => (
      hashRecord('AutonomousSubmissionPortalTokenEnvironmentVariableName', { name })
        === configuration.tokenEnvironmentVariableNameHash
    ));
    if (rejectPortalCredential && portalCredentialPresent) {
      throw new Error('autonomous_submission_portal_credential_in_research_environment');
    }
    return configuration;
  }
  const privateConfigPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG || '',
  ).trim();
  if (!privateConfigPath || !allowPrivateConfigurationFallback) return null;
  return readAutonomousSubmissionPortalConfiguration({ configPath: privateConfigPath });
}
