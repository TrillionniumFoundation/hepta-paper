import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { copySqliteDatabase } from './sqlite-consistent-copy.mjs';
import { fileSha256HashSync, readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

/**
 * The distribution profile has a ten-database, externally attested state
 * authority.  A private single-host deployment deliberately has a smaller
 * state boundary: the native store is the only database used by that mode.
 * This module is the local, auditable boundary for that deployment.  It does
 * not mint external authority evidence and it never mutates the production
 * database during inspection or restore drills.
 */

export const PERSONAL_DATABASE_MIN_SCHEMA_VERSION = 25;
export const PERSONAL_DATABASE_RELATIVE_PATH = 'hepta-paper.sqlite';
export const PERSONAL_DATABASE_ANTI_ROLLBACK_RELATIVE_PATH =
  'deployment/personal-database-anti-rollback.json';
export const PERSONAL_DATABASE_BACKUP_RELATIVE_DIRECTORY =
  'backups/personal-database';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function openFileDescriptorTargets(targets) {
  const found = [];
  if (!fs.existsSync('/proc')) return found;
  let pids;
  try { pids = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)); }
  catch { return found; }
  const wanted = new Set(targets.map((candidate) => path.resolve(candidate)));
  for (const pid of pids) {
    let descriptors;
    try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const descriptor of descriptors) {
      let target;
      try { target = fs.realpathSync(`/proc/${pid}/fd/${descriptor}`); } catch { continue; }
      if (wanted.has(target)) found.push(Object.freeze({ pid: Number(pid), descriptor, target }));
    }
  }
  return found;
}

export function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

function currentUserId() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function canonicalInstant(value) {
  const selected = String(value || '');
  const milliseconds = Date.parse(selected);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === selected ? canonical : null;
}

export function nowIso(clock = null) {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  const result = date.toISOString();
  if (!canonicalInstant(result)) fail('personal_database_clock_invalid');
  return result;
}

function safeMode(stat) {
  return Number(stat.mode & 0o7777n);
}

export function assertOwnerDirectory(candidate, {
  create = false,
  mode = 0o700,
  errorCode = 'personal_database_directory_unsafe',
} = {}) {
  const resolved = path.resolve(candidate);
  if (create && !fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true, mode });
  }
  let stat;
  try { stat = fs.lstatSync(resolved, { bigint: true }); }
  catch { fail(errorCode); }
  const owner = currentUserId();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (owner !== null && Number(stat.uid) !== owner)
    || (safeMode(stat) & 0o022) !== 0
    || fs.realpathSync(resolved) !== resolved) {
    fail(errorCode, { path: resolved, mode: safeMode(stat) });
  }
  return resolved;
}

export function assertRuntimeRoot(runtimeRoot) {
  return assertOwnerDirectory(runtimeRoot, {
    errorCode: 'personal_database_runtime_root_unsafe',
  });
}

export function assertOwnerFile(candidate, {
  errorCode = 'personal_database_file_unsafe',
  requireReadOnly = false,
  allowMissing = false,
} = {}) {
  const resolved = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(resolved, { bigint: true }); }
  catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    fail(errorCode);
  }
  const owner = currentUserId();
  const mode = safeMode(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1
    || (owner !== null && Number(stat.uid) !== owner)
    || (mode & 0o022) !== 0
    || (requireReadOnly && (mode & 0o222) !== 0)
    || fs.realpathSync(resolved) !== resolved) {
    fail(errorCode, { path: resolved, mode });
  }
  return Object.freeze({ path: resolved, stat, mode });
}

export function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function immutableSqliteLocation(candidate) {
  const location = pathToFileURL(candidate);
  location.searchParams.set('mode', 'ro');
  location.searchParams.set('immutable', '1');
  return location;
}

export function sourceIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    bytes: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
    links: String(stat.nlink),
    mode: String(stat.mode),
  });
}

