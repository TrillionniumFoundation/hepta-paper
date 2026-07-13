import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('read-only StorePort rejects writes and preserves database bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-readonly-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'hepta-paper.sqlite');
  createDefaultPaperStore({ root, runtimeRoot: root, dbPath });
  const before = sha(dbPath);
  const store = createReadOnlyPaperStore({ root, runtimeRoot: root, dbPath });
  assert.equal(store.query('SELECT count(*) AS count FROM schema_migrations;').rows[0].count, 18);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-hygiene-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
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
    env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: root, HEPTA_PAPER_ASSET_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(run().status, 0);
  assert.equal(run().status, 0);
  const verified = createReadOnlyPaperStore({ root, runtimeRoot: root });
  assert.equal(verified.query("SELECT count(*) AS count FROM receipt_ledger_qualifications WHERE receipt_id='runtime-unclassified-fixture';").rows[0].count, 1);
});

test('remediation selftest refuses a non-isolated runtime before touching its store', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-selftest-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'hepta-paper.sqlite');
  createDefaultPaperStore({ root, runtimeRoot: root, dbPath });
  const before = sha(dbPath);
  const result = spawnSync(process.execPath, ['paper-core/src/remediation-selftest.mjs'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: root, HEPTA_PAPER_RUNTIME_ISOLATED: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires HEPTA_PAPER_RUNTIME_ISOLATED=1/);
  assert.equal(sha(dbPath), before);
});
