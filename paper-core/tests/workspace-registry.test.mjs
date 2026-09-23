import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import { exportWorkspaceSnapshot, restoreWorkspaceSnapshot } from '../../paper-adapters/automation/workspace-snapshot-exporter.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueWorkspaceSnapshotVerifierWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture(t, prefix, ids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 0, ids.day, 0, 0, tick++)), nowIso() { return this.now().toISOString(); } };
  store.execute(`INSERT INTO papers(slug,title,canonical_dir,source_dir) VALUES('${ids.paper}','Paper','.','.');`);
  createSqliteCampaignStore({ store, clock }).createCampaign({ campaignId: ids.campaign, paperId: ids.paper, maxRounds: 1, nodes: [{ nodeId: ids.node, kind: 'draft', dependencies: [] }] });
  const restoreReceiptLedger = createSqliteReceiptLedger({ store, clock, issuerCapability: issueWorkspaceSnapshotVerifierWriter() });
  const registry = createWorkspaceRegistry({ store, clock, receiptLedger: restoreReceiptLedger });
  const workspacePath = path.join(root, 'automation-workspaces', ids.workspace);
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'main.tex'), 'fixture\n');
  const entry = registry.register({ workspaceId: ids.workspace, campaignId: ids.campaign, nodeId: ids.node, sourcePath: '/source', workspacePath, manifestHash: 'sha256:initial' });
  return { root, store, clock, registry, restoreReceiptLedger, workspacePath, entry };
}

test('workspace registry requires effective trusted restore evidence and fails closed after evidence corruption', (t) => {
  const f = fixture(t, 'hepta-workspace-registry-', { day: 1, paper: 'paper', campaign: 'campaign', node: 'node', workspace: 'workspace-1' });
  assert.equal(f.entry.retentionState, 'protected');
  const failed = f.registry.transition(f.entry.workspaceId, { status: 'failed', failureClass: 'merge_conflict' });
  assert.equal(failed.retentionState, 'protected');
  assert.throws(() => f.registry.transition(f.entry.workspaceId, { status: 'merged', retentionState: 'eligible' }), /verified restore qualification/);
  const exported = exportWorkspaceSnapshot({ registry: f.registry, workspaceId: f.entry.workspaceId, workspacePath: f.workspacePath, exportRoot: path.join(f.root, 'exports') });
  assert.equal(f.registry.retentionRecords()[0].retentionState, 'protected');

  const forgedPayload = {
    version: 1,
    kind: 'WorkspaceSnapshotRestoreReceipt',
    status: 'workspace_snapshot_restore_verified',
    workspaceId: f.entry.workspaceId,
    manifestHash: exported.manifestHash,
    archivePath: exported.archivePath,
    archiveHash: exported.archiveHash,
    exportReceiptHash: exported.exportReceiptHash,
    externalContentHash: exported.externalContentHash,
    restoredManifestHash: 'sha256:forged',
    restoredEntryCount: 1,
    verifiedAt: '2026-01-01T00:00:10.000Z',
    blockers: [],
  };
  const forged = { ...forgedPayload, restoreReceiptHash: hashRecord('WorkspaceSnapshotRestoreReceipt', forgedPayload) };
  assert.throws(() => f.registry.qualifyForRetention(f.entry.workspaceId, {
    manifestHash: exported.manifestHash,
    archiveHash: exported.archiveHash,
    restoreReceipt: forged,
    restoreLedgerReceiptId: `workspace-snapshot-restore:${forged.restoreReceiptHash}`,
  }), /verified hash-bound restore receipt/);

  const restored = restoreWorkspaceSnapshot({
    receipt: exported,
    restoreRoot: path.join(f.root, 'restored'),
    registry: f.registry,
    restoreReceiptLedger: f.restoreReceiptLedger,
    workspaceId: f.entry.workspaceId,
    verifiedAt: '2026-01-01T00:00:11.000Z',
  });
  const qualified = f.registry.retentionRecords()[0];
  assert.equal(qualified.retentionState, 'eligible');
  assert.equal(qualified.restoreReceiptHash, restored.restoreReceiptHash);
  assert.equal(qualified.restoreLedgerReceiptId, `workspace-snapshot-restore:${restored.restoreReceiptHash}`);
  f.store.execute("UPDATE workspace_snapshots SET restore_receipt_json='{}' WHERE workspace_id='workspace-1';");
  const corrupted = f.registry.retentionRecords()[0];
  assert.equal(corrupted.retentionState, 'protected');
  assert.equal(corrupted.retentionReason, 'restore_qualification_invalid');
});

