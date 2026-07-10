#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heptaStorePath, legacyStorePath } from '../src/hepta-store.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(workspaceRoot, '..');
const dbPath = heptaStorePath(root);
const legacyPath = legacyStorePath(root);
const migrationPath = path.join(workspaceRoot, 'store', 'migrations', '001_initial.sql');
const store = createSqliteStore({ dbPath });

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSql(sql, { json = false } = {}) {
  const result = json ? store.query(sql) : store.execute(sql);
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || 'sqlite3 failed');
  return json ? JSON.stringify(result.rows) : result.stdout;
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function initialize() {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  runSql(`${sql}\nINSERT OR IGNORE INTO schema_migrations(version,name,migration_sha256) VALUES(1,'001_initial',${sqlQuote(`sha256:${fileSha256(migrationPath)}`)});`);
}

function migrateLegacy() {
  initialize();
  if (!fs.existsSync(legacyPath)) throw new Error(`Legacy store missing: ${legacyPath}`);
  const sourceHash = `sha256:${fileSha256(legacyPath)}`;
  runSql(`
PRAGMA foreign_keys=OFF;
ATTACH DATABASE ${sqlQuote(legacyPath)} AS legacy;
BEGIN IMMEDIATE;
DELETE FROM audit_receipts;
DELETE FROM workflow_states;
DELETE FROM patch_queue;
DELETE FROM referee_revision_requests;
DELETE FROM artifacts;
DELETE FROM submissions;
DELETE FROM submission_ledger;
DELETE FROM venues;
DELETE FROM papers;
INSERT INTO papers SELECT * FROM legacy.papers;
INSERT INTO venues SELECT * FROM legacy.venues;
INSERT INTO submission_ledger SELECT l.* FROM legacy.submission_ledger l JOIN papers p ON p.slug=l.slug;
INSERT INTO submissions SELECT s.* FROM legacy.submissions s JOIN papers p ON p.slug=s.slug;
INSERT INTO artifacts SELECT a.* FROM legacy.artifacts a JOIN papers p ON p.slug=a.slug;
INSERT INTO referee_revision_requests SELECT r.* FROM legacy.referee_revision_requests r JOIN papers p ON p.slug=r.slug;
INSERT INTO patch_queue SELECT q.* FROM legacy.patch_queue q JOIN papers p ON p.slug=q.slug;
INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('store_role','hepta-paper-native',datetime('now')),
  ('legacy_import_source',${sqlQuote(legacyPath)},datetime('now')),
  ('legacy_import_sha256',${sqlQuote(sourceHash)},datetime('now')),
  ('legacy_imported_at',datetime('now'),datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
COMMIT;
DETACH DATABASE legacy;
PRAGMA foreign_keys=ON;
`);
}

function status() {
  initialize();
  const rows = JSON.parse(runSql(`
SELECT 'papers' AS name,count(*) AS count FROM papers
UNION ALL SELECT 'venues',count(*) FROM venues
UNION ALL SELECT 'submission_ledger',count(*) FROM submission_ledger
UNION ALL SELECT 'submissions',count(*) FROM submissions
UNION ALL SELECT 'artifacts',count(*) FROM artifacts
UNION ALL SELECT 'referee_revision_requests',count(*) FROM referee_revision_requests
UNION ALL SELECT 'patch_queue',count(*) FROM patch_queue;
`, { json: true }) || '[]');
  const metadata = JSON.parse(runSql('SELECT key,value,updated_at FROM store_metadata ORDER BY key;', { json: true }) || '[]');
  const quickCheck = runSql('PRAGMA quick_check;').trim();
  return {
    version: 1,
    kind: 'HeptaNativeStoreStatus',
    status: quickCheck === 'ok' ? 'hepta_native_store_ready' : 'hepta_native_store_blocked',
    dbPath,
    schemaVersion: 1,
    quickCheck,
    tables: Object.fromEntries(rows.map((row) => [row.name, Number(row.count)])),
    metadata,
    legacyDefaultDependency: false,
  };
}

const command = process.argv[2] || 'status';
if (command === 'init') initialize();
else if (command === 'migrate-legacy') migrateLegacy();
else if (command !== 'status') throw new Error(`Unknown hepta-store command: ${command}`);
process.stdout.write(`${JSON.stringify(status(), null, 2)}\n`);
