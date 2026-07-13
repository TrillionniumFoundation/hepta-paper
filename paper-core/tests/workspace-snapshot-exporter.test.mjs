import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportWorkspaceSnapshot, restoreWorkspaceSnapshot } from '../../paper-adapters/automation/workspace-snapshot-exporter.mjs';

test('workspace snapshot export is hash-bound and restore-verifiable before GC eligibility', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'fixture\n');
  fs.writeFileSync(path.join(workspace, 'sub', 'result.json'), '{"value":1}\n');
  const calls = [];
  const registry = { recordSnapshot(...args) { calls.push(['snapshot', ...args]); }, transition(...args) { calls.push(['transition', ...args]); } };
  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'workspace-1', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  assert.equal(receipt.status, 'workspace_snapshot_exported');
  assert.equal(calls[1][2].retentionState, 'eligible');
  const restored = restoreWorkspaceSnapshot({ receipt, restoreRoot: path.join(root, 'restored') });
  assert.equal(restored.status, 'workspace_snapshot_restore_verified');
  fs.appendFileSync(receipt.archivePath, 'corruption');
  assert.throws(() => restoreWorkspaceSnapshot({ receipt, restoreRoot: path.join(root, 'corrupt') }), /hash mismatch/);
});

test('snapshot can bind duplicate large content externally and restore it by verified hash', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-external-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const authority = path.join(root, 'authority');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'fixture\n');
  fs.writeFileSync(path.join(workspace, 'dataset.bin'), Buffer.alloc(1024 * 1024, 7));
  fs.copyFileSync(path.join(workspace, 'dataset.bin'), path.join(authority, 'dataset.bin'));
  const registry = { recordSnapshot() {}, transition() {} };
  const receipt = exportWorkspaceSnapshot({
    registry,
    workspaceId: 'workspace-external',
    workspacePath: workspace,
    exportRoot: path.join(root, 'exports'),
    externalContentBindings: { 'dataset.bin': path.join(authority, 'dataset.bin') },
  });
  assert.ok(receipt.entries.find((entry) => entry.path === 'dataset.bin').externalContent);
  assert.ok(receipt.bytes < 100_000);
  const restored = restoreWorkspaceSnapshot({ receipt, restoreRoot: path.join(root, 'restored') });
  assert.equal(restored.status, 'workspace_snapshot_restore_verified');
  fs.writeFileSync(path.join(authority, 'dataset.bin'), 'changed');
  assert.throws(() => restoreWorkspaceSnapshot({ receipt, restoreRoot: path.join(root, 'blocked') }), /external_content_restore_blocked/);
});
