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
  assert.equal(store.query('SELECT count(*) AS count FROM schema_migrations;').rows[0].count, 6);
  assert.equal(store.execute("DELETE FROM schema_migrations;").ok, false);
  assert.equal(store.execute("DELETE FROM schema_migrations;").error, 'sqlite_readonly_store_execute_forbidden');
  assert.equal(sha(dbPath), before);
});

test('native SQLite adapter rolls back a failed multi-statement transaction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sqlite-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const failed = store.execute("BEGIN IMMEDIATE; INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(6,'duplicate','duplicate'); COMMIT;");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /UNIQUE constraint failed/);
  const recovered = store.execute("BEGIN IMMEDIATE; INSERT INTO store_metadata(key,value,updated_at) VALUES('rollback_probe','ok',datetime('now')); COMMIT;");
  assert.equal(recovered.ok, true);
  assert.equal(store.query("SELECT value FROM store_metadata WHERE key='rollback_probe';").rows[0].value, 'ok');
  store.close();
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
