import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createDefaultPaperStore,
  createReadOnlyPaperStore,
  preflightStoreMigrations,
} from '../../paper-adapters/persistence/store-provider.mjs';
import { prepareIsolatedRuntimeStore } from '../bin/isolated-runtime-store.mjs';

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('isolated runtime preparation checkpoints and closes SQLite before child execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-isolated-preparation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'hepta-paper.sqlite');
  const prepared = prepareIsolatedRuntimeStore({
    root,
    runtimeRoot: root,
    dbPath,
    initialize(store) {
      const inserted = store.execute("INSERT INTO store_metadata(key,value,updated_at) VALUES('isolated_prepared','yes','2026-07-14T00:00:00.000Z');");
      assert.equal(inserted.ok, true);
    },
  });
  assert.equal(prepared.connectionClosed, true);
  assert.equal(prepared.checkpointMode, 'TRUNCATE');
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}-shm`), false);
  const readOnly = createReadOnlyPaperStore({ root, runtimeRoot: root, dbPath });
  try {
    assert.equal(readOnly.query("SELECT value FROM store_metadata WHERE key='isolated_prepared';").rows[0].value, 'yes');
  } finally {
    readOnly.close();
  }
});

test('read-only StorePort rejects writes and preserves database bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-readonly-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'hepta-paper.sqlite');
  createDefaultPaperStore({ root, runtimeRoot: root, dbPath });
  const before = sha(dbPath);
  const store = createReadOnlyPaperStore({ root, runtimeRoot: root, dbPath });
  const migrationPreflight = preflightStoreMigrations(store);
  assert.equal(
    store.query('SELECT count(*) AS count FROM schema_migrations;').rows[0].count,
    migrationPreflight.targetVersion,
  );
  assert.equal(store.execute("DELETE FROM schema_migrations;").ok, false);
  assert.equal(store.execute("DELETE FROM schema_migrations;").error, 'sqlite_readonly_store_execute_forbidden');
  assert.equal(sha(dbPath), before);
});

test('native SQLite adapter rolls back a failed multi-statement transaction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sqlite-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const failed = store.execute("BEGIN IMMEDIATE; INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(8,'duplicate','duplicate'); COMMIT;");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /UNIQUE constraint failed/);
  const recovered = store.execute("BEGIN IMMEDIATE; INSERT INTO store_metadata(key,value,updated_at) VALUES('rollback_probe','ok',datetime('now')); COMMIT;");
  assert.equal(recovered.ok, true);
  assert.equal(store.query("SELECT value FROM store_metadata WHERE key='rollback_probe';").rows[0].value, 'ok');
  store.close();
});

test('runtime evidence hygiene qualifies each immutable receipt at most once', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-hygiene-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const assetRoot = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  const store = createDefaultPaperStore({ root: assetRoot, runtimeRoot });
  const inserted = store.execute(`INSERT INTO receipt_ledger(
    receipt_id,stream,kind,status,receipt_json,receipt_sha256,created_at,
    environment,evidence_class,writer_trusted,issuer_assurance
  ) VALUES(
    'runtime-unclassified-fixture','fixture','FixtureReceipt','complete','{}','sha256:fixture',
    '2026-07-13T00:00:00.000Z','production','runtime_unclassified',0,'legacy_unclassified'
  );`);
  assert.equal(inserted.ok, true);
  store.close();
  const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const run = () => spawnSync(process.execPath, ['paper-core/bin/runtime-hygiene.mjs', '--execute'], {
    cwd: workspaceRoot,
    env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot, HEPTA_PAPER_ASSET_ROOT: assetRoot },
    encoding: 'utf8',
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).receiptQualificationCount, 1);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).receiptQualificationCount, 0);
  const verified = createReadOnlyPaperStore({ root: assetRoot, runtimeRoot });
  try {
    assert.equal(verified.query("SELECT count(*) AS count FROM receipt_ledger_qualifications WHERE receipt_id='runtime-unclassified-fixture';").rows[0].count, 1);
  } finally {
    verified.close();
  }
});

test('remediation selftest refuses a non-isolated runtime before touching its store', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-selftest-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'hepta-paper.sqlite');
  createDefaultPaperStore({ root, runtimeRoot: root, dbPath });
  const before = sha(dbPath);
  const result = spawnSync(process.execPath, ['paper-core/verification/remediation-selftest.mjs'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: root, HEPTA_PAPER_RUNTIME_ISOLATED: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires HEPTA_PAPER_RUNTIME_ISOLATED=1/);
  assert.equal(sha(dbPath), before);
});
