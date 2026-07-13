import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { exportWorkspaceSnapshot, restoreWorkspaceSnapshot } from './workspace-snapshot-exporter.mjs';

function safeKey(value) { return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_'); }
function fileHash(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally { fs.closeSync(descriptor); }
  return `sha256:${hash.digest('hex')}`;
}
function manifest(root) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const relative = path.relative(root, candidate).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`workspace_backfill_symlink_forbidden:${relative}`);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) entries.push({ path: relative, bytes: fs.statSync(candidate).size, hash: fileHash(candidate) });
    }
  };
  walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function buildWorkspaceLineageBackfillPlan({ store, runtimeRoot, assetRoot } = {}) {
  if (!store || !runtimeRoot || !assetRoot) throw new Error('Workspace lineage backfill requires store, runtimeRoot and assetRoot');
  const workspaceRoot = path.join(path.resolve(runtimeRoot), 'automation-workspaces');
  const nodes = store.query(`SELECT n.node_id,n.campaign_id,n.status AS node_status,c.status AS campaign_status,c.paper_id,p.canonical_dir
    FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
    LEFT JOIN papers p ON p.slug=c.paper_id ORDER BY n.campaign_id,n.node_id;`).rows;
  const entries = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const workspacePath = path.join(workspaceRoot, entry.name);
    const matches = nodes.filter((node) => entry.name.startsWith(`${safeKey(node.campaign_id)}-${safeKey(node.node_id)}-`));
    if (matches.length !== 1) return { workspacePath, workspaceName: entry.name, status: 'workspace_lineage_ambiguous', matchCount: matches.length };
    const node = matches[0];
    const sourcePath = node.canonical_dir ? path.join(path.resolve(assetRoot), node.canonical_dir) : null;
    const files = manifest(workspacePath);
    const manifestPayload = { version: 1, kind: 'WorkspaceBackfillManifest', entries: files };
    const externalContentBindings = {};
    for (const file of files.filter((item) => item.bytes >= 64 * 1024 * 1024)) {
      const sourceCandidate = sourcePath ? path.join(sourcePath, file.path) : null;
      if (sourceCandidate && fs.existsSync(sourceCandidate) && fs.statSync(sourceCandidate).isFile()
        && fs.statSync(sourceCandidate).size === file.bytes && fileHash(sourceCandidate) === file.hash) {
        externalContentBindings[file.path] = sourceCandidate;
      }
    }
    const completed = node.node_status === 'completed';
    return {
      workspaceId: `workspace:${entry.name}`,
      workspacePath,
      workspaceName: entry.name,
      sourcePath,
      campaignId: node.campaign_id,
      nodeId: node.node_id,
      nodeStatus: node.node_status,
      campaignStatus: node.campaign_status,
      status: completed ? 'workspace_lineage_completed_export_required' : 'workspace_lineage_active_or_unresolved',
      manifestHash: hashRecord('WorkspaceBackfillManifest', manifestPayload),
      fileCount: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      externalContentBindings,
      externalContentBytes: files.filter((file) => externalContentBindings[file.path]).reduce((total, file) => total + file.bytes, 0),
      exportEligible: completed,
    };
  }) : [];
  const payload = { version: 1, kind: 'WorkspaceLineageBackfillPlan', workspaceRoot, entries };
  return Object.freeze({ ...payload, status: entries.every((entry) => entry.matchCount === undefined) ? 'workspace_lineage_backfill_ready' : 'workspace_lineage_backfill_blocked', workspaceLineageBackfillPlanHash: hashRecord('WorkspaceLineageBackfillPlan', payload) });
}

export function executeWorkspaceLineageBackfill({ plan, registry, exportRoot, restoreRoot } = {}) {
  if (plan?.status !== 'workspace_lineage_backfill_ready' || !registry || !exportRoot || !restoreRoot) throw new Error('Workspace lineage backfill execution prerequisites missing');
  const results = [];
  for (const entry of plan.entries) {
    const registered = registry.register({ workspaceId: entry.workspaceId, campaignId: entry.campaignId, nodeId: entry.nodeId, sourcePath: entry.sourcePath, workspacePath: entry.workspacePath, manifestHash: entry.manifestHash });
    if (!entry.exportEligible) {
      registry.transition(registered.workspaceId, { status: 'created', retentionState: 'protected', retentionReason: 'active_or_reconciled_node_workspace' });
      results.push({ workspaceId: registered.workspaceId, status: 'workspace_backfilled_protected', bytes: entry.bytes });
      continue;
    }
    registry.transition(registered.workspaceId, { status: 'merged', retentionState: 'protected', retentionReason: 'completed_node_pending_snapshot' });
    const snapshot = exportWorkspaceSnapshot({ registry, workspaceId: registered.workspaceId, workspacePath: entry.workspacePath, exportRoot, externalContentBindings: entry.externalContentBindings });
    const restore = restoreWorkspaceSnapshot({ receipt: snapshot, restoreRoot: path.join(restoreRoot, safeKey(registered.workspaceId)) });
    if (restore.status !== 'workspace_snapshot_restore_verified') throw new Error(`workspace snapshot restore blocked:${registered.workspaceId}`);
    fs.rmSync(path.join(restoreRoot, safeKey(registered.workspaceId)), { recursive: true, force: true });
    results.push({ workspaceId: registered.workspaceId, status: 'workspace_backfilled_exported_and_restore_verified', bytes: entry.bytes, externalContentBytes: entry.externalContentBytes, archiveBytes: snapshot.bytes, manifestHash: snapshot.manifestHash, archiveHash: snapshot.archiveHash, exportReceiptHash: snapshot.exportReceiptHash, restoreReceiptHash: restore.restoreReceiptHash });
  }
  const payload = { version: 1, kind: 'WorkspaceLineageBackfillReceipt', status: 'workspace_lineage_backfill_completed', planHash: plan.workspaceLineageBackfillPlanHash, workspaceCount: results.length, exportedCount: results.filter((item) => item.status.includes('exported')).length, protectedCount: results.filter((item) => item.status.includes('protected')).length, results, completedAt: new Date().toISOString(), externalActionPerformed: false };
  return Object.freeze({ ...payload, workspaceLineageBackfillReceiptHash: hashRecord('WorkspaceLineageBackfillReceipt', payload) });
}
