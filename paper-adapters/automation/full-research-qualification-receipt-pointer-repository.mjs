import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MAXIMUM_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const POINTER_FILE = 'HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT.json';

function receiptHashValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || !SHA256.test(String(receipt.fullResearchQualificationReceiptHash || ''))
    || !SHA256.test(String(receipt.runtimeImageReproducibilityReceiptHash || ''))
    || JSON.stringify(receipt.runtimeImageReproducibilityRequiredProfiles)
      !== JSON.stringify(['python', 'pythonGpu', 'r'])
    || JSON.stringify(Object.keys(
      receipt.runtimeImageReproducibilityDefinitionManifestHashes || {},
    )) !== JSON.stringify(['python', 'pythonGpu', 'r'])
    || Object.values(receipt.runtimeImageReproducibilityDefinitionManifestHashes || {})
      .some((value) => !SHA256.test(String(value || '')))) return false;
  const { fullResearchQualificationReceiptHash, ...payload } = receipt;
  return hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', payload)
    === fullResearchQualificationReceiptHash;
}

function canonicalTimestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
}

function receiptTimeWindowValid(receipt, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const issuedAt = canonicalTimestamp(receipt?.issuedAt);
  const expiresAt = canonicalTimestamp(receipt?.expiresAt);
  return Number.isFinite(nowMs) && issuedAt !== null && expiresAt !== null
    && expiresAt > issuedAt && expiresAt - issuedAt <= MAXIMUM_AGE_MS
    && nowMs >= issuedAt && nowMs < expiresAt;
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function safeFile(candidate, { minimumBytes = 1, maximumBytes = MAXIMUM_RECEIPT_BYTES } = {}) {
  const requested = path.resolve(candidate);
  const stat = fs.lstatSync(requested);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid
    || (stat.mode & 0o022) !== 0 || stat.size < minimumBytes || stat.size > maximumBytes
    || fs.realpathSync(requested) !== requested) {
    throw new Error('full_research_qualification_pointer_file_invalid');
  }
  return requested;
}

function parseReceiptBytes(bytes) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('full_research_qualification_pointer_json_invalid'); }
  if (!receiptHashValid(receipt)) {
    throw new Error('full_research_qualification_pointer_receipt_hash_invalid');
  }
  return Object.freeze(receipt);
}

function safeReadMirror(candidate) {
  const bytes = fs.readFileSync(safeFile(candidate));
  return Object.freeze({ receipt: parseReceiptBytes(bytes), bytes });
}

function ensureDatabaseFile(candidate) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(candidate), 0o700);
  try {
    const descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    safeFile(candidate, { minimumBytes: 0, maximumBytes: 256 * 1024 * 1024 });
  }
}

function ensureSchema(database) {
  // DELETE journaling keeps status/read() side-effect free. Opening a read-only
  // WAL database can materialize `-shm`/`-wal` sidecars even without a query mutation.
  database.exec('PRAGMA journal_mode=DELETE;');
  database.exec('PRAGMA synchronous=FULL;');
  database.exec(`CREATE TABLE IF NOT EXISTS full_research_qualification_pointer_authority (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    receipt_json TEXT NOT NULL,
    receipt_content_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL,
    runtime_receipt_hash TEXT NOT NULL,
    qualification_state_hash TEXT NOT NULL,
    qualification_state_generation INTEGER NOT NULL CHECK(qualification_state_generation>=1),
    publisher_scope TEXT NOT NULL,
    publisher_owner_id TEXT NOT NULL,
    publisher_lease_generation INTEGER NOT NULL CHECK(publisher_lease_generation>=1),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    publication_generation INTEGER NOT NULL CHECK(publication_generation>=1),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS full_research_qualification_pointer_lease (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    lease_owner TEXT,
    lease_token TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
    lease_expires_at TEXT,
    recovered_lease_count INTEGER NOT NULL DEFAULT 0 CHECK(recovered_lease_count>=0),
    updated_at TEXT NOT NULL
  ) STRICT;`);
  database.prepare(`INSERT OR IGNORE INTO full_research_qualification_pointer_lease(
    singleton_id,lease_generation,recovered_lease_count,updated_at
  ) VALUES(1,0,0,?)`).run(new Date(0).toISOString());
}

