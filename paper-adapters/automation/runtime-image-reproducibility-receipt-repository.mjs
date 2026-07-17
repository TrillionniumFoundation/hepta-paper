import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_BYTES = 32 * 1024 * 1024;

function receiptHashValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || !SHA256.test(String(receipt.runtimeImageReproducibilityReceiptHash || ''))) return false;
  const { runtimeImageReproducibilityReceiptHash, ...payload } = receipt;
  return hashRecord('RuntimeImageReproducibilityReceipt', payload)
    === runtimeImageReproducibilityReceiptHash;
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function safeFile(candidate, { minimumBytes = 1, maximumBytes = MAXIMUM_BYTES } = {}) {
  const requested = path.resolve(candidate);
  const stat = fs.lstatSync(requested);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid
    || (stat.mode & 0o022) !== 0 || stat.size < minimumBytes || stat.size > maximumBytes
    || fs.realpathSync(requested) !== requested) {
    throw new Error('runtime_reproducibility_receipt_file_invalid');
  }
  return requested;
}

function canonicalTimestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
}

function ensurePublicationDatabaseFile(candidate) {
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

function parseReceiptBytes(bytes) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('runtime_reproducibility_receipt_json_invalid'); }
  if (!receiptHashValid(receipt)) throw new Error('runtime_reproducibility_receipt_hash_invalid');
  return Object.freeze(receipt);
}

function safeReadMirror(candidate) {
  const bytes = fs.readFileSync(safeFile(candidate));
  return Object.freeze({ receipt: parseReceiptBytes(bytes), bytes });
}

function ensureSchema(database) {
  database.exec('PRAGMA journal_mode=WAL;');
  database.exec('PRAGMA synchronous=FULL;');
  database.exec(`CREATE TABLE IF NOT EXISTS runtime_image_reproducibility_receipt (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    receipt_json TEXT NOT NULL,
    receipt_content_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    publication_generation INTEGER NOT NULL CHECK(publication_generation>=1),
    updated_at TEXT NOT NULL
  ) STRICT;`);
}

function authorityRow(database) {
  return database.prepare(`SELECT receipt_json,receipt_content_hash,receipt_hash,
    issued_at,expires_at,publication_generation,updated_at
    FROM runtime_image_reproducibility_receipt WHERE singleton_id=1`).get() || null;
}

function validatedAuthority(database) {
  const row = authorityRow(database);
  if (!row) return null;
  const bytes = Buffer.from(String(row.receipt_json));
  const receipt = parseReceiptBytes(bytes);
  if (hashBytes(bytes) !== row.receipt_content_hash
    || receipt.runtimeImageReproducibilityReceiptHash !== row.receipt_hash
    || receipt.issuedAt !== row.issued_at || receipt.expiresAt !== row.expires_at
    || !Number.isSafeInteger(Number(row.publication_generation))
    || Number(row.publication_generation) < 1) {
    throw new Error('runtime_reproducibility_receipt_authority_state_invalid');
  }
  return Object.freeze({ row, bytes, receipt });
}

function rollback(database) {
  if (database.isTransaction) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve original failure */ }
  }
}

function reconcileMirrorWithDatabase(database, canonicalPath) {
  let committed = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    const authority = validatedAuthority(database);
    if (!authority) {
      database.exec('COMMIT;');
      committed = true;
      return null;
    }
    writeDurableJsonSync(canonicalPath, authority.receipt, { mode: 0o400 });
    const mirror = safeReadMirror(canonicalPath);
    if (hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
      || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
      throw new Error('runtime_reproducibility_receipt_mirror_reconciliation_failed');
    }
    database.exec('COMMIT;');
    committed = true;
    return Object.freeze({
      receiptHash: authority.row.receipt_hash,
      receiptContentHash: authority.row.receipt_content_hash,
      publicationGeneration: Number(authority.row.publication_generation),
    });
  } catch (error) {
    if (!committed) rollback(database);
    throw error;
  }
}

function monotonicSuccessor(current, receipt) {
  if (!current) return true;
  const currentIssuedAt = Date.parse(current.issued_at);
  const currentExpiresAt = Date.parse(current.expires_at);
  const nextIssuedAt = Date.parse(receipt.issuedAt);
  const nextExpiresAt = Date.parse(receipt.expiresAt);
  if (nextIssuedAt === currentIssuedAt
    && receipt.runtimeImageReproducibilityReceiptHash === current.receipt_hash) return true;
  return Number.isFinite(currentIssuedAt) && Number.isFinite(currentExpiresAt)
    && Number.isFinite(nextIssuedAt) && Number.isFinite(nextExpiresAt)
    && nextIssuedAt > currentIssuedAt && nextExpiresAt > currentExpiresAt;
}

export function runtimeImageReproducibilityReceiptPath({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('runtime_reproducibility_runtime_root_required');
  return path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    'runtime-image-reproducibility',
    'receipt.json',
  );
}

