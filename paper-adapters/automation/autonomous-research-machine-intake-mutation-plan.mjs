import {
  compileExternallyFencedSqliteMutationOperation,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';
import { SELECT_RECORD } from './autonomous-research-machine-intake-repository-support.mjs';

export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_ROLE = 'machine-intake';
export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_INSTANCE_ID = 'machine-intake';
export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_SCHEMA_CONTRACT_ID =
  'machine-intake-schema-v2';
export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID =
  'writer:machine-intake:machine-intake-repository:v1';

const authorityStatements = Object.freeze([
  {
    statementId: 'authority.genesis.all.v1',
    mode: 'all',
    sql: `SELECT * FROM autonomous_research_machine_intake_authority_genesis
      ORDER BY singleton`,
  },
  {
    statementId: 'authority.metadata.current.get.v1',
    mode: 'get',
    sql: `SELECT configured_source_authority_hash,
      authorized_machine_producer_profile_hash,authority_generation,
      last_authority_rotation_receipt_hash
      FROM autonomous_research_machine_intake_metadata WHERE singleton=1`,
  },
  {
    statementId: 'authority.rotation.all.v1',
    mode: 'all',
    sql: `SELECT * FROM autonomous_research_machine_intake_authority_rotation
      ORDER BY authority_generation`,
  },
]);

const operation = (operationId, statements) => (
  compileExternallyFencedSqliteMutationOperation(operationId, statements, {
    sharedStatements: authorityStatements,
  })
);

const recordSql = `${SELECT_RECORD} WHERE i.intake_id=?`;

export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS = Object.freeze({
  'machine-intake.machine-intake-repository.appendIntake.v1': operation(
    'machine-intake.machine-intake-repository.appendIntake.v1',
    [
      {
        statementId: 'append.daily-current.get.v1', mode: 'get',
        sql: `SELECT * FROM autonomous_research_machine_intake_daily_admission
          WHERE epoch_start=?`,
      },
      {
        statementId: 'append.daily-create.apply.v1', mode: 'run',
        sql: `INSERT OR IGNORE INTO autonomous_research_machine_intake_daily_admission(
          epoch_start,machine_append_count,reserved_cost_usd,reserved_agent_calls,
          reserved_gpu_jobs,updated_at
        ) VALUES(?,?,?,?,?,?)`,
      },
      {
        statementId: 'append.daily-update.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake_daily_admission SET
          machine_append_count=?,reserved_cost_usd=?,reserved_agent_calls=?,reserved_gpu_jobs=?,
          updated_at=? WHERE epoch_start=?`,
      },
      {
        statementId: 'append.identity.all.v1', mode: 'all',
        sql: `SELECT intake_id,intake_hash,campaign_id,source_kind,source_ref,
          source_authority_hash,admission_hash FROM autonomous_research_machine_intake
          WHERE intake_id=? OR campaign_id=? OR intake_hash=?`,
      },
      {
        statementId: 'append.intake-create.apply.v1', mode: 'run',
        sql: `INSERT INTO autonomous_research_machine_intake(
          intake_id,intake_hash,paper_id,campaign_id,intake_json,admission_json,admission_hash,
          source_kind,source_ref,source_authority_hash,disposition,lease_generation,
          failure_count,next_attempt_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      },
      {
        statementId: 'append.pending-count.get.v1', mode: 'get',
        sql: `SELECT COUNT(*) AS count FROM autonomous_research_machine_intake
          WHERE disposition='pending'`,
      },
      {
        statementId: 'append.pending-non-recurring-count.get.v1', mode: 'get',
        sql: `SELECT COUNT(*) AS count FROM autonomous_research_machine_intake
          WHERE disposition='pending' AND source_kind<>'recurring-golden'`,
      },
      { statementId: 'append.record-current.get.v1', mode: 'get', sql: recordSql },
      {
        statementId: 'append.recurring-lease-retire.apply.v1', mode: 'run',
        sql: `DELETE FROM autonomous_research_machine_intake_lease WHERE intake_id IN (
          SELECT intake_id FROM autonomous_research_machine_intake
          WHERE disposition='superseded')`,
      },
      {
        statementId: 'append.recurring-supersede.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake SET disposition='superseded',updated_at=?
          WHERE disposition='pending' AND source_kind='recurring-golden'
          AND substr(source_ref,1,?)=? AND intake_id<>? AND NOT EXISTS(
            SELECT 1 FROM autonomous_research_machine_intake_lease l
            WHERE l.intake_id=autonomous_research_machine_intake.intake_id AND l.expires_at>?
          )`,
      },
    ],
  ),
  'machine-intake.machine-intake-repository.deferIntake.v1': operation(
    'machine-intake.machine-intake-repository.deferIntake.v1',
    [
      {
        statementId: 'defer.active.get.v1', mode: 'get',
        sql: `SELECT i.disposition,i.lease_generation,l.owner_id,l.lease_token,
          l.lease_generation AS active_lease_generation,l.expires_at
          FROM autonomous_research_machine_intake i
          JOIN autonomous_research_machine_intake_lease l ON l.intake_id=i.intake_id
          WHERE i.intake_id=?`,
      },
      {
        statementId: 'defer.intake-update.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake SET failure_count=failure_count+1,
          next_attempt_at=?,last_error=?,updated_at=?
          WHERE intake_id=? AND disposition='pending' AND lease_generation=?`,
      },
      {
        statementId: 'defer.lease-delete.apply.v1', mode: 'run',
        sql: `DELETE FROM autonomous_research_machine_intake_lease
          WHERE intake_id=? AND owner_id=? AND lease_token=? AND lease_generation=?`,
      },
      { statementId: 'defer.record-current.get.v1', mode: 'get', sql: recordSql },
    ],
  ),
  'machine-intake.machine-intake-repository.markEnqueuedIntakeInvalid.v1': operation(
    'machine-intake.machine-intake-repository.markEnqueuedIntakeInvalid.v1',
    [
      {
        statementId: 'invalid.intake-update.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake SET
          disposition='invalid',invalid_reason=?,updated_at=?
          WHERE intake_id=? AND disposition='enqueued' AND admission_hash=?`,
      },
      { statementId: 'invalid.record-current.get.v1', mode: 'get', sql: recordSql },
    ],
  ),
  'machine-intake.machine-intake-repository.markIntakeEnqueued.v1': operation(
    'machine-intake.machine-intake-repository.markIntakeEnqueued.v1',
    [
      {
        statementId: 'enqueue.active.get.v1', mode: 'get',
        sql: `SELECT l.owner_id,l.lease_token,l.lease_generation,l.expires_at,
          i.source_kind,i.intake_json,i.admission_hash
          FROM autonomous_research_machine_intake_lease l
          JOIN autonomous_research_machine_intake i ON i.intake_id=l.intake_id
          WHERE l.intake_id=?`,
      },
      {
        statementId: 'enqueue.intake-update.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake SET disposition='enqueued',
          campaign_plan_hash=?,preparation_hash=?,enqueued_at=?,updated_at=?
          WHERE intake_id=? AND disposition='pending' AND lease_generation=?
          AND admission_hash=?`,
      },
      {
        statementId: 'enqueue.lease-delete.apply.v1', mode: 'run',
        sql: `DELETE FROM autonomous_research_machine_intake_lease
          WHERE intake_id=? AND owner_id=? AND lease_token=? AND lease_generation=?`,
      },
      { statementId: 'enqueue.record-current.get.v1', mode: 'get', sql: recordSql },
    ],
  ),
  'machine-intake.machine-intake-repository.reconcileExpiredIntakeLeases.v1': operation(
    'machine-intake.machine-intake-repository.reconcileExpiredIntakeLeases.v1',
    [{
      statementId: 'reconcile.lease-delete.apply.v1', mode: 'run',
      sql: 'DELETE FROM autonomous_research_machine_intake_lease WHERE expires_at<=?',
    }],
  ),
  'machine-intake.machine-intake-repository.releaseIntakeLease.v1': operation(
    'machine-intake.machine-intake-repository.releaseIntakeLease.v1',
    [{
      statementId: 'release.lease-delete.apply.v1', mode: 'run',
      sql: `DELETE FROM autonomous_research_machine_intake_lease
        WHERE intake_id=? AND owner_id=? AND lease_token=? AND lease_generation=?`,
    }],
  ),
  'machine-intake.machine-intake-repository.renewIntakeLease.v1': operation(
    'machine-intake.machine-intake-repository.renewIntakeLease.v1',
    [
      {
        statementId: 'renew.intake-current.get.v1', mode: 'get',
        sql: `SELECT source_kind,intake_json FROM autonomous_research_machine_intake
          WHERE intake_id=?`,
      },
      {
        statementId: 'renew.lease-update.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake_lease SET renewed_at=?,expires_at=?
          WHERE intake_id=? AND owner_id=? AND lease_token=? AND lease_generation=?
          AND expires_at>?`,
      },
    ],
  ),
  'machine-intake.machine-intake-repository.tryAcquireIntakeLease.v1': operation(
    'machine-intake.machine-intake-repository.tryAcquireIntakeLease.v1',
    [
      {
        statementId: 'acquire.intake-current.get.v1', mode: 'get',
        sql: `SELECT disposition,lease_generation,next_attempt_at,source_kind,intake_json
          FROM autonomous_research_machine_intake WHERE intake_id=?`,
      },
      {
        statementId: 'acquire.intake-generation-update.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake SET lease_generation=?,updated_at=?
          WHERE intake_id=? AND disposition='pending'`,
      },
      {
        statementId: 'acquire.intake-supersede.apply.v1', mode: 'run',
        sql: `UPDATE autonomous_research_machine_intake SET disposition='superseded',updated_at=?
          WHERE intake_id=? AND disposition='pending'`,
      },
      {
        statementId: 'acquire.lease-current.get.v1', mode: 'get',
        sql: `SELECT expires_at FROM autonomous_research_machine_intake_lease
          WHERE intake_id=?`,
      },
      {
        statementId: 'acquire.lease-delete.apply.v1', mode: 'run',
        sql: 'DELETE FROM autonomous_research_machine_intake_lease WHERE intake_id=?',
      },
      {
        statementId: 'acquire.lease-upsert.apply.v1', mode: 'run',
        sql: `INSERT INTO autonomous_research_machine_intake_lease(
          intake_id,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
        ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(intake_id) DO UPDATE SET
          owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,acquired_at=excluded.acquired_at,
          renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`,
      },
    ],
  ),
});

export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
    operationPlans: Object.values(AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS),
  });

export function createOfflineMachineIntakeMutationCoordinator({
  operationPlans = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS,
  databaseInstanceId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'autonomous_research_machine_intake_offline_mutation_input_invalid',
    asyncMutationError: 'autonomous_research_machine_intake_async_mutation_forbidden',
    recoveryUnavailableError:
      'autonomous_research_machine_intake_offline_recovery_unavailable',
    statusBlocker:
      'autonomous_research_machine_intake_external_mutation_coordinator_required',
    receiptKind: 'OfflineMachineIntakeMutationReceipt',
  });
}
