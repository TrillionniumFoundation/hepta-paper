import {
  compileExternallyFencedSqliteMutationOperation as operation,
  defineExternallyFencedSqliteMutationStatement as statement,
  externallyFencedSqliteWriterPlanHash,
} from '../automation/externally-fenced-sqlite-mutation-plan.mjs';

export const NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_ID =
  'writer:native-store:resource-workspace-automation:v1';

export const NATIVE_STORE_RESOURCE_WORKSPACE_OPERATION_IDS = Object.freeze({
  acquireResources: 'native-store.resource-governor.acquire.v1',
  configureResourceGovernor:
    'native-store.resource-governor.createSqliteResourceGovernor.v1',
  qualifyWorkspaceRetention:
    'native-store.workspace-registry.qualifyForRetention.v1',
  reapDeadResourceOwners: 'native-store.resource-governor.reapDeadOwners.v1',
  recordWorkspaceSnapshot: 'native-store.workspace-registry.recordSnapshot.v1',
  registerWorkspace: 'native-store.workspace-registry.register.v1',
  releaseResourceLease: 'native-store.resource-governor.release.v1',
  renewResourceLeaseHeartbeat:
    'native-store.resource-governor.renewLeaseHeartbeat.v1',
  transitionWorkspace: 'native-store.workspace-registry.transition.v1',
});

export const NATIVE_STORE_RESOURCE_WORKSPACE_STATEMENT_IDS = Object.freeze({
  acquireCancelWaiter: 'native-store.resource.acquire.cancel-waiter.v1',
  acquireDeleteExpiredLeases: 'native-store.resource.acquire.delete-expired-leases.v1',
  acquireDeleteExpiredWaiters: 'native-store.resource.acquire.delete-expired-waiters.v1',
  acquireDeleteWaiter: 'native-store.resource.acquire.delete-acquired-waiter.v1',
  acquireEnqueueWaiter: 'native-store.resource.acquire.enqueue-waiter.v1',
  acquireGetLease: 'native-store.resource.acquire.get-lease.v1',
  acquireInsertLease: 'native-store.resource.acquire.insert-lease.v1',
  acquireRenewWaiter: 'native-store.resource.acquire.renew-waiter.v1',
  acquireUpdatePeaks: 'native-store.resource.acquire.update-peaks.v1',
  configureLimits: 'native-store.resource.configure.insert-limits.v1',
  configurePeaks: 'native-store.resource.configure.insert-peaks.v1',
  qualifySnapshot: 'native-store.workspace.qualify.update-snapshot.v1',
  qualifyWorkspace: 'native-store.workspace.qualify.update-workspace.v1',
  reapLeases: 'native-store.resource.reap.delete-leases.v1',
  reapWaiters: 'native-store.resource.reap.delete-waiters.v1',
  recordSnapshot: 'native-store.workspace.snapshot.insert.v1',
  registerWorkspace: 'native-store.workspace.register.upsert.v1',
  releaseLease: 'native-store.resource.release.delete-lease.v1',
  renewLeaseHeartbeat: 'native-store.resource.heartbeat.renew-lease.v1',
  transitionWorkspace: 'native-store.workspace.transition.update.v1',
});

const O = NATIVE_STORE_RESOURCE_WORKSPACE_OPERATION_IDS;
const S = NATIVE_STORE_RESOURCE_WORKSPACE_STATEMENT_IDS;

