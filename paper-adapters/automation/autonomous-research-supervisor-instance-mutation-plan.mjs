import {
  compileExternallyFencedSqliteMutationOperation as operation,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';

export const AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_ROLE =
  'resident-instance';
export const AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_INSTANCE_ID =
  'resident-instance';
export const AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_SCHEMA_CONTRACT_ID =
  'resident-instance-schema-v1';
export const AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID =
  'writer:resident-instance:supervisor-instance-repository:v1';

export const AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS = Object.freeze({
  'resident-instance.supervisor-instance-repository.acquireInstanceLease.v1': operation(
    'resident-instance.supervisor-instance-repository.acquireInstanceLease.v1',
    [
      {
        statementId: 'resident-instance.acquire.current.v1',
        mode: 'get',
        sql: `SELECT * FROM autonomous_research_supervisor_instance
          WHERE scope_id=?`,
      },
      {
        statementId: 'resident-instance.acquire.upsert.v1',
        mode: 'run',
        sql: `INSERT INTO autonomous_research_supervisor_instance(
          scope_id,status,owner_id,lease_token,lease_generation,lease_duration_ms,
          heartbeat_interval_ms,started_at,last_heartbeat_at,lease_expires_at,
          startup_reconciled_at,startup_reconciliation_receipt_hash,
          fully_autonomous_required,fully_autonomous_prerequisite_identity_hash,
          machine_intake_reconciled_at,machine_intake_reconciliation_receipt_hash,
          machine_intake_configuration_hash,machine_intake_dataset_snapshot_hash,
          machine_intake_reconciliation_failed_at,
          machine_intake_reconciliation_failure,last_cycle_at,last_cycle_receipt_hash,
          stopped_at,stop_reason,recovered_lease_count,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_id) DO UPDATE SET
          status='running',owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,
          lease_duration_ms=excluded.lease_duration_ms,
          heartbeat_interval_ms=excluded.heartbeat_interval_ms,
          started_at=excluded.started_at,last_heartbeat_at=excluded.last_heartbeat_at,
          lease_expires_at=excluded.lease_expires_at,startup_reconciled_at=NULL,
          startup_reconciliation_receipt_hash=NULL,machine_intake_reconciled_at=NULL,
          fully_autonomous_required=excluded.fully_autonomous_required,
          fully_autonomous_prerequisite_identity_hash=NULL,
          machine_intake_reconciliation_receipt_hash=NULL,
          machine_intake_configuration_hash=NULL,
          machine_intake_dataset_snapshot_hash=NULL,
          machine_intake_reconciliation_failed_at=NULL,
          machine_intake_reconciliation_failure=NULL,last_cycle_at=NULL,
          last_cycle_receipt_hash=NULL,stopped_at=NULL,stop_reason=NULL,
          recovered_lease_count=autonomous_research_supervisor_instance.recovered_lease_count+?,
          updated_at=excluded.updated_at`,
      },
    ],
  ),
  'resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1': operation(
    'resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1',
    [{
      statementId: 'resident-instance.heartbeat.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_supervisor_instance SET
        last_heartbeat_at=?,lease_expires_at=?,last_cycle_at=coalesce(?,last_cycle_at),
        last_cycle_receipt_hash=coalesce(?,last_cycle_receipt_hash),
        updated_at=? WHERE scope_id=? AND status='running' AND owner_id=?
        AND lease_token=? AND lease_generation=?
        AND julianday(lease_expires_at)>julianday(?)`,
    }],
  ),
  'resident-instance.supervisor-instance-repository.markMachineIntakeReconciled.v1': operation(
    'resident-instance.supervisor-instance-repository.markMachineIntakeReconciled.v1',
    [{
      statementId: 'resident-instance.machine-intake-reconciled.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_supervisor_instance SET
        last_heartbeat_at=?,lease_expires_at=?,machine_intake_reconciled_at=?,
        machine_intake_reconciliation_receipt_hash=?,machine_intake_configuration_hash=?,
        machine_intake_dataset_snapshot_hash=?,
        machine_intake_reconciliation_failed_at=NULL,
        machine_intake_reconciliation_failure=NULL,updated_at=? WHERE scope_id=?
        AND status='running' AND owner_id=? AND lease_token=? AND lease_generation=?
        AND startup_reconciliation_receipt_hash IS NOT NULL
        AND julianday(lease_expires_at)>julianday(?)`,
    }],
  ),
  'resident-instance.supervisor-instance-repository.markMachineIntakeReconciliationFailed.v1': operation(
    'resident-instance.supervisor-instance-repository.markMachineIntakeReconciliationFailed.v1',
    [{
      statementId: 'resident-instance.machine-intake-failed.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_supervisor_instance SET
        last_heartbeat_at=?,lease_expires_at=?,machine_intake_reconciled_at=NULL,
        machine_intake_reconciliation_receipt_hash=NULL,
        machine_intake_configuration_hash=NULL,machine_intake_dataset_snapshot_hash=NULL,
        machine_intake_reconciliation_failed_at=?,
        machine_intake_reconciliation_failure=?,updated_at=? WHERE scope_id=?
        AND status='running' AND owner_id=? AND lease_token=? AND lease_generation=?
        AND startup_reconciliation_receipt_hash IS NOT NULL
        AND julianday(lease_expires_at)>julianday(?)`,
    }],
  ),
  'resident-instance.supervisor-instance-repository.markStartupReconciled.v1': operation(
    'resident-instance.supervisor-instance-repository.markStartupReconciled.v1',
    [
      {
        statementId: 'resident-instance.startup.apply.v1',
        mode: 'run',
        sql: `UPDATE autonomous_research_supervisor_instance SET
          last_heartbeat_at=?,lease_expires_at=?,startup_reconciled_at=?,
          startup_reconciliation_receipt_hash=?,
          fully_autonomous_prerequisite_identity_hash=?,updated_at=? WHERE scope_id=?
          AND status='running' AND owner_id=? AND lease_token=? AND lease_generation=?
          AND julianday(lease_expires_at)>julianday(?)`,
      },
      {
        statementId: 'resident-instance.startup.current.v1',
        mode: 'get',
        sql: `SELECT * FROM autonomous_research_supervisor_instance
          WHERE scope_id=?`,
      },
    ],
  ),
  'resident-instance.supervisor-instance-repository.releaseInstanceLease.v1': operation(
    'resident-instance.supervisor-instance-repository.releaseInstanceLease.v1',
    [{
      statementId: 'resident-instance.release.apply.v1',
      mode: 'run',
      sql: `UPDATE autonomous_research_supervisor_instance SET
        status='stopped',owner_id=NULL,lease_token=NULL,lease_expires_at=NULL,
        stopped_at=?,stop_reason=?,updated_at=? WHERE scope_id=? AND status='running'
        AND owner_id=? AND lease_token=? AND lease_generation=?
        AND julianday(lease_expires_at)>julianday(?)`,
    }],
  ),
});

export const AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
    operationPlans: Object.values(AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS),
  });

export function createOfflineResidentInstanceMutationCoordinator({
  operationPlans = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS,
  databaseInstanceId = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'autonomous_research_resident_instance_offline_mutation_input_invalid',
    asyncMutationError:
      'autonomous_research_resident_instance_async_mutation_forbidden',
    recoveryUnavailableError:
      'autonomous_research_resident_instance_offline_recovery_unavailable',
    statusBlocker:
      'autonomous_research_resident_instance_external_mutation_coordinator_required',
    receiptKind: 'OfflineResidentInstanceMutationReceipt',
  });
}
