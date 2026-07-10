import { spawnSync } from 'node:child_process';
import { safeJsonParse } from '../paper-core/src/utils.mjs';

export function sqliteJson(dbPath, sql) {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return safeJsonParse(result.stdout || '[]', []);
}

export function sqliteExec(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

export function escapeSqlText(value) {
  return String(value ?? '').replace(/'/g, "''");
}

export function sqlText(value) {
  return `'${escapeSqlText(value)}'`;
}

export function sqlJson(value) {
  return sqlText(JSON.stringify(value ?? null));
}

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
