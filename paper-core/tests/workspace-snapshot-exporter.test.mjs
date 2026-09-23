import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { exportWorkspaceSnapshot, restoreWorkspaceSnapshot } from '../../paper-adapters/automation/workspace-snapshot-exporter.mjs';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueWorkspaceSnapshotVerifierWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function trustedRestoreLedger(store, clock) {
  return createSqliteReceiptLedger({ store, clock, issuerCapability: issueWorkspaceSnapshotVerifierWriter() });
}

function sha256File(candidate) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(candidate));
  return `sha256:${hash.digest('hex')}`;
}

function rebindArchiveReceipt(receipt) {
  const rebound = {
    ...receipt,
    archiveHash: sha256File(receipt.archivePath),
    bytes: fs.statSync(receipt.archivePath).size,
  };
  const { exportReceiptHash: _oldHash, manifestPath: _manifestPath, ...payload } = rebound;
  rebound.exportReceiptHash = hashRecord('WorkspaceSnapshotExportReceipt', payload);
  fs.chmodSync(receipt.manifestPath, 0o600);
  fs.writeFileSync(receipt.manifestPath, `${JSON.stringify(rebound, null, 2)}\n`, { mode: 0o444 });
  fs.chmodSync(receipt.manifestPath, 0o444);
  return Object.freeze(rebound);
}

function snapshotTemporaryArtifacts(directory) {
  return fs.readdirSync(directory).filter((name) => name.startsWith('.workspace-snapshot-')
    || name.startsWith('.hepta-workspace-restore-')
    || name.includes('.tmp-'));
}

test('workspace snapshot archive excludes materialization recovery state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-recovery-exclusion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const recovery = path.join(workspace, '.hepta-materialization-recovery');
  fs.mkdirSync(recovery, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'fixture\n');
  fs.writeFileSync(path.join(recovery, 'completed-operation.tombstone'), 'internal recovery state\n');
  const nestedRecovery = path.join(workspace, 'sections', '.hepta-materialization-recovery');
  fs.mkdirSync(nestedRecovery, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'sections', 'body.tex'), 'body\n');
  fs.writeFileSync(path.join(nestedRecovery, 'nested-operation.tombstone'), 'nested recovery state\n');
  const registry = { recordSnapshot() {}, transition() {} };

  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'workspace-recovery-exclusion', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  assert.deepEqual(receipt.entries.map((entry) => entry.path), ['main.tex', 'sections/body.tex']);
  const restoreRoot = path.join(root, 'restored');
  const restored = restoreWorkspaceSnapshot({ receipt, restoreRoot });
  assert.equal(restored.status, 'workspace_snapshot_restore_verified');
  assert.equal(fs.existsSync(path.join(restoreRoot, '.hepta-materialization-recovery')), false);
  assert.equal(fs.existsSync(path.join(restoreRoot, 'sections', '.hepta-materialization-recovery')), false);
});

test('workspace snapshot export is hash-bound and restore-verifiable before GC eligibility', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'fixture\n');
  fs.writeFileSync(path.join(workspace, 'sub', 'result.json'), '{"value":1}\n');
  const calls = [];
  const registry = { recordSnapshot(...args) { calls.push(['snapshot', ...args]); }, transition(...args) { calls.push(['transition', ...args]); }, qualifyForRetention(...args) { calls.push(['qualify', ...args]); } };
  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'workspace-1', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  assert.equal(receipt.status, 'workspace_snapshot_exported');
  assert.equal(calls[0][2].status, 'exported_unverified');
  assert.equal(calls[1][2].retentionState, 'protected');
  assert.equal(calls[1][2].retentionReason, 'exported_unverified');
  const restoreReceiptLedger = { record(value) { return { receiptId: `workspace-snapshot-restore:${value.restoreReceiptHash}`, writerTrusted: true, issuerPolicyId: 'workspace-snapshot-verifier' }; } };
  const restored = restoreWorkspaceSnapshot({ receipt, restoreRoot: path.join(root, 'restored'), registry, restoreReceiptLedger, workspaceId: 'workspace-1', verifiedAt: '2026-07-14T00:00:00.000Z' });
  assert.equal(restored.status, 'workspace_snapshot_restore_verified');
  assert.equal(calls[2][0], 'qualify');
  assert.equal(calls[2][2].restoreReceipt.restoreReceiptHash, restored.restoreReceiptHash);
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

