import crypto from 'node:crypto';
import {
  leaseDuration,
  leaseIdentity,
  observedDate,
} from './autonomous-research-topic-producer-repository-support.mjs';
import {
  assertTopicProducerMutationClock,
  topicProducerMutationValue,
} from './autonomous-research-topic-producer-online-mutation.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;

export function createAutonomousResearchTopicProducerLeaseOperations({
  requireDatabase,
  coordinator,
  databaseInstanceId,
  schemaContractId,
  writerId,
} = {}) {
  function assertClock(database, observedAt) {
    const metadata = database.prepare(`SELECT last_observed_at FROM
      autonomous_research_topic_producer_metadata WHERE singleton=1`).get();
    assertTopicProducerMutationClock(metadata, observedAt.toISOString());
  }

  function activeLease(database, lease, observedAt) {
    const row = database.prepare(`SELECT * FROM autonomous_research_topic_producer_lease
      WHERE singleton=1`).get();
    return row && row.owner_id === lease.ownerId && row.lease_token === lease.leaseToken
      && Number(row.lease_generation) === lease.leaseGeneration
      && row.expires_at > observedAt.toISOString();
  }

  function assertLease({ lease, now = new Date() } = {}) {
    const database = requireDatabase();
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    assertClock(database, observedAt);
    if (!activeLease(database, identity, observedAt)) {
      throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
    }
    return Object.freeze({
      ...identity,
      expiresAt: database.prepare(`SELECT expires_at FROM
        autonomous_research_topic_producer_lease WHERE singleton=1`).get().expires_at,
    });
  }

  function tryAcquireLease({ ownerId, leaseMs, now = new Date() } = {}) {
    if (!SAFE_ID.test(String(ownerId || ''))) {
      throw new Error('autonomous_research_topic_producer_lease_owner_invalid');
    }
    const duration = leaseDuration(leaseMs);
    const observedAt = observedDate(now);
    const database = requireDatabase({ writable: true });
    return topicProducerMutationValue(coordinator.executeMutation({
      database,
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId: 'topic-producer.topic-producer-repository.tryAcquireLease.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate(transaction) {
        const timestamp = observedAt.toISOString();
        assertTopicProducerMutationClock(transaction.get(
          'topic-producer.acquire.metadata-clock.get.v1',
        ), timestamp);
        transaction.run('topic-producer.acquire.metadata-clock.update.v1', timestamp);
        const active = transaction.get('topic-producer.acquire.lease-current.get.v1');
        if (active && active.expires_at > timestamp) return null;
        const metadata = transaction.get('topic-producer.acquire.metadata-current.get.v1');
        const leaseGeneration = Number(metadata.lease_generation) + 1;
        const leaseToken = `producer-lease:${crypto.randomUUID()}`;
        const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
        transaction.run(
          'topic-producer.acquire.lease-upsert.apply.v1',
          ownerId, leaseToken, leaseGeneration, timestamp, timestamp, expiresAt,
        );
        transaction.run(
          'topic-producer.acquire.metadata-generation.update.v1',
          leaseGeneration,
        );
        return Object.freeze({ ownerId, leaseToken, leaseGeneration, expiresAt });
      },
    }));
  }

  function renewLease({ lease, leaseMs, now = new Date() } = {}) {
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    const expiresAt = new Date(observedAt.getTime() + leaseDuration(leaseMs)).toISOString();
    const database = requireDatabase({ writable: true });
    return topicProducerMutationValue(coordinator.executeMutation({
      database,
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId: 'topic-producer.topic-producer-repository.renewLease.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate(transaction) {
        const timestamp = observedAt.toISOString();
        assertTopicProducerMutationClock(transaction.get(
          'topic-producer.renew.metadata-clock.get.v1',
        ), timestamp);
        transaction.run('topic-producer.renew.metadata-clock.update.v1', timestamp);
        const result = transaction.run(
          'topic-producer.renew.lease-update.apply.v1',
          timestamp, expiresAt, identity.ownerId, identity.leaseToken,
          identity.leaseGeneration, timestamp,
        );
        return Number(result.changes) === 1 ? Object.freeze({ ...identity, expiresAt }) : null;
      },
    }));
  }

  function releaseLease({ lease } = {}) {
    const identity = leaseIdentity(lease);
    const database = requireDatabase({ writable: true });
    return topicProducerMutationValue(coordinator.executeMutation({
      database,
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId: 'topic-producer.topic-producer-repository.releaseLease.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate(transaction) {
        return Number(transaction.run(
          'topic-producer.release.lease-delete.apply.v1',
          identity.ownerId,
          identity.leaseToken,
          identity.leaseGeneration,
        ).changes) === 1;
      },
    }));
  }

  return Object.freeze({ assertLease, tryAcquireLease, renewLease, releaseLease });
}
