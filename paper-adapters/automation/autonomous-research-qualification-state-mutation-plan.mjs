import {
  compileExternallyFencedSqliteMutationOperation as operation,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';

export const AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_ROLE =
  'external-qualification';
export const AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID =
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_ROLE;
export const AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_SCHEMA_CONTRACT_ID =
  'external-qualification-schema-v1';
export const AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID =
  'writer:external-qualification:qualification-state-repository:v1';

export const AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS = Object.freeze({
  compareAndSwap:
    'external-qualification.qualification-state-repository.compareAndSwapExternalQualificationState.v1',
  acquireLease:
    'external-qualification.qualification-state-repository.tryAcquireQualificationAttemptLease.v1',
  renewLease:
    'external-qualification.qualification-state-repository.renewQualificationAttemptLease.v1',
  releaseLease:
    'external-qualification.qualification-state-repository.releaseQualificationAttemptLease.v1',
  reconcileLease:
    'external-qualification.qualification-state-repository.reconcileStaleQualificationAttemptLease.v1',
  markAttemptExternalActionStarted:
    'external-qualification.qualification-state-repository.markQualificationAttemptExternalActionStarted.v1',
  cancelAttemptInfrastructureDeferred:
    'external-qualification.qualification-state-repository.cancelQualificationAttemptInfrastructureDeferred.v1',
  reconcileAttemptReservation:
    'external-qualification.qualification-state-repository.reconcileStaleQualificationAttemptReservation.v1',
});

export const AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS = Object.freeze({
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.compareAndSwap]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.compareAndSwap,
    [
      {
        statementId: 'external-qualification.cas.attempt-reservation-insert.apply.v1',
        mode: 'run',
        sql: `INSERT INTO autonomous_external_qualification_attempt_reservation(
          scope,state_generation,state_hash,recovery_identity_hash,cycle,epoch,
          attempt_count,total_attempt_count,reserved_cost_usd,prior_attempt_count,
          prior_total_attempt_count,prior_reserved_cost_usd,attempt_reservation_cost_usd,
          idempotency_key,lease_owner_id,lease_token_hash,lease_generation,created_at,
          external_action_may_have_started,started_actions_json,first_started_at,
          last_started_at,side_effect_permit_hash,recovery_takeover_count,
          last_recovery_takeover_at,cancelled_at,cancelled_state_generation,cancelled_state_hash
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'[]',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL)`,
      },
      {
        statementId: 'external-qualification.cas.lease-current.get.v1',
        mode: 'get',
        sql: `SELECT owner_id,lease_token,lease_generation,expires_at
          FROM autonomous_external_qualification_attempt_lease WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.cas.state-current.get.v1',
        mode: 'get',
        sql: `SELECT generation,state_hash,state_json
          FROM autonomous_external_qualification_state WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.cas.state-insert.apply.v1',
        mode: 'run',
        sql: `INSERT INTO autonomous_external_qualification_state(
          scope,generation,state_hash,state_json,updated_at
        ) VALUES(?,?,?,?,?)`,
      },
      {
        statementId: 'external-qualification.cas.state-update.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_external_qualification_state
          SET generation=?,state_hash=?,state_json=?,updated_at=?
          WHERE scope=? AND generation=? AND state_hash=?`,
      },
    ],
  ),
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS
    .markAttemptExternalActionStarted]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS
      .markAttemptExternalActionStarted,
    [
      {
        statementId: 'external-qualification.attempt-start.lease-current.get.v1',
        mode: 'get',
        sql: `SELECT owner_id,lease_token,lease_generation,expires_at
          FROM autonomous_external_qualification_attempt_lease WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.attempt-start.reservation-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM autonomous_external_qualification_attempt_reservation
          WHERE scope=? AND state_generation=? AND state_hash=? AND idempotency_key=?`,
      },
      {
        statementId: 'external-qualification.attempt-start.reservation-update.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_external_qualification_attempt_reservation
          SET external_action_may_have_started=1,started_actions_json=?,
            first_started_at=coalesce(first_started_at,?),last_started_at=?,
            side_effect_permit_hash=coalesce(side_effect_permit_hash,?)
          WHERE scope=? AND state_generation=? AND state_hash=? AND idempotency_key=?
            AND lease_owner_id=? AND lease_token_hash=? AND lease_generation=?
            AND (side_effect_permit_hash IS NULL OR side_effect_permit_hash=?)
            AND cancelled_at IS NULL`,
      },
      {
        statementId: 'external-qualification.attempt-start.state-current.get.v1',
        mode: 'get',
        sql: `SELECT generation,state_hash,state_json
          FROM autonomous_external_qualification_state WHERE scope=?`,
      },
    ],
  ),
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS
    .reconcileAttemptReservation]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS
      .reconcileAttemptReservation,
    [
      {
        statementId: 'external-qualification.attempt-reconcile.lease-current.get.v1',
        mode: 'get',
        sql: `SELECT owner_id,lease_token,lease_generation,expires_at
          FROM autonomous_external_qualification_attempt_lease WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.attempt-reconcile.lease-delete.apply.v1',
        mode: 'run',
        sql: `DELETE FROM autonomous_external_qualification_attempt_lease
          WHERE scope=? AND owner_id=? AND lease_token=? AND lease_generation=?
            AND julianday(expires_at)<=julianday(?)`,
      },
      {
        statementId: 'external-qualification.attempt-reconcile.lease-upsert.apply.v1',
        mode: 'run',
        sql: `INSERT INTO autonomous_external_qualification_attempt_lease(
          scope,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
        ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
          owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,acquired_at=excluded.acquired_at,
          renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`,
      },
      {
        statementId: 'external-qualification.attempt-reconcile.reservation-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM autonomous_external_qualification_attempt_reservation
          WHERE scope=? AND state_generation=? AND state_hash=? AND idempotency_key=?`,
      },
      {
        statementId: 'external-qualification.attempt-reconcile.reservation-refund.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_external_qualification_attempt_reservation
          SET cancelled_at=?,cancelled_state_generation=?,cancelled_state_hash=?
          WHERE scope=? AND state_generation=? AND state_hash=? AND idempotency_key=?
            AND external_action_may_have_started=0 AND cancelled_at IS NULL`,
      },
      {
        statementId: 'external-qualification.attempt-reconcile.reservation-takeover.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_external_qualification_attempt_reservation
          SET lease_owner_id=?,lease_token_hash=?,lease_generation=?,
            recovery_takeover_count=recovery_takeover_count+1,
            last_recovery_takeover_at=?
          WHERE scope=? AND state_generation=? AND state_hash=? AND idempotency_key=?
            AND external_action_may_have_started=1 AND cancelled_at IS NULL
            AND lease_owner_id=? AND lease_token_hash=? AND lease_generation=?`,
      },
      {
        statementId: 'external-qualification.attempt-reconcile.state-current.get.v1',
        mode: 'get',
        sql: `SELECT generation,state_hash,state_json
          FROM autonomous_external_qualification_state WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.attempt-reconcile.state-refund.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_external_qualification_state
          SET generation=?,state_hash=?,state_json=?,updated_at=?
          WHERE scope=? AND generation=? AND state_hash=?`,
      },
    ],
  ),
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS
    .cancelAttemptInfrastructureDeferred]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS
      .cancelAttemptInfrastructureDeferred,
    [
      {
        statementId: 'external-qualification.attempt-cancel.lease-current.get.v1',
        mode: 'get',
        sql: `SELECT owner_id,lease_token,lease_generation,expires_at
          FROM autonomous_external_qualification_attempt_lease WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.attempt-cancel.lease-delete.apply.v1',
        mode: 'run',
        sql: `DELETE FROM autonomous_external_qualification_attempt_lease
          WHERE scope=? AND owner_id=? AND lease_token=? AND lease_generation=?`,
      },
      {
        statementId: 'external-qualification.attempt-cancel.reservation-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM autonomous_external_qualification_attempt_reservation
          WHERE scope=? AND state_generation=? AND state_hash=? AND idempotency_key=?`,
      },
      {
        statementId: 'external-qualification.attempt-cancel.reservation-update.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_external_qualification_attempt_reservation
          SET cancelled_at=?,cancelled_state_generation=?,cancelled_state_hash=?
          WHERE scope=? AND state_generation=? AND state_hash=? AND idempotency_key=?
            AND lease_owner_id=? AND lease_token_hash=? AND lease_generation=?
            AND external_action_may_have_started=0 AND cancelled_at IS NULL`,
      },
      {
        statementId: 'external-qualification.attempt-cancel.state-current.get.v1',
        mode: 'get',
        sql: `SELECT generation,state_hash,state_json
          FROM autonomous_external_qualification_state WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.attempt-cancel.state-update.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_external_qualification_state
          SET generation=?,state_hash=?,state_json=?,updated_at=?
          WHERE scope=? AND generation=? AND state_hash=?`,
      },
    ],
  ),
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.reconcileLease]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.reconcileLease,
    [{
      statementId: 'external-qualification.reconcile.lease-delete.apply.v1',
      mode: 'run',
      sql: `DELETE FROM autonomous_external_qualification_attempt_lease
        WHERE scope=? AND julianday(expires_at)<=julianday(?)`,
    }],
  ),
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.releaseLease]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.releaseLease,
    [{
      statementId: 'external-qualification.release.lease-delete.apply.v1',
      mode: 'run',
      sql: `DELETE FROM autonomous_external_qualification_attempt_lease
        WHERE scope=? AND owner_id=? AND lease_token=? AND lease_generation=?`,
    }],
  ),
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.renewLease]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.renewLease,
    [{
      statementId: 'external-qualification.renew.lease-update.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_external_qualification_attempt_lease
        SET renewed_at=?,expires_at=? WHERE scope=? AND owner_id=? AND lease_token=?
        AND lease_generation=? AND julianday(expires_at)>julianday(?)`,
    }],
  ),
  [AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.acquireLease]: operation(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_OPERATION_IDS.acquireLease,
    [
      {
        statementId: 'external-qualification.acquire.lease-current.get.v1',
        mode: 'get',
        sql: `SELECT owner_id,lease_token,lease_generation,expires_at
          FROM autonomous_external_qualification_attempt_lease WHERE scope=?`,
      },
      {
        statementId: 'external-qualification.acquire.lease-upsert.apply.v1',
        mode: 'run',
        sql: `INSERT INTO autonomous_external_qualification_attempt_lease(
          scope,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
        ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
          owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,acquired_at=excluded.acquired_at,
          renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`,
      },
    ],
  ),
});

export const AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID,
    operationPlans: Object.values(
      AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS,
    ),
  });

export function createOfflineExternalQualificationMutationCoordinator({
  operationPlans = AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS,
  databaseInstanceId,
  schemaContractId = AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'autonomous_research_external_qualification_offline_mutation_input_invalid',
    asyncMutationError:
      'autonomous_research_external_qualification_async_mutation_forbidden',
    recoveryUnavailableError:
      'autonomous_research_external_qualification_offline_recovery_unavailable',
    statusBlocker:
      'autonomous_research_external_qualification_external_mutation_coordinator_required',
    receiptKind: 'OfflineExternalQualificationMutationReceipt',
  });
}
