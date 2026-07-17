import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  validateAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAXIMUM_STATE_BYTES = 2 * 1024 * 1024;
const MINIMUM_LEASE_MS = 1000;
const MAXIMUM_LEASE_MS = 10 * 60 * 1000;

function safeNow(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_qualification_state_clock_invalid');
  }
  return date;
}

function readLegacyState(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2
    || stat.size > MAXIMUM_STATE_BYTES || (stat.mode & 0o022) !== 0) {
    throw new Error('autonomous_research_external_qualification_state_file_invalid');
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch { throw new Error('autonomous_research_external_qualification_state_json_invalid'); }
  return validateAutonomousExternalQualificationState(value);
}

function parsePersistedState(row) {
  if (!row) return null;
  const serialized = String(row.state_json || '');
  if (Buffer.byteLength(serialized) < 2
    || Buffer.byteLength(serialized) > MAXIMUM_STATE_BYTES) {
    throw new Error('autonomous_research_external_qualification_state_file_invalid');
  }
  let state;
  try { state = JSON.parse(serialized); }
  catch { throw new Error('autonomous_research_external_qualification_state_json_invalid'); }
  validateAutonomousExternalQualificationState(state);
  if (Number(row.generation) !== state.generation
    || row.state_hash !== state.autonomousExternalQualificationStateHash) {
    throw new Error('autonomous_research_external_qualification_state_fence_invalid');
  }
  return state;
}

function boundedLeaseMs(value) {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate)) {
    throw new Error('autonomous_research_qualification_attempt_lease_duration_invalid');
  }
  return Math.max(MINIMUM_LEASE_MS, Math.min(MAXIMUM_LEASE_MS, candidate));
}

function leaseIdentity({ ownerId, leaseToken, leaseGeneration } = {}) {
  if (!SAFE_ID.test(String(ownerId || ''))
    || !SAFE_ID.test(String(leaseToken || ''))
    || !Number.isSafeInteger(Number(leaseGeneration))
    || Number(leaseGeneration) < 1) {
    throw new Error('autonomous_research_qualification_attempt_lease_identity_invalid');
  }
  return {
    ownerId: String(ownerId),
    leaseToken: String(leaseToken),
    leaseGeneration: Number(leaseGeneration),
  };
}

function begin(database) {
  database.exec('BEGIN IMMEDIATE;');
}

function rollback(database) {
  if (database.isTransaction) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve the original failure */ }
  }
}

