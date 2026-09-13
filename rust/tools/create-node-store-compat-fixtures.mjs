#!/usr/bin/env node
// Creates disposable fixtures through the actual production Node store API.
// Usage: node rust/tools/create-node-store-compat-fixtures.mjs <empty-output-dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createReadOnlySqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { buildSqliteLogicalIntegrityReport } from '../../paper-adapters/persistence/sqlite-logical-integrity.mjs';

const output = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('output_directory_required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
if (fs.readdirSync(output).length) throw new Error('output_directory_must_be_empty');
const reports = [];
const timestamp = '2026-01-01 00:00:00';
for (let version = 1; version <= 25; version += 1) {
  const dbPath = path.join(output, `node-v${version}.sqlite`);
  const store = createDefaultPaperStore({ dbPath, targetVersion: version });
  try {
    for (const slug of ['paper-b', 'paper-a']) {
      assert.equal(store.run(`INSERT INTO papers(slug,title,canonical_dir,created_at,updated_at,metadata_json)
        VALUES(?,?,?,?,?,?)`, [slug, 'Rust parity 中文 🧪', `papers/${slug}`, timestamp, timestamp,
      '{"2":4,"10":3,"unicode":"é"}']).ok, true);
    }
    assert.equal(store.run('UPDATE schema_migrations SET applied_at=?', [timestamp]).ok, true);
    assert.equal(store.run('UPDATE store_metadata SET updated_at=?', [timestamp]).ok, true);
    // Real production columns exercise NULL, INTEGER, REAL, TEXT and BLOB affinity.
    assert.equal(store.run(`INSERT INTO artifacts(artifact_id,slug,kind,path,sha256,bytes,created_at)
      VALUES(?,?,?,?,?,?,?)`, [1, 'paper-a', 'fixture', 'a.bin', new Uint8Array([0, 1, 255, 2, 5, 6, 7, 8, 9, 10, 11, 12]),
      0.0000008, timestamp]).ok, true);
    assert.equal(store.run(`INSERT INTO artifacts(artifact_id,slug,kind,path,bytes,created_at)
      VALUES(?,?,?,?,?,?)`, [2, 'paper-b', 'fixture', 'b.bin', null, timestamp]).ok, true);
    assert.equal(store.run(`INSERT INTO artifacts(artifact_id,slug,kind,path,bytes,created_at)
      VALUES(?,?,?,?,?,?)`, [3, 'paper-b', 'fixture', 'c.bin', 9007199254740991, timestamp]).ok, true);
  } finally { store.close(); }
  const before = fs.readFileSync(dbPath);
  const readonly = createReadOnlySqliteStore({ dbPath, immutable: true });
  let report;
  try {
    assert.equal(readonly.query('SELECT user_version FROM pragma_user_version').rows[0].user_version, 0);
    assert.equal(readonly.query('SELECT application_id FROM pragma_application_id').rows[0].application_id, 0);
    report = buildSqliteLogicalIntegrityReport({ dbPath, store: readonly, rowBatchSize: 2 });
  } finally { readonly.close(); }
  assert.equal(report.status, 'sqlite_logical_integrity_verified');
  assert.deepEqual(fs.readFileSync(dbPath), before);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(`${dbPath}${suffix}`), false);
  reports.push({ version, file: path.basename(dbPath), report });
}
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(reports, null, 2)}\n`);
process.stdout.write(`Generated ${reports.length} production Node migration fixtures\n`);
