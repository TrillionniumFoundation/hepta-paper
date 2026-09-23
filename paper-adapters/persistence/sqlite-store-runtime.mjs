import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';

const SAFE_MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;

export function storeFailure(error, fallback) {
  return {
    ok: false,
    status: 1,
    stdout: '',
    stderr: String(error?.message || fallback),
    error: normalizeText(error?.message || fallback),
  };
}

export function openSqliteDatabase({
  dbPath,
  readOnly = false,
  immutable = false,
  busyTimeoutMs = 10_000,
} = {}) {
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

export function checkedOnlineMutationBoundary(boundary) {
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

export function invokeSqliteStatement(statement, operation, parameters) {
  if (Array.isArray(parameters)) return statement[operation](...parameters);
  if (parameters && typeof parameters === 'object') return statement[operation](parameters);
  return statement[operation]();
}

export function createStoreAccessState() {
  return {
    activeTransaction: null,
    accessError(ownerToken = null, scope = null) {
      if (scope && !scope.active) return new Error('sqlite_transaction_scope_inactive');
      if (this.activeTransaction && ownerToken !== this.activeTransaction.owner) {
        const error = new Error('sqlite_outer_store_access_during_unit_of_work_forbidden');
        if (!this.activeTransaction.state.failure) this.activeTransaction.state.failure = error;
        return error;
      }
      return null;
    },
  };
}
