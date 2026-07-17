import crypto from 'node:crypto';
import fs from 'node:fs';
import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyWorkspaceRetentionEvidence } from './workspace-retention-evidence.mjs';

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
    exportReceiptHash: row.export_receipt_sha256 || null,
    restoreReceiptHash: row.restore_receipt_sha256 || null,
    restoreLedgerReceiptId: row.restore_ledger_receipt_id || null,
    manifestPath: row.manifest_path || null,
    archivePath: row.archive_path || null,
    archiveHash: row.archive_sha256 || null,
    externalContentHash: row.external_content_sha256 || null,
    restoreVerifiedAt: row.restore_verified_at || null,
    retentionQualifiedAt: row.retention_qualified_at || null,
  });
}

function parseRetention(row, receiptLedger) {
  const record = parse(row);
  if (!record || record.retentionState !== 'eligible' || record.status === 'removed') return record;
  const verification = verifyWorkspaceRetentionEvidence(row, receiptLedger);
  return verification.verified
    ? Object.freeze({ ...record, retentionEvidence: verification })
    : Object.freeze({ ...record, retentionState: 'protected', retentionReason: 'restore_qualification_invalid', retentionEvidence: verification });
}

export function createWorkspaceRegistry({ store: suppliedStore, clock, receiptLedger = null } = {}) {
  if (!suppliedStore || !clock) throw new Error('Workspace registry requires StorePort and ClockPort');
  const store = failClosedStoreQueries(suppliedStore);
  const query = (sql) => store.query(sql);
  return Object.freeze({
    version: 1,
    kind: 'SqliteCampaignWorkspaceRegistry',
    register({ workspaceId = null, campaignId, nodeId = null, parentWorkspaceId = null, sourcePath, workspacePath, sourceHash = null, manifestHash = null } = {}) {
      if (!campaignId || !sourcePath || !workspacePath) throw new Error('campaignId, sourcePath and workspacePath are required');
      const id = workspaceId || `workspace:${crypto.randomUUID()}`;
      const now = clock.nowIso();
      const write = store.execute(`INSERT INTO campaign_workspaces(workspace_id,campaign_id,node_id,parent_workspace_id,source_path,workspace_path,source_sha256,workspace_manifest_sha256,status,retention_state,retention_reason,created_at,updated_at) VALUES(${sqlText(id)},${sqlText(campaignId)},${nodeId ? sqlText(nodeId) : 'NULL'},${parentWorkspaceId ? sqlText(parentWorkspaceId) : 'NULL'},${sqlText(sourcePath)},${sqlText(workspacePath)},${sourceHash ? sqlText(sourceHash) : 'NULL'},${manifestHash ? sqlText(manifestHash) : 'NULL'},'created','protected','active_or_unresolved_lineage',${sqlText(now)},${sqlText(now)}) ON CONFLICT(workspace_path) DO UPDATE SET node_id=excluded.node_id,workspace_manifest_sha256=excluded.workspace_manifest_sha256,updated_at=excluded.updated_at;`);
      if (!write.ok) throw new Error(write.error || 'workspace_registry_register_failed');
      return parse(query(`SELECT * FROM campaign_workspaces WHERE workspace_path=${sqlText(workspacePath)} LIMIT 1;`).rows[0]);
    },
    transition(workspaceId, { status, failureClass = null, retentionState = null, retentionReason = null, manifestHash = null, exportReceiptHash = null } = {}) {
      const existing = query(`SELECT * FROM campaign_workspaces WHERE workspace_id=${sqlText(workspaceId)} LIMIT 1;`).rows[0];
      if (!existing) throw new Error(`workspace registry entry not found: ${workspaceId}`);
      const nextStatus = status || existing.status;
      let nextRetention = retentionState || existing.retention_state;
      let nextReason = retentionReason || existing.retention_reason;
      if (nextRetention === 'eligible' && nextStatus !== 'removed') {
        throw new Error('retention eligibility requires verified restore qualification');
      }
      if (['failed', 'conflict', 'orphaned'].includes(nextStatus)) {
        nextRetention = 'protected';
        nextReason = retentionReason || 'failure_or_unresolved_lineage';
      }
      const now = clock.nowIso();
      const write = store.execute(`UPDATE campaign_workspaces SET status=${sqlText(nextStatus)},failure_class=${failureClass ? sqlText(failureClass) : 'failure_class'},retention_state=${sqlText(nextRetention)},retention_reason=${sqlText(nextReason)},workspace_manifest_sha256=${manifestHash ? sqlText(manifestHash) : 'workspace_manifest_sha256'},export_receipt_sha256=${exportReceiptHash ? sqlText(exportReceiptHash) : 'export_receipt_sha256'},exported_at=${exportReceiptHash ? sqlText(now) : 'exported_at'},updated_at=${sqlText(now)} WHERE workspace_id=${sqlText(workspaceId)};`);
      if (!write.ok) throw new Error(write.error || 'workspace_registry_transition_failed');
      return parse(query(`SELECT * FROM campaign_workspaces WHERE workspace_id=${sqlText(workspaceId)} LIMIT 1;`).rows[0]);
    },
    recordSnapshot(workspaceId, { manifestHash, manifestPath = null, archivePath = null, archiveHash = null, externalContentHash = null, bytes = 0, status = 'recorded', exportReceiptHash = null } = {}) {
      if (!manifestHash) throw new Error('workspace snapshot manifestHash is required');
      const createdAt = clock.nowIso();
      const payload = { version: 1, kind: 'WorkspaceSnapshot', workspaceId, manifestHash, archivePath, archiveHash, bytes: Number(bytes || 0), status, createdAt };
      const snapshotHash = hashRecord('WorkspaceSnapshot', payload);
      const snapshotId = `snapshot:${snapshotHash.replace(/^sha256:/, '')}`;
      const write = store.execute(`INSERT OR IGNORE INTO workspace_snapshots(snapshot_id,workspace_id,manifest_sha256,manifest_path,archive_path,archive_sha256,external_content_sha256,bytes,status,created_at,export_receipt_sha256) VALUES(${sqlText(snapshotId)},${sqlText(workspaceId)},${sqlText(manifestHash)},${manifestPath ? sqlText(manifestPath) : 'NULL'},${archivePath ? sqlText(archivePath) : 'NULL'},${archiveHash ? sqlText(archiveHash) : 'NULL'},${externalContentHash ? sqlText(externalContentHash) : 'NULL'},${Math.max(0, Number(bytes || 0))},${sqlText(status)},${sqlText(createdAt)},${exportReceiptHash ? sqlText(exportReceiptHash) : 'NULL'});`);
      if (!write.ok) throw new Error(write.error || 'workspace_snapshot_record_failed');
      return Object.freeze({ ...payload, snapshotId, workspaceSnapshotHash: snapshotHash });
    },
    qualifyForRetention(workspaceId, { manifestHash, archiveHash, restoreReceipt = null, restoreLedgerReceiptId = null } = {}) {
      const { restoreReceiptHash = null, ...restorePayload } = restoreReceipt || {};
      const receiptVerified = restoreReceipt?.version === 1
        && restoreReceipt?.kind === 'WorkspaceSnapshotRestoreReceipt'
        && restoreReceipt.status === 'workspace_snapshot_restore_verified'
        && restoreReceipt.workspaceId === workspaceId
        && restoreReceipt.manifestHash === manifestHash
        && restoreReceipt.archiveHash === archiveHash
        && typeof restoreReceipt.verifiedAt === 'string'
        && Number.isFinite(Date.parse(restoreReceipt.verifiedAt))
        && Array.isArray(restoreReceipt.blockers)
        && restoreReceipt.blockers.length === 0
        && hashRecord('WorkspaceSnapshotRestoreReceipt', restorePayload) === restoreReceiptHash;
      const latest = query(`SELECT workspace.workspace_path,workspace.export_receipt_sha256 AS workspace_export_receipt_sha256,snapshot.* FROM campaign_workspaces workspace JOIN workspace_snapshots snapshot ON snapshot.snapshot_id=(SELECT candidate.snapshot_id FROM workspace_snapshots candidate WHERE candidate.workspace_id=workspace.workspace_id ORDER BY candidate.created_at DESC,candidate.snapshot_id DESC LIMIT 1) WHERE workspace.workspace_id=${sqlText(workspaceId)} LIMIT 1;`).rows[0] || null;
      const evidence = verifyWorkspaceRetentionEvidence({
        ...latest,
        workspace_id: workspaceId,
        export_receipt_sha256: latest?.workspace_export_receipt_sha256 || latest?.export_receipt_sha256 || null,
        restore_receipt_sha256: restoreReceiptHash,
        restore_receipt_json: restoreReceipt ? JSON.stringify(restoreReceipt) : null,
        restore_ledger_receipt_id: restoreLedgerReceiptId,
      }, receiptLedger);
      if (!workspaceId || !manifestHash || !archiveHash || !receiptVerified || !evidence.verified) {
        throw new Error('workspace retention qualification requires a verified hash-bound restore receipt');
      }
      const now = restoreReceipt.verifiedAt;
      const guard = 'workspace_retention_qualification_guard';
      const latestSnapshot = `(SELECT candidate.snapshot_id FROM workspace_snapshots candidate WHERE candidate.workspace_id=${sqlText(workspaceId)} ORDER BY candidate.created_at DESC,candidate.snapshot_id DESC LIMIT 1)`;
      const write = store.execute(`BEGIN IMMEDIATE;
CREATE TEMP TABLE IF NOT EXISTS ${guard}(matched INTEGER NOT NULL CHECK(matched=1));
DELETE FROM ${guard};
INSERT INTO ${guard}(matched)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM campaign_workspaces workspace
  JOIN workspace_snapshots snapshot ON snapshot.snapshot_id=${latestSnapshot}
  WHERE workspace.workspace_id=${sqlText(workspaceId)}
    AND workspace.status='exported'
    AND workspace.retention_state IN ('protected','eligible')
    AND workspace.export_receipt_sha256 IS NOT NULL
    AND snapshot.manifest_sha256=${sqlText(manifestHash)}
    AND snapshot.archive_sha256=${sqlText(archiveHash)}
    AND snapshot.export_receipt_sha256=workspace.export_receipt_sha256
    AND snapshot.status IN ('exported_unverified','restore_verified')
    AND (snapshot.restore_receipt_sha256 IS NULL OR (snapshot.restore_receipt_sha256=${sqlText(restoreReceiptHash)} AND snapshot.restore_ledger_receipt_id=${sqlText(restoreLedgerReceiptId)}))
) THEN 1 ELSE 0 END;
DELETE FROM ${guard};
UPDATE workspace_snapshots
SET restore_receipt_sha256=${sqlText(restoreReceiptHash)},restore_receipt_json=${sqlJson(restoreReceipt)},restore_ledger_receipt_id=${sqlText(restoreLedgerReceiptId)},restore_verified_at=${sqlText(now)},retention_qualified_at=${sqlText(now)},status='restore_verified'
WHERE snapshot_id=${latestSnapshot} AND workspace_id=${sqlText(workspaceId)} AND manifest_sha256=${sqlText(manifestHash)} AND archive_sha256=${sqlText(archiveHash)}
  AND status IN ('exported_unverified','restore_verified')
  AND (restore_receipt_sha256 IS NULL OR (restore_receipt_sha256=${sqlText(restoreReceiptHash)} AND restore_ledger_receipt_id=${sqlText(restoreLedgerReceiptId)}));
INSERT INTO ${guard}(matched) VALUES(changes());
DELETE FROM ${guard};
UPDATE campaign_workspaces
SET status='exported',retention_state='eligible',retention_reason='snapshot_restore_verified',updated_at=${sqlText(now)}
WHERE workspace_id=${sqlText(workspaceId)} AND status='exported' AND retention_state IN ('protected','eligible') AND export_receipt_sha256 IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM workspace_snapshots snapshot
    WHERE snapshot.snapshot_id=${latestSnapshot}
      AND snapshot.workspace_id=campaign_workspaces.workspace_id
      AND snapshot.manifest_sha256=${sqlText(manifestHash)}
      AND snapshot.archive_sha256=${sqlText(archiveHash)}
      AND snapshot.export_receipt_sha256=campaign_workspaces.export_receipt_sha256
      AND snapshot.restore_receipt_sha256=${sqlText(restoreReceiptHash)}
      AND snapshot.restore_ledger_receipt_id=${sqlText(restoreLedgerReceiptId)}
      AND snapshot.retention_qualified_at=${sqlText(now)}
  );
INSERT INTO ${guard}(matched) VALUES(changes());
COMMIT;`);
      if (!write.ok) throw new Error(write.error || 'workspace_retention_qualification_failed');
      const qualified = query(`SELECT workspace.*,snapshot.manifest_path,snapshot.archive_path,snapshot.archive_sha256,snapshot.external_content_sha256,snapshot.restore_receipt_sha256,snapshot.restore_receipt_json,snapshot.restore_ledger_receipt_id,snapshot.restore_verified_at,snapshot.retention_qualified_at FROM campaign_workspaces workspace JOIN workspace_snapshots snapshot ON snapshot.snapshot_id=${latestSnapshot} WHERE workspace.workspace_id=${sqlText(workspaceId)} AND snapshot.manifest_sha256=${sqlText(manifestHash)} AND snapshot.archive_sha256=${sqlText(archiveHash)} LIMIT 1;`).rows[0] || null;
      if (!qualified || qualified.retention_state !== 'eligible' || qualified.restore_receipt_sha256 !== restoreReceiptHash || qualified.restore_ledger_receipt_id !== restoreLedgerReceiptId) {
        throw new Error('workspace_retention_qualification_precondition_failed');
      }
      return parse(qualified);
    },
    list({ campaignId = null } = {}) {
      const where = campaignId ? ` WHERE campaign_id=${sqlText(campaignId)}` : '';
      return query(`SELECT * FROM campaign_workspaces${where} ORDER BY created_at,workspace_id;`).rows.map(parse);
    },
    retentionRecords() {
      const result = query(`SELECT workspace.workspace_id,workspace.campaign_id,workspace.node_id,workspace.workspace_path,workspace.status,workspace.retention_state,workspace.retention_reason,workspace.export_receipt_sha256,snapshot.manifest_sha256,snapshot.manifest_path,snapshot.archive_path,snapshot.archive_sha256,snapshot.external_content_sha256,snapshot.restore_receipt_sha256,snapshot.restore_receipt_json,snapshot.restore_ledger_receipt_id,snapshot.restore_verified_at,snapshot.retention_qualified_at
FROM campaign_workspaces workspace
LEFT JOIN workspace_snapshots snapshot ON snapshot.snapshot_id=(SELECT candidate.snapshot_id FROM workspace_snapshots candidate WHERE candidate.workspace_id=workspace.workspace_id ORDER BY candidate.created_at DESC,candidate.snapshot_id DESC LIMIT 1)
ORDER BY workspace.workspace_path;`);
      return result.rows.map((row) => parseRetention(row, receiptLedger));
    },
    reconcileMissingEligible() {
      // Read the persisted authority directly here. retentionRecords() quite
      // deliberately downgrades a missing live workspace to protected; after
      // a trusted retention deletion this method is the operation that records
      // that expected absence as `removed`.
      const result = query("SELECT * FROM campaign_workspaces WHERE retention_state='eligible' AND status<>'removed' ORDER BY workspace_path;");
      const missing = result.rows.map(parse).filter((record) => !fs.existsSync(record.workspacePath));
      return missing.map((record) => this.transition(record.workspaceId, {
        status: 'removed',
        retentionState: 'eligible',
        retentionReason: 'retention_applied_after_verified_export',
      }));
    },
  });
}
