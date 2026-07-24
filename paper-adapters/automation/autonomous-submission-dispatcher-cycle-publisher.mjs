import {
  verifyAutonomousSubmissionDispatcherChallenge,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  dispatcherExchangeFilePath,
  listDispatcherExchangeDocuments,
  publishDispatcherExchangeDocument,
  readDispatcherExchangeDocument,
} from './autonomous-submission-dispatcher-exchange-repository.mjs';

export function listPendingAutonomousSubmissionDispatcherChallenges({
  runtimeRoot,
  now = new Date(),
  limit = 100,
} = {}) {
  return Object.freeze(listDispatcherExchangeDocuments({
    runtimeRoot,
    kind: 'dispatcher-challenges',
    limit,
  }).flatMap(({ document }) => {
    if (!verifyAutonomousSubmissionDispatcherChallenge(document, { now })) return [];
    const existing = readDispatcherExchangeDocument(dispatcherExchangeFilePath({
      runtimeRoot,
      kind: 'dispatcher-cycles',
      hash: document.challengeHash,
    }));
    return existing ? [] : [Object.freeze(document)];
  }));
}

export function publishAutonomousSubmissionDispatcherCycleEnvelope({
  runtimeRoot,
  challenge,
  envelope,
} = {}) {
  if (envelope?.challengeHash !== challenge?.challengeHash) {
    throw new Error('autonomous_submission_dispatcher_cycle_publication_binding_invalid');
  }
  return publishDispatcherExchangeDocument({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    hash: challenge.challengeHash,
    document: envelope,
  });
}