test('export-after-crash remains protected and only persisted restore verification qualifies GC', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-export-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'state.sqlite') });
  t.after(() => store.close());
  let tick = 0;
  const clock = { nowIso: () => new Date(Date.UTC(2026, 6, 14, 0, 0, tick++)).toISOString() };
  store.execute("INSERT INTO papers(slug,title,canonical_dir,status) VALUES('paper','Paper','paper','draft');");
  createSqliteCampaignStore({ store, clock }).createCampaign({ campaignId: 'campaign', paperId: 'paper', maxRounds: 1, nodes: [{ nodeId: 'node', kind: 'draft', dependencies: [] }] });
  const restoreReceiptLedger = trustedRestoreLedger(store, clock);
  const registry = createWorkspaceRegistry({ store, clock, receiptLedger: restoreReceiptLedger });
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'fixture\n');
  registry.register({ workspaceId: 'workspace-crash', campaignId: 'campaign', nodeId: 'node', sourcePath: '/source', workspacePath: workspace });
  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'workspace-crash', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  assert.equal(registry.retentionRecords()[0].retentionState, 'protected');
  assert.equal(registry.retentionRecords()[0].restoreReceiptHash, null);
  const recoveredRegistry = createWorkspaceRegistry({ store, clock, receiptLedger: restoreReceiptLedger });
  assert.equal(recoveredRegistry.retentionRecords()[0].retentionState, 'protected');
  const restored = restoreWorkspaceSnapshot({ receipt, restoreRoot: path.join(root, 'restore'), registry: recoveredRegistry, restoreReceiptLedger, workspaceId: 'workspace-crash', verifiedAt: '2026-07-14T01:00:00.000Z' });
  assert.equal(restored.status, 'workspace_snapshot_restore_verified');
  const qualified = recoveredRegistry.retentionRecords()[0];
  assert.equal(qualified.retentionState, 'eligible');
  assert.equal(qualified.restoreReceiptHash, restored.restoreReceiptHash);
  fs.appendFileSync(receipt.archivePath, 'corrupted-after-qualification');
  const damaged = recoveredRegistry.retentionRecords()[0];
  assert.equal(damaged.retentionState, 'protected');
  assert.ok(damaged.retentionEvidence.blockers.includes('workspace_snapshot_archive_hash_mismatch'));
});

test('export archives the pinned manifest tree when the public source path is swapped before tar opens it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-export-source-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const displaced = path.join(root, 'workspace-original');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'trusted workspace\n');
  fs.writeFileSync(path.join(outside, 'main.tex'), 'outside secret\n');
  const registry = { recordSnapshot() {}, transition() {} };
  const receipt = exportWorkspaceSnapshot({
    registry,
    workspaceId: 'source-swap',
    workspacePath: workspace,
    exportRoot: path.join(root, 'exports'),
    stageFaultInjector(milestone) {
      assert.equal(milestone, 'after_source_staged');
      fs.renameSync(workspace, displaced);
      fs.symlinkSync(outside, workspace);
    },
  });
  const restoredRoot = path.join(root, 'restored');
  const restored = restoreWorkspaceSnapshot({ receipt, restoreRoot: restoredRoot });
  assert.equal(restored.status, 'workspace_snapshot_restore_verified');
  assert.equal(fs.readFileSync(path.join(restoredRoot, 'main.tex'), 'utf8'), 'trusted workspace\n');
  assert.equal(fs.readFileSync(path.join(displaced, 'main.tex'), 'utf8'), 'trusted workspace\n');
});

test('manifest-invalid archive never replaces an existing restore root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-invalid-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const invalid = path.join(root, 'invalid');
  const restoreRoot = path.join(root, 'restore');
  fs.mkdirSync(workspace);
  fs.mkdirSync(invalid);
  fs.mkdirSync(restoreRoot);
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'trusted workspace\n');
  fs.writeFileSync(path.join(invalid, 'main.tex'), 'wrong postimage\n');
  fs.writeFileSync(path.join(restoreRoot, 'sentinel.txt'), 'preserve me\n');
  const originalIdentity = fs.lstatSync(restoreRoot);
  const registry = { recordSnapshot() {}, transition() {} };
  const exported = exportWorkspaceSnapshot({ registry, workspaceId: 'invalid-restore', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  const rewrite = spawnSync('tar', ['-czf', exported.archivePath, '-C', invalid, '--', '.'], { encoding: 'utf8' });
  assert.equal(rewrite.status, 0, rewrite.stderr);
  const rebound = rebindArchiveReceipt(exported);
  const blocked = restoreWorkspaceSnapshot({ receipt: rebound, restoreRoot });
  assert.equal(blocked.status, 'workspace_snapshot_restore_blocked');
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'sentinel.txt'), 'utf8'), 'preserve me\n');
  assert.equal(fs.lstatSync(restoreRoot).dev, originalIdentity.dev);
  assert.equal(fs.lstatSync(restoreRoot).ino, originalIdentity.ino);
  assert.equal(fs.existsSync(path.join(restoreRoot, 'main.tex')), false);
  assert.deepEqual(snapshotTemporaryArtifacts(root), []);
});

