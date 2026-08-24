import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import {
  clearPersonalDatabaseEmptySidecars,
  createPersonalDatabaseBackup,
  inspectPersonalLocalDatabase,
  recordPersonalDatabaseAntiRollback,
  restoreDrillPersonalDatabase,
  PERSONAL_DATABASE_MIN_SCHEMA_VERSION,
} from '../../paper-adapters/persistence/personal-local-database-readiness.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function fixture(t, { targetVersion = PERSONAL_DATABASE_MIN_SCHEMA_VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-personal-db-test-'));
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeRoot, 0o700);
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  const store = createDefaultPaperStore({
    root: workspaceRoot,
    runtimeRoot,
    dbPath,
    targetVersion,
  });
  store.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runtimeRoot, dbPath };
}

test('personal database readiness is fail-closed until a local head and restore drill exist', async (t) => {
  const fixtureState = fixture(t);
  const initial = await inspectPersonalLocalDatabase({
    runtimeRoot: fixtureState.runtimeRoot,
    requireRestoreDrill: false,
  });
  assert.equal(initial.schemaVersion, PERSONAL_DATABASE_MIN_SCHEMA_VERSION);
  assert.equal(initial.quickCheck, 'ok');
  assert.equal(initial.foreignKeyViolationCount, 0);
  assert.equal(initial.ready, false);
  assert.ok(initial.blockers.includes('personal_database_anti_rollback_state_missing'));

  const head = await recordPersonalDatabaseAntiRollback({ runtimeRoot: fixtureState.runtimeRoot });
  assert.equal(head.status, 'personal_database_anti_rollback_ready');
  assert.equal(head.sequence, 1);
  const backup = await createPersonalDatabaseBackup({ runtimeRoot: fixtureState.runtimeRoot });
  assert.equal(backup.status, 'personal_database_backup_recorded');
  assert.equal(backup.antiRollbackSequence, 1);
  const drill = await restoreDrillPersonalDatabase({
    runtimeRoot: fixtureState.runtimeRoot,
    backupPath: backup.backupPath,
  });
  assert.equal(drill.status, 'personal_database_restore_drill_passed');
  assert.equal(drill.productionDatabaseMutated, false);
  const ready = await inspectPersonalLocalDatabase({ runtimeRoot: fixtureState.runtimeRoot });
  assert.equal(ready.status, 'personal_local_database_ready', ready.blockers.join(','));
  assert.equal(ready.ready, true);
  assert.equal(ready.antiRollback.sequence, 1);
});

test('personal anti-rollback rejects a previously observed database head', async (t) => {
  const fixtureState = fixture(t);
  const first = await recordPersonalDatabaseAntiRollback({ runtimeRoot: fixtureState.runtimeRoot });
  const firstBackup = await createPersonalDatabaseBackup({ runtimeRoot: fixtureState.runtimeRoot });

  const store = createDefaultPaperStore({
    root: workspaceRoot,
    runtimeRoot: fixtureState.runtimeRoot,
    dbPath: fixtureState.dbPath,
  });
  const mutation = store.execute(`
UPDATE store_metadata SET updated_at='2099-01-01 00:00:00'
WHERE key='schema_version';
`);
  assert.equal(mutation.ok, true, mutation.error);
  store.close();
  const second = await recordPersonalDatabaseAntiRollback({ runtimeRoot: fixtureState.runtimeRoot });
  assert.equal(second.status, 'personal_database_anti_rollback_ready');
  assert.equal(second.sequence, 2);

  // Restoring a known old file is exactly the accidental rollback this local
  // chain is intended to expose; do not modify the ledger during this test.
  fs.copyFileSync(firstBackup.backupPath, fixtureState.dbPath);
  fs.chmodSync(fixtureState.dbPath, 0o600);
  const rollback = await inspectPersonalLocalDatabase({
    runtimeRoot: fixtureState.runtimeRoot,
    requireRestoreDrill: false,
  });
  assert.equal(rollback.ready, false);
  assert.ok(rollback.blockers.includes('personal_database_rollback_detected'));
  assert.equal(first.sequence, 1);
});