test('workspace retention qualification guards every precondition, rolls back a failed second step, and is idempotent', (t) => {
  const f = fixture(t, 'hepta-workspace-qualification-atomic-', { day: 2, paper: 'paper-atomic', campaign: 'campaign-atomic', node: 'node-atomic', workspace: 'workspace-atomic' });
  const exported = exportWorkspaceSnapshot({ registry: f.registry, workspaceId: f.entry.workspaceId, workspacePath: f.workspacePath, exportRoot: path.join(f.root, 'exports') });
  const restoreReceipt = restoreWorkspaceSnapshot({
    receipt: exported,
    restoreRoot: path.join(f.root, 'restore-check'),
    restoreReceiptLedger: f.restoreReceiptLedger,
    workspaceId: f.entry.workspaceId,
    verifiedAt: '2026-01-02T00:00:10.000Z',
  });
  const restoreLedgerReceiptId = `workspace-snapshot-restore:${restoreReceipt.restoreReceiptHash}`;
  const qualify = () => f.registry.qualifyForRetention(f.entry.workspaceId, {
    manifestHash: exported.manifestHash,
    archiveHash: exported.archiveHash,
    restoreReceipt,
    restoreLedgerReceiptId,
  });
  const snapshot = () => f.store.query("SELECT status,restore_receipt_sha256,restore_ledger_receipt_id,retention_qualified_at FROM workspace_snapshots WHERE workspace_id='workspace-atomic';").rows[0];
  const assertSnapshotUnqualified = (status = 'exported_unverified') => assert.deepEqual(snapshot(), { status, restore_receipt_sha256: null, restore_ledger_receipt_id: null, retention_qualified_at: null });

  for (const [breakSql, repairSql, snapshotStatus] of [
    ["UPDATE campaign_workspaces SET status='created' WHERE workspace_id='workspace-atomic';", "UPDATE campaign_workspaces SET status='exported' WHERE workspace_id='workspace-atomic';", 'exported_unverified'],
    ["UPDATE workspace_snapshots SET status='recorded' WHERE workspace_id='workspace-atomic';", "UPDATE workspace_snapshots SET status='exported_unverified' WHERE workspace_id='workspace-atomic';", 'recorded'],
    ["UPDATE campaign_workspaces SET export_receipt_sha256='sha256:mismatch' WHERE workspace_id='workspace-atomic';", `UPDATE campaign_workspaces SET export_receipt_sha256='${exported.exportReceiptHash}' WHERE workspace_id='workspace-atomic';`, 'exported_unverified'],
  ]) {
    assert.equal(f.store.execute(breakSql).ok, true);
    assert.throws(qualify, /CHECK constraint|qualification_failed|verified hash-bound/);
    assertSnapshotUnqualified(snapshotStatus);
    assert.equal(f.store.execute(repairSql).ok, true);
  }

  assert.equal(f.store.execute("CREATE TRIGGER inject_workspace_qualification_failure BEFORE UPDATE OF retention_state ON campaign_workspaces WHEN NEW.workspace_id='workspace-atomic' AND NEW.retention_state='eligible' BEGIN SELECT RAISE(IGNORE); END;").ok, true);
  assert.throws(qualify, /CHECK constraint|qualification_failed/);
  assertSnapshotUnqualified();
  assert.equal(f.store.query("SELECT retention_state FROM campaign_workspaces WHERE workspace_id='workspace-atomic';").rows[0].retention_state, 'protected');
  assert.equal(f.store.execute('DROP TRIGGER inject_workspace_qualification_failure;').ok, true);

  assert.equal(qualify().retentionState, 'eligible');
  assert.equal(qualify().retentionState, 'eligible');
  assert.equal(f.store.query("SELECT count(*) AS count FROM workspace_snapshots WHERE workspace_id='workspace-atomic' AND restore_receipt_sha256 IS NOT NULL AND restore_ledger_receipt_id IS NOT NULL;").rows[0].count, 1);
});
