import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import { assertStorePort } from '../../paper-ports/store-port.mjs';

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
  const database = openDatabase({ dbPath, readOnly, immutable, busyTimeoutMs });
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
    if (closed) throw new Error('sqlite_store_closed');
    if (!onlineWriteGuardHealthy) throw new Error('native_store_online_write_guard_failed');
    if (onlineMutation
      && !/^\s*(?:SELECT|WITH|EXPLAIN)\b/i.test(String(sql || ''))) {
      const error = new Error('native_store_unfenced_query_write_forbidden');
      if (state && !state.failure) state.failure = error;
      throw error;
    }
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

  function withOnlineWrite(action) {
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
    return withOnlineWrite(() => onlineMutation.coordinator.executeMutation({
      database,
      databaseRole: onlineMutation.databaseRole,
      databaseInstanceId: onlineMutation.databaseInstanceId,
      schemaContractId: onlineMutation.schemaContractId,
      writerId: onlineMutation.writerByOperationId.get(operationId),
      operationId,
      authorizationReceiptHashes: Object.freeze([...authorizationReceiptHashes]),
      sideEffectReservationHashes: Object.freeze([...sideEffectReservationHashes]),
      mutate: callback,
    }));
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
        return withOnlineWrite(() => onlineMutation.coordinator
          .recoverPendingMutations({ database }));
      },
    } : {}),
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
