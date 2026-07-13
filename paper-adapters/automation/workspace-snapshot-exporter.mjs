import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fileHash(candidate) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`; }
function safeRelative(value) { return Boolean(value && !path.isAbsolute(value) && !String(value).replace(/\\/g, '/').split('/').some((part) => part === '..' || !part)); }

function manifestFor(root) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const relative = path.relative(root, candidate).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`workspace_snapshot_symlink_forbidden:${relative}`);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) entries.push({ path: relative, hash: fileHash(candidate), bytes: fs.statSync(candidate).size });
      else throw new Error(`workspace_snapshot_special_file_forbidden:${relative}`);
    }
  };
  walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function exportWorkspaceSnapshot({ registry, workspaceId, workspacePath, exportRoot } = {}) {
  if (!registry || !workspaceId || !workspacePath || !exportRoot) throw new Error('registry, workspaceId, workspacePath and exportRoot are required');
  const source = path.resolve(workspacePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('workspace snapshot source directory missing');
  const entries = manifestFor(source);
  const manifestPayload = { version: 1, kind: 'WorkspaceExportManifest', workspaceId, entries };
  const manifestHash = hashRecord('WorkspaceExportManifest', manifestPayload);
  const destination = path.resolve(exportRoot);
  fs.mkdirSync(destination, { recursive: true });
  const stem = manifestHash.replace(/^sha256:/, '');
  const archivePath = path.join(destination, `${stem}.tar.gz`);
  const manifestPath = path.join(destination, `${stem}.manifest.json`);
  const temporary = `${archivePath}.tmp-${process.pid}`;
  const archive = spawnSync('tar', ['-czf', temporary, '-C', source, '--', '.'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(archive.stderr || 'workspace_snapshot_archive_failed');
  fs.renameSync(temporary, archivePath);
  const archiveHash = fileHash(archivePath);
  const receiptPayload = { ...manifestPayload, manifestHash, archivePath, archiveHash, bytes: fs.statSync(archivePath).size, status: 'workspace_snapshot_exported', externalActionPerformed: false };
  const exportReceiptHash = hashRecord('WorkspaceSnapshotExportReceipt', receiptPayload);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...receiptPayload, exportReceiptHash }, null, 2)}\n`, { mode: 0o444 });
  registry.recordSnapshot(workspaceId, { manifestHash, archivePath, archiveHash, bytes: receiptPayload.bytes, status: 'exported' });
  registry.transition(workspaceId, { status: 'exported', retentionState: 'eligible', retentionReason: 'diagnostic_snapshot_exported', exportReceiptHash });
  return Object.freeze({ ...receiptPayload, manifestPath, exportReceiptHash });
}

export function restoreWorkspaceSnapshot({ receipt, restoreRoot } = {}) {
  if (!receipt?.archivePath || !receipt?.archiveHash || !receipt?.entries) throw new Error('workspace snapshot receipt is incomplete');
  if (fileHash(receipt.archivePath) !== receipt.archiveHash) throw new Error('workspace snapshot archive hash mismatch');
  const listing = spawnSync('tar', ['-tzf', receipt.archivePath], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(listing.stderr || 'workspace_snapshot_listing_failed');
  const unsafe = String(listing.stdout || '').split(/\r?\n/).filter(Boolean).map((item) => item.replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean).find((item) => !safeRelative(item));
  if (unsafe) throw new Error(`workspace_snapshot_archive_path_unsafe:${unsafe}`);
  const destination = path.resolve(restoreRoot);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const extract = spawnSync('tar', ['-xzf', receipt.archivePath, '-C', destination, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (extract.status !== 0) throw new Error(extract.stderr || 'workspace_snapshot_restore_failed');
  const restored = manifestFor(destination);
  const expected = JSON.stringify(receipt.entries);
  const actual = JSON.stringify(restored);
  const blockers = expected === actual ? [] : ['workspace_snapshot_restore_manifest_mismatch'];
  const payload = { version: 1, kind: 'WorkspaceSnapshotRestoreReceipt', status: blockers.length ? 'workspace_snapshot_restore_blocked' : 'workspace_snapshot_restore_verified', manifestHash: receipt.manifestHash, archiveHash: receipt.archiveHash, restoredEntryCount: restored.length, blockers };
  return Object.freeze({ ...payload, restoreReceiptHash: hashRecord('WorkspaceSnapshotRestoreReceipt', payload) });
}
