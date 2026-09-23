import {
  buildAutonomousSubmissionDispatcherChallenge,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  publishDispatcherExchangeDocument,
} from './autonomous-submission-dispatcher-exchange-repository.mjs';

export function publishAutonomousSubmissionDispatcherChallenge({
  runtimeRoot,
  planHash,
  idempotencyKey,
  portalId,
  portalConfigurationHash,
  portalDescriptorHash,
  now = new Date(),
  lifetimeMs = 10 * 60 * 1000,
} = {}) {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000
    || lifetimeMs > 60 * 60 * 1000) {
    throw new Error('autonomous_submission_dispatcher_challenge_lifetime_invalid');
  }
  const challengedAt = new Date(now).toISOString();
  const challenge = buildAutonomousSubmissionDispatcherChallenge({
    planHash,
    idempotencyKey,
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    challengedAt,
    expiresAt: new Date(Date.parse(challengedAt) + lifetimeMs).toISOString(),
  });
  const publication = publishDispatcherExchangeDocument({
    runtimeRoot,
    kind: 'dispatcher-challenges',
    hash: challenge.challengeHash,
    document: challenge,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherChallengePublication',
    status: 'autonomous_submission_dispatcher_challenge_published',
    ready: true,
    challenge,
    challengeHash: challenge.challengeHash,
    published: publication.published,
  });
}