function authorityRow(database) {
  return database.prepare('SELECT * FROM full_research_qualification_pointer_authority WHERE singleton_id=1').get() || null;
}

function validatedAuthority(database) {
  const row = authorityRow(database);
  if (!row) return null;
  const bytes = Buffer.from(String(row.receipt_json));
  const receipt = parseReceiptBytes(bytes);
  if (hashBytes(bytes) !== row.receipt_content_hash
    || receipt.fullResearchQualificationReceiptHash !== row.receipt_hash
    || receipt.runtimeImageReproducibilityReceiptHash !== row.runtime_receipt_hash
    || receipt.issuedAt !== row.issued_at || receipt.expiresAt !== row.expires_at
    || !SHA256.test(String(row.qualification_state_hash || ''))
    || !Number.isSafeInteger(Number(row.qualification_state_generation))
    || Number(row.qualification_state_generation) < 1
    || !SAFE_ID.test(String(row.publisher_scope || ''))
    || !SAFE_ID.test(String(row.publisher_owner_id || ''))
    || !Number.isSafeInteger(Number(row.publisher_lease_generation))
    || Number(row.publisher_lease_generation) < 1
    || !Number.isSafeInteger(Number(row.publication_generation))
    || Number(row.publication_generation) < 1) {
    throw new Error('full_research_qualification_pointer_authority_state_invalid');
  }
  return Object.freeze({ row, bytes, receipt });
}

function rollback(database) {
  if (database.isTransaction) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve original failure */ }
  }
}

function leaseIdentity(value = {}) {
  if (!SAFE_ID.test(String(value.ownerId || ''))
    || !SAFE_ID.test(String(value.leaseToken || ''))
    || !Number.isSafeInteger(Number(value.leaseGeneration))
    || Number(value.leaseGeneration) < 1) {
    throw new Error('full_research_qualification_pointer_lease_identity_invalid');
  }
  return Object.freeze({
    ownerId: String(value.ownerId),
    leaseToken: String(value.leaseToken),
    leaseGeneration: Number(value.leaseGeneration),
  });
}

function fencedLease(database, rawLease, nowMs) {
  const lease = leaseIdentity(rawLease);
  const row = database.prepare('SELECT * FROM full_research_qualification_pointer_lease WHERE singleton_id=1').get();
  if (!row || row.lease_owner !== lease.ownerId || row.lease_token !== lease.leaseToken
    || Number(row.lease_generation) !== lease.leaseGeneration
    || Date.parse(row.lease_expires_at || '') <= nowMs) {
    throw new Error('full_research_qualification_pointer_lease_lost');
  }
  return lease;
}

function monotonicSuccessor(current, receipt, qualificationStateGeneration) {
  if (!current) return true;
  if (receipt.fullResearchQualificationReceiptHash === current.receipt_hash) {
    return Number(qualificationStateGeneration) === Number(current.qualification_state_generation);
  }
  const currentIssuedAt = Date.parse(current.issued_at);
  const currentExpiresAt = Date.parse(current.expires_at);
  const nextIssuedAt = Date.parse(receipt.issuedAt);
  const nextExpiresAt = Date.parse(receipt.expiresAt);
  return Number.isFinite(currentIssuedAt) && Number.isFinite(currentExpiresAt)
    && Number.isFinite(nextIssuedAt) && Number.isFinite(nextExpiresAt)
    && nextIssuedAt > currentIssuedAt && nextExpiresAt > currentExpiresAt
    && Number(qualificationStateGeneration) > Number(current.qualification_state_generation);
}

function reconcileMirrorWithDatabase(database, qualificationReceiptPath) {
  let committed = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    const authority = validatedAuthority(database);
    if (!authority) {
      database.exec('COMMIT;');
      committed = true;
      return null;
    }
    writeDurableJsonSync(qualificationReceiptPath, authority.receipt, { mode: 0o400 });
    const mirror = safeReadMirror(qualificationReceiptPath);
    if (hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
      || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
      throw new Error('full_research_qualification_pointer_mirror_reconciliation_failed');
    }
    database.exec('COMMIT;');
    committed = true;
    return Object.freeze({
      qualificationReceiptHash: authority.row.receipt_hash,
      receiptContentHash: authority.row.receipt_content_hash,
      publicationGeneration: Number(authority.row.publication_generation),
    });
  } catch (error) {
    if (!committed) rollback(database);
    throw error;
  }
}

