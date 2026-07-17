import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildRuntimeRetentionPlan, executeRuntimeRetentionPlan, reconcileRuntimeRetentionIntents } from '../../paper-adapters/automation/runtime-retention.mjs';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import { exportWorkspaceSnapshot, restoreWorkspaceSnapshot } from '../../paper-adapters/automation/workspace-snapshot-exporter.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { issueRuntimeRetentionWriter, issueStoreAdministratorWriter, issueWorkspaceSnapshotVerifierWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function trustedRetentionLedger(store, clock) {
  return createSqliteReceiptLedger({ store, clock, issuerCapability: issueRuntimeRetentionWriter() });
}

function trustedStoreAdminLedger(store, clock) {
  return createSqliteReceiptLedger({ store, clock, issuerCapability: issueStoreAdministratorWriter() });
}

function createQualifiedWorkspaceFixture({ root, store, clock, names }) {
  const suffix = crypto.randomUUID();
  const paperId = `paper-${suffix}`;
  const campaignId = `campaign-${suffix}`;
  const nodes = names.map((name, index) => ({ nodeId: `node-${index}-${suffix}`, kind: 'draft', dependencies: [] }));
  const insert = store.execute(`INSERT INTO papers(slug,title,canonical_dir,source_dir) VALUES('${paperId}','Paper','.','.');`);
  assert.equal(insert.ok, true, insert.error);
  createSqliteCampaignStore({ store, clock }).createCampaign({ campaignId, paperId, maxRounds: 1, nodes });
  const receiptLedger = createSqliteReceiptLedger({ store, clock, issuerCapability: issueWorkspaceSnapshotVerifierWriter() });
  const registry = createWorkspaceRegistry({ store, clock, receiptLedger });
  const workspaces = names.map((name, index) => {
    const workspacePath = path.join(root, 'automation-workspaces', name);
    const workspaceId = `workspace-${index}-${suffix}`;
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'payload'), `qualified-${name}\n`);
    registry.register({ workspaceId, campaignId, nodeId: nodes[index].nodeId, sourcePath: '/source', workspacePath, manifestHash: 'sha256:initial' });
    const exported = exportWorkspaceSnapshot({ registry, workspaceId, workspacePath, exportRoot: path.join(root, 'workspace-snapshots') });
    restoreWorkspaceSnapshot({
      receipt: exported,
      restoreRoot: path.join(root, 'workspace-restore-checks', name),
      registry,
      restoreReceiptLedger: receiptLedger,
      workspaceId,
      verifiedAt: `2026-07-14T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
    return { workspaceId, workspacePath, exported };
  });
  return { receiptLedger, registry, workspaces, records: registry.retentionRecords() };
}

function createRecoverableBackup({ backups, index, receiptLedger, date = 11 + index, sourcePath = path.join(path.dirname(backups), 'hepta-paper.sqlite') }) {
  const databasePath = path.join(backups, `hepta-paper-${index}.sqlite`);
  const receiptPath = `${databasePath}.receipt.json`;
  const restoreReceiptPath = `${databasePath}.restore-drill.receipt.json`;
  const content = `sqlite-backup-${index}`;
  fs.writeFileSync(databasePath, content);
  const backupSha256 = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  const createdAt = new Date(Date.UTC(2026, 6, date)).toISOString();
  const performedAt = new Date(Date.UTC(2026, 6, date, 0, 1)).toISOString();
  const receipt = { version: 1, kind: 'HeptaStoreBackupReceipt', status: 'hepta_store_backup_recorded', sourcePath, backupPath: databasePath, backupSha256, bytes: Buffer.byteLength(content), createdAt };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const backupLedger = receiptLedger.record(receipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'backup' });
  const restoreReceipt = { version: 2, kind: 'HeptaStoreRestoreDrillReceipt', status: 'hepta_store_restore_drill_passed', backupPath: databasePath, backupSha256, backupLedgerReceiptSha256: backupLedger.receiptHash, backupLedgerReceiptId: backupLedger.receiptId, hashMatches: true, quickCheck: 'ok', foreignKeyViolationCount: 0, performedAt, productionStoreMutated: false };
  fs.writeFileSync(restoreReceiptPath, `${JSON.stringify(restoreReceipt)}\n`);
  receiptLedger.record(restoreReceipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'restore_drill' });
  const modified = new Date(Date.UTC(2026, 6, date));
  for (const candidate of [databasePath, receiptPath, restoreReceiptPath]) fs.utimesSync(candidate, modified, modified);
  return { databasePath, receiptPath, restoreReceiptPath };
}

test('runtime retention enforces quotas without deleting active COW workspaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const workspaces = path.join(root, 'automation-workspaces');
  const activeNode = 'campaign:1:revise';
  const active = path.join(workspaces, `campaign-${activeNode.replace(/[^A-Za-z0-9_.-]/g, '_')}-uuid`);
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, 'payload'), Buffer.alloc(64));
  const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: ['stale-workspace'] });
  const stale = qualified.workspaces[0].workspacePath;
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    activeNodeIds: [activeNode],
    workspaceRecords: [{ workspacePath: active, retentionState: 'protected' }, ...qualified.records],
    receiptLedger: qualified.receiptLedger,
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: Number.MAX_SAFE_INTEGER } },
  });
  assert.equal(plan.categories.find((entry) => entry.category === 'automation-workspaces').activeProtectedCount, 1);
  assert.equal(plan.removals.some((entry) => entry.path === active), false);
  assert.equal(plan.removals.some((entry) => entry.path === stale), true);
  const dryRun = executeRuntimeRetentionPlan(plan);
  assert.equal(dryRun.applied, false);
  assert.equal(fs.existsSync(stale), true);
  const applied = executeRuntimeRetentionPlan(plan, { apply: true, workspaceRegistry: qualified.registry, receiptLedger: qualified.receiptLedger, retentionReceiptLedger });
  assert.equal(applied.applied, true);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(applied.receiptPath), true);
  assert.equal(qualified.registry.list().find((entry) => entry.workspacePath === stale).status, 'removed');
});

test('runtime retention protects unregistered and unresolved workspaces by default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const workspaces = path.join(root, 'automation-workspaces');
  const unresolved = path.join(workspaces, 'unresolved');
  const unregistered = path.join(workspaces, 'unregistered');
  for (const candidate of [unresolved, unregistered]) { fs.mkdirSync(candidate, { recursive: true }); fs.writeFileSync(path.join(candidate, 'payload'), 'x'); }
  const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: ['eligible'] });
  const eligible = qualified.workspaces[0].workspacePath;
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
    workspaceRecords: [{ workspacePath: unresolved, retentionState: 'protected' }, ...qualified.records],
    receiptLedger: qualified.receiptLedger,
  });
  assert.equal(plan.removals.some((entry) => entry.path === eligible), true);
  assert.equal(plan.removals.some((entry) => entry.path === unresolved), false);
  assert.equal(plan.removals.some((entry) => entry.path === unregistered), false);
  assert.equal(plan.categories.find((entry) => entry.category === 'automation-workspaces').unregisteredProtectedCount, 1);
});

test('backup retention requires effective backup and restore-drill receipts and preserves two generations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-backup-pair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const receiptLedger = trustedStoreAdminLedger(store, clock);
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const paths = Array.from({ length: 3 }, (_value, index) => createRecoverableBackup({ backups, index, receiptLedger }));
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    receiptLedger,
    policies: { backups: { maxBytes: 1, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 0 } },
  });
  const removal = plan.removals.find((entry) => entry.path === paths[0].databasePath);
  assert.ok(removal);
  assert.deepEqual(removal.companionPaths, [paths[0].receiptPath, paths[0].restoreReceiptPath]);
  assert.match(removal.contentHash, /^sha256:/);
  assert.equal(plan.categories.find((entry) => entry.category === 'backups').entryCount, 3);
  assert.equal(plan.categories.find((entry) => entry.category === 'backups').policy.keepNewest, 0);
  assert.equal(plan.categories.find((entry) => entry.category === 'backups').recoverableGenerationCount, 3);
  assert.equal(plan.categories.find((entry) => entry.category === 'backups').recoverableGenerationCountAfter, 2);
  const applied = executeRuntimeRetentionPlan(plan, { apply: true, receiptLedger, retentionReceiptLedger });
  assert.equal(fs.existsSync(paths[0].databasePath), false);
  assert.equal(fs.existsSync(paths[0].receiptPath), false);
  assert.equal(fs.existsSync(paths[0].restoreReceiptPath), false);
  assert.equal(fs.existsSync(paths[1].databasePath), true);
  assert.equal(fs.existsSync(paths[2].databasePath), true);
  assert.deepEqual(applied.removed[0].companionPaths, [paths[0].receiptPath, paths[0].restoreReceiptPath]);
  assert.equal(fs.existsSync(applied.intentPath), true);
  assert.match(applied.receiptPath, /\.tombstone\.json$/);
});

test('backup retention preserves two recoverable generations even when the newest local generations are unrecoverable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-backup-recoverable-minimum-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const receiptLedger = trustedStoreAdminLedger(store, clock);
  const valid = Array.from({ length: 3 }, (_value, index) => createRecoverableBackup({ backups, index, receiptLedger }));
  for (let index = 0; index < 2; index += 1) {
    const candidate = path.join(backups, `newest-but-unrecoverable-${index}.sqlite`);
    fs.writeFileSync(candidate, `unrecoverable-${index}`);
    fs.writeFileSync(`${candidate}.receipt.json`, '{"kind":"BackupReceipt"}\n');
    const modified = new Date(Date.UTC(2026, 6, 14 + index));
    fs.utimesSync(candidate, modified, modified);
    fs.utimesSync(`${candidate}.receipt.json`, modified, modified);
  }
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    receiptLedger,
    policies: { backups: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0, minimumRecoverableGenerations: 2 } },
  });
  const category = plan.categories.find((entry) => entry.category === 'backups');
  assert.equal(category.entryCount, 5);
  assert.equal(category.evidenceProtectedCount, 2);
  assert.equal(category.recoverableGenerationCount, 3);
  assert.equal(category.recoverableGenerationCountAfter, 2);
  assert.deepEqual(plan.removals.filter((entry) => entry.category === 'backups').map((entry) => entry.path), [valid[0].databasePath]);
});

test('backup retention rejects trusted receipts issued for a different product database', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-backup-subject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const receiptLedger = trustedStoreAdminLedger(store, clock);
  for (let index = 0; index < 3; index += 1) {
    createRecoverableBackup({ backups, index, receiptLedger, sourcePath: '/wrong/other-product.sqlite' });
  }
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    receiptLedger,
    policies: { backups: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0 } },
  });
  const category = plan.categories.find((entry) => entry.category === 'backups');
  assert.equal(category.recoverableGenerationCount, 0);
  assert.equal(category.evidenceProtectedCount, 3);
  assert.equal(plan.removals.some((entry) => entry.category === 'backups'), false);
});

test('backup retention recomputes recoverable generations before every deletion', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-backup-apply-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const receiptLedger = trustedStoreAdminLedger(store, clock);
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const paths = Array.from({ length: 4 }, (_value, index) => createRecoverableBackup({ backups, index, receiptLedger }));
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    receiptLedger,
    policies: { backups: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0, minimumRecoverableGenerations: 2 } },
  });
  assert.deepEqual(plan.removals.filter((entry) => entry.category === 'backups').map((entry) => entry.path), [paths[0].databasePath, paths[1].databasePath]);
  let invalidated = false;
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    receiptLedger,
    retentionReceiptLedger,
    faultInjector(event) {
      if (!invalidated && event.stage === 'after_member_removed' && event.entryIndex === 0 && event.memberIndex === 2) {
        invalidated = true;
        fs.appendFileSync(paths[3].databasePath, 'changed-after-first-deletion');
      }
    },
  });
  const backupResults = applied.removed.filter((entry) => entry.category === 'backups');
  assert.equal(backupResults[0].removed, true);
  assert.equal(backupResults[1].removed, false);
  assert.equal(backupResults[1].blockers.includes('backup_minimum_recoverable_generations_would_be_violated'), true);
  assert.equal(fs.existsSync(paths[0].databasePath), false);
  assert.equal(fs.existsSync(paths[1].databasePath), true);
});

test('backup retention protects forged local receipts and apply rechecks planned content hashes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-fail-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    const candidate = path.join(backups, `forged-${index}.sqlite`);
    fs.writeFileSync(candidate, 'sqlite-backup');
    fs.writeFileSync(`${candidate}.receipt.json`, '{"kind":"BackupReceipt"}\n');
  }
  const forged = buildRuntimeRetentionPlan({ runtimeRoot: root, policies: { backups: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0 } } });
  assert.equal(forged.removals.some((entry) => entry.category === 'backups'), false);
  assert.equal(forged.categories.find((entry) => entry.category === 'backups').evidenceProtectedCount, 3);

  const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: ['stale'] });
  const stale = qualified.workspaces[0].workspacePath;
  const plan = buildRuntimeRetentionPlan({ runtimeRoot: root, workspaceRecords: qualified.records, receiptLedger: qualified.receiptLedger, policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } } });
  fs.writeFileSync(path.join(stale, 'payload'), 'after');
  const applied = executeRuntimeRetentionPlan(plan, { apply: true, workspaceRegistry: qualified.registry, receiptLedger: qualified.receiptLedger, retentionReceiptLedger });
  assert.equal(applied.status, 'runtime_retention_partially_blocked');
  assert.equal(applied.removed[0].removed, false);
  assert.deepEqual(applied.removed[0].blockers, ['retention_entry_hash_changed_after_plan']);
  assert.equal(fs.existsSync(stale), true);
  assert.equal(fs.existsSync(applied.intentPath), true);
});

for (const [mutationName, mutate, expectedEvidenceBlocker] of [
  ['changed file', (workspacePath) => fs.writeFileSync(path.join(workspacePath, 'payload'), 'changed-after-qualification\n'), 'workspace_live_manifest_changed_after_qualification'],
  ['added file', (workspacePath) => fs.writeFileSync(path.join(workspacePath, 'added'), 'added-after-qualification\n'), 'workspace_live_manifest_changed_after_qualification'],
  ['deleted file', (workspacePath) => fs.unlinkSync(path.join(workspacePath, 'payload')), 'workspace_live_manifest_changed_after_qualification'],
  ['added symlink', (workspacePath, root) => {
    const outside = path.join(root, 'outside-retention-source');
    fs.writeFileSync(outside, 'outside\n');
    fs.symlinkSync(outside, path.join(workspacePath, 'unsafe-link'));
  }, 'workspace_live_manifest_unsafe'],
]) {
  test(`workspace retention rejects ${mutationName} after restore qualification`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-live-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
    t.after(() => store.close());
    const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
    const retentionReceiptLedger = trustedRetentionLedger(store, clock);
    const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: [`live-${mutationName.replace(/\s+/g, '-')}`] });
    const workspacePath = qualified.workspaces[0].workspacePath;
    const plannedBeforeMutation = buildRuntimeRetentionPlan({
      runtimeRoot: root,
      workspaceRecords: qualified.records,
      receiptLedger: qualified.receiptLedger,
      policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
    });
    assert.equal(plannedBeforeMutation.removals.some((entry) => entry.path === workspacePath), true);

    mutate(workspacePath, root);
    const revalidated = qualified.registry.retentionRecords()[0];
    assert.equal(revalidated.retentionState, 'protected');
    assert.equal(revalidated.retentionEvidence.blockers.includes(expectedEvidenceBlocker), true);
    const plannedAfterMutation = buildRuntimeRetentionPlan({
      runtimeRoot: root,
      workspaceRecords: qualified.records,
      receiptLedger: qualified.receiptLedger,
      policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
    });
    assert.equal(plannedAfterMutation.removals.some((entry) => entry.path === workspacePath), false);

    const applied = executeRuntimeRetentionPlan(plannedBeforeMutation, {
      apply: true,
      workspaceRegistry: qualified.registry,
      receiptLedger: qualified.receiptLedger,
      retentionReceiptLedger,
    });
    const result = applied.removed.find((entry) => entry.path === workspacePath);
    assert.equal(result.removed, false);
    assert.equal(fs.existsSync(workspacePath), true);
  });
}

test('retention rejects a symlink category root and a parent swap without touching external files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-scope-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-outside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);

  const externalVictim = path.join(outside, 'external-report.json');
  fs.writeFileSync(externalVictim, 'must-survive\n');
  fs.symlinkSync(outside, path.join(root, 'reports'));
  const symlinkPlan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    policies: { reports: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0 } },
  });
  assert.equal(symlinkPlan.removals.some((entry) => entry.category === 'reports'), false);
  assert.match(symlinkPlan.categories.find((entry) => entry.category === 'reports').scopeBlocker, /scope_not_regular_directory/);
  executeRuntimeRetentionPlan(symlinkPlan, { apply: true, retentionReceiptLedger });
  assert.equal(fs.readFileSync(externalVictim, 'utf8'), 'must-survive\n');

  fs.unlinkSync(path.join(root, 'reports'));
  const reports = path.join(root, 'reports');
  fs.mkdirSync(reports);
  const plannedVictim = path.join(reports, 'old-report.json');
  fs.writeFileSync(plannedVictim, 'planned\n');
  const swapPlan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    policies: { reports: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0 } },
  });
  assert.equal(swapPlan.removals.some((entry) => entry.path === plannedVictim), true);
  const originalReports = path.join(root, 'reports-before-swap');
  fs.renameSync(reports, originalReports);
  const swappedExternalVictim = path.join(outside, 'old-report.json');
  fs.writeFileSync(swappedExternalVictim, 'external-swap-victim\n');
  fs.symlinkSync(outside, reports);
  const swapped = executeRuntimeRetentionPlan(swapPlan, { apply: true, retentionReceiptLedger });
  const swappedResult = swapped.removed.find((entry) => entry.path === plannedVictim);
  assert.equal(swappedResult.removed, false);
  assert.equal(swappedResult.blockers.some((blocker) => /scope_(?:not_regular_directory|identity_changed)/.test(blocker)), true);
  assert.equal(fs.readFileSync(swappedExternalVictim, 'utf8'), 'external-swap-victim\n');
  assert.equal(fs.existsSync(path.join(originalReports, 'old-report.json')), true);

  fs.unlinkSync(reports);
  fs.rmSync(originalReports, { recursive: true, force: true });
  fs.mkdirSync(reports);
  const afterIntentVictim = path.join(reports, 'after-intent.json');
  fs.writeFileSync(afterIntentVictim, 'planned-after-intent\n');
  const afterIntentPlan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    policies: { reports: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0 } },
  });
  const pinnedOriginalReports = path.join(root, 'reports-pinned-after-intent');
  const externalAfterIntentVictim = path.join(outside, 'after-intent.json');
  fs.writeFileSync(externalAfterIntentVictim, 'external-after-intent-victim\n');
  const afterIntent = executeRuntimeRetentionPlan(afterIntentPlan, {
    apply: true,
    retentionReceiptLedger,
    faultInjector(event) {
      if (event.stage !== 'after_intent_recorded') return;
      fs.renameSync(reports, pinnedOriginalReports);
      fs.symlinkSync(outside, reports);
    },
  });
  const afterIntentResult = afterIntent.removed.find((entry) => entry.path === afterIntentVictim);
  assert.equal(afterIntentResult.removed, false);
  assert.equal(afterIntentResult.blockers.some((blocker) => /scope_(?:not_regular_directory|identity_changed)/.test(blocker)), true);
  assert.equal(fs.readFileSync(externalAfterIntentVictim, 'utf8'), 'external-after-intent-victim\n');
  assert.equal(fs.existsSync(path.join(pinnedOriginalReports, 'after-intent.json')), true);
});

test('workspace retention revalidates archive evidence after intent recording', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-workspace-apply-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: ['apply-race'] });
  const workspace = qualified.workspaces[0];
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    workspaceRecords: qualified.records,
    receiptLedger: qualified.receiptLedger,
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
  });
  const applied = executeRuntimeRetentionPlan(plan, {
    apply: true,
    workspaceRegistry: qualified.registry,
    receiptLedger: qualified.receiptLedger,
    retentionReceiptLedger,
    faultInjector(event) {
      if (event.stage === 'after_intent_recorded') fs.appendFileSync(workspace.exported.archivePath, 'corrupt-after-intent');
    },
  });
  const workspaceResult = applied.removed.find((entry) => entry.category === 'automation-workspaces');
  assert.equal(workspaceResult.removed, false);
  assert.equal(workspaceResult.blockers.includes('workspace_snapshot_archive_hash_mismatch'), true);
  assert.equal(fs.existsSync(workspace.workspacePath), true);
});

test('backup retention rejects valid-shaped receipts from an untrusted ledger writer', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-untrusted-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const untrustedLedger = createSqliteReceiptLedger({ store, clock });
  for (let index = 0; index < 3; index += 1) {
    const databasePath = path.join(backups, `untrusted-${index}.sqlite`);
    const content = `backup-${index}`;
    fs.writeFileSync(databasePath, content);
    const backupSha256 = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
    const backupReceipt = { version: 1, kind: 'HeptaStoreBackupReceipt', status: 'hepta_store_backup_recorded', sourcePath: '/source.sqlite', backupPath: databasePath, backupSha256, bytes: Buffer.byteLength(content), createdAt: '2026-07-13T00:00:00.000Z' };
    fs.writeFileSync(`${databasePath}.receipt.json`, `${JSON.stringify(backupReceipt)}\n`);
    const backupLedger = untrustedLedger.record(backupReceipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'backup' });
    const restoreReceipt = { version: 2, kind: 'HeptaStoreRestoreDrillReceipt', status: 'hepta_store_restore_drill_passed', backupPath: databasePath, backupSha256, backupLedgerReceiptSha256: backupLedger.receiptHash, backupLedgerReceiptId: backupLedger.receiptId, hashMatches: true, quickCheck: 'ok', foreignKeyViolationCount: 0, performedAt: '2026-07-13T00:01:00.000Z', productionStoreMutated: false };
    fs.writeFileSync(`${databasePath}.restore-drill.receipt.json`, `${JSON.stringify(restoreReceipt)}\n`);
    untrustedLedger.record(restoreReceipt, { stream: 'store-admin', environment: 'administrative', evidenceClass: 'restore_drill' });
  }
  const plan = buildRuntimeRetentionPlan({ runtimeRoot: root, receiptLedger: untrustedLedger, policies: { backups: { maxBytes: 1, maxAgeMs: 0, keepNewest: 0 } } });
  assert.equal(plan.removals.some((entry) => entry.category === 'backups'), false);
  assert.equal(plan.categories.find((entry) => entry.category === 'backups').evidenceProtectedCount, 3);
});

test('trusted retention intent converges after a crash between deletion and tombstone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: ['first', 'second'] });
  const workspaces = qualified.workspaces.map((entry) => entry.workspacePath);
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    workspaceRecords: qualified.records,
    receiptLedger: qualified.receiptLedger,
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
  });
  let injected = false;
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    workspaceRegistry: qualified.registry,
    receiptLedger: qualified.receiptLedger,
    retentionReceiptLedger,
    faultInjector(event) {
      if (!injected && event.stage === 'after_member_removed') { injected = true; throw new Error('simulated_process_crash'); }
    },
  }), /simulated_process_crash/);
  assert.equal(workspaces.filter((workspace) => fs.existsSync(workspace)).length, 1);
  const retentionRoot = path.join(root, 'retention');
  assert.equal(fs.readdirSync(retentionRoot).filter((name) => name.endsWith('.intent.json')).length, 1);
  assert.equal(fs.readdirSync(retentionRoot).filter((name) => name.endsWith('.tombstone.json')).length, 0);
  const recovered = reconcileRuntimeRetentionIntents({ runtimeRoot: root, workspaceRegistry: qualified.registry, receiptLedger: qualified.receiptLedger, retentionReceiptLedger: trustedRetentionLedger(store, clock) });
  assert.equal(recovered.status, 'runtime_retention_recovery_complete');
  assert.equal(workspaces.some((workspace) => fs.existsSync(workspace)), false);
  assert.equal(fs.readdirSync(retentionRoot).filter((name) => name.endsWith('.tombstone.json')).length, 1);
  const replayed = reconcileRuntimeRetentionIntents({ runtimeRoot: root, workspaceRegistry: qualified.registry, receiptLedger: qualified.receiptLedger, retentionReceiptLedger: trustedRetentionLedger(store, clock) });
  assert.equal(replayed.recovered[0].status, 'runtime_retention_already_converged');
});

test('retention recovery converges after the trusted tombstone commits but before its local file is published', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-ledger-before-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: ['ledger-before-local'] });
  const workspacePath = qualified.workspaces[0].workspacePath;
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    workspaceRecords: qualified.records,
    receiptLedger: qualified.receiptLedger,
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
  });
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    workspaceRegistry: qualified.registry,
    receiptLedger: qualified.receiptLedger,
    retentionReceiptLedger,
    faultInjector(event) {
      if (event.stage === 'after_trusted_tombstone_recorded') throw new Error('crash_after_trusted_tombstone');
    },
  }), /crash_after_trusted_tombstone/);
  assert.equal(fs.existsSync(workspacePath), false);
  const retentionRoot = path.join(root, 'retention');
  assert.equal(fs.readdirSync(retentionRoot).filter((name) => name.endsWith('.tombstone.json')).length, 0);
  assert.equal(retentionReceiptLedger.listRawForAudit({ stream: 'runtime-retention' }).filter((row) => row.kind === 'RuntimeRetentionReceipt').length, 1);
  const recovered = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    workspaceRegistry: qualified.registry,
    receiptLedger: qualified.receiptLedger,
    retentionReceiptLedger,
  });
  assert.equal(recovered.status, 'runtime_retention_recovery_complete');
  assert.equal(fs.readdirSync(retentionRoot).filter((name) => name.endsWith('.tombstone.json')).length, 1);
});

test('recovery refuses to promote a locally forged self-hashed tombstone into the trusted ledger', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-forged-tombstone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const clock = { nowIso: () => '2026-07-14T00:00:00.000Z' };
  const retentionReceiptLedger = trustedRetentionLedger(store, clock);
  const qualified = createQualifiedWorkspaceFixture({ root, store, clock, names: ['forged-tombstone'] });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    workspaceRecords: qualified.records,
    receiptLedger: qualified.receiptLedger,
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
  });
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    workspaceRegistry: qualified.registry,
    receiptLedger: qualified.receiptLedger,
    retentionReceiptLedger,
    faultInjector(event) {
      if (event.stage === 'before_tombstone') throw new Error('stop_before_trusted_tombstone');
    },
  }), /stop_before_trusted_tombstone/);
  const retentionRoot = path.join(root, 'retention');
  const intentPath = path.join(retentionRoot, fs.readdirSync(retentionRoot).find((name) => name.endsWith('.intent.json')));
  const intent = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
  const removed = intent.entries.map((entry) => ({
    category: entry.category,
    path: entry.path,
    companionPaths: entry.companionPaths,
    bytes: entry.bytes,
    contentHash: entry.contentHash,
    reason: entry.reason,
    removed: true,
    alreadyAbsent: false,
    blockers: [],
  }));
  const forgedPayload = {
    version: 2,
    kind: 'RuntimeRetentionReceipt',
    status: 'runtime_retention_applied',
    planHash: intent.planHash,
    intentHash: intent.runtimeRetentionIntentReceiptHash,
    intentReceiptId: `runtime-retention:${intent.runtimeRetentionIntentReceiptHash}`,
    removed,
    bytesEligible: removed.reduce((total, entry) => total + entry.bytes, 0),
    bytesRemoved: removed.reduce((total, entry) => total + entry.bytes, 0),
    applied: true,
    externalActionPerformed: false,
    intentPath,
    createdAt: new Date(Date.parse(intent.createdAt) + 1000).toISOString(),
  };
  const forged = { ...forgedPayload, runtimeRetentionReceiptHash: hashRecord('RuntimeRetentionReceipt', forgedPayload) };
  const tombstonePath = intentPath.replace(/\.intent\.json$/, '.tombstone.json');
  fs.writeFileSync(tombstonePath, `${JSON.stringify(forged, null, 2)}\n`);

  const recovered = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    workspaceRegistry: qualified.registry,
    receiptLedger: qualified.receiptLedger,
    retentionReceiptLedger,
  });
  assert.equal(recovered.status, 'runtime_retention_recovery_blocked');
  assert.match(recovered.blockers[0].blocker, /trusted_receipt_missing_or_invalid/);
  const trustedId = `runtime-retention:${forged.runtimeRetentionReceiptHash}`;
  assert.equal(retentionReceiptLedger.get(trustedId), null);
});

test('hepta-store CLI binds a selected backup to trusted admin backup and restore receipts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-receipt-roundtrip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const env = {
    ...process.env,
    HEPTA_PAPER_RUNTIME_ROOT: path.join(root, 'runtime'),
    HEPTA_PAPER_ASSET_ROOT: path.join(root, 'assets'),
  };
  const run = (...args) => spawnSync(process.execPath, ['paper-core/bin/hepta-store.mjs', ...args], { cwd: workspaceRoot, env, encoding: 'utf8' });
  const migrateRun = run('migrate');
  assert.equal(migrateRun.status, 0, migrateRun.stderr);
  const backupRun = run('backup');
  assert.equal(backupRun.status, 0, backupRun.stderr);
  const backup = JSON.parse(backupRun.stdout);
  const localBackupReceipt = JSON.parse(fs.readFileSync(`${backup.backupPath}.receipt.json`, 'utf8'));
  assert.equal(backup.ledgerReceipt.receiptHash, hashRecord('HeptaStoreBackupReceipt', localBackupReceipt));
  assert.equal(backup.ledgerReceipt.receiptId, `store-admin:${backup.ledgerReceipt.receiptHash}`);
  assert.equal(backup.ledgerReceipt.writerTrusted, true);
  assert.equal(backup.ledgerReceipt.issuerPolicyId, 'store-administrator');
  const restoreRun = run('restore-drill', '--backup', backup.backupPath);
  assert.equal(restoreRun.status, 0, restoreRun.stderr);
  const restore = JSON.parse(restoreRun.stdout);
  assert.equal(restore.backupLedgerReceiptId, backup.ledgerReceipt.receiptId);
  assert.equal(restore.backupLedgerReceiptSha256, backup.ledgerReceipt.receiptHash);
  assert.equal(restore.ledgerReceipt.receiptId, `store-admin:${restore.ledgerReceipt.receiptHash}`);
  assert.notEqual(restore.ledgerReceipt.receiptHash, backup.ledgerReceipt.receiptHash);
  assert.equal(restore.ledgerReceipt.writerTrusted, true);
  assert.equal(restore.ledgerReceipt.issuerPolicyId, 'store-administrator');
  assert.equal(fs.existsSync(`${backup.backupPath}.restore-drill.receipt.json`), true);
});
