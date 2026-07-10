import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heptaStorePath } from '../../paper-core/src/hepta-store.mjs';
import { createSqliteStore } from './sqlite-store.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrations = [
  { version: 1, name: '001_initial', path: path.join(workspaceRoot, 'store', 'migrations', '001_initial.sql') },
  { version: 2, name: '002_runtime_ledger', path: path.join(workspaceRoot, 'store', 'migrations', '002_runtime_ledger.sql') },
];

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function applyStoreMigrations(store) {
  const applied = new Map();
  const existing = store.query('SELECT version,name,migration_sha256 FROM schema_migrations ORDER BY version;');
  if (existing.ok) {
    for (const row of existing.rows || []) applied.set(Number(row.version), row);
  }
  for (const migration of migrations) {
    const sql = fs.readFileSync(migration.path, 'utf8');
    const hash = `sha256:${crypto.createHash('sha256').update(sql).digest('hex')}`;
    const prior = applied.get(migration.version);
    if (prior) {
      if (prior.name !== migration.name || prior.migration_sha256 !== hash) {
        throw new Error(`store migration ${migration.version} history mismatch`);
      }
      continue;
    }
    const result = store.execute(`BEGIN IMMEDIATE;\n${sql}\nINSERT INTO schema_migrations(version,name,migration_sha256) VALUES(${migration.version},${sqlQuote(migration.name)},${sqlQuote(hash)});\nCOMMIT;`);
    if (!result.ok) throw new Error(result.error || result.stderr || `store migration ${migration.version} failed`);
    applied.set(migration.version, { version: migration.version, name: migration.name, migration_sha256: hash });
  }
  return store;
}

export function createDefaultPaperStore({ root, runtimeRoot = null, dbPath = null, maxBuffer } = {}) {
  const resolved = dbPath || heptaStorePath(root, runtimeRoot);
  return applyStoreMigrations(createSqliteStore({ dbPath: resolved, maxBuffer }));
}
