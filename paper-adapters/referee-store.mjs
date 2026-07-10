import { safeJsonParse } from '../paper-core/src/utils.mjs';
import { createSqliteStore } from './persistence/sqlite-store.mjs';
import { sqlEscape as escapeSqlText, sqlJson, sqlText } from '../paper-ports/store-port.mjs';

export function sqliteJson(dbPath, sql) {
  return createSqliteStore({ dbPath }).query(sql).rows;
}

export function sqliteExec(dbPath, sql) {
  const result = createSqliteStore({ dbPath }).execute(sql);
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

export { escapeSqlText, sqlJson, sqlText };

export function normalizePatch(row = {}) {
  return {
    ...row,
    targetPaths: safeJsonParse(row.target_paths_json || '[]', []),
    metadata: safeJsonParse(row.metadata_json || '{}', {}),
  };
}

export function normalizeRequest(row = {}) {
  return {
    ...row,
    metadata: safeJsonParse(row.metadata_json || '{}', {}),
  };
}
