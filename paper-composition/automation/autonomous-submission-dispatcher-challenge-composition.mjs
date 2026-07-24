import {
  publishAutonomousSubmissionDispatcherChallenge as publishChallenge,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-challenge-repository.mjs';
import {
  readConfiguredAutonomousSubmissionPortalDescriptorConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-descriptor-reader.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
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
  return Object.freeze({
    descriptor,
    descriptorHash: descriptor
      ? autonomousSubmissionPortalPublicDescriptorHash(descriptor) : null,
  });
}
