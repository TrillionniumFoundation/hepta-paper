import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import { assertStorePort } from '../../paper-ports/store-port.mjs';
import { createRustCutoverFence } from '../migration/rust-cutover-fence.mjs';
import { assertNoSqliteTransactionControl } from './sqlite-transaction-sql-guard.mjs';

const SAFE_MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;

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

function checkedOnlineMutationBoundary(boundary) {
  const coordinator = assertExternallyFencedSqliteMutationCoordinatorPort(
    boundary?.coordinator,
  );
  const status = coordinator.inspectStatus();
  const operationIds = Array.isArray(boundary?.operationIds)
    ? [...boundary.operationIds].map(String).sort() : [];
  const suppliedOperationWriters = boundary?.operationWriters;
  const operationWritersArePlain = suppliedOperationWriters
    && typeof suppliedOperationWriters === 'object'
    && !Array.isArray(suppliedOperationWriters)
    && [Object.prototype, null].includes(Object.getPrototypeOf(suppliedOperationWriters));
  const operationWriterEntries = operationWritersArePlain
    ? Object.entries(suppliedOperationWriters)
      .map(([operationId, writerId]) => [String(operationId), String(writerId)])
      .sort(([left], [right]) => left.localeCompare(right))
    : operationIds.map((operationId) => [operationId, String(boundary?.writerId || '')]);
  const writerIds = [...new Set(operationWriterEntries.map(([, writerId]) => writerId))]
    .sort();
  if (coordinator.implemented !== true
    || status?.implemented !== true
    || status.status !== 'externally_fenced_sqlite_mutation_coordinator_ready'
    || !Array.isArray(status.blockers) || status.blockers.length !== 0
    || !SAFE_MUTATION_ID.test(String(boundary?.databaseRole || ''))
    || !coordinator.coveredDatabaseRoles?.includes(boundary.databaseRole)
    || !status.coveredDatabaseRoles?.includes(boundary.databaseRole)
    || !SAFE_MUTATION_ID.test(String(boundary?.databaseInstanceId || ''))
    || !SAFE_MUTATION_ID.test(String(boundary?.schemaContractId || ''))
    || operationIds.length === 0
    || new Set(operationIds).size !== operationIds.length
    || operationIds.some((operationId) => !SAFE_MUTATION_ID.test(operationId))
    || operationWriterEntries.map(([operationId]) => operationId).join('\0')
      !== operationIds.join('\0')
    || writerIds.length === 0
    || writerIds.some((writerId) => !SAFE_MUTATION_ID.test(writerId))) {
    throw new Error('native_store_external_mutation_coordinator_required');
  }
  return Object.freeze({
    coordinator,
    databaseRole: boundary.databaseRole,
    databaseInstanceId: boundary.databaseInstanceId,
    schemaContractId: boundary.schemaContractId,
    writerId: writerIds.length === 1 ? writerIds[0] : null,
    writerIds: Object.freeze(writerIds),
    operationWriters: Object.freeze(Object.fromEntries(operationWriterEntries)),
    writerByOperationId: new Map(operationWriterEntries),
    operationIds: Object.freeze(operationIds),
    operationIdSet: new Set(operationIds),
  });
}