test('verified restore atomically replaces an existing tree and cleans staging state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-restore-replace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const restoreRoot = path.join(root, 'restore');
  const exportRoot = path.join(root, 'exports');
  fs.mkdirSync(workspace);
  fs.mkdirSync(restoreRoot);
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'replacement\n');
  fs.writeFileSync(path.join(restoreRoot, 'sentinel.txt'), 'old tree\n');
  const originalIdentity = fs.lstatSync(restoreRoot);
  const registry = { recordSnapshot() {}, transition() {} };
  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'replace', workspacePath: workspace, exportRoot });
  const restored = restoreWorkspaceSnapshot({ receipt, restoreRoot });
  assert.equal(restored.status, 'workspace_snapshot_restore_verified');
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'main.tex'), 'utf8'), 'replacement\n');
  assert.equal(fs.existsSync(path.join(restoreRoot, 'sentinel.txt')), false);
  assert.notEqual(fs.lstatSync(restoreRoot).ino, originalIdentity.ino);
  assert.deepEqual(snapshotTemporaryArtifacts(root), []);
  assert.deepEqual(snapshotTemporaryArtifacts(exportRoot), []);
});

test('restore parent swap to a symlink never installs outside and durable intent recovers after binding returns', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-restore-parent-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const parent = path.join(root, 'restore-parent');
  const displacedParent = path.join(root, 'restore-parent-displaced');
  const outside = path.join(root, 'outside');
  const restoreRoot = path.join(parent, 'restore');
  fs.mkdirSync(workspace);
  fs.mkdirSync(restoreRoot, { recursive: true });
  fs.mkdirSync(path.join(outside, 'restore'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'trusted replacement\n');
  fs.writeFileSync(path.join(restoreRoot, 'sentinel.txt'), 'original tree\n');
  fs.writeFileSync(path.join(outside, 'restore', 'outside.txt'), 'outside tree\n');
  const registry = { recordSnapshot() {}, transition() {} };
  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'parent-swap', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  let swapped = false;
  assert.throws(() => restoreWorkspaceSnapshot({
    receipt,
    restoreRoot,
    publishFaultInjector(milestone) {
      if (milestone !== 'after_intent_directory_sync' || swapped) return;
      swapped = true;
      fs.renameSync(parent, displacedParent);
      fs.symlinkSync(outside, parent, 'dir');
    },
  }), /restore_parent_identity_changed/);
  assert.equal(fs.readFileSync(path.join(outside, 'restore', 'outside.txt'), 'utf8'), 'outside tree\n');
  assert.equal(fs.existsSync(path.join(outside, 'restore', 'main.tex')), false);
  assert.equal(fs.readFileSync(path.join(displacedParent, 'restore', 'sentinel.txt'), 'utf8'), 'original tree\n');
  fs.unlinkSync(parent);
  fs.renameSync(displacedParent, parent);
  const recovered = restoreWorkspaceSnapshot({ receipt, restoreRoot });
  assert.equal(recovered.status, 'workspace_snapshot_restore_verified');
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'main.tex'), 'utf8'), 'trusted replacement\n');
  assert.deepEqual(snapshotTemporaryArtifacts(parent), []);
});

test('restore refuses a destination symlink without changing its target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-restore-destination-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const restoreRoot = path.join(root, 'restore');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'trusted replacement\n');
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside tree\n');
  fs.symlinkSync(outside, restoreRoot, 'dir');
  const registry = { recordSnapshot() {}, transition() {} };
  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'destination-link', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  assert.throws(() => restoreWorkspaceSnapshot({ receipt, restoreRoot }), /destination_unsafe/);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside tree\n');
  assert.equal(fs.existsSync(path.join(outside, 'main.tex')), false);
  assert.equal(fs.lstatSync(restoreRoot).isSymbolicLink(), true);
  assert.deepEqual(snapshotTemporaryArtifacts(root), []);
});