export function createRuntimeImageReproducibilityReceiptRepository({
  runtimeRoot,
  receiptPath = null,
  receiptVerifier = null,
  busyTimeoutMs = 10_000,
} = {}) {
  const boundedBusyTimeoutMs = Number(busyTimeoutMs);
  if (!Number.isSafeInteger(boundedBusyTimeoutMs)
    || boundedBusyTimeoutMs < 1 || boundedBusyTimeoutMs > 60_000) {
    throw new Error('runtime_reproducibility_receipt_busy_timeout_invalid');
  }
  const canonicalPath = receiptPath
    ? path.resolve(receiptPath) : runtimeImageReproducibilityReceiptPath({ runtimeRoot });
  const databasePath = `${canonicalPath}.publication.sqlite`;

  function read() {
    if (!fs.existsSync(databasePath)) return null;
    safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const authority = validatedAuthority(database);
      if (!authority) return null;
      let mirror;
      try { mirror = safeReadMirror(canonicalPath); }
      catch { throw new Error('runtime_reproducibility_receipt_mirror_drift'); }
      if (hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
        || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
        throw new Error('runtime_reproducibility_receipt_mirror_drift');
      }
      return Object.freeze({
        receipt: authority.receipt,
        receiptPath: canonicalPath,
        databasePath,
        contentHash: authority.row.receipt_content_hash,
        publicationGeneration: Number(authority.row.publication_generation),
      });
    } finally { database.close(); }
  }

  return Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityReceiptRepository',
    receiptPath: canonicalPath,
    databasePath,
    durable: true,
    sqliteAuthorityAtomicPublication: true,
    derivedJsonMirror: true,
    crossResourceAtomicPublicationClaimed: false,
    derivedJsonMirrorCrashRecoverable: true,
    sqliteMonotonicCompareAndSwap: true,
    read,
    reconcileMirror() {
      if (!fs.existsSync(databasePath)) return null;
      safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA busy_timeout=${boundedBusyTimeoutMs};`);
      try {
        ensureSchema(database);
        return reconcileMirrorWithDatabase(database, canonicalPath);
      } finally { database.close(); }
    },
    publish({ receipt, now = new Date() } = {}) {
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      if (typeof receiptVerifier !== 'function') {
        throw new Error('runtime_reproducibility_receipt_verifier_required');
      }
      if (!receiptHashValid(receipt) || !Number.isFinite(nowMs)
        || canonicalTimestamp(receipt.issuedAt) === null
        || canonicalTimestamp(receipt.expiresAt) === null
        || canonicalTimestamp(receipt.expiresAt) <= canonicalTimestamp(receipt.issuedAt)
        || nowMs < canonicalTimestamp(receipt.issuedAt)
        || nowMs >= canonicalTimestamp(receipt.expiresAt)) {
        throw new Error('runtime_reproducibility_verified_receipt_required');
      }
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      ensurePublicationDatabaseFile(databasePath);
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA busy_timeout=${boundedBusyTimeoutMs};`);
      ensureSchema(database);
      fs.chmodSync(databasePath, 0o600);
      let authorityCommitted = false;
      try {
        database.exec('BEGIN IMMEDIATE;');
        let inspection;
        try { inspection = receiptVerifier(receipt, now); }
        catch { inspection = null; }
        if (inspection?.ready !== true || inspection?.receiptAccepted !== true
          || inspection?.receiptHash !== receipt.runtimeImageReproducibilityReceiptHash) {
          throw new Error('runtime_reproducibility_verified_receipt_required');
        }
        const current = authorityRow(database);
        if (!monotonicSuccessor(current, receipt)) {
          throw new Error('runtime_reproducibility_receipt_monotonic_cas_rejected');
        }
        const bytes = receiptBytes(receipt);
        const contentHash = hashBytes(bytes);
        const generation = current ? Number(current.publication_generation) + 1 : 1;
        database.prepare(`INSERT INTO runtime_image_reproducibility_receipt(
          singleton_id,receipt_json,receipt_content_hash,receipt_hash,issued_at,expires_at,
          publication_generation,updated_at
        ) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET
          receipt_json=excluded.receipt_json,
          receipt_content_hash=excluded.receipt_content_hash,
          receipt_hash=excluded.receipt_hash,
          issued_at=excluded.issued_at,
          expires_at=excluded.expires_at,
          publication_generation=excluded.publication_generation,
          updated_at=excluded.updated_at`).run(
          bytes.toString('utf8'),
          contentHash,
          receipt.runtimeImageReproducibilityReceiptHash,
          receipt.issuedAt,
          receipt.expiresAt,
          generation,
          new Date(nowMs).toISOString(),
        );
        database.exec('COMMIT;');
        authorityCommitted = true;
        const mirrorReconciliation = reconcileMirrorWithDatabase(database, canonicalPath);
        const payload = Object.freeze({
          version: 2,
          kind: 'RuntimeImageReproducibilityReceiptPublication',
          status: 'runtime_image_reproducibility_receipt_published',
          receiptPath: canonicalPath,
          publicationDatabasePath: databasePath,
          publicationGeneration: generation,
          receiptHash: receipt.runtimeImageReproducibilityReceiptHash,
          receiptContentHash: contentHash,
          issuedAt: receipt.issuedAt,
          expiresAt: receipt.expiresAt,
          sqliteAuthorityAtomicPublication: true,
          sqliteAuthorityDurablePublication: true,
          sqliteMonotonicCompareAndSwap: true,
          derivedJsonMirror: true,
          derivedJsonMirrorCrashRecoverable: true,
          crossResourceAtomicPublicationClaimed: false,
          mirrorReconciledToReceiptHash: mirrorReconciliation?.receiptHash || null,
          receiptRemainedCurrentAtMirrorReconciliation:
            mirrorReconciliation?.receiptHash === receipt.runtimeImageReproducibilityReceiptHash,
          currentCodeReleaseAndInputClosureDriftMustRevalidate: true,
          externalActionPerformed: false,
        });
        return Object.freeze({
          ...payload,
          runtimeImageReproducibilityReceiptPublicationHash: hashRecord(
            'RuntimeImageReproducibilityReceiptPublication',
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
