import crypto from 'node:crypto';
import fs from 'node:fs';
import { sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function parse(row) {
  if (!row) return null;
  return Object.freeze({
    ...row,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    nodeId: row.node_id || null,
    workspacePath: row.workspace_path,
    sourcePath: row.source_path,
    retentionState: row.retention_state,
    retentionReason: row.retention_reason,
  });
}

export function createWorkspaceRegistry({ store, clock } = {}) {
  if (!store || !clock) throw new Error('Workspace registry requires StorePort and ClockPort');
  return Object.freeze({
    version: 1,
    kind: 'SqliteCampaignWorkspaceRegistry',
    register({ workspaceId = null, campaignId, nodeId = null, parentWorkspaceId = null, sourcePath, workspacePath, sourceHash = null, manifestHash = null } = {}) {
      if (!campaignId || !sourcePath || !workspacePath) throw new Error('campaignId, sourcePath and workspacePath are required');
      const id = workspaceId || `workspace:${crypto.randomUUID()}`;
      const now = clock.nowIso();
      const write = store.execute(`INSERT INTO campaign_workspaces(workspace_id,campaign_id,node_id,parent_workspace_id,source_path,workspace_path,source_sha256,workspace_manifest_sha256,status,retention_state,retention_reason,created_at,updated_at) VALUES(${sqlText(id)},${sqlText(campaignId)},${nodeId ? sqlText(nodeId) : 'NULL'},${parentWorkspaceId ? sqlText(parentWorkspaceId) : 'NULL'},${sqlText(sourcePath)},${sqlText(workspacePath)},${sourceHash ? sqlText(sourceHash) : 'NULL'},${manifestHash ? sqlText(manifestHash) : 'NULL'},'created','protected','active_or_unresolved_lineage',${sqlText(now)},${sqlText(now)}) ON CONFLICT(workspace_path) DO UPDATE SET node_id=excluded.node_id,workspace_manifest_sha256=excluded.workspace_manifest_sha256,updated_at=excluded.updated_at;`);
      if (!write.ok) throw new Error(write.error || 'workspace_registry_register_failed');
      return parse(store.query(`SELECT * FROM campaign_workspaces WHERE workspace_path=${sqlText(workspacePath)} LIMIT 1;`).rows[0]);
    },
    transition(workspaceId, { status, failureClass = null, retentionState = null, retentionReason = null, manifestHash = null, exportReceiptHash = null } = {}) {
      const existing = store.query(`SELECT * FROM campaign_workspaces WHERE workspace_id=${sqlText(workspaceId)} LIMIT 1;`).rows[0];
      if (!existing) throw new Error(`workspace registry entry not found: ${workspaceId}`);
      const nextStatus = status || existing.status;
      let nextRetention = retentionState || existing.retention_state;
      let nextReason = retentionReason || existing.retention_reason;
      if (nextRetention === 'eligible' && !['merged', 'removed', 'exported'].includes(nextStatus)) throw new Error('unresolved workspace cannot become retention eligible');
      if (nextRetention === 'eligible' && !exportReceiptHash && !existing.export_receipt_sha256 && nextStatus !== 'removed') {
        throw new Error('retention eligibility requires export receipt or prior removal');
      }
      if (['failed', 'conflict', 'orphaned'].includes(nextStatus)) {
        nextRetention = 'protected';
        nextReason = retentionReason || 'failure_or_unresolved_lineage';
      }
      const now = clock.nowIso();
      const write = store.execute(`UPDATE campaign_workspaces SET status=${sqlText(nextStatus)},failure_class=${failureClass ? sqlText(failureClass) : 'failure_class'},retention_state=${sqlText(nextRetention)},retention_reason=${sqlText(nextReason)},workspace_manifest_sha256=${manifestHash ? sqlText(manifestHash) : 'workspace_manifest_sha256'},export_receipt_sha256=${exportReceiptHash ? sqlText(exportReceiptHash) : 'export_receipt_sha256'},exported_at=${exportReceiptHash ? sqlText(now) : 'exported_at'},updated_at=${sqlText(now)} WHERE workspace_id=${sqlText(workspaceId)};`);
      if (!write.ok) throw new Error(write.error || 'workspace_registry_transition_failed');
      return parse(store.query(`SELECT * FROM campaign_workspaces WHERE workspace_id=${sqlText(workspaceId)} LIMIT 1;`).rows[0]);
    },
    recordSnapshot(workspaceId, { manifestHash, archivePath = null, archiveHash = null, bytes = 0, status = 'recorded' } = {}) {
      if (!manifestHash) throw new Error('workspace snapshot manifestHash is required');
      const createdAt = clock.nowIso();
      const payload = { version: 1, kind: 'WorkspaceSnapshot', workspaceId, manifestHash, archivePath, archiveHash, bytes: Number(bytes || 0), status, createdAt };
      const snapshotHash = hashRecord('WorkspaceSnapshot', payload);
      const snapshotId = `snapshot:${snapshotHash.replace(/^sha256:/, '')}`;
      const write = store.execute(`INSERT OR IGNORE INTO workspace_snapshots(snapshot_id,workspace_id,manifest_sha256,archive_path,archive_sha256,bytes,status,created_at) VALUES(${sqlText(snapshotId)},${sqlText(workspaceId)},${sqlText(manifestHash)},${archivePath ? sqlText(archivePath) : 'NULL'},${archiveHash ? sqlText(archiveHash) : 'NULL'},${Math.max(0, Number(bytes || 0))},${sqlText(status)},${sqlText(createdAt)});`);
      if (!write.ok) throw new Error(write.error || 'workspace_snapshot_record_failed');
      return Object.freeze({ ...payload, snapshotId, workspaceSnapshotHash: snapshotHash });
    },
    list({ campaignId = null } = {}) {
      const where = campaignId ? ` WHERE campaign_id=${sqlText(campaignId)}` : '';
      return store.query(`SELECT * FROM campaign_workspaces${where} ORDER BY created_at,workspace_id;`).rows.map(parse);
    },
    retentionRecords() {
      const result = store.query('SELECT workspace_id,campaign_id,node_id,workspace_path,status,retention_state,retention_reason,export_receipt_sha256 FROM campaign_workspaces ORDER BY workspace_path;');
      return result.ok ? result.rows.map(parse) : [];
    },
    reconcileMissingEligible() {
      const missing = this.retentionRecords().filter((record) => record.retentionState === 'eligible' && !fs.existsSync(record.workspacePath));
      return missing.map((record) => this.transition(record.workspaceId, {
        status: 'removed',
        retentionState: 'eligible',
        retentionReason: 'retention_applied_after_verified_export',
      }));
    },
  });
}
