import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
import { assertStorePort } from '../../paper-ports/store-port.mjs';
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
  { version: 19, name: '019_effective_receipt_ledger', path: path.join(workspaceRoot, 'store', 'migrations', '019_effective_receipt_ledger.sql') },
  { version: 20, name: '020_monotonic_receipt_qualification', path: path.join(workspaceRoot, 'store', 'migrations', '020_monotonic_receipt_qualification.sql') },
  { version: 21, name: '021_job_lease_fencing', path: path.join(workspaceRoot, 'store', 'migrations', '021_job_lease_fencing.sql') },
  { version: 22, name: '022_campaign_attempt_fencing', path: path.join(workspaceRoot, 'store', 'migrations', '022_campaign_attempt_fencing.sql') },
  { version: 23, name: '023_workspace_retention_qualification', path: path.join(workspaceRoot, 'store', 'migrations', '023_workspace_retention_qualification.sql') },
];

const latestMigrationVersion = migrations.at(-1).version;
const offlineCutoverMigrationVersions = new Set([21, 22, 23]);

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function migrationHash(migration) {
  const sql = fs.readFileSync(migration.path, 'utf8');
  return Object.freeze({
    ...migration,
    sql,
    hash: `sha256:${crypto.createHash('sha256').update(sql).digest('hex')}`,
  });
}

function normalizedTargetVersion(targetVersion) {
  const normalized = Number(targetVersion ?? latestMigrationVersion);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > latestMigrationVersion) {
    throw new Error(`store_migration_target_version_invalid:${targetVersion}`);
  }
  return normalized;
}

function queryRows(store, sql, failureCode) {
  const result = store.query(sql);
  if (!result.ok) throw new Error(`${failureCode}:${result.error || result.stderr || 'unknown'}`);
  return result.rows || [];
}

function hasTable(store, tableName) {
  return queryRows(
    store,
    `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlQuote(tableName)} LIMIT 1;`,
    'store_migration_catalog_query_failed',
  ).length === 1;
}

function appliedMigrationRows(store) {
  if (!hasTable(store, 'schema_migrations')) return [];
  return queryRows(
    store,
    'SELECT version,name,migration_sha256 FROM schema_migrations ORDER BY version;',
    'store_migration_history_query_failed',
  );
}

function validateMigrationHistory(rows) {
  const descriptors = new Map(migrations.map((migration) => {
    const descriptor = migrationHash(migration);
    return [descriptor.version, descriptor];
  }));
  const applied = new Map();
  for (const row of rows) {
    const version = Number(row.version);
    const expected = descriptors.get(version);
    if (!expected || applied.has(version) || row.name !== expected.name || row.migration_sha256 !== expected.hash) {
      throw new Error(`store migration ${version} history mismatch`);
    }
    applied.set(version, row);
  }
  return applied;
}

function countRows(store, tableName, where) {
  if (!hasTable(store, tableName)) return 0;
  const rows = queryRows(
    store,
    `SELECT count(*) AS count FROM ${tableName} WHERE ${where};`,
    `store_offline_migration_${tableName}_lease_query_failed`,
  );
  return Number(rows[0]?.count || 0);
}

function submissionLeaseCount(store) {
  let count = 0;
  if (hasTable(store, 'submission_outbox')) {
    const columns = new Set(queryRows(
      store,
      'SELECT name FROM pragma_table_info(\'submission_outbox\');',
      'store_offline_migration_submission_outbox_columns_query_failed',
    ).map((row) => row.name));
    const markers = ["status='in_flight'"];
    for (const column of ['claimed_by', 'lease_token', 'lease_expires_at']) {
      if (columns.has(column)) markers.push(`${column} IS NOT NULL`);
    }
    count += countRows(store, 'submission_outbox', markers.join(' OR '));
  }
  if (hasTable(store, 'submission_response_consumption')) {
    count += countRows(
      store,
      'submission_response_consumption',
      "state='IN_PROGRESS' OR claimed_by IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL",
    );
  }
  return count;
}

function assertOfflineCutoverReady(store, applied, targetVersion) {
  if (!applied.size) return;
  const pendingOfflineCutover = migrations.some((migration) => (
    migration.version <= targetVersion
    && !applied.has(migration.version)
    && offlineCutoverMigrationVersions.has(migration.version)
  ));
  if (!pendingOfflineCutover) return;
  const liveLeases = Object.freeze({
    jobs: countRows(store, 'jobs', "status IN ('leased','running') OR lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL"),
    campaigns: countRows(store, 'campaign_nodes', "status IN ('leased','running') OR lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL"),
    submissions: submissionLeaseCount(store),
  });
  if (Object.values(liveLeases).some((count) => count > 0)) {
    throw new Error(`store_offline_migration_live_leases_present:jobs=${liveLeases.jobs},campaigns=${liveLeases.campaigns},submissions=${liveLeases.submissions}`);
  }
}