const plans = [
  operation(O.configureResourceGovernor, [
    statement(S.configureLimits, `INSERT OR IGNORE INTO automation_resource_limits(
      scope,agent_limit,cpu_limit,gpu_limit,memory_mib_limit,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`),
    statement(S.configurePeaks, `INSERT OR IGNORE INTO automation_resource_peaks(
      scope,updated_at
    ) VALUES(?,?)`),
  ]),
  operation(O.reapDeadResourceOwners, [
    statement(S.reapLeases, `DELETE FROM automation_resource_leases
      WHERE scope=? AND owner_id=?`),
    statement(S.reapWaiters, `DELETE FROM automation_resource_waiters
      WHERE scope=? AND owner_id=?`),
  ]),
  operation(O.acquireResources, [
    statement(S.acquireCancelWaiter, `DELETE FROM automation_resource_waiters
      WHERE waiter_id=? AND owner_id=?`),
    statement(S.acquireDeleteExpiredLeases, `DELETE FROM automation_resource_leases
      WHERE scope=? AND expires_at<=?`),
    statement(S.acquireDeleteExpiredWaiters, `DELETE FROM automation_resource_waiters
      WHERE scope=? AND expires_at<=?`),
    statement(S.acquireDeleteWaiter, `DELETE FROM automation_resource_waiters
      WHERE waiter_id=? AND owner_id=?
        AND EXISTS(SELECT 1 FROM automation_resource_leases WHERE lease_id=?)`),
    statement(S.acquireEnqueueWaiter, `INSERT OR IGNORE INTO automation_resource_waiters(
      waiter_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,
      requested_at,renewed_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    statement(S.acquireGetLease, `SELECT lease_id FROM automation_resource_leases
      WHERE lease_id=? LIMIT 1`, 'get'),
    statement(S.acquireInsertLease, `INSERT INTO automation_resource_leases(
      lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,
      acquired_at,renewed_at,expires_at
    )
    WITH capacity AS (
      SELECT
        l.agent_limit-coalesce(sum(r.agent),0) AS agent_available,
        l.cpu_limit-coalesce(sum(r.cpu),0) AS cpu_available,
        l.gpu_limit-coalesce(sum(r.gpu),0) AS gpu_available,
        l.memory_mib_limit-coalesce(sum(r.memory_mib),0) AS memory_mib_available
      FROM automation_resource_limits l
      LEFT JOIN automation_resource_leases r
        ON r.scope=l.scope AND r.expires_at>?
      WHERE l.scope=?
      GROUP BY l.scope
    ), eligible AS (
      SELECT w.waiter_id
      FROM automation_resource_waiters w,capacity c
      WHERE w.scope=? AND w.expires_at>?
        AND w.agent<=c.agent_available AND w.cpu<=c.cpu_available
        AND w.gpu<=c.gpu_available AND w.memory_mib<=c.memory_mib_available
      ORDER BY w.requested_at,w.waiter_id LIMIT 1
    )
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?
    FROM capacity
    WHERE ?<=agent_available AND ?<=cpu_available
      AND ?<=gpu_available AND ?<=memory_mib_available
      AND ?=(SELECT waiter_id FROM eligible)`),
    statement(S.acquireRenewWaiter, `UPDATE automation_resource_waiters
      SET renewed_at=?,expires_at=? WHERE waiter_id=? AND owner_id=?`),
    statement(S.acquireUpdatePeaks, `UPDATE automation_resource_peaks SET
      agent_peak=max(agent_peak,(SELECT coalesce(sum(agent),0)
        FROM automation_resource_leases WHERE scope=? AND expires_at>?)),
      cpu_peak=max(cpu_peak,(SELECT coalesce(sum(cpu),0)
        FROM automation_resource_leases WHERE scope=? AND expires_at>?)),
      gpu_peak=max(gpu_peak,(SELECT coalesce(sum(gpu),0)
        FROM automation_resource_leases WHERE scope=? AND expires_at>?)),
      memory_mib_peak=max(memory_mib_peak,(SELECT coalesce(sum(memory_mib),0)
        FROM automation_resource_leases WHERE scope=? AND expires_at>?)),
      updated_at=? WHERE scope=?`),
  ]),
  operation(O.renewResourceLeaseHeartbeat, [
    statement(S.renewLeaseHeartbeat, `UPDATE automation_resource_leases
      SET renewed_at=?,expires_at=?
      WHERE lease_id=? AND owner_id=? AND expires_at>?`),
  ]),
  operation(O.releaseResourceLease, [
    statement(S.releaseLease, `DELETE FROM automation_resource_leases
      WHERE lease_id=? AND owner_id=? AND expires_at>?`),
  ]),
  operation(O.registerWorkspace, [
    statement(S.registerWorkspace, `INSERT INTO campaign_workspaces(
      workspace_id,campaign_id,node_id,parent_workspace_id,source_path,workspace_path,
      source_sha256,workspace_manifest_sha256,status,retention_state,retention_reason,
      created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,'created','protected','active_or_unresolved_lineage',?,?)
    ON CONFLICT(workspace_path) DO UPDATE SET
      node_id=excluded.node_id,
      workspace_manifest_sha256=excluded.workspace_manifest_sha256,
      updated_at=excluded.updated_at`),
  ]),
  operation(O.transitionWorkspace, [
    statement(S.transitionWorkspace, `UPDATE campaign_workspaces SET
      status=?,failure_class=?,retention_state=?,retention_reason=?,
      workspace_manifest_sha256=?,export_receipt_sha256=?,exported_at=?,updated_at=?
      WHERE workspace_id=?`),
  ]),
  operation(O.recordWorkspaceSnapshot, [
    statement(S.recordSnapshot, `INSERT OR IGNORE INTO workspace_snapshots(
      snapshot_id,workspace_id,manifest_sha256,manifest_path,archive_path,
      archive_sha256,external_content_sha256,bytes,status,created_at,
      export_receipt_sha256
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
  ]),
  operation(O.qualifyWorkspaceRetention, [
    statement(S.qualifySnapshot, `UPDATE workspace_snapshots SET
      restore_receipt_sha256=?,restore_receipt_json=?,restore_ledger_receipt_id=?,
      restore_verified_at=?,retention_qualified_at=?,status='restore_verified'
    WHERE snapshot_id=? AND workspace_id=?
      AND manifest_sha256=? AND archive_sha256=?
      AND snapshot_id=(SELECT candidate.snapshot_id FROM workspace_snapshots candidate
        WHERE candidate.workspace_id=?
        ORDER BY candidate.created_at DESC,candidate.snapshot_id DESC LIMIT 1)
      AND status IN ('exported_unverified','restore_verified')
      AND (restore_receipt_sha256 IS NULL
        OR (restore_receipt_sha256=? AND restore_ledger_receipt_id=?))
      AND EXISTS(SELECT 1 FROM campaign_workspaces workspace
        WHERE workspace.workspace_id=? AND workspace.status='exported'
          AND workspace.retention_state IN ('protected','eligible')
          AND workspace.export_receipt_sha256 IS NOT NULL
          AND workspace.export_receipt_sha256=workspace_snapshots.export_receipt_sha256)`),
    statement(S.qualifyWorkspace, `UPDATE campaign_workspaces SET
      status='exported',retention_state='eligible',
      retention_reason='snapshot_restore_verified',updated_at=?
    WHERE workspace_id=? AND status='exported'
      AND retention_state IN ('protected','eligible')
      AND export_receipt_sha256 IS NOT NULL
      AND EXISTS(SELECT 1 FROM workspace_snapshots snapshot
        WHERE snapshot.snapshot_id=?
          AND snapshot.workspace_id=campaign_workspaces.workspace_id
          AND snapshot.snapshot_id=(SELECT candidate.snapshot_id
            FROM workspace_snapshots candidate
            WHERE candidate.workspace_id=campaign_workspaces.workspace_id
            ORDER BY candidate.created_at DESC,candidate.snapshot_id DESC LIMIT 1)
          AND snapshot.manifest_sha256=? AND snapshot.archive_sha256=?
          AND snapshot.export_receipt_sha256=campaign_workspaces.export_receipt_sha256
          AND snapshot.restore_receipt_sha256=?
          AND snapshot.restore_ledger_receipt_id=?
          AND snapshot.retention_qualified_at=?)`),
  ]),
];

export const NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS = Object.freeze(
  Object.fromEntries(plans.map((plan) => [plan.operationId, plan])),
);

export const NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_ID,
    operationPlans: Object.values(NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS),
  });
