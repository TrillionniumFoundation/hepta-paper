import {
  compileExternallyFencedSqliteMutationOperation as operation,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';

export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_ROLE = 'topic-producer';
export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_INSTANCE_ID = 'topic-producer';
export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_SCHEMA_CONTRACT_ID =
  'topic-producer-schema-v1';
export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID =
  'writer:topic-producer:topic-producer-repository:v1';

const clockStatements = (prefix) => [
  {
    statementId: `${prefix}.metadata-clock.get.v1`,
    mode: 'get',
    sql: `SELECT last_observed_at FROM autonomous_research_topic_producer_metadata
      WHERE singleton=1`,
  },
  {
    statementId: `${prefix}.metadata-clock.update.v1`,
    mode: 'run',
    sql: `UPDATE autonomous_research_topic_producer_metadata SET last_observed_at=?
      WHERE singleton=1`,
  },
];

const leaseStatement = (prefix) => ({
  statementId: `${prefix}.lease-current.get.v1`,
  mode: 'get',
  sql: `SELECT * FROM autonomous_research_topic_producer_lease WHERE singleton=1`,
});

export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS = Object.freeze({
  acquireLease: 'topic-producer.topic-producer-repository.tryAcquireLease.v1',
  beginCanary: 'topic-producer.topic-producer-repository.beginProviderCanaryAction.v1',
  completeGeneration: 'topic-producer.topic-producer-repository.completeGeneration.v1',
  failGeneration: 'topic-producer.topic-producer-repository.failGeneration.v1',
  finishCanary: 'topic-producer.topic-producer-repository.finishProviderCanaryAction.v1',
  issueAuthorization: 'topic-producer.topic-producer-repository.issueAppendAuthorization.v1',
  prepareGeneration: 'topic-producer.topic-producer-repository.prepareGeneration.v1',
  recoverGeneration: 'topic-producer.topic-producer-repository.recoverCommittedGeneration.v1',
  releaseLease: 'topic-producer.topic-producer-repository.releaseLease.v1',
  renewLease: 'topic-producer.topic-producer-repository.renewLease.v1',
});

const IDS = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS;

export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS = Object.freeze({
  [IDS.acquireLease]: operation(IDS.acquireLease, [
    leaseStatement('topic-producer.acquire'),
    ...clockStatements('topic-producer.acquire'),
    {
      statementId: 'topic-producer.acquire.metadata-current.get.v1',
      mode: 'get',
      sql: `SELECT lease_generation FROM autonomous_research_topic_producer_metadata
        WHERE singleton=1`,
    },
    {
      statementId: 'topic-producer.acquire.metadata-generation.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_metadata SET lease_generation=?
        WHERE singleton=1`,
    },
    {
      statementId: 'topic-producer.acquire.lease-upsert.apply.v1',
      mode: 'run',
      sql: `INSERT INTO autonomous_research_topic_producer_lease(
        singleton,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
      ) VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
        owner_id=excluded.owner_id,lease_token=excluded.lease_token,
        lease_generation=excluded.lease_generation,acquired_at=excluded.acquired_at,
        renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`,
    },
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.beginCanary]: operation(IDS.beginCanary, [
    {
      statementId: 'topic-producer.canary-begin.generation-current.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?`,
    },
    {
      statementId: 'topic-producer.canary-begin.generation-journal.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        provider_canary_attempt_started=1,provider_canary_attempt_journal_json=?,updated_at=?
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?`,
    },
    leaseStatement('topic-producer.canary-begin'),
    ...clockStatements('topic-producer.canary-begin'),
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.completeGeneration]: operation(IDS.completeGeneration, [
    {
      statementId: 'topic-producer.complete.generation-current.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=?`,
    },
    {
      statementId: 'topic-producer.complete.generation-produced.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        status='produced',intake_id=?,intake_hash=?,admission_hash=?,updated_at=?
        WHERE generation_sequence=? AND status='authorized' AND lease_generation=?`,
    },
    {
      statementId: 'topic-producer.complete.generation-result.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=?`,
    },
    leaseStatement('topic-producer.complete'),
    ...clockStatements('topic-producer.complete'),
    {
      statementId: 'topic-producer.complete.metadata-produced.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_metadata SET
        last_produced_at=?,next_attempt_at=NULL WHERE singleton=1`,
    },
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.failGeneration]: operation(IDS.failGeneration, [
    {
      statementId: 'topic-producer.fail.generation-current.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=? AND status IN ('planned','authorized')
        AND lease_generation=?`,
    },
    {
      statementId: 'topic-producer.fail.generation-failed.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        status='failed',error=?,provider_canary_attempt_started=?,
        provider_canary_side_effect_inspection_json=?,updated_at=?
        WHERE generation_sequence=? AND status IN ('planned','authorized')
        AND lease_generation=?`,
    },
    {
      statementId: 'topic-producer.fail.generation-result.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=?`,
    },
    leaseStatement('topic-producer.fail'),
    ...clockStatements('topic-producer.fail'),
    {
      statementId: 'topic-producer.fail.metadata-retry.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_metadata SET next_attempt_at=?
        WHERE singleton=1`,
    },
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.finishCanary]: operation(IDS.finishCanary, [
    {
      statementId: 'topic-producer.canary-finish.generation-current.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?`,
    },
    {
      statementId: 'topic-producer.canary-finish.generation-journal.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        provider_canary_attempt_journal_json=?,updated_at=?
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?
        AND provider_canary_attempt_started=1`,
    },
    leaseStatement('topic-producer.canary-finish'),
    ...clockStatements('topic-producer.canary-finish'),
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.issueAuthorization]: operation(IDS.issueAuthorization, [
    {
      statementId: 'topic-producer.authorize.generation.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        status='authorized',capability_hash=?,capability_nonce=?,capability_json=?,updated_at=?
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?
        AND planned_generation_hash=? AND budget_reservation_id=?`,
    },
    leaseStatement('topic-producer.authorize'),
    ...clockStatements('topic-producer.authorize'),
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.prepareGeneration]: operation(IDS.prepareGeneration, [
    {
      statementId: 'topic-producer.prepare.budget-current.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_daily_budget
        WHERE epoch_start=?`,
    },
    {
      statementId: 'topic-producer.prepare.budget-ensure.apply.v1',
      mode: 'run',
      sql: `INSERT OR IGNORE INTO autonomous_research_topic_producer_daily_budget(
        epoch_start,provider_canary_attempt_count,provider_canary_reserved_cost_usd,
        produced_topic_count,updated_at) VALUES(?,?,?,?,?)`,
    },
    {
      statementId: 'topic-producer.prepare.budget-reserve-canary.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_daily_budget SET
        provider_canary_attempt_count=?,provider_canary_reserved_cost_usd=?,updated_at=?
        WHERE epoch_start=?`,
    },
    {
      statementId: 'topic-producer.prepare.budget-reserve-topic.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_daily_budget SET
        produced_topic_count=produced_topic_count+1,updated_at=? WHERE epoch_start=?
        AND produced_topic_count<?`,
    },
    {
      statementId: 'topic-producer.prepare.generation-expire.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation
        SET status='failed',error=?,updated_at=? WHERE generation_sequence=?`,
    },
    {
      statementId: 'topic-producer.prepare.generation-insert.apply.v1',
      mode: 'run',
      sql: `INSERT INTO autonomous_research_topic_producer_generation(
        generation_sequence,status,lease_generation,producer_topic_id,topic_fingerprint,
        canonical_research_topic_hash,budget_reservation_id,budget_epoch_start,
        planned_generation_hash,planned_generation_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    },
    {
      statementId: 'topic-producer.prepare.generation-interrupted.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        status='failed',error=?,provider_canary_attempt_started=1,
        provider_canary_side_effect_inspection_json=?,updated_at=?
        WHERE generation_sequence=? AND status IN ('planned','authorized')`,
    },
    {
      statementId: 'topic-producer.prepare.generation-outstanding.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE status IN ('planned','authorized') ORDER BY generation_sequence LIMIT 1`,
    },
    {
      statementId: 'topic-producer.prepare.generation-reset.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        status='planned',lease_generation=?,capability_hash=NULL,capability_nonce=NULL,
        capability_json=NULL,updated_at=? WHERE generation_sequence=?`,
    },
    {
      statementId: 'topic-producer.prepare.generation-result.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=?`,
    },
    leaseStatement('topic-producer.prepare'),
    ...clockStatements('topic-producer.prepare'),
    {
      statementId: 'topic-producer.prepare.metadata-current.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_metadata WHERE singleton=1`,
    },
    {
      statementId: 'topic-producer.prepare.metadata-high-water.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_metadata
        SET generation_high_watermark=? WHERE singleton=1`,
    },
    {
      statementId: 'topic-producer.prepare.metadata-retry.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_metadata SET next_attempt_at=?
        WHERE singleton=1`,
    },
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.recoverGeneration]: operation(IDS.recoverGeneration, [
    {
      statementId: 'topic-producer.recover.generation-authorized.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE status='authorized' ORDER BY generation_sequence LIMIT 1`,
    },
    {
      statementId: 'topic-producer.recover.generation-produced.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_generation SET
        status='produced',lease_generation=?,intake_id=?,intake_hash=?,admission_hash=?,updated_at=?
        WHERE generation_sequence=? AND status='authorized' AND capability_nonce=?`,
    },
    {
      statementId: 'topic-producer.recover.generation-result.get.v1',
      mode: 'get',
      sql: `SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=?`,
    },
    leaseStatement('topic-producer.recover'),
    ...clockStatements('topic-producer.recover'),
    {
      statementId: 'topic-producer.recover.metadata-produced.update.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_metadata SET
        last_produced_at=?,next_attempt_at=NULL WHERE singleton=1`,
    },
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
  [IDS.releaseLease]: operation(IDS.releaseLease, [{
    statementId: 'topic-producer.release.lease-delete.apply.v1',
    mode: 'run',
    sql: `DELETE FROM autonomous_research_topic_producer_lease
      WHERE singleton=1 AND owner_id=? AND lease_token=? AND lease_generation=?`,
  }]),
  [IDS.renewLease]: operation(IDS.renewLease, [
    {
      statementId: 'topic-producer.renew.lease-update.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_topic_producer_lease SET
        renewed_at=?,expires_at=? WHERE singleton=1 AND owner_id=? AND lease_token=?
        AND lease_generation=? AND expires_at>?`,
    },
    ...clockStatements('topic-producer.renew'),
  ].sort((left, right) => left.statementId.localeCompare(right.statementId))),
});

export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
    operationPlans: Object.values(AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS),
  });

export function createOfflineTopicProducerMutationCoordinator({
  operationPlans = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
  databaseInstanceId = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'autonomous_research_topic_producer_offline_mutation_input_invalid',
    asyncMutationError:
      'autonomous_research_topic_producer_async_mutation_forbidden',
    recoveryUnavailableError:
      'autonomous_research_topic_producer_offline_recovery_unavailable',
    statusBlocker:
      'autonomous_research_topic_producer_external_mutation_coordinator_required',
    receiptKind: 'OfflineTopicProducerMutationReceipt',
  });
}