test('restore rejects traversal and non-regular tar members before touching the destination', async (t) => {
  for (const fixture of [
    {
      name: 'dotdot',
      prepare(directory) { fs.writeFileSync(path.join(directory, 'main.tex'), 'payload\n'); },
      tarArgs(directory, archivePath) {
        return ['-czf', archivePath, '--transform=s|^\\./|../|', '-C', directory, '--', '.'];
      },
      error: /archive_path_unsafe/,
    },
    {
      name: 'absolute',
      prepare(directory) { fs.writeFileSync(path.join(directory, 'main.tex'), 'payload\n'); },
      tarArgs(directory, archivePath) {
        return ['-czf', archivePath, '--transform=s|^\\./|/|', '-C', directory, '--', '.'];
      },
      error: /archive_path_unsafe/,
    },
    {
      name: 'symlink',
      prepare(directory) { fs.symlinkSync('/etc/passwd', path.join(directory, 'main.tex')); },
      tarArgs(directory, archivePath) { return ['-czf', archivePath, '-C', directory, '--', '.']; },
      error: /member_type_forbidden:l/,
    },
    {
      name: 'hardlink',
      prepare(directory) {
        fs.writeFileSync(path.join(directory, 'main.tex'), 'payload\n');
        fs.linkSync(path.join(directory, 'main.tex'), path.join(directory, 'alias.tex'));
      },
      tarArgs(directory, archivePath) { return ['-czf', archivePath, '-C', directory, '--', '.']; },
      error: /member_type_forbidden:h/,
    },
    {
      name: 'fifo',
      prepare(directory) {
        const made = spawnSync('mkfifo', [path.join(directory, 'main.tex')], { encoding: 'utf8' });
        assert.equal(made.status, 0, made.stderr);
      },
      tarArgs(directory, archivePath) { return ['-czf', archivePath, '-C', directory, '--', '.']; },
      error: /member_type_forbidden:p/,
    },
  ]) {
    await t.test(fixture.name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-workspace-archive-${fixture.name}-`));
      try {
        const workspace = path.join(root, 'workspace');
        const malicious = path.join(root, 'malicious');
        const restoreRoot = path.join(root, 'restore');
        fs.mkdirSync(workspace);
        fs.mkdirSync(malicious);
        fs.mkdirSync(restoreRoot);
        fs.writeFileSync(path.join(workspace, 'main.tex'), 'trusted\n');
        fs.writeFileSync(path.join(restoreRoot, 'sentinel.txt'), 'preserve\n');
        const registry = { recordSnapshot() {}, transition() {} };
        const exported = exportWorkspaceSnapshot({ registry, workspaceId: fixture.name, workspacePath: workspace, exportRoot: path.join(root, 'exports') });
        fixture.prepare(malicious);
        const rewrite = spawnSync('tar', fixture.tarArgs(malicious, exported.archivePath), { encoding: 'utf8' });
        assert.equal(rewrite.status, 0, rewrite.stderr);
        const rebound = rebindArchiveReceipt(exported);
        assert.throws(() => restoreWorkspaceSnapshot({ receipt: rebound, restoreRoot }), fixture.error);
        assert.equal(fs.readFileSync(path.join(restoreRoot, 'sentinel.txt'), 'utf8'), 'preserve\n');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});

test('SIGKILL at every publication rename/fsync milestone recovers to a complete new tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-restore-kill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const restoreRoot = path.join(root, 'restore');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'complete new tree\n');
  const registry = { recordSnapshot() {}, transition() {} };
  const receipt = exportWorkspaceSnapshot({ registry, workspaceId: 'kill-recovery', workspacePath: workspace, exportRoot: path.join(root, 'exports') });
  const childSource = `
    import fs from 'node:fs';
    import { restoreWorkspaceSnapshot } from './paper-adapters/automation/workspace-snapshot-exporter.mjs';
    const receipt = JSON.parse(fs.readFileSync(process.env.HEPTA_RECEIPT, 'utf8'));
    restoreWorkspaceSnapshot({
      receipt,
      restoreRoot: process.env.HEPTA_RESTORE_ROOT,
      publishFaultInjector(milestone) {
        if (milestone === process.env.HEPTA_KILL_MILESTONE) process.kill(process.pid, 'SIGKILL');
      },
    });
  `;
  for (const milestone of [
    'after_intent_directory_sync',
    'after_original_rename',
    'after_original_directory_sync',
    'after_staging_rename',
    'after_staging_directory_sync',
    'after_backup_cleanup_directory_sync',
    'after_intent_cleanup_directory_sync',
  ]) {
    fs.rmSync(restoreRoot, { recursive: true, force: true });
    fs.mkdirSync(restoreRoot);
    fs.writeFileSync(path.join(restoreRoot, 'sentinel.txt'), `old tree at ${milestone}\n`);
    const killed = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        HEPTA_RECEIPT: receipt.manifestPath,
        HEPTA_RESTORE_ROOT: restoreRoot,
        HEPTA_KILL_MILESTONE: milestone,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(killed.signal, 'SIGKILL', `${milestone}: ${killed.stderr}`);
    const recovered = restoreWorkspaceSnapshot({ receipt, restoreRoot });
    assert.equal(recovered.status, 'workspace_snapshot_restore_verified', milestone);
    assert.equal(fs.readFileSync(path.join(restoreRoot, 'main.tex'), 'utf8'), 'complete new tree\n', milestone);
    assert.deepEqual(fs.readdirSync(restoreRoot), ['main.tex'], milestone);
    assert.deepEqual(snapshotTemporaryArtifacts(root), [], milestone);
  }
});