export function createAutonomousResearchQualificationStateRepository({
  runtimeRoot,
  paperId,
  create = true,
  busyTimeoutMs = 10_000,
} = {}) {
  if (!runtimeRoot || !SAFE_ID.test(String(paperId || ''))) {
    throw new Error('autonomous_research_qualification_state_repository_scope_invalid');
  }
  const stateRoot = path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    paperId,
    'system-state',
  );
  const statePath = path.join(stateRoot, 'external-qualification-state.sqlite');
  const legacyStatePath = path.join(stateRoot, 'external-qualification-state.json');
  const scope = `paper:${paperId}`;
  if (create) fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  if (create && fs.existsSync(stateRoot)) fs.chmodSync(stateRoot, 0o700);

  let database = null;
  if (create || fs.existsSync(statePath)) {
    database = new DatabaseSync(statePath, { readOnly: !create });
    database.exec(`PRAGMA busy_timeout=${Math.max(1, Number(busyTimeoutMs || 10_000))};`);
    if (create) {
      try {
        database.exec('PRAGMA journal_mode=DELETE;');
        database.exec('PRAGMA synchronous=FULL;');
        database.exec(`CREATE TABLE IF NOT EXISTS autonomous_external_qualification_state (
          scope TEXT PRIMARY KEY,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          state_hash TEXT NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS autonomous_external_qualification_attempt_lease (
          scope TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          lease_token TEXT NOT NULL,
          lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
          acquired_at TEXT NOT NULL,
          renewed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) STRICT;`);
        fs.chmodSync(statePath, 0o600);
        const existing = database.prepare(
          'SELECT generation,state_hash,state_json FROM autonomous_external_qualification_state WHERE scope=?',
        ).get(scope);
        if (!existing) {
          const legacy = readLegacyState(legacyStatePath);
          if (legacy) {
            database.prepare(`INSERT INTO autonomous_external_qualification_state(
              scope,generation,state_hash,state_json,updated_at
            ) VALUES(?,?,?,?,?)`).run(
              scope,
              legacy.generation,
              legacy.autonomousExternalQualificationStateHash,
              JSON.stringify(legacy),
              new Date().toISOString(),
            );
          }
        }
      } catch (error) {
        database.close();
        throw error;
      }
    }
  }

  let closed = false;
  function requireOpen({ writable = false } = {}) {
    if (closed) throw new Error('autonomous_research_qualification_state_repository_closed');
    if (!database) {
      if (writable) throw new Error('autonomous_research_qualification_state_repository_read_only');
      return null;
    }
    if (writable && !create) {
      throw new Error('autonomous_research_qualification_state_repository_read_only');
    }
    return database;
  }

  function readState() {
    const db = requireOpen();
    if (!db) return readLegacyState(legacyStatePath);
    return parsePersistedState(db.prepare(
      'SELECT generation,state_hash,state_json FROM autonomous_external_qualification_state WHERE scope=?',
    ).get(scope));
  }

  return Object.freeze({
    version: 2,
    kind: 'AutonomousResearchQualificationStateRepository',
    durable: true,
    compareAndSwap: true,
    sqliteCompareAndSwap: true,
    lifecycleBudgetFencing: true,
    recoverableAttemptLease: true,
    systemOwnedRuntimeState: true,
    statePath,
    legacyStatePath,
    readExternalQualificationState: readState,
    compareAndSwapExternalQualificationState({
      expectedStateHash = null,
      state,
      attemptLease = null,
      now = new Date(),
    } = {}) {
      const db = requireOpen({ writable: true });
      validateAutonomousExternalQualificationState(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > MAXIMUM_STATE_BYTES) {
        throw new Error('autonomous_research_external_qualification_state_file_invalid');
      }
      try {
        begin(db);
        if (attemptLease) {
          const identity = leaseIdentity(attemptLease);
          const observedAt = safeNow(now);
          const persistedLease = db.prepare(`SELECT owner_id,lease_token,lease_generation,expires_at
            FROM autonomous_external_qualification_attempt_lease WHERE scope=?`).get(scope);
          if (!persistedLease
            || persistedLease.owner_id !== identity.ownerId
            || persistedLease.lease_token !== identity.leaseToken
            || Number(persistedLease.lease_generation) !== identity.leaseGeneration
            || Date.parse(persistedLease.expires_at) <= observedAt.getTime()) {
            throw new Error('autonomous_research_qualification_attempt_lease_fence_conflict');
          }
        }
        const current = parsePersistedState(db.prepare(
          'SELECT generation,state_hash,state_json FROM autonomous_external_qualification_state WHERE scope=?',
        ).get(scope));
        const currentHash = current?.autonomousExternalQualificationStateHash || null;
        if (currentHash !== expectedStateHash
          || state.generation !== Number(current?.generation || 0) + 1) {
          throw new Error('autonomous_research_qualification_state_fence_conflict');
        }
        const updatedAt = new Date().toISOString();
        if (current) {
          const result = db.prepare(`UPDATE autonomous_external_qualification_state
            SET generation=?,state_hash=?,state_json=?,updated_at=?
            WHERE scope=? AND generation=? AND state_hash=?`).run(
            state.generation,
            state.autonomousExternalQualificationStateHash,
            serialized,
            updatedAt,
            scope,
            current.generation,
            currentHash,
          );
          if (Number(result.changes) !== 1) {
            throw new Error('autonomous_research_qualification_state_fence_conflict');
          }
        } else {
          db.prepare(`INSERT INTO autonomous_external_qualification_state(
            scope,generation,state_hash,state_json,updated_at
          ) VALUES(?,?,?,?,?)`).run(
            scope,
            state.generation,
            state.autonomousExternalQualificationStateHash,
            serialized,
            updatedAt,
          );
        }
        db.exec('COMMIT;');
        return state;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    tryAcquireQualificationAttemptLease({ ownerId, leaseMs, now = new Date() } = {}) {
      const db = requireOpen({ writable: true });
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('autonomous_research_qualification_attempt_lease_owner_invalid');
      }
      const observedAt = safeNow(now);
      const duration = boundedLeaseMs(leaseMs);
      try {
        begin(db);
        const current = db.prepare(`SELECT owner_id,lease_token,lease_generation,expires_at
          FROM autonomous_external_qualification_attempt_lease WHERE scope=?`).get(scope);
        if (current && Date.parse(current.expires_at) > observedAt.getTime()) {
          db.exec('COMMIT;');
          return null;
        }
        const leaseGeneration = Number(current?.lease_generation || 0) + 1;
        const leaseToken = `lease:${crypto.randomUUID()}`;
        const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
        db.prepare(`INSERT INTO autonomous_external_qualification_attempt_lease(
          scope,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
        ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
          owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,acquired_at=excluded.acquired_at,
          renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`).run(
          scope,
          String(ownerId),
          leaseToken,
          leaseGeneration,
          observedAt.toISOString(),
          observedAt.toISOString(),
          expiresAt,
        );
        db.exec('COMMIT;');
        return Object.freeze({ ownerId: String(ownerId), leaseToken, leaseGeneration, expiresAt });
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    renewQualificationAttemptLease({ ownerId, leaseToken, leaseGeneration, leaseMs, now = new Date() } = {}) {
      const db = requireOpen({ writable: true });
      const identity = leaseIdentity({ ownerId, leaseToken, leaseGeneration });
      const observedAt = safeNow(now);
      const expiresAt = new Date(observedAt.getTime() + boundedLeaseMs(leaseMs)).toISOString();
      const result = db.prepare(`UPDATE autonomous_external_qualification_attempt_lease
        SET renewed_at=?,expires_at=? WHERE scope=? AND owner_id=? AND lease_token=?
        AND lease_generation=? AND julianday(expires_at)>julianday(?)`).run(
        observedAt.toISOString(),
        expiresAt,
        scope,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      );
      return Number(result.changes) === 1
        ? Object.freeze({ ...identity, expiresAt }) : null;
    },
    releaseQualificationAttemptLease({ ownerId, leaseToken, leaseGeneration } = {}) {
      const db = requireOpen({ writable: true });
      const identity = leaseIdentity({ ownerId, leaseToken, leaseGeneration });
      const result = db.prepare(`DELETE FROM autonomous_external_qualification_attempt_lease
        WHERE scope=? AND owner_id=? AND lease_token=? AND lease_generation=?`).run(
        scope,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
      );
      return Number(result.changes) === 1;
    },
    reconcileStaleQualificationAttemptLease({ now = new Date() } = {}) {
      const db = requireOpen({ writable: true });
      const observedAt = safeNow(now).toISOString();
      const result = db.prepare(`DELETE FROM autonomous_external_qualification_attempt_lease
        WHERE scope=? AND julianday(expires_at)<=julianday(?)`).run(scope, observedAt);
      return Object.freeze({ recoveredLeaseCount: Number(result.changes), reconciledAt: observedAt });
    },
    close() {
      if (!closed) database?.close();
      closed = true;
    },
  });
}
