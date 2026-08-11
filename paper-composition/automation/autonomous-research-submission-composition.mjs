import {
  createAutonomousSubmissionPortalDescriptor,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  readConfiguredAutonomousSubmissionPortalDescriptorConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-descriptor-reader.mjs';
import {
  createLocalAutonomousVenueComplianceInspector,
} from '../../paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs';
import {
  inspectAutonomousResearchSubmissionHandoff,
} from '../../paper-application/automation/autonomous-research-submission-recovery.mjs';
import {
  verifyAutonomousLiveSubmissionAuthorization,
} from '../../paper-adapters/submission/live-authorization.mjs';

function configuredPortalConfiguration(environment) {
  return readConfiguredAutonomousSubmissionPortalDescriptorConfiguration({
    environment,
    allowPrivateConfigurationFallback: false,
  });
}

function configuredPortalDescriptor(environment) {
  const configuration = configuredPortalConfiguration(environment);
  return configuration ? createAutonomousSubmissionPortalDescriptor({
    configuration,
    expectedConfigurationHash: String(
      environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH || '',
    ).trim() || null,
    expectedDescriptorHash: String(
      environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH || '',
    ).trim() || null,
  }) : null;
}

export function composeAutonomousResearchSubmissionServices({
  root,
  environment = process.env,
  runtimeRoot,
  clock = null,
  autonomousSubmissionRequestVerifier,
} = {}) {
  const autonomousSubmissionPortal = configuredPortalDescriptor(environment);
  return Object.freeze({
    autonomousSubmissionPortal,
    autonomousVenueComplianceInspector: autonomousSubmissionPortal
      ? createLocalAutonomousVenueComplianceInspector({ runtimeRoot }) : null,
    autonomousSubmissionRequestVerifier,
    verifyAutonomousSubmissionHumanAuthorization: autonomousSubmissionPortal
      ? (input = {}) => verifyAutonomousLiveSubmissionAuthorization({
        root,
        runtimeRoot,
        ...input,
        now: input.now || (typeof clock?.now === 'function' ? clock.now() : new Date()),
      }) : null,
  });
}

export function createAutonomousResearchSubmissionHandoffInspection({
  environment = process.env,
  autonomousSubmissionOutbox,
  autonomousSubmissionRequestVerifier,
} = {}) {
  const portalDescriptor = configuredPortalDescriptor(environment);
  return ({ campaign } = {}) => inspectAutonomousResearchSubmissionHandoff({
    campaign,
    portalDescriptor,
    outbox: autonomousSubmissionOutbox,
    submissionRequestVerifier: autonomousSubmissionRequestVerifier,
  });
}
