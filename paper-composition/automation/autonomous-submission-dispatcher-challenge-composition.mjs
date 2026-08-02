import {
  publishAutonomousSubmissionDispatcherChallenge as publishChallenge,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-challenge-repository.mjs';
import {
  readConfiguredAutonomousSubmissionPortalDescriptorConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-descriptor-reader.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
  createAutonomousSubmissionPortalDescriptor,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  inspectAutonomousSubmissionDispatcherReadiness,
} from './autonomous-submission-dispatcher-readiness-composition.mjs';

export function publishAutonomousSubmissionDispatcherChallenge(input = {}) {
  return publishChallenge(input);
}

export function inspectPublishedAutonomousSubmissionDispatcherChallenge(input = {}) {
  return inspectAutonomousSubmissionDispatcherReadiness(input);
}

export function resolveAutonomousSubmissionPortalDescriptorBinding({
  environment = process.env,
} = {}) {
  const descriptor = readConfiguredAutonomousSubmissionPortalDescriptorConfiguration({
    environment,
    allowPrivateConfigurationFallback: false,
    rejectPortalCredential: true,
  });
  const readiness = descriptor ? createAutonomousSubmissionPortalDescriptor({
    configuration: descriptor,
    expectedConfigurationHash: String(
      environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH || '',
    ).trim() || null,
    expectedDescriptorHash: String(
      environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH || '',
    ).trim() || null,
  }) : null;
  if (readiness?.fullProductionReady !== true) {
    throw new Error('autonomous_submission_portal_full_production_binding_required');
  }
  return Object.freeze({
    descriptor,
    descriptorHash: descriptor
      ? autonomousSubmissionPortalPublicDescriptorHash(descriptor) : null,
  });
}
