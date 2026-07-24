import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import {
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_ROLE,
  createOfflineTopicProducerMutationCoordinator,
} from './autonomous-research-topic-producer-mutation-plan.mjs';

export function resolveTopicProducerMutationCoordinator({
  mutationCoordinator,
  offlineProvision,
  requireExternallyFencedMutations,
  databaseInstanceId,
  schemaContractId,
  writerId,
} = {}) {
  let coordinator = mutationCoordinator;
  if (coordinator !== null) assertExternallyFencedSqliteMutationCoordinatorPort(coordinator);
  if (requireExternallyFencedMutations) {
    const status = coordinator?.inspectStatus();
    if (offlineProvision || coordinator?.implemented !== true
      || status?.implemented !== true
      || status.status !== 'externally_fenced_sqlite_mutation_coordinator_ready'
      || !Array.isArray(status.blockers) || status.blockers.length !== 0
      || !coordinator.coveredDatabaseRoles?.includes(
        AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_ROLE,
      )
      || !status.coveredDatabaseRoles?.includes(
        AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_ROLE,
      )) {
      throw new Error('autonomous_research_topic_producer_external_mutation_coordinator_required');
    }
  }
  return coordinator || createOfflineTopicProducerMutationCoordinator({
    databaseInstanceId,
    schemaContractId,
    writerId,
  });
}

export function topicProducerMutationValue(receipt) {
  if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
    throw new Error('autonomous_research_topic_producer_mutation_receipt_invalid');
  }
  return receipt.value;
}

export function assertTopicProducerMutationClock(metadata, timestamp) {
  if (metadata.last_observed_at && timestamp < metadata.last_observed_at) {
    throw new Error('autonomous_research_topic_producer_clock_rollback_detected');
  }
}

export function assertTopicProducerMutationLease(row, identity, timestamp) {
  if (!row || row.owner_id !== identity.ownerId || row.lease_token !== identity.leaseToken
    || Number(row.lease_generation) !== identity.leaseGeneration
    || row.expires_at <= timestamp) {
    throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
  }
}