test('restore drill rejects an older backup after the local head advances', async (t) => {
  const fixtureState = fixture(t);
  await recordPersonalDatabaseAntiRollback({ runtimeRoot: fixtureState.runtimeRoot });
  const oldBackup = await createPersonalDatabaseBackup({ runtimeRoot: fixtureState.runtimeRoot });
  const store = createDefaultPaperStore({
    root: workspaceRoot,
    runtimeRoot: fixtureState.runtimeRoot,
    dbPath: fixtureState.dbPath,
  });
  assert.equal(store.execute(
    "UPDATE store_metadata SET updated_at='2099-01-02 00:00:00' WHERE key='schema_version';",
  ).ok, true);
  store.close();
  await recordPersonalDatabaseAntiRollback({ runtimeRoot: fixtureState.runtimeRoot });
  const blocked = await restoreDrillPersonalDatabase({
    runtimeRoot: fixtureState.runtimeRoot,
    backupPath: oldBackup.backupPath,
  });
  assert.equal(blocked.status, 'personal_database_restore_drill_blocked');
  assert.ok(blocked.blockers.includes('personal_database_restore_would_rollback_current_head'));
});

test('legacy schema is not ready until the offline migration raises it to the floor', async (t) => {
  const fixtureState = fixture(t, { targetVersion: PERSONAL_DATABASE_MIN_SCHEMA_VERSION - 5 });
  const report = await inspectPersonalLocalDatabase({
    runtimeRoot: fixtureState.runtimeRoot,
    requireRestoreDrill: false,
  });
  assert.equal(report.schemaVersion, 20);
  assert.ok(report.blockers.some((blocker) => (
    blocker.startsWith('personal_database_schema_version_below_minimum:')
  )));
});

test('sidecar cleanup requires a verified backup and explicit stale-shm confirmation', async (t) => {
  const fixtureState = fixture(t);
  const backup = await createPersonalDatabaseBackup({ runtimeRoot: fixtureState.runtimeRoot });
  fs.writeFileSync(`${fixtureState.dbPath}-wal`, '');
  fs.writeFileSync(`${fixtureState.dbPath}-shm`, Buffer.alloc(32, 7));
  fs.chmodSync(`${fixtureState.dbPath}-wal`, 0o600);
  fs.chmodSync(`${fixtureState.dbPath}-shm`, 0o600);
  const blocked = await clearPersonalDatabaseEmptySidecars({
    runtimeRoot: fixtureState.runtimeRoot,
    backupReceiptPath: backup.backupPath,
  });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes(
    'personal_database_nonempty_shared_memory_requires_explicit_confirmation',
  ));
  const cleared = await clearPersonalDatabaseEmptySidecars({
    runtimeRoot: fixtureState.runtimeRoot,
    backupReceiptPath: backup.backupPath,
    allowStaleSharedMemory: true,
  });
  assert.equal(cleared.status, 'personal_database_sidecars_cleared');
  assert.deepEqual([...cleared.removed].sort(), ['-shm', '-wal']);
});

test('quiescent WAL metadata left by a read does not block personal readiness', async (t) => {
  const fixtureState = fixture(t);
  await recordPersonalDatabaseAntiRollback({ runtimeRoot: fixtureState.runtimeRoot });
  const backup = await createPersonalDatabaseBackup({ runtimeRoot: fixtureState.runtimeRoot });
  await restoreDrillPersonalDatabase({
    runtimeRoot: fixtureState.runtimeRoot,
    backupPath: backup.backupPath,
  });
  fs.writeFileSync(`${fixtureState.dbPath}-wal`, '');
  fs.writeFileSync(`${fixtureState.dbPath}-shm`, Buffer.alloc(32 * 1024));
  fs.chmodSync(`${fixtureState.dbPath}-wal`, 0o600);
  fs.chmodSync(`${fixtureState.dbPath}-shm`, 0o600);

  const report = await inspectPersonalLocalDatabase({
    runtimeRoot: fixtureState.runtimeRoot,
  });
  assert.equal(report.ready, true, report.blockers.join(','));
  assert.equal(report.sidecars.clear, true);
  assert.equal(report.sidecars.sidecars.length, 2);
  assert.deepEqual(report.sidecars.blockers, []);
});
