import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStoreQueryResult } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED = Object.freeze([
  Object.freeze({ version: 21, name: '021_job_lease_fencing' }),
  Object.freeze({ version: 22, name: '022_campaign_attempt_fencing' }),
  Object.freeze({ version: 23, name: '023_workspace_retention_qualification' }),
]);

function expectedMigration(item) {
  const file = path.join(workspaceRoot, 'store', 'migrations', `${item.name}.sql`);
  const migrationSha256 = sha256FileSync(file);
  return Object.freeze({ ...item, migrationSha256 });
}

export function assertScopedSchemaVersion({ store, allowUnavailable = false, rootKind = 'scoped' } = {}) {
  if (!store?.query) throw new Error('scoped_schema_store_required');
  if (allowUnavailable && typeof store.available === 'function' && !store.available()) {
    const payload = {
      version: 1,
      kind: 'ScopedSchemaVersionGateReceipt',
      status: 'scoped_schema_gate_unavailable_read_only_store',
      rootKind,
      requiredVersions: [21, 22, 23],
      observedVersions: [],
      blockers: [],
    };
    return Object.freeze({ ...payload, scopedSchemaVersionGateReceiptHash: hashRecord('ScopedSchemaVersionGateReceipt', payload) });
  }
  const result = assertStoreQueryResult(store.query('SELECT version,name,migration_sha256 FROM schema_migrations WHERE version IN (21,22,23) ORDER BY version;'));
  const expected = REQUIRED.map(expectedMigration);
  const rows = result.rows || [];
  const blockers = [];
  for (const migration of expected) {
    const observed = rows.find((row) => Number(row.version) === migration.version);
    if (!observed) blockers.push(`scoped_schema_migration_${migration.version}_required`);
    else if (observed.name !== migration.name || observed.migration_sha256 !== migration.migrationSha256) {
      blockers.push(`scoped_schema_migration_${migration.version}_history_mismatch`);
    }
  }
  if (blockers.length) throw new Error(`scoped_schema_version_gate_failed:${blockers.join(',')}`);
  const payload = {
    version: 1,
    kind: 'ScopedSchemaVersionGateReceipt',
    status: 'scoped_schema_version_verified',
    rootKind,
    requiredVersions: expected.map((item) => item.version),
    observedVersions: rows.map((row) => Number(row.version)),
    migrationHashes: Object.fromEntries(expected.map((item) => [item.version, item.migrationSha256])),
    blockers: [],
  };
  return Object.freeze({ ...payload, scopedSchemaVersionGateReceiptHash: hashRecord('ScopedSchemaVersionGateReceipt', payload) });
}
