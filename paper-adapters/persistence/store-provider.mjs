import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
import { createReadOnlySqliteStore, createSqliteStore } from './sqlite-store.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrations = [
  { version: 1, name: '001_initial', path: path.join(workspaceRoot, 'store', 'migrations', '001_initial.sql') },
  { version: 2, name: '002_runtime_ledger', path: path.join(workspaceRoot, 'store', 'migrations', '002_runtime_ledger.sql') },
  { version: 3, name: '003_evidence_isolation', path: path.join(workspaceRoot, 'store', 'migrations', '003_evidence_isolation.sql') },
  { version: 4, name: '004_automation_campaigns', path: path.join(workspaceRoot, 'store', 'migrations', '004_automation_campaigns.sql') },
  { version: 5, name: '005_automation_operations', path: path.join(workspaceRoot, 'store', 'migrations', '005_automation_operations.sql') },
  { version: 6, name: '006_multiprocess_automation', path: path.join(workspaceRoot, 'store', 'migrations', '006_multiprocess_automation.sql') },
  { version: 7, name: '007_campaign_lineage_backfill', path: path.join(workspaceRoot, 'store', 'migrations', '007_campaign_lineage_backfill.sql') },
  { version: 8, name: '008_reviewer_identity_backfill', path: path.join(workspaceRoot, 'store', 'migrations', '008_reviewer_identity_backfill.sql') },
  { version: 9, name: '009_resource_admission_queue', path: path.join(workspaceRoot, 'store', 'migrations', '009_resource_admission_queue.sql') },
  { version: 10, name: '010_resource_admission_metadata', path: path.join(workspaceRoot, 'store', 'migrations', '010_resource_admission_metadata.sql') },
  { version: 11, name: '011_workspace_lineage', path: path.join(workspaceRoot, 'store', 'migrations', '011_workspace_lineage.sql') },
  { version: 12, name: '012_schema_metadata_consistency', path: path.join(workspaceRoot, 'store', 'migrations', '012_schema_metadata_consistency.sql') },
  { version: 13, name: '013_campaign_telemetry', path: path.join(workspaceRoot, 'store', 'migrations', '013_campaign_telemetry.sql') },
  { version: 14, name: '014_legacy_native_lineage', path: path.join(workspaceRoot, 'store', 'migrations', '014_legacy_native_lineage.sql') },
  { version: 15, name: '015_submission_boundary_hardening', path: path.join(workspaceRoot, 'store', 'migrations', '015_submission_boundary_hardening.sql') },
  { version: 16, name: '016_submission_delivery_leases', path: path.join(workspaceRoot, 'store', 'migrations', '016_submission_delivery_leases.sql') },
  { version: 17, name: '017_trusted_evidence_and_response_consumption', path: path.join(workspaceRoot, 'store', 'migrations', '017_trusted_evidence_and_response_consumption.sql') },
  { version: 18, name: '018_append_only_receipt_ledger', path: path.join(workspaceRoot, 'store', 'migrations', '018_append_only_receipt_ledger.sql') },
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
  const checkpoint = store.checkpoint?.({ mode: 'TRUNCATE' });
  if (checkpoint && !checkpoint.ok) throw new Error(checkpoint.error || 'store migration checkpoint failed');
  return store;
}

export function createDefaultPaperStore({ root, runtimeRoot = null, dbPath = null, maxBuffer } = {}) {
  const resolved = dbPath || heptaStorePath(root, runtimeRoot);
  return applyStoreMigrations(createSqliteStore({ dbPath: resolved, maxBuffer }));
}

export function createReadOnlyPaperStore({ root, runtimeRoot = null, dbPath = null, maxBuffer } = {}) {
  const resolved = dbPath || heptaStorePath(root, runtimeRoot);
  if (!fs.existsSync(resolved)) throw new Error(`Read-only paper store missing: ${resolved}`);
  return createReadOnlySqliteStore({ dbPath: resolved, maxBuffer });
}
