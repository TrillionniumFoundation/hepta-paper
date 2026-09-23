import {
  verifyAutonomousSubmissionDispatcherChallenge,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  dispatcherExchangeFilePath,
  listDispatcherExchangeDocuments,
  readDispatcherExchangeDocument,
} from './autonomous-submission-dispatcher-exchange-repository.mjs';

export function findAutonomousSubmissionDispatcherChallenge({
  runtimeRoot,
  planHash = null,
  idempotencyKey = null,
  portalId = null,
  portalConfigurationHash = null,
  portalDescriptorHash = null,
  now = new Date(),
} = {}) {
  return listDispatcherExchangeDocuments({
    runtimeRoot,
    kind: 'dispatcher-challenges',
    limit: 1000,
  }).map(({ document }) => document)
    .filter((challenge) => verifyAutonomousSubmissionDispatcherChallenge(challenge, {
      now,
      expectedPlanHash: planHash,
      expectedIdempotencyKey: idempotencyKey,
      expectedPortalId: portalId,
      expectedPortalConfigurationHash: portalConfigurationHash,
      expectedPortalDescriptorHash: portalDescriptorHash,
    }))
    .sort((left, right) => right.challengedAt.localeCompare(left.challengedAt))[0] || null;
}

export function readAutonomousSubmissionDispatcherChallenge({
  runtimeRoot,
  challengeHash,
  now = new Date(),
} = {}) {
  const challenge = readDispatcherExchangeDocument(dispatcherExchangeFilePath({
    runtimeRoot,
    kind: 'dispatcher-challenges',
    hash: challengeHash,
  }));
  return verifyAutonomousSubmissionDispatcherChallenge(challenge, { now })
    ? Object.freeze(challenge) : null;
}

export function readAutonomousSubmissionDispatcherCycleEnvelope({
  runtimeRoot,
  challengeHash,
} = {}) {
  return readDispatcherExchangeDocument(dispatcherExchangeFilePath({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    hash: challengeHash,
  }));
}