function createPort({
  dbPath,
  readOnly = false,
  immutable = false,
  busyTimeoutMs = 10_000,
  requireExisting = false,
  onlineMutationBoundary = null,
} = {}) {
  if (!dbPath) throw new Error('SQLite store dbPath is required');
  const onlineMutation = onlineMutationBoundary === null
    ? null : checkedOnlineMutationBoundary(onlineMutationBoundary);
  if ((readOnly || requireExisting) && !fs.existsSync(dbPath)) {
    throw new Error(readOnly
      ? 'sqlite_readonly_database_missing' : 'paper_store_not_initialized');
  }
  const cutoverFence = readOnly ? null : createRustCutoverFence({ dbPath, busyTimeoutMs });
  const fenced = (action) => cutoverFence ? cutoverFence.withWrite(action) : action();
  let database;
  let publicReadDatabase = null;
  try {
    database = fenced(() => openDatabase({ dbPath, readOnly, immutable, busyTimeoutMs }));
    // Public queries on an externally fenced store use a physically read-only
    // connection. The authority connection may temporarily clear query_only,
    // but no StorePort query can ever inherit that write capability.
    if (onlineMutation) {
      publicReadDatabase = openDatabase({ dbPath, readOnly: true, busyTimeoutMs });
    }
  } catch (error) {
    try { publicReadDatabase?.close(); } catch { /* preserve the opening failure */ }
    try { database?.close(); } catch { /* preserve the opening failure */ }
    cutoverFence?.close();
    throw error;
  }
  let closed = false;
  let activeTransaction = null;
  let onlineWriteGuardHealthy = true;
  if (onlineMutation) database.exec('PRAGMA query_only=ON;');

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
    return fenced(() => queryInner(sql, parameters, state, ownerToken));
  }

  function queryInner(sql, parameters = [], state = null, ownerToken = null) {
    const denied = accessError(ownerToken, state);
    if (denied) throw denied;
    if (closed) throw new Error('sqlite_store_closed');
    if (!onlineWriteGuardHealthy) throw new Error('native_store_online_write_guard_failed');
    try {
      const text = String(sql || '');
      // A query is never classified from its first token. Top-level online
      // reads execute on a read-only SQLite connection; scoped reads execute
      // under the transaction's query_only/owner-token boundary.
      assertNoSqliteTransactionControl(text);
      const target = onlineMutation && !state ? publicReadDatabase : database;
      const rows = invoke(target.prepare(text), 'all', parameters).map((row) => ({ ...row }));
      return { ok: true, status: 0, stdout: '', stderr: '', error: null, rows };
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
    try { return fenced(() => runInner(sql, parameters, state, scopedReadOnly, ownerToken)); }
    catch (error) {
      if (state && !state.failure) state.failure = error;
      return failure(error, 'rust_cutover_write_fenced');
    }
  }

  function runInner(sql, parameters = [], state = null, scopedReadOnly = readOnly, ownerToken = null) {
    const denied = accessError(ownerToken, state);
    if (denied) return failure(denied, denied.message);
    if (onlineMutation) {
      const error = new Error('native_store_unfenced_write_forbidden');
      if (state && !state.failure) state.failure = error;
      return failure(error, error.message);
    }
    if (scopedReadOnly) {
      const error = new Error('sqlite_readonly_store_execute_forbidden');
      if (state && !state.failure) state.failure = error;
      return failure(error, 'sqlite_readonly_store_execute_forbidden');
    }
    try {
      const text = String(sql || '');
      if (state) assertNoSqliteTransactionControl(text);
      const result = invoke(database.prepare(text), 'run', parameters);
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
    try { return fenced(() => executeInner(sql, state, scopedReadOnly, ownerToken)); }
    catch (error) {
      if (state && !state.failure) state.failure = error;
      return failure(error, 'rust_cutover_write_fenced');
    }
  }

  function executeInner(sql, state = null, scopedReadOnly = readOnly, ownerToken = null) {
    const denied = accessError(ownerToken, state);
    if (denied) return failure(denied, denied.message);
    if (onlineMutation) {
      const error = new Error('native_store_unfenced_write_forbidden');
      if (state && !state.failure) state.failure = error;
      return failure(error, error.message);
    }
    if (scopedReadOnly) {
      const error = new Error('sqlite_readonly_store_execute_forbidden');
      if (state && !state.failure) state.failure = error;
      return failure(error, 'sqlite_readonly_store_execute_forbidden');
    }
    try {
      const text = String(sql || '');
      if (state) assertNoSqliteTransactionControl(text);
      database.exec(text);
      return { ok: true, status: 0, stdout: '', stderr: '', error: null };
    } catch (error) {
      if (state && !state.failure) state.failure = error;
      if (!state && database.isTransaction) {
        try { database.exec('ROLLBACK;'); } catch { /* preserve the original SQLite error */ }
      }
      return failure(error, 'sqlite_execute_failed');
    }
  }

  function transaction(callback, options = {}) {
    const denied = accessError();
    if (denied) throw denied;
    return fenced(() => transactionInner(callback, options));
  }

  function transactionInner(callback, { readOnly: transactionReadOnly = false } = {}) {
    if (typeof callback !== 'function') throw new Error('sqlite_unit_of_work_callback_required');
    if (closed) throw new Error('sqlite_store_closed');
    if (onlineMutation && !transactionReadOnly) {
      throw new Error('native_store_unfenced_write_forbidden');
    }
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
    const queryOnlyApplied = Boolean(effectiveReadOnly && !readOnly && !onlineMutation);
    const scopedStore = assertStorePort(Object.freeze({
      version: 3,
      kind: effectiveReadOnly ? 'ReadOnlySqliteTransactionStoreAdapter' : 'SqliteTransactionStoreAdapter',
      dbPath,
      readOnly: effectiveReadOnly,
      query: (sql, parameters = []) => query(sql, parameters, state, owner),
      run: (sql, parameters = []) => run(sql, parameters, state, effectiveReadOnly, owner),
      execute: (sql) => execute(sql, state, effectiveReadOnly, owner),
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

  function withOnlineWrite(action) {
    const denied = accessError();
    if (denied) throw denied;
    return fenced(() => withOnlineWriteInner(action));
  }

  function withOnlineWriteInner(action) {
    if (!onlineMutation) throw new Error('native_store_online_mutation_boundary_unavailable');
    checkedOnlineMutationBoundary(onlineMutation);
    if (closed) throw new Error('sqlite_store_closed');
    if (!onlineWriteGuardHealthy) throw new Error('native_store_online_write_guard_failed');
    if (activeTransaction || database.isTransaction) {
      throw new Error('sqlite_nested_unit_of_work_forbidden');
    }
    database.exec('PRAGMA query_only=OFF;');
    let value;
    let actionError = null;
    try { value = action(); }
    catch (error) { actionError = error; }
    try { database.exec('PRAGMA query_only=ON;'); }
    catch (restoreError) {
      onlineWriteGuardHealthy = false;
      try { publicReadDatabase?.close(); } catch { /* preserve the guard failure */ }
      try { database.close(); } catch { /* the adapter remains permanently closed */ }
      closed = true;
      const error = new Error('native_store_query_only_restore_failed');
      error.cause = actionError || restoreError;
      throw error;
    }
    if (actionError) throw actionError;
    return value;
  }

  function mutate({
    operationId,
    authorizationReceiptHashes = [],
    sideEffectReservationHashes = [],
    mutate: callback,
  } = {}) {
    if (!onlineMutation?.operationIdSet.has(operationId)
      || !Array.isArray(authorizationReceiptHashes)
      || !Array.isArray(sideEffectReservationHashes)
      || typeof callback !== 'function') {
      throw new Error('native_store_online_mutation_input_invalid');
    }
    return withOnlineWrite(() => {
      const state = { active: true, failure: null };
      const owner = Symbol('sqlite-online-mutation');
      activeTransaction = { owner, state };
      try {
        return onlineMutation.coordinator.executeMutation({
          database,
          databaseRole: onlineMutation.databaseRole,
          databaseInstanceId: onlineMutation.databaseInstanceId,
          schemaContractId: onlineMutation.schemaContractId,
          writerId: onlineMutation.writerByOperationId.get(operationId),
          operationId,
          authorizationReceiptHashes: Object.freeze([...authorizationReceiptHashes]),
          sideEffectReservationHashes: Object.freeze([...sideEffectReservationHashes]),
          mutate(transactionSurface) {
            let value;
            try { value = callback(transactionSurface); }
            catch (error) {
              if (!state.failure) state.failure = error;
              throw error;
            }
            if (value && typeof value.then === 'function') {
              const error = new Error('externally_fenced_sqlite_mutation_async_callback_forbidden');
              if (!state.failure) state.failure = error;
              throw error;
            }
            if (state.failure) throw state.failure;
            return value;
          },
        });
      } finally {
        state.active = false;
        if (activeTransaction?.owner === owner) activeTransaction = null;
      }
    });
  }

  return assertStorePort({
    version: 3,
    kind: readOnly
      ? 'ReadOnlySqliteStoreAdapter'
      : onlineMutation
        ? 'ExternallyFencedNativeSqliteStoreAdapter'
        : 'SqliteStoreAdapter',
    dbPath,
    readOnly,
    query: (sql, parameters = []) => query(sql, parameters),
    run: (sql, parameters = []) => run(sql, parameters),
    execute: (sql) => execute(sql),
    transaction,
    ...(onlineMutation ? {
      externallyFencedMutations: true,
      databaseRole: onlineMutation.databaseRole,
      databaseInstanceId: onlineMutation.databaseInstanceId,
      schemaContractId: onlineMutation.schemaContractId,
      writerId: onlineMutation.writerId,
      writerIds: onlineMutation.writerIds,
      operationWriters: onlineMutation.operationWriters,
      operationIds: onlineMutation.operationIds,
      mutate,
      recoverPendingMutations() {
        const denied = accessError();
        if (denied) throw denied;
        return withOnlineWrite(() => onlineMutation.coordinator
          .recoverPendingMutations({ database }));
      },
    } : {}),
    available() {
      const denied = accessError();
      if (denied) return false;
      try {
        (publicReadDatabase || database).prepare('SELECT 1 AS available').get();
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
        const row = fenced(() => database.prepare(`PRAGMA wal_checkpoint(${normalized})`).get());
        return { ok: true, status: 0, stdout: JSON.stringify(row || {}), stderr: '', error: null, row: row ? { ...row } : null };
      } catch (error) {
        return failure(error, 'sqlite_checkpoint_failed');
      }
    },
    close() {
      const denied = accessError();
      if (denied) throw denied;
      if (!closed) {
        publicReadDatabase?.close();
        database.close();
      }
      cutoverFence?.close();
      closed = true;
    },
  });
}

export function createSqliteStore({ dbPath, busyTimeoutMs = 10_000 } = {}) {
  return createPort({ dbPath, busyTimeoutMs, readOnly: false });
}

export function createOfflineSqliteStore({ dbPath, busyTimeoutMs = 10_000 } = {}) {
  return createPort({ dbPath, busyTimeoutMs, readOnly: false });
}

export function createExternallyFencedNativeSqliteStore({
  dbPath,
  busyTimeoutMs = 10_000,
  mutationCoordinator,
  databaseInstanceId,
  schemaContractId,
  writerId,
  operationWriters = null,
  operationIds,
} = {}) {
  return createExternallyFencedSqliteStore({
    dbPath,
    busyTimeoutMs,
    mutationCoordinator,
    databaseRole: 'native-store',
    databaseInstanceId,
    schemaContractId,
    writerId,
    operationWriters,
    operationIds,
  });
}

export function createExternallyFencedSqliteStore({
  dbPath,
  busyTimeoutMs = 10_000,
  mutationCoordinator,
  databaseRole,
  databaseInstanceId,
  schemaContractId,
  writerId,
  operationWriters = null,
  operationIds,
} = {}) {
  return createPort({
    dbPath,
    busyTimeoutMs,
    readOnly: false,
    requireExisting: true,
    onlineMutationBoundary: Object.freeze({
      coordinator: mutationCoordinator,
      databaseRole,
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationWriters,
      operationIds,
    }),
  });
}

export function createReadOnlySqliteStore({ dbPath, busyTimeoutMs = 10_000, immutable = false } = {}) {
  return createPort({ dbPath, busyTimeoutMs, readOnly: true, immutable });
}
