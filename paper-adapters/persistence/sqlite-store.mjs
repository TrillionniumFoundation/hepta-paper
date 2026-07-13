import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import { assertStorePort } from '../../paper-ports/store-port.mjs';

function failure(error, fallback) {
  return {
    ok: false,
    status: 1,
    stdout: '',
    stderr: String(error?.message || fallback),
    error: normalizeText(error?.message || fallback),
  };
}

function openDatabase({ dbPath, readOnly = false, busyTimeoutMs = 10_000 } = {}) {
  const resolved = path.resolve(dbPath);
  if (!readOnly) fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new DatabaseSync(resolved, { readOnly });
  database.exec(`PRAGMA busy_timeout=${Math.max(1, Number(busyTimeoutMs || 10_000))};`);
  database.exec('PRAGMA foreign_keys=ON;');
  if (!readOnly) {
    database.exec('PRAGMA journal_mode=WAL;');
    database.exec('PRAGMA synchronous=NORMAL;');
  }
  return database;
}

function createPort({ dbPath, readOnly = false, busyTimeoutMs = 10_000 } = {}) {
  if (!dbPath) throw new Error('SQLite store dbPath is required');
  if (readOnly && !fs.existsSync(dbPath)) throw new Error('sqlite_readonly_database_missing');
  const database = openDatabase({ dbPath, readOnly, busyTimeoutMs });
  let closed = false;
  return assertStorePort({
    version: 2,
    kind: readOnly ? 'ReadOnlySqliteStoreAdapter' : 'SqliteStoreAdapter',
    dbPath,
    query(sql) {
      try {
        const rows = database.prepare(String(sql || '')).all().map((row) => ({ ...row }));
        return { ok: true, status: 0, stdout: JSON.stringify(rows), stderr: '', error: null, rows };
      } catch (error) {
        return { ...failure(error, 'sqlite_query_failed'), rows: [] };
      }
    },
    execute(sql) {
      if (readOnly) return failure(new Error('sqlite_readonly_store_execute_forbidden'), 'sqlite_readonly_store_execute_forbidden');
      try {
        database.exec(String(sql || ''));
        return { ok: true, status: 0, stdout: '', stderr: '', error: null };
      } catch (error) {
        if (database.isTransaction) {
          try { database.exec('ROLLBACK;'); } catch { /* preserve the original SQLite error */ }
        }
        return failure(error, 'sqlite_execute_failed');
      }
    },
    available() {
      try {
        database.prepare('SELECT 1 AS available').get();
        return true;
      } catch {
        return false;
      }
    },
    checkpoint({ mode = 'PASSIVE' } = {}) {
      if (readOnly) return { ok: true, status: 0, stdout: '', stderr: '', error: null };
      try {
        const normalized = String(mode || 'PASSIVE').toUpperCase();
        if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalized)) {
          throw new Error('sqlite_checkpoint_mode_invalid');
        }
        const row = database.prepare(`PRAGMA wal_checkpoint(${normalized})`).get();
        return { ok: true, status: 0, stdout: JSON.stringify(row || {}), stderr: '', error: null, row: row ? { ...row } : null };
      } catch (error) {
        return failure(error, 'sqlite_checkpoint_failed');
      }
    },
    close() {
      if (!closed) database.close();
      closed = true;
    },
  });
}

export function createSqliteStore({ dbPath, busyTimeoutMs = 10_000 } = {}) {
  return createPort({ dbPath, busyTimeoutMs, readOnly: false });
}

export function createReadOnlySqliteStore({ dbPath, busyTimeoutMs = 10_000 } = {}) {
  return createPort({ dbPath, busyTimeoutMs, readOnly: true });
}