export function fullResearchQualificationReceiptPointerPath({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('full_research_qualification_pointer_runtime_root_required');
  return path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    'qualification',
    POINTER_FILE,
  );
}

export function createFullResearchQualificationReceiptPointerRepository({
  runtimeRoot,
  busyTimeoutMs = 10_000,
  afterAuthorityCommit = null,
} = {}) {
  const qualificationReceiptPath = fullResearchQualificationReceiptPointerPath({ runtimeRoot });
  const databasePath = `${qualificationReceiptPath}.publication.sqlite`;
  const timeout = Number(busyTimeoutMs);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new Error('full_research_qualification_pointer_busy_timeout_invalid');
  }

  function writableDatabase() {
    ensureDatabaseFile(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA busy_timeout=${timeout};`);
    ensureSchema(database);
    fs.chmodSync(databasePath, 0o600);
    return database;
  }

  function read() {
    if (!fs.existsSync(databasePath)) return null;
    safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const authority = validatedAuthority(database);
      if (!authority) return null;
      let mirror;
      try { mirror = safeReadMirror(qualificationReceiptPath); }
      catch { throw new Error('full_research_qualification_pointer_mirror_drift'); }
      if (hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
        || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
        throw new Error('full_research_qualification_pointer_mirror_drift');
      }
      return Object.freeze({
        receipt: authority.receipt,
        qualificationReceiptPath,
        databasePath,
        contentHash: authority.row.receipt_content_hash,
        publicationGeneration: Number(authority.row.publication_generation),
        qualificationStateHash: authority.row.qualification_state_hash,
        qualificationStateGeneration: Number(authority.row.qualification_state_generation),
      });
    } finally { database.close(); }
  }

  return Object.freeze({
    version: 2,
    kind: 'FullResearchQualificationReceiptPointerRepository',
    durable: true,
    atomicPublication: true,
    sqliteAuthorityAtomicPublication: true,
    sqliteMonotonicCompareAndSwap: true,
    derivedJsonMirror: true,
    derivedJsonMirrorCrashRecoverable: true,
    statusReadOnly: true,
    crossResourceAtomicPublicationClaimed: false,
    qualificationReceiptPath,
    databasePath,
    read,
    reconcileMirror() {
      if (!fs.existsSync(databasePath)) return null;
      safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA busy_timeout=${timeout};`);
      try {
        ensureSchema(database);
        return reconcileMirrorWithDatabase(database, qualificationReceiptPath);
      } finally { database.close(); }
    },
    tryAcquirePublicationLease({ ownerId, leaseMs = 5 * 60 * 1000, now = new Date() } = {}) {
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('full_research_qualification_pointer_owner_invalid');
      }
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      const duration = Number(leaseMs);
      if (!Number.isFinite(nowMs) || !Number.isSafeInteger(duration)
        || duration < 1000 || duration > 10 * 60 * 1000) {
        throw new Error('full_research_qualification_pointer_lease_invalid');
      }
      const database = writableDatabase();
      try {
        database.exec('BEGIN IMMEDIATE;');
        const current = database.prepare('SELECT * FROM full_research_qualification_pointer_lease WHERE singleton_id=1').get();
        const activeUntil = Date.parse(current.lease_expires_at || '');
        if (Number.isFinite(activeUntil) && activeUntil > nowMs) {
          database.exec('COMMIT;');
          return null;
        }
        const recovered = Boolean(current.lease_expires_at);
        const lease = Object.freeze({
          ownerId: String(ownerId),
          leaseToken: `qualification-pointer:${crypto.randomUUID()}`,
          leaseGeneration: Number(current.lease_generation) + 1,
          expiresAt: new Date(nowMs + duration).toISOString(),
        });
        const updated = database.prepare(`UPDATE full_research_qualification_pointer_lease SET
          lease_owner=?,lease_token=?,lease_generation=?,lease_expires_at=?,
          recovered_lease_count=recovered_lease_count+?,updated_at=?
          WHERE singleton_id=1 AND lease_generation=?`).run(
          lease.ownerId, lease.leaseToken, lease.leaseGeneration, lease.expiresAt,
          recovered ? 1 : 0, new Date(nowMs).toISOString(), current.lease_generation,
        );
        if (Number(updated.changes) !== 1) {
          throw new Error('full_research_qualification_pointer_lease_fence_conflict');
        }
        database.exec('COMMIT;');
        return lease;
      } catch (error) {
        rollback(database);
        throw error;
      } finally { database.close(); }
    },
    renewPublicationLease({ lease, leaseMs = 5 * 60 * 1000, now = new Date() } = {}) {
      const identity = leaseIdentity(lease);
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      const duration = Number(leaseMs);
      if (!Number.isFinite(nowMs) || !Number.isSafeInteger(duration)
        || duration < 1000 || duration > 10 * 60 * 1000) {
        throw new Error('full_research_qualification_pointer_lease_invalid');
      }
      const database = writableDatabase();
      try {
        const expiresAt = new Date(nowMs + duration).toISOString();
        const updated = database.prepare(`UPDATE full_research_qualification_pointer_lease SET
          lease_expires_at=?,updated_at=? WHERE singleton_id=1 AND lease_owner=?
          AND lease_token=? AND lease_generation=? AND julianday(lease_expires_at)>julianday(?)`).run(
          expiresAt, new Date(nowMs).toISOString(), identity.ownerId, identity.leaseToken,
          identity.leaseGeneration, new Date(nowMs).toISOString(),
        );
        return Number(updated.changes) === 1 ? Object.freeze({ ...identity, expiresAt }) : null;
      } finally { database.close(); }
    },
    releasePublicationLease({ lease, now = new Date() } = {}) {
      const identity = leaseIdentity(lease);
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      if (!Number.isFinite(nowMs)) throw new Error('full_research_qualification_pointer_clock_invalid');
      const database = writableDatabase();
      try {
        const result = database.prepare(`UPDATE full_research_qualification_pointer_lease SET
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE singleton_id=1 AND lease_owner=? AND lease_token=? AND lease_generation=?`).run(
          new Date(nowMs).toISOString(), identity.ownerId, identity.leaseToken,
          identity.leaseGeneration,
        );
        return Number(result.changes) === 1;
      } finally { database.close(); }
    },
    publish({
      lease,
      receipt,
      qualificationStateHash,
      qualificationStateGeneration,
      expectedRuntimeReceiptHash,
      publisherFence,
      now = new Date(),
    } = {}) {
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      if (!receiptHashValid(receipt)) {
        throw new Error('full_research_qualification_pointer_receipt_hash_invalid');
      }
      if (!receiptTimeWindowValid(receipt, now)) {
        throw new Error('full_research_qualification_pointer_receipt_expired');
      }
      if (!SHA256.test(String(qualificationStateHash || ''))
        || !Number.isSafeInteger(Number(qualificationStateGeneration))
        || Number(qualificationStateGeneration) < 1
        || !SHA256.test(String(expectedRuntimeReceiptHash || ''))
        || receipt.runtimeImageReproducibilityReceiptHash !== expectedRuntimeReceiptHash
        || !SAFE_ID.test(String(publisherFence?.scope || ''))
        || !SAFE_ID.test(String(publisherFence?.ownerId || ''))
        || !Number.isSafeInteger(Number(publisherFence?.leaseGeneration))
        || Number(publisherFence.leaseGeneration) < 1) {
        throw new Error('full_research_qualification_pointer_verified_binding_required');
      }
      const database = writableDatabase();
      let authorityCommitted = false;
      try {
        database.exec('BEGIN IMMEDIATE;');
        const identity = fencedLease(database, lease, nowMs);
        const current = authorityRow(database);
        if (!monotonicSuccessor(current, receipt, qualificationStateGeneration)) {
          throw new Error('full_research_qualification_pointer_monotonic_cas_rejected');
        }
        const bytes = receiptBytes(receipt);
        const contentHash = hashBytes(bytes);
        const same = current?.receipt_hash === receipt.fullResearchQualificationReceiptHash;
        const generation = same
          ? Number(current.publication_generation) : Number(current?.publication_generation || 0) + 1;
        if (!same) {
          database.prepare(`INSERT INTO full_research_qualification_pointer_authority(
            singleton_id,receipt_json,receipt_content_hash,receipt_hash,runtime_receipt_hash,
            qualification_state_hash,qualification_state_generation,publisher_scope,
            publisher_owner_id,publisher_lease_generation,issued_at,expires_at,
            publication_generation,updated_at
          ) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET
            receipt_json=excluded.receipt_json,
            receipt_content_hash=excluded.receipt_content_hash,
            receipt_hash=excluded.receipt_hash,
            runtime_receipt_hash=excluded.runtime_receipt_hash,
            qualification_state_hash=excluded.qualification_state_hash,
            qualification_state_generation=excluded.qualification_state_generation,
            publisher_scope=excluded.publisher_scope,
            publisher_owner_id=excluded.publisher_owner_id,
            publisher_lease_generation=excluded.publisher_lease_generation,
            issued_at=excluded.issued_at,
            expires_at=excluded.expires_at,
            publication_generation=excluded.publication_generation,
            updated_at=excluded.updated_at`).run(
            bytes.toString('utf8'), contentHash,
            receipt.fullResearchQualificationReceiptHash,
            receipt.runtimeImageReproducibilityReceiptHash,
            qualificationStateHash, Number(qualificationStateGeneration),
            publisherFence.scope, publisherFence.ownerId,
            Number(publisherFence.leaseGeneration), receipt.issuedAt, receipt.expiresAt,
            generation, new Date(nowMs).toISOString(),
          );
        }
        fencedLease(database, identity, nowMs);
        database.exec('COMMIT;');
        authorityCommitted = true;
        afterAuthorityCommit?.({ receipt, generation });
        const mirror = reconcileMirrorWithDatabase(database, qualificationReceiptPath);
        const payload = Object.freeze({
          version: 2,
          kind: 'FullResearchQualificationReceiptPointerPublication',
          status: 'full_research_qualification_receipt_pointer_published',
          environmentVariable: 'HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT',
          qualificationReceiptPath,
          publicationDatabasePath: databasePath,
          qualificationReceiptHash: receipt.fullResearchQualificationReceiptHash,
          receiptContentHash: contentHash,
          runtimeImageReproducibilityReceiptHash:
            receipt.runtimeImageReproducibilityReceiptHash,
          qualificationStateHash,
          qualificationStateGeneration: Number(qualificationStateGeneration),
          publisherScope: publisherFence.scope,
          publisherOwnerId: publisherFence.ownerId,
          publisherLeaseGeneration: Number(publisherFence.leaseGeneration),
          pointerLeaseGeneration: identity.leaseGeneration,
          publicationGeneration: generation,
          issuedAt: receipt.issuedAt,
          expiresAt: receipt.expiresAt,
          maximumReceiptAgeMs: MAXIMUM_AGE_MS,
          atomicPublication: true,
          durablePublication: true,
          sqliteAuthorityAtomicPublication: true,
          sqliteMonotonicCompareAndSwap: true,
          derivedJsonMirror: true,
          derivedJsonMirrorCrashRecoverable: true,
          crossResourceAtomicPublicationClaimed: false,
          mirrorReconciledToReceiptHash: mirror?.qualificationReceiptHash || null,
          receiptRemainedCurrentAtMirrorReconciliation:
            mirror?.qualificationReceiptHash === receipt.fullResearchQualificationReceiptHash,
          codeAndReleaseDriftMustRevalidate: true,
          externalActionPerformed: false,
        });
        return Object.freeze({
          ...payload,
          fullResearchQualificationReceiptPointerPublicationHash: hashRecord(
            'FullResearchQualificationReceiptPointerPublication',
            payload,
          ),
        });
      } catch (error) {
        if (!authorityCommitted) rollback(database);
        throw error;
      } finally { database.close(); }
    },
  });
}