export function preflightStoreMigrations(store, { targetVersion = latestMigrationVersion, requireOfflineFilesystem = false } = {}) {
  const target = normalizedTargetVersion(targetVersion);
  const applied = validateMigrationHistory(appliedMigrationRows(store));
  const pendingOfflineCutover = migrations.some((migration) => (
    migration.version <= target
    && !applied.has(migration.version)
    && offlineCutoverMigrationVersions.has(migration.version)
  ));
  if (requireOfflineFilesystem && pendingOfflineCutover && store.dbPath) {
    const sidecars = [`${store.dbPath}-wal`, `${store.dbPath}-shm`].filter((candidate) => fs.existsSync(candidate));
    if (sidecars.length) throw new Error(`store_offline_migration_active_wal_present:${sidecars.map((candidate) => path.basename(candidate)).join(',')}`);
  }
  assertOfflineCutoverReady(store, applied, target);
  return Object.freeze({ targetVersion: target, appliedVersions: Object.freeze([...applied.keys()]) });
}

export function applyStoreMigrations(store, { targetVersion = latestMigrationVersion } = {}) {
  const target = normalizedTargetVersion(targetVersion);
  const preflight = preflightStoreMigrations(store, { targetVersion: target });
  const applied = new Map();
  for (const version of preflight.appliedVersions) applied.set(version, true);
  for (const migration of migrations) {
    if (migration.version > target || applied.has(migration.version)) continue;
    const descriptor = migrationHash(migration);
    const result = store.execute(`BEGIN IMMEDIATE;\n${descriptor.sql}\nINSERT INTO schema_migrations(version,name,migration_sha256) VALUES(${migration.version},${sqlQuote(migration.name)},${sqlQuote(descriptor.hash)});\nCOMMIT;`);
    if (!result.ok) throw new Error(result.error || result.stderr || `store migration ${migration.version} failed`);
    applied.set(migration.version, true);
  }
  const checkpoint = store.checkpoint?.({ mode: 'TRUNCATE' });
  if (checkpoint && !checkpoint.ok) throw new Error(checkpoint.error || 'store migration checkpoint failed');
  return store;
}

export function createDefaultPaperStore({ root, runtimeRoot = null, dbPath = null, maxBuffer, targetVersion = latestMigrationVersion } = {}) {
  const resolved = dbPath || heptaStorePath(root, runtimeRoot);
  const target = normalizedTargetVersion(targetVersion);
  if (fs.existsSync(resolved)) {
    const inspector = createReadOnlySqliteStore({ dbPath: resolved, maxBuffer, immutable: true });
    try {
      preflightStoreMigrations(inspector, { targetVersion: target, requireOfflineFilesystem: true });
    } finally {
      inspector.close();
    }
  }
  const store = createSqliteStore({ dbPath: resolved, maxBuffer });
  try {
    return applyStoreMigrations(store, { targetVersion: target });
  } catch (error) {
    store.close();
    throw error;
  }
}

export function openExistingWritablePaperStore({ root, runtimeRoot = null, dbPath = null, maxBuffer } = {}) {
  const resolved = dbPath || heptaStorePath(root, runtimeRoot);
  if (!fs.existsSync(resolved)) throw new Error(`paper_store_not_initialized:run_store_migrate:${resolved}`);
  return createSqliteStore({ dbPath: resolved, maxBuffer });
}

function createMissingReadOnlyPaperStore(dbPath) {
  const missing = () => ({ ok: false, status: 1, stdout: '', stderr: 'sqlite_readonly_database_missing', error: 'sqlite_readonly_database_missing', rows: [] });
  return assertStorePort(Object.freeze({
    version: 3,
    kind: 'MissingReadOnlySqliteStoreAdapter',
    dbPath,
    readOnly: true,
    query: missing,
    run: () => ({ ...missing(), error: 'sqlite_readonly_store_execute_forbidden', stderr: 'sqlite_readonly_store_execute_forbidden' }),
    execute: () => ({ ...missing(), error: 'sqlite_readonly_store_execute_forbidden', stderr: 'sqlite_readonly_store_execute_forbidden' }),
    available: () => false,
    checkpoint: () => ({ ok: true, status: 0, stdout: '', stderr: '', error: null }),
    close() {},
  }));
}

export function createReadOnlyPaperStore({ root, runtimeRoot = null, dbPath = null, maxBuffer, allowMissing = false, immutable = false } = {}) {
  const resolved = dbPath || heptaStorePath(root, runtimeRoot);
  if (!fs.existsSync(resolved)) {
    if (allowMissing) return createMissingReadOnlyPaperStore(resolved);
    throw new Error(`Read-only paper store missing: ${resolved}`);
  }
  return createReadOnlySqliteStore({ dbPath: resolved, maxBuffer, immutable });
}
