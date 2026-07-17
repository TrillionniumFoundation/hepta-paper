import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

function openDatabase({ dbPath, readOnly = false, immutable = false, busyTimeoutMs = 10_000 } = {}) {
  const resolved = path.resolve(dbPath);
  if (!readOnly) fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const location = immutable ? pathToFileURL(resolved) : resolved;
  if (immutable) {
    location.searchParams.set('mode', 'ro');
    location.searchParams.set('immutable', '1');
  }
  const database = new DatabaseSync(location, { readOnly });
  database.exec(`PRAGMA busy_timeout=${Math.max(1, Number(busyTimeoutMs || 10_000))};`);
  database.exec('PRAGMA foreign_keys=ON;');
  if (!readOnly) {
    database.exec('PRAGMA journal_mode=WAL;');
    database.exec('PRAGMA synchronous=NORMAL;');
  }
  return database;
}

function createPort({ dbPath, readOnly = false, immutable = false, busyTimeoutMs = 10_000 } = {}) {
  if (!dbPath) throw new Error('SQLite store dbPath is required');
  if (readOnly && !fs.existsSync(dbPath)) throw new Error('sqlite_readonly_database_missing');
  const database = openDatabase({ dbPath, readOnly, immutable, busyTimeoutMs });
  let closed = false;
  let activeTransaction = null;

  function accessError(ownerToken = null, state = null) {
    if (state && !state.active) return new Error('sqlite_transaction_scope_inactive');
    if (activeTransaction && ownerToken !== activeTransaction.owner) {
      const error = new Error('sqlite_outer_store_access_during_unit_of_work_forbidden');
      if (!activeTransaction.state.failure) activeTransaction.state.failure = error;
      return error;
    }
    return null;
  }

  function invoke(statement, operation, parameters) {
    if (Array.isArray(parameters)) return statement[operation](...parameters);
    if (parameters && typeof parameters === 'object') return statement[operation](parameters);
    return statement[operation]();
  }

  function query(sql, parameters = [], state = null, ownerToken = null) {
    const denied = accessError(ownerToken, state);
    if (denied) throw denied;
    if (closed) throw new Error('sqlite_store_closed');
    try {
      const rows = invoke(database.prepare(String(sql || '')), 'all', parameters).map((row) => ({ ...row }));
      return { ok: true, status: 0, stdout: JSON.stringify(rows), stderr: '', error: null, rows };
    } catch (error) {
      if (state && !state.failure) state.failure = error;
      if (!state && database.isTransaction) {
        try { database.exec('ROLLBACK;'); } catch { /* preserve the original SQLite error */ }
      }
      throw error;
    }
  }

  function run(sql, parameters = [], state = null, scopedReadOnly = readOnly, ownerToken = null) {
    const denied = accessError(ownerToken, state);
    if (denied) return failure(denied, denied.message);
    if (scopedReadOnly) {
      const error = new Error('sqlite_readonly_store_execute_forbidden');
      if (state && !state.failure) state.failure = error;
      return failure(error, 'sqlite_readonly_store_execute_forbidden');
    }
    try {
      const result = invoke(database.prepare(String(sql || '')), 'run', parameters);
      return {
        ok: true,
        status: 0,
        stdout: '',
        stderr: '',
        error: null,
        changes: Number(result.changes || 0),
        lastInsertRowid: result.lastInsertRowid,
      };
    } catch (error) {
      if (state && !state.failure) state.failure = error;
      return failure(error, 'sqlite_statement_failed');
    }
  }

  function execute(sql, state = null, scopedReadOnly = readOnly, ownerToken = null) {
    const denied = accessError(ownerToken, state);
    if (denied) return failure(denied, denied.message);
    if (scopedReadOnly) {
      const error = new Error('sqlite_readonly_store_execute_forbidden');
      if (state && !state.failure) state.failure = error;
      return failure(error, 'sqlite_readonly_store_execute_forbidden');
    }
    try {
      database.exec(String(sql || ''));
      return { ok: true, status: 0, stdout: '', stderr: '', error: null };
    } catch (error) {
      if (state && !state.failure) state.failure = error;
      if (!state && database.isTransaction) {
        try { database.exec('ROLLBACK;'); } catch { /* preserve the original SQLite error */ }
      }
      return failure(error, 'sqlite_execute_failed');
    }
  }

  function transaction(callback, { readOnly: transactionReadOnly = false } = {}) {
    if (typeof callback !== 'function') throw new Error('sqlite_unit_of_work_callback_required');
    if (closed) throw new Error('sqlite_store_closed');
    if (activeTransaction || database.isTransaction) {
      const error = new Error('sqlite_nested_unit_of_work_forbidden');
      if (activeTransaction && !activeTransaction.state.failure) activeTransaction.state.failure = error;
      throw error;
    }
    if (readOnly && !transactionReadOnly) throw new Error('sqlite_readonly_unit_of_work_write_forbidden');
    const state = { active: true, failure: null };
    const owner = Symbol('sqlite-unit-of-work');
    activeTransaction = { owner, state };
    const effectiveReadOnly = Boolean(readOnly || transactionReadOnly);
    const queryOnlyApplied = Boolean(effectiveReadOnly && !readOnly);
    const scopedStore = assertStorePort(Object.freeze({
      version: 3,
      kind: effectiveReadOnly ? 'ReadOnlySqliteTransactionStoreAdapter' : 'SqliteTransactionStoreAdapter',
      dbPath,
      readOnly: effectiveReadOnly,
      query: (sql, parameters = []) => {
        if (effectiveReadOnly && !/^\s*(?:SELECT|WITH|EXPLAIN)\b/i.test(String(sql || ''))) {
          const error = new Error('sqlite_readonly_query_statement_forbidden');
          if (!state.failure) state.failure = error;
          throw error;
        }
        return query(sql, parameters, state, owner);
      },
      run: (sql, parameters = []) => run(sql, parameters, state, effectiveReadOnly, owner),
      execute(sql) {
        if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(String(sql || ''))) {
          const error = new Error('sqlite_transaction_control_statement_forbidden');
          if (!state.failure) state.failure = error;
          return failure(error, 'sqlite_transaction_control_statement_forbidden');
        }
        return execute(sql, state, effectiveReadOnly, owner);
      },
      available: () => Boolean(state.active && !closed),
    }));
    let began = false;
    try {
      if (queryOnlyApplied) database.exec('PRAGMA query_only=ON;');
      database.exec(effectiveReadOnly ? 'BEGIN;' : 'BEGIN IMMEDIATE;');
      began = true;
      const value = callback(scopedStore);
      if (value && typeof value.then === 'function') throw new Error('sqlite_unit_of_work_async_callback_forbidden');
      if (state.failure) throw state.failure;
      database.exec('COMMIT;');
      began = false;
      return value;
    } catch (error) {
      if (began && database.isTransaction) {
        try { database.exec('ROLLBACK;'); } catch { /* preserve the original failure */ }
      }
      throw error;
    } finally {
      if (queryOnlyApplied) {
        try { database.exec('PRAGMA query_only=OFF;'); } catch { /* the store will fail closed on later use */ }
      }
      state.active = false;
      if (activeTransaction?.owner === owner) activeTransaction = null;
    }
  }

  return assertStorePort({
    version: 3,
    kind: readOnly ? 'ReadOnlySqliteStoreAdapter' : 'SqliteStoreAdapter',
    dbPath,
    readOnly,
    query: (sql, parameters = []) => query(sql, parameters),
    run: (sql, parameters = []) => run(sql, parameters),
    execute: (sql) => execute(sql),
    transaction,
    available() {
      const denied = accessError();
      if (denied) return false;
      try {
        database.prepare('SELECT 1 AS available').get();
        return true;
      } catch {
        return false;
      }
    },
    checkpoint({ mode = 'PASSIVE' } = {}) {
      const denied = accessError();
      if (denied) return failure(denied, denied.message);
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
      const denied = accessError();
      if (denied) throw denied;
      if (!closed) database.close();
      closed = true;
    },
  });
}

export function createSqliteStore({ dbPath, busyTimeoutMs = 10_000 } = {}) {
  return createPort({ dbPath, busyTimeoutMs, readOnly: false });
}

export function createReadOnlySqliteStore({ dbPath, busyTimeoutMs = 10_000, immutable = false } = {}) {
  return createPort({ dbPath, busyTimeoutMs, readOnly: true, immutable });
}
