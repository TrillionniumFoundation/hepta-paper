import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStoreQueryResult } from '../../paper-ports/store-port.mjs';
import {
  REQUIRED_SCOPED_SCHEMA_MIGRATIONS,
  REQUIRED_SCOPED_SCHEMA_VERSIONS,
} from '../../paper-domain/automation/scoped-schema-version-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
      requiredVersions: REQUIRED_SCOPED_SCHEMA_VERSIONS,
      observedVersions: [],
      blockers: [],
    };
    return Object.freeze({ ...payload, scopedSchemaVersionGateReceiptHash: hashRecord('ScopedSchemaVersionGateReceipt', payload) });
  }
  const result = assertStoreQueryResult(store.query(`SELECT version,name,migration_sha256
    FROM schema_migrations
    WHERE version IN (${REQUIRED_SCOPED_SCHEMA_VERSIONS.join(',')})
    ORDER BY version;`));
  const expected = REQUIRED_SCOPED_SCHEMA_MIGRATIONS.map(expectedMigration);
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
