import {
  compileExternallyFencedSqliteMutationOperation as operation,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';

export const AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_ROLE =
  'runtime-reproducibility-refresh';
export const AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_INSTANCE_ID =
  'runtime-reproducibility-refresh';
export const AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_SCHEMA_CONTRACT_ID =
  'runtime-reproducibility-refresh-schema-v1';
export const AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID =
  'writer:runtime-reproducibility-refresh:runtime-refresh-state-repository:v1';

export const AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS = Object.freeze({
  'runtime-reproducibility-refresh.runtime-refresh-state-repository.completeRefreshAttempt.v1': operation(
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.completeRefreshAttempt.v1',
    [
      {
        statementId: 'runtime-refresh.complete.attempt-apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_attempt SET
          status='succeeded',receipt_hash=?,completed_at=? WHERE lease_generation=?
          AND owner_id=? AND status='reserved'`,
      },
      {
        statementId: 'runtime-refresh.complete.state-apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_state SET
          status='refresh_verified',consecutive_failures=0,next_attempt_at=?,last_error=NULL,
          last_receipt_hash=?,last_receipt_content_hash=?,last_issued_at=?,last_expires_at=?,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE scope_id=?`,
      },
      {
        statementId: 'runtime-refresh.complete.state-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM runtime_reproducibility_refresh_state WHERE scope_id=?`,
      },
    ],
  ),
  'runtime-reproducibility-refresh.runtime-refresh-state-repository.failRefreshAttempt.v1': operation(
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.failRefreshAttempt.v1',
    [
      {
        statementId: 'runtime-refresh.fail.attempt-apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_attempt SET
          status=?,error=?,completed_at=? WHERE lease_generation=? AND owner_id=?
          AND status='reserved'`,
      },
      {
        statementId: 'runtime-refresh.fail.state-apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_state SET
          status='refresh_retry_scheduled',consecutive_failures=consecutive_failures+1,
          next_attempt_at=?,last_error=?,lease_owner=NULL,lease_token=NULL,
          lease_expires_at=NULL,updated_at=? WHERE scope_id=?`,
      },
      {
        statementId: 'runtime-refresh.fail.state-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM runtime_reproducibility_refresh_state WHERE scope_id=?`,
      },
    ],
  ),
  'runtime-reproducibility-refresh.runtime-refresh-state-repository.reconcileStaleRefreshLease.v1': operation(
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.reconcileStaleRefreshLease.v1',
    [
      {
        statementId: 'runtime-refresh.reconcile.attempt-expire.apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_attempt SET
          status='failed',error='runtime_reproducibility_refresh_lease_expired',completed_at=?
          WHERE lease_generation=? AND status='reserved'`,
      },
      {
        statementId: 'runtime-refresh.reconcile.state-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM runtime_reproducibility_refresh_state WHERE scope_id=?`,
      },
      {
        statementId: 'runtime-refresh.reconcile.state-recover.apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_state SET
          status='refresh_retry_scheduled',next_attempt_at=?,
          last_error='runtime_reproducibility_refresh_lease_expired',
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?,
          recovered_lease_count=recovered_lease_count+1 WHERE scope_id=?`,
      },
    ],
  ),
  'runtime-reproducibility-refresh.runtime-refresh-state-repository.releaseRefreshLease.v1': operation(
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.releaseRefreshLease.v1',
    [{
      statementId: 'runtime-refresh.release.state-apply.v1',
      mode: 'run',
      sql: `UPDATE runtime_reproducibility_refresh_state SET
        status='refresh_observation_current',lease_owner=NULL,lease_token=NULL,
        lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE scope_id=?
        AND lease_owner=? AND lease_token=? AND lease_generation=?`,
    }],
  ),
  'runtime-reproducibility-refresh.runtime-refresh-state-repository.renewRefreshLease.v1': operation(
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.renewRefreshLease.v1',
    [{
      statementId: 'runtime-refresh.renew.state-apply.v1',
      mode: 'run',
      sql: `UPDATE runtime_reproducibility_refresh_state SET
        lease_expires_at=?,updated_at=? WHERE scope_id=? AND lease_owner=? AND lease_token=?
        AND lease_generation=? AND julianday(lease_expires_at)>julianday(?)`,
    }],
  ),
  'runtime-reproducibility-refresh.runtime-refresh-state-repository.reserveRefreshAttempt.v1': operation(
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.reserveRefreshAttempt.v1',
    [
      {
        statementId: 'runtime-refresh.reserve.attempt-create.apply.v1',
        mode: 'run',
        sql: `INSERT INTO runtime_reproducibility_refresh_attempt(
          lease_generation,owner_id,campaign_id,epoch_start,configuration_identity_hash,
          reserved_cost_usd,cost_authority,status,reserved_at
        ) VALUES(?,?,?,?,?,?,?,'reserved',?)`,
      },
      {
        statementId: 'runtime-refresh.reserve.epoch-create.apply.v1',
        mode: 'run',
        sql: `INSERT INTO runtime_reproducibility_refresh_budget_epoch(
          epoch_start,epoch_end,policy_json,policy_hash,created_at,updated_at
        ) VALUES(?,?,?,?,?,?)`,
      },
      {
        statementId: 'runtime-refresh.reserve.epoch-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM runtime_reproducibility_refresh_budget_epoch
          WHERE epoch_start=?`,
      },
      {
        statementId: 'runtime-refresh.reserve.epoch-reserve.apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_budget_epoch SET
          attempt_count=?,reserved_cost_usd=?,updated_at=? WHERE epoch_start=?`,
      },
      {
        statementId: 'runtime-refresh.reserve.state-block.apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_state SET
          status=?,next_attempt_at=?,last_error=?,lease_owner=NULL,lease_token=NULL,
          lease_expires_at=NULL,updated_at=? WHERE scope_id=?`,
      },
      {
        statementId: 'runtime-refresh.reserve.state-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM runtime_reproducibility_refresh_state WHERE scope_id=?`,
      },
      {
        statementId: 'runtime-refresh.reserve.state-progress.apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_state SET
          status='refresh_in_progress',last_configuration_identity_hash=?,last_error=NULL,
          updated_at=? WHERE scope_id=?`,
      },
    ],
  ),
  'runtime-reproducibility-refresh.runtime-refresh-state-repository.tryAcquireRefreshLease.v1': operation(
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.tryAcquireRefreshLease.v1',
    [
      {
        statementId: 'runtime-refresh.acquire.attempt-expire.apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_attempt SET
          status='failed',error='runtime_reproducibility_refresh_lease_expired',completed_at=?
          WHERE lease_generation=? AND status='reserved'`,
      },
      {
        statementId: 'runtime-refresh.acquire.state-apply.v1',
        mode: 'run',
        sql: `UPDATE runtime_reproducibility_refresh_state SET
          status='refresh_leased',lease_owner=?,lease_token=?,lease_generation=?,
          lease_expires_at=?,recovered_lease_count=recovered_lease_count+?,updated_at=?
          WHERE scope_id=? AND lease_generation=?`,
      },
      {
        statementId: 'runtime-refresh.acquire.state-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM runtime_reproducibility_refresh_state WHERE scope_id=?`,
      },
    ],
  ),
});

export const AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
    operationPlans: Object.values(AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS),
  });

export function createOfflineRuntimeRefreshMutationCoordinator({
  operationPlans = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS,
  databaseInstanceId = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'autonomous_research_runtime_refresh_offline_mutation_input_invalid',
    asyncMutationError:
      'autonomous_research_runtime_refresh_async_mutation_forbidden',
    recoveryUnavailableError:
      'autonomous_research_runtime_refresh_offline_recovery_unavailable',
    statusBlocker:
      'autonomous_research_runtime_refresh_external_mutation_coordinator_required',
    receiptKind: 'OfflineRuntimeRefreshMutationReceipt',
  });
}
