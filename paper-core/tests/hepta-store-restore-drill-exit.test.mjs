import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function createCliFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-restore-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const runtimeRoot = path.join(root, 'runtime');
  const env = {
    ...process.env,
    HEPTA_PAPER_ASSET_ROOT: assetRoot,
    HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
  };
  const run = (...args) => spawnSync(
    process.execPath,
    ['paper-core/bin/hepta-store.mjs', ...args],
    { cwd: workspaceRoot, env, encoding: 'utf8' },
  );
  const migrated = run('migrate');
  assert.equal(migrated.status, 0, migrated.stderr);
  return { assetRoot, runtimeRoot, run };
}

test('hepta-store restore drill preserves a zero exit for a passing receipt', (t) => {
  const { run } = createCliFixture(t);
  const backupRun = run('backup');
  assert.equal(backupRun.status, 0, backupRun.stderr);
  const backup = JSON.parse(backupRun.stdout);

  const restoreRun = run('restore-drill', '--backup', backup.backupPath);
  assert.equal(restoreRun.status, 0, restoreRun.stderr);
  assert.equal(JSON.parse(restoreRun.stdout).status, 'hepta_store_restore_drill_passed');
});

test('hepta-store restore drill exits nonzero for a blocked receipt', (t) => {
  const { assetRoot, runtimeRoot, run } = createCliFixture(t);
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  const store = createDefaultPaperStore({ root: assetRoot, runtimeRoot, dbPath });
  const injected = store.execute(`
PRAGMA foreign_keys=OFF;
INSERT INTO submission_ledger(slug) VALUES('missing-parent-paper');
PRAGMA foreign_keys=ON;
`);
  store.close();
  assert.equal(injected.ok, true, injected.error);

  const backupRun = run('backup');
  assert.equal(backupRun.status, 0, backupRun.stderr);
  const backup = JSON.parse(backupRun.stdout);
  const restoreRun = run('restore-drill', '--backup', backup.backupPath);
  const restore = JSON.parse(restoreRun.stdout);

  assert.equal(restore.status, 'hepta_store_restore_drill_blocked');
  assert.equal(restore.foreignKeyViolationCount, 1);
  assert.equal(restoreRun.status, 2, restoreRun.stderr);
});
