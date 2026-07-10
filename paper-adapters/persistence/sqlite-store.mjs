import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeText, safeJsonParse } from '../../paper-core/src/utils.mjs';
import { assertStorePort } from '../../paper-ports/store-port.mjs';

export function createSqliteStore({ dbPath, sqliteBinary = 'sqlite3', maxBuffer = 32 * 1024 * 1024 } = {}) {
  if (!dbPath) throw new Error('SQLite store dbPath is required');
  const run = (sql, { json = false } = {}) => {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const args = json ? ['-json', dbPath] : [dbPath];
    const result = spawnSync(sqliteBinary, args, {
      input: String(sql || ''),
      encoding: 'utf8',
      maxBuffer,
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    return {
      ok: result.status === 0,
      status: result.status,
      stdout,
      stderr,
      error: result.status === 0 ? null : normalizeText(stderr || stdout || 'sqlite_query_failed'),
    };
  };
  const port = {
    version: 1,
    kind: 'SqliteStoreAdapter',
    dbPath,
    query(sql) {
      const result = run(sql, { json: true });
      return { ...result, rows: result.ok ? safeJsonParse(result.stdout || '[]', []) : [] };
    },
    execute(sql) {
      return run(sql);
    },
    available() {
      const result = spawnSync(sqliteBinary, ['-version'], { encoding: 'utf8' });
      return result.status === 0;
    },
  };
  return assertStorePort(port);
}
