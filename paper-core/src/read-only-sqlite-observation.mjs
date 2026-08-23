import { createReadOnlySqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';

// Verification-only SQLite inspection.  The adapter is opened in immutable
// mode and no mutation API is exposed to the caller.
export function inspectReadOnlySqliteDatabase({
  dbPath,
  expectedSchemaContractId = null,
  absolute,
  regularFile,
} = {}) {
  if (!dbPath) return {
    path: null,
    present: false,
    readable: false,
    blockers: ['database_path_missing'],
  };
  const selected = absolute(dbPath, dbPath);
  const file = regularFile(selected, { maximumBytes: 1024 * 1024 * 1024 });
  if (!file.present) return {
    path: selected,
    present: false,
    readable: false,
    blockers: ['database_missing'],
  };
  if (!file.safe) return {
    path: selected,
    present: true,
    readable: false,
    blockers: ['database_file_unsafe'],
  };
  let store = null;
  try {
    store = createReadOnlySqliteStore({ dbPath: selected, immutable: true });
    const quickCheck = store.query('PRAGMA quick_check;').rows[0]?.quick_check || 'unknown';
    const objects = store.query(`SELECT type,name FROM sqlite_master
      WHERE type IN ('table','index','trigger','view') ORDER BY type,name;`).rows;
    const migrationTable = expectedSchemaContractId?.startsWith('autonomous-submission-handoff')
      ? 'handoff_schema_migrations' : 'schema_migrations';
    const hasMigrations = objects.some((row) => row.type === 'table' && row.name === migrationTable);
    const migration = hasMigrations
      ? (store.query(`SELECT coalesce(max(version),0) AS version FROM "${migrationTable}";`).rows[0] || {})
      : {};
    const hasOnlineMarker = objects.some((row) => row.name === 'autonomous_research_online_mutation_authority_marker');
    const hasFinalization = objects.some((row) => row.name === 'autonomous_research_online_mutation_finalization_receipt');
    const blockers = [];
    if (quickCheck !== 'ok') blockers.push('database_quick_check_failed');
    if (expectedSchemaContractId && objects.length === 0) blockers.push('database_schema_objects_missing');
    const expectedSchemaVersion = /-v(\d+)$/i.exec(String(expectedSchemaContractId || ''));
    if (expectedSchemaVersion && Number(migration.version || 0) < Number(expectedSchemaVersion[1])) {
      blockers.push('database_schema_contract_version_mismatch');
    }
    if (!hasOnlineMarker || !hasFinalization) blockers.push('database_online_anti_rollback_markers_missing');
    return {
      path: selected,
      present: true,
      readable: true,
      quickCheck,
      schemaObjectCount: objects.length,
      schemaVersion: Number(migration.version || 0),
      migrationTable,
      antiRollbackMarkerPresent: hasOnlineMarker && hasFinalization,
      expectedSchemaContractId,
      blockers,
    };
  } catch (error) {
    return {
      path: selected,
      present: true,
      readable: false,
      blockers: [`database_read_only_inspection_failed:${String(error?.message || 'unknown')}`],
    };
  } finally {
    try { store?.close(); } catch { /* read-only cleanup */ }
  }
}
