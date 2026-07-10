import { safeJsonParse } from '../paper-core/src/runtime/data-utils.mjs';
import {
  assertStorePort,
  sqlEscape as escapeSqlText,
  sqlJson,
  sqlText,
} from '../paper-ports/store-port.mjs';

export function sqliteJson(store, sql) {
  return assertStorePort(store).query(sql).rows;
}

export function sqliteExec(store, sql) {
  const result = assertStorePort(store).execute(sql);
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