export function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function inspectSidecars(dbPath) {
  const sidecars = [];
  const blockers = [];
  // A SQLite WAL database may retain an empty WAL and a shared-memory file
  // after an immutable read.  Those files are not evidence of a live writer.
  // A live descriptor, or a non-empty WAL/journal, is the boundary that would
  // make an offline personal backup/migration unsafe.
  const openDescriptors = openFileDescriptorTargets([
    dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`,
  ]);
  if (openDescriptors.length) blockers.push('personal_database_open_file_descriptor_present');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const candidate = `${dbPath}${suffix}`;
    let stat;
    try { stat = fs.lstatSync(candidate, { bigint: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      blockers.push(`personal_database_sidecar_stat_failed:${suffix}`);
      continue;
    }
    const mode = safeMode(stat);
    const owner = currentUserId();
    const safe = stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1
      && (owner === null || Number(stat.uid) === owner)
      && (mode & 0o022) === 0;
    const bytes = Number(stat.size);
    sidecars.push(Object.freeze({
      suffix,
      path: candidate,
      bytes,
      mode,
      safe,
      identity: Object.freeze({
        device: String(stat.dev), inode: String(stat.ino), links: String(stat.nlink),
      }),
    }));
    if (!safe) blockers.push(`personal_database_sidecar_unsafe:${suffix}`);
    else if (suffix === '-wal' && bytes > 0) blockers.push('personal_database_active_wal_present');
    else if (suffix === '-journal' && bytes > 0) blockers.push('personal_database_active_journal_present');
  }
  return Object.freeze({
    clear: blockers.length === 0,
    sidecars: Object.freeze(sidecars),
    blockers: Object.freeze(blockers),
  });
}

function tableNames(database) {
  return new Set(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';",
  ).all().map((row) => String(row.name)));
}

function columnNames(database, table) {
  return new Set(database.prepare(`PRAGMA table_info("${String(table).replaceAll('"', '""')}");`)
    .all().map((row) => String(row.name)));
}

function leaseCount(database, table, predicate) {
  const names = tableNames(database);
  if (!names.has(table)) return 0;
  const columns = columnNames(database, table);
  const clauses = [];
  if (columns.has('status')) clauses.push(predicate.status);
  for (const column of ['lease_owner', 'claimed_by', 'lease_token', 'lease_expires_at']) {
    if (columns.has(column)) clauses.push(`${column} IS NOT NULL`);
  }
  if (!clauses.length) return 0;
  const sql = `SELECT count(*) AS count FROM "${table}" WHERE ${clauses.join(' OR ')};`;
  return Number(database.prepare(sql).get()?.count || 0);
}

export function inspectSqlite(dbPath) {
  const database = new DatabaseSync(immutableSqliteLocation(dbPath), { readOnly: true });
  try {
    const quickCheck = String(database.prepare('PRAGMA quick_check;').get()?.quick_check || 'unknown');
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check;').all();
    const migrations = tableNames(database).has('schema_migrations')
      ? database.prepare('SELECT coalesce(max(version),0) AS version FROM schema_migrations;').get()
      : { version: 0 };
    const schemaRows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
    const leases = Object.freeze({
      jobs: leaseCount(database, 'jobs', {
        status: "status IN ('leased','running')",
      }),
      campaigns: leaseCount(database, 'campaign_nodes', {
        status: "status IN ('leased','running')",
      }),
      submissions: leaseCount(database, 'submission_outbox', {
        status: "status='in_flight'",
      }) + leaseCount(database, 'submission_response_consumption', {
        status: "state='IN_PROGRESS'",
      }),
    });
    return Object.freeze({
      quickCheck,
      foreignKeyViolationCount: foreignKeyViolations.length,
      schemaVersion: Number(migrations.version || 0),
      schemaHash: hashRecord('PersonalLocalDatabaseSchema', schemaRows),
      schemaObjects: Object.freeze(schemaRows.map((row) => `${row.type}:${row.name}`)),
      leases,
      activeLeaseCount: Object.values(leases).reduce((sum, value) => sum + value, 0),
    });
  } finally { database.close(); }
}

export async function consistentSnapshot({
  dbPath,
  temporaryRoot = null,
  sourceImmutable = true,
} = {}) {
  const sourceBefore = sourceIdentity(dbPath);
  const root = temporaryRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-personal-db-'));
  fs.chmodSync(root, 0o700);
  const snapshotPath = path.join(root, 'snapshot.sqlite');
  try {
    await copySqliteDatabase({
      sourcePath: dbPath,
      destinationPath: snapshotPath,
      sourceImmutable,
    });
    const sourceAfter = sourceIdentity(dbPath);
    if (!sameIdentity(sourceBefore, sourceAfter)) {
      fail('personal_database_changed_during_snapshot');
    }
    const snapshotSha256 = fileSha256HashSync(snapshotPath);
    const inspection = inspectSqlite(snapshotPath);
    return Object.freeze({
      snapshotPath,
      snapshotSha256,
      sourceIdentity: sourceAfter,
      inspection,
      temporaryRoot: root,
    });
  } catch (error) {
    if (!temporaryRoot) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupSnapshot(snapshot) {
  if (snapshot?.temporaryRoot) {
    try { fs.rmSync(snapshot.temporaryRoot, { recursive: true, force: true }); }
    catch { /* preserve the primary result */ }
  }
}

export function antiRollbackPath(runtimeRoot, explicitPath = null) {
  const root = path.resolve(runtimeRoot);
  const selected = path.resolve(
    explicitPath || path.join(root, PERSONAL_DATABASE_ANTI_ROLLBACK_RELATIVE_PATH),
  );
  if (!pathWithin(root, selected)) fail('personal_database_anti_rollback_path_outside_runtime');
  return selected;
}

function validHash(value) { return SHA256.test(String(value || '')); }

export function readAntiRollbackLedger(runtimeRoot, explicitPath = null) {
  const selected = antiRollbackPath(runtimeRoot, explicitPath);
  const file = assertOwnerFile(selected, {
    errorCode: 'personal_database_anti_rollback_state_unsafe',
    requireReadOnly: true,
    allowMissing: true,
  });
  if (!file) return Object.freeze({ path: selected, ledger: null, blockers: ['personal_database_anti_rollback_state_missing'] });
  let value;
  try { value = JSON.parse(fs.readFileSync(selected, 'utf8')); }
  catch { return Object.freeze({ path: selected, ledger: null, blockers: ['personal_database_anti_rollback_state_invalid'] }); }
  const blockers = [];
  if (!value || value.version !== 1
    || value.kind !== 'PersonalDatabaseAntiRollbackLedger'
    || value.status !== 'active'
    || value.databaseRelativePath !== PERSONAL_DATABASE_RELATIVE_PATH
    || !Array.isArray(value.entries)
    || !canonicalInstant(value.updatedAt)
    || !validHash(value.ledgerHash)) {
    blockers.push('personal_database_anti_rollback_state_shape_invalid');
  }
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const seenHashes = new Set();
  let previousEntryHash = null;
  entries.forEach((entry, index) => {
    const expectedSequence = index + 1;
    const payload = {
      sequence: entry?.sequence,
      databaseSha256: entry?.databaseSha256,
      schemaVersion: entry?.schemaVersion,
      observedAt: entry?.observedAt,
      previousEntryHash: entry?.previousEntryHash ?? null,
    };
    if (!entry || entry.sequence !== expectedSequence
      || !validHash(entry.databaseSha256)
      || !Number.isSafeInteger(entry.schemaVersion)
      || !canonicalInstant(entry.observedAt)
      || entry.previousEntryHash !== previousEntryHash
      || !validHash(entry.entryHash)
      || entry.entryHash !== hashRecord('PersonalDatabaseAntiRollbackEntry', payload)
      || seenHashes.has(entry.databaseSha256)) {
      blockers.push(`personal_database_anti_rollback_entry_invalid:${expectedSequence}`);
    }
    seenHashes.add(entry?.databaseSha256);
    previousEntryHash = entry?.entryHash || null;
  });
  const { ledgerHash, ...ledgerPayload } = value || {};
  if (validHash(ledgerHash)
    && ledgerHash !== hashRecord('PersonalDatabaseAntiRollbackLedger', ledgerPayload)) {
    blockers.push('personal_database_anti_rollback_ledger_hash_invalid');
  }
  return Object.freeze({
    path: selected,
    ledger: blockers.length ? null : Object.freeze(value),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function validateRuntimeAndDatabase(runtimeRoot) {
  const root = assertRuntimeRoot(runtimeRoot);
  const dbPath = path.join(root, PERSONAL_DATABASE_RELATIVE_PATH);
  const file = assertOwnerFile(dbPath, {
    errorCode: 'personal_database_native_store_unsafe',
  });
  const sidecars = inspectSidecars(dbPath);
  const inspection = inspectSqlite(dbPath);
  const blockers = [...sidecars.blockers];
  if (inspection.quickCheck !== 'ok') blockers.push('personal_database_quick_check_failed');
  if (inspection.foreignKeyViolationCount !== 0) blockers.push('personal_database_foreign_key_check_failed');
  if (inspection.schemaVersion < PERSONAL_DATABASE_MIN_SCHEMA_VERSION) {
    blockers.push(`personal_database_schema_version_below_minimum:${inspection.schemaVersion}/${PERSONAL_DATABASE_MIN_SCHEMA_VERSION}`);
  }
  if (inspection.activeLeaseCount !== 0) blockers.push('personal_database_active_leases_present');
  return Object.freeze({
    root,
    dbPath,
    file,
    sidecars,
    inspection,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function restoreReceiptPath(backupPath) {
  return `${backupPath}.restore-drill.receipt.json`;
}

export function verifyBackupReceipt({ runtimeRoot, backupPath, receipt } = {}) {
  const root = path.resolve(runtimeRoot);
  const backupRoot = path.join(root, PERSONAL_DATABASE_BACKUP_RELATIVE_DIRECTORY);
  const selected = path.resolve(backupPath);
  const receiptPath = `${selected}.receipt.json`;
  const file = assertOwnerFile(selected, {
    errorCode: 'personal_database_backup_file_unsafe',
  });
  if (!pathWithin(backupRoot, selected) || !file) fail('personal_database_backup_path_invalid');
  const value = receipt || readRegularJsonFileSync(receiptPath);
  if (!value || value.version !== 1
    || value.kind !== 'PersonalDatabaseBackupReceipt'
    || value.status !== 'personal_database_backup_recorded'
    || value.databaseRelativePath !== PERSONAL_DATABASE_RELATIVE_PATH
    || path.resolve(String(value.backupPath || '')) !== selected
    || !validHash(value.backupSha256)
    || value.backupSha256 !== fileSha256HashSync(selected)
    || Number(value.bytes) !== Number(file.stat.size)
    || !Number.isSafeInteger(value.schemaVersion)
    || !canonicalInstant(value.createdAt)
    || !validHash(value.receiptHash)) {
    fail('personal_database_backup_receipt_invalid');
  }
  const { receiptHash, ...payload } = value;
  if (receiptHash !== hashRecord('PersonalDatabaseBackupReceipt', payload)) {
    fail('personal_database_backup_receipt_hash_invalid');
  }
  return Object.freeze(value);
}

function latestBackup(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  const backupRoot = path.join(root, PERSONAL_DATABASE_BACKUP_RELATIVE_DIRECTORY);
  if (!fs.existsSync(backupRoot)) return null;
  assertOwnerDirectory(backupRoot, { errorCode: 'personal_database_backup_root_unsafe' });
  const candidates = fs.readdirSync(backupRoot)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => path.join(backupRoot, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs
      || right.localeCompare(left));
  for (const candidate of candidates) {
    try { return verifyBackupReceipt({ runtimeRoot: root, backupPath: candidate }); }
    catch { /* skip corrupt candidates; a later caller reports no valid backup */ }
  }
  return null;
}

function latestRestoreReceipt(runtimeRoot, backup = null) {
  const selected = backup || latestBackup(runtimeRoot);
  if (!selected) return null;
  const receiptPath = restoreReceiptPath(selected.backupPath);
  const value = readRegularJsonFileSync(receiptPath);
  if (!value || value.version !== 1
    || value.kind !== 'PersonalDatabaseRestoreDrillReceipt'
    || value.status !== 'personal_database_restore_drill_passed'
    || path.resolve(String(value.backupPath || '')) !== path.resolve(selected.backupPath)
    || value.backupSha256 !== selected.backupSha256
    || value.productionDatabaseMutated !== false
    || (Array.isArray(value.blockers) && value.blockers.length !== 0)
    || !validHash(value.receiptHash)
    || !canonicalInstant(value.performedAt)) return null;
  const { receiptHash, ...payload } = value;
  return receiptHash === hashRecord('PersonalDatabaseRestoreDrillReceipt', payload)
    ? Object.freeze(value) : null;
}

async function buildReadinessReport({ runtimeRoot, requireRestoreDrill = true } = {}) {
  const core = validateRuntimeAndDatabase(runtimeRoot);
  const ledgerResult = readAntiRollbackLedger(core.root);
  const blockers = [...core.blockers, ...ledgerResult.blockers];
  let currentHash = null;
  let snapshot = null;
  try {
    // This is intentionally a read-only, temporary online backup.  It does
    // not publish or alter the production database.
    snapshot = await consistentSnapshot({ dbPath: core.dbPath });
    currentHash = snapshot.snapshotSha256;
  } catch (error) {
    blockers.push(`personal_database_snapshot_failed:${error?.message || 'unknown'}`);
  }
  const latest = ledgerResult.ledger?.entries?.at(-1) || null;
  if (ledgerResult.ledger && !latest) blockers.push('personal_database_anti_rollback_head_missing');
  if (latest && currentHash && latest.databaseSha256 !== currentHash) {
    const oldEntry = ledgerResult.ledger.entries.find((entry) => (
      entry.databaseSha256 === currentHash
    ));
    blockers.push(oldEntry
      ? 'personal_database_rollback_detected'
      : 'personal_database_current_head_unrecorded');
  }
  if (latest && currentHash === latest.databaseSha256) {
    // Keep the explicit fields below useful to an operator while avoiding a
    // false ready result when the ledger itself was malformed.
    if (ledgerResult.ledger === null) blockers.push('personal_database_anti_rollback_state_invalid');
  }
  const restore = latestBackup(core.root);
  const restoreDrill = latestRestoreReceipt(core.root, restore);
  if (requireRestoreDrill && (!restore || !restoreDrill)) {
    blockers.push('personal_database_restore_drill_required');
  }
  if (restore && latest
    && (!Number.isSafeInteger(restore.antiRollbackSequence)
      || restore.antiRollbackSequence < latest.sequence)) {
    blockers.push('personal_database_backup_head_sequence_stale');
  }
  const report = Object.freeze({
    version: 1,
    kind: 'PersonalLocalDatabaseReadiness',
    status: blockers.length ? 'personal_local_database_blocked' : 'personal_local_database_ready',
    ready: blockers.length === 0,
    runtimeRoot: core.root,
    databasePath: core.dbPath,
    databaseRelativePath: PERSONAL_DATABASE_RELATIVE_PATH,
    schemaVersion: core.inspection.schemaVersion,
    minimumSchemaVersion: PERSONAL_DATABASE_MIN_SCHEMA_VERSION,
    quickCheck: core.inspection.quickCheck,
    foreignKeyViolationCount: core.inspection.foreignKeyViolationCount,
    schemaHash: core.inspection.schemaHash,
    activeLeaseCount: core.inspection.activeLeaseCount,
    leases: core.inspection.leases,
    sidecars: core.sidecars,
    antiRollback: Object.freeze({
      path: ledgerResult.path,
      ready: ledgerResult.ledger !== null && latest !== null,
      sequence: latest?.sequence || 0,
      databaseSha256: latest?.databaseSha256 || null,
      ledgerHash: ledgerResult.ledger?.ledgerHash || null,
      currentDatabaseSha256: currentHash,
    }),
    backup: restore ? Object.freeze({
      path: restore.backupPath,
      sha256: restore.backupSha256,
      schemaVersion: restore.schemaVersion,
      antiRollbackSequence: restore.antiRollbackSequence,
    }) : null,
    restoreDrill: restoreDrill ? Object.freeze({
      path: restoreReceiptPath(restore.backupPath),
      receiptHash: restoreDrill.receiptHash,
      performedAt: restoreDrill.performedAt,
    }) : null,
    blockers: Object.freeze([...new Set(blockers)].sort()),
  });
  if (snapshot) cleanupSnapshot(snapshot);
  return report;
}

export async function inspectPersonalLocalDatabase({
  runtimeRoot,
  requireRestoreDrill = true,
} = {}) {
  // Keep this API synchronous in its observable effects.  The async boundary
  // is retained so callers can share it with the online-backup path.
  return buildReadinessReport({ runtimeRoot, requireRestoreDrill });
}
