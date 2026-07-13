import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fileHash(candidate) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(candidate, 'r');
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

export function exportWorkspaceSnapshot({ registry, workspaceId, workspacePath, exportRoot, externalContentBindings = {} } = {}) {
  if (!registry || !workspaceId || !workspacePath || !exportRoot) throw new Error('registry, workspaceId, workspacePath and exportRoot are required');
  const source = path.resolve(workspacePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('workspace snapshot source directory missing');
  const entries = manifestFor(source).map((entry) => {
    const externalPath = externalContentBindings[entry.path] ? path.resolve(externalContentBindings[entry.path]) : null;
    if (!externalPath) return entry;
    if (!fs.existsSync(externalPath) || !fs.statSync(externalPath).isFile()) throw new Error(`workspace_snapshot_external_content_missing:${entry.path}`);
    if (fs.statSync(externalPath).size !== entry.bytes || fileHash(externalPath) !== entry.hash) throw new Error(`workspace_snapshot_external_content_mismatch:${entry.path}`);
    return { ...entry, externalContent: { path: externalPath, hash: entry.hash, bytes: entry.bytes } };
  });
  const manifestPayload = { version: 1, kind: 'WorkspaceExportManifest', workspaceId, entries };
  const manifestHash = hashRecord('WorkspaceExportManifest', manifestPayload);
  const destination = path.resolve(exportRoot);
  fs.mkdirSync(destination, { recursive: true });
  const stem = manifestHash.replace(/^sha256:/, '');
  const archivePath = path.join(destination, `${stem}.tar.gz`);
  const manifestPath = path.join(destination, `${stem}.manifest.json`);
  const temporary = `${archivePath}.tmp-${process.pid}`;
  const excludes = entries.filter((entry) => entry.externalContent).flatMap((entry) => ['--exclude', `./${entry.path}`]);
  const archive = spawnSync('tar', ['-czf', temporary, '-C', source, ...excludes, '--', '.'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
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
  for (const entry of receipt.entries.filter((item) => item.externalContent)) {
    const external = entry.externalContent;
    if (!fs.existsSync(external.path) || fs.statSync(external.path).size !== external.bytes || fileHash(external.path) !== external.hash) {
      throw new Error(`workspace_snapshot_external_content_restore_blocked:${entry.path}`);
    }
    const target = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(external.path, target, fs.constants.COPYFILE_FICLONE);
  }
  const restored = manifestFor(destination);
  const expected = JSON.stringify(receipt.entries.map(({ externalContent: _externalContent, ...entry }) => entry));
  const actual = JSON.stringify(restored);
  const blockers = expected === actual ? [] : ['workspace_snapshot_restore_manifest_mismatch'];
  const payload = { version: 1, kind: 'WorkspaceSnapshotRestoreReceipt', status: blockers.length ? 'workspace_snapshot_restore_blocked' : 'workspace_snapshot_restore_verified', manifestHash: receipt.manifestHash, archiveHash: receipt.archiveHash, restoredEntryCount: restored.length, blockers };
  return Object.freeze({ ...payload, restoreReceiptHash: hashRecord('WorkspaceSnapshotRestoreReceipt', payload) });
}
