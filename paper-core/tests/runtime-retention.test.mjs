import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRuntimeRetentionPlan, executeRuntimeRetentionPlan } from '../../paper-adapters/automation/runtime-retention.mjs';

test('runtime retention enforces quotas without deleting active COW workspaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaces = path.join(root, 'automation-workspaces');
  const activeNode = 'campaign:1:revise';
  const active = path.join(workspaces, `campaign-${activeNode.replace(/[^A-Za-z0-9_.-]/g, '_')}-uuid`);
  const stale = path.join(workspaces, 'stale-workspace');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(active, 'payload'), Buffer.alloc(64));
  fs.writeFileSync(path.join(stale, 'payload'), Buffer.alloc(64));
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    activeNodeIds: [activeNode],
    workspaceRecords: [
      { workspacePath: active, retentionState: 'protected' },
      { workspacePath: stale, retentionState: 'eligible' },
    ],
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: Number.MAX_SAFE_INTEGER } },
  });
  assert.equal(plan.categories.find((entry) => entry.category === 'automation-workspaces').activeProtectedCount, 1);
  assert.equal(plan.removals.some((entry) => entry.path === active), false);
  assert.equal(plan.removals.some((entry) => entry.path === stale), true);
  const dryRun = executeRuntimeRetentionPlan(plan);
  assert.equal(dryRun.applied, false);
  assert.equal(fs.existsSync(stale), true);
  const reconciled = [];
  const applied = executeRuntimeRetentionPlan(plan, { apply: true, workspaceRegistry: { reconcileMissingEligible() { reconciled.push('called'); } } });
  assert.equal(applied.applied, true);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(applied.receiptPath), true);
  assert.deepEqual(reconciled, ['called']);
});

test('runtime retention protects unregistered and unresolved workspaces by default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaces = path.join(root, 'automation-workspaces');
  const unresolved = path.join(workspaces, 'unresolved');
  const unregistered = path.join(workspaces, 'unregistered');
  const eligible = path.join(workspaces, 'eligible');
  for (const candidate of [unresolved, unregistered, eligible]) { fs.mkdirSync(candidate, { recursive: true }); fs.writeFileSync(path.join(candidate, 'payload'), 'x'); }
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    policies: { 'automation-workspaces': { maxBytes: 1, maxAgeMs: 0 } },
    workspaceRecords: [
      { workspacePath: unresolved, retentionState: 'protected' },
      { workspacePath: eligible, retentionState: 'eligible' },
    ],
  });
  assert.equal(plan.removals.some((entry) => entry.path === eligible), true);
  assert.equal(plan.removals.some((entry) => entry.path === unresolved), false);
  assert.equal(plan.removals.some((entry) => entry.path === unregistered), false);
  assert.equal(plan.categories.find((entry) => entry.category === 'automation-workspaces').unregisteredProtectedCount, 1);
});
