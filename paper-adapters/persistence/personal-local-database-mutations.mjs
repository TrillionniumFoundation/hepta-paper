import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';
import { fsyncDirectorySync, writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  PERSONAL_DATABASE_BACKUP_RELATIVE_DIRECTORY,
  PERSONAL_DATABASE_MIN_SCHEMA_VERSION,
  PERSONAL_DATABASE_RELATIVE_PATH,
  assertOwnerDirectory,
  assertOwnerFile,
  assertRuntimeRoot,
  cleanupSnapshot,
  consistentSnapshot,
  fail,
  inspectSidecars,
  inspectSqlite,
  nowIso,
  openFileDescriptorTargets,
  antiRollbackPath,
  readAntiRollbackLedger,
  restoreReceiptPath,
  sameIdentity,
  sourceIdentity,
  validateRuntimeAndDatabase,
  verifyBackupReceipt,
} from './personal-local-database-inspection.mjs';

const OWNER_ONLY_FILE_MODE = 0o600;
const READ_ONLY_RECEIPT_MODE = 0o400;

export async function recordPersonalDatabaseAntiRollback({
  runtimeRoot,
  clock = null,
} = {}) {
  const core = validateRuntimeAndDatabase(runtimeRoot);
  if (core.blockers.length) {
    return Object.freeze({
      version: 1,
      kind: 'PersonalDatabaseAntiRollbackRecord',
      status: 'personal_database_anti_rollback_blocked',
      ready: false,
      blockers: core.blockers,
    });
  }
  const snapshot = await consistentSnapshot({ dbPath: core.dbPath });
  try {
    const currentHash = snapshot.snapshotSha256;
    const ledgerResult = readAntiRollbackLedger(core.root);
    const onlyMissingLedger = ledgerResult.blockers.length === 1
      && ledgerResult.blockers[0] === 'personal_database_anti_rollback_state_missing';
    if (ledgerResult.blockers.length && !onlyMissingLedger) {
      return Object.freeze({
        version: 1,
        kind: 'PersonalDatabaseAntiRollbackRecord',
        status: 'personal_database_anti_rollback_blocked',
        ready: false,
        blockers: ledgerResult.blockers,
      });
    }
    const prior = ledgerResult.ledger?.entries?.at(-1) || null;
    const oldEntry = ledgerResult.ledger?.entries?.find((entry) => (
      entry.databaseSha256 === currentHash
    ));
    if (oldEntry && (!prior || oldEntry.sequence !== prior.sequence)) {
      return Object.freeze({
        version: 1,
        kind: 'PersonalDatabaseAntiRollbackRecord',
        status: 'personal_database_anti_rollback_blocked',
        ready: false,
        blockers: Object.freeze(['personal_database_rollback_detected']),
        observedDatabaseSha256: currentHash,
        previousSequence: prior?.sequence || 0,
      });
    }
    if (prior?.databaseSha256 === currentHash) {
      return Object.freeze({
        version: 1,
        kind: 'PersonalDatabaseAntiRollbackRecord',
        status: 'personal_database_anti_rollback_ready',
        ready: true,
        wrote: false,
        sequence: prior.sequence,
        databaseSha256: currentHash,
        ledgerHash: ledgerResult.ledger.ledgerHash,
        blockers: Object.freeze([]),
      });
    }
    const entryPayload = {
      sequence: (prior?.sequence || 0) + 1,
      databaseSha256: currentHash,
      schemaVersion: snapshot.inspection.schemaVersion,
      observedAt: nowIso(clock),
      previousEntryHash: prior?.entryHash || null,
    };
    const entry = Object.freeze({
      ...entryPayload,
      entryHash: hashRecord('PersonalDatabaseAntiRollbackEntry', entryPayload),
    });
    const payload = {
      version: 1,
      kind: 'PersonalDatabaseAntiRollbackLedger',
      status: 'active',
      databaseRelativePath: PERSONAL_DATABASE_RELATIVE_PATH,
      entries: Object.freeze([...(ledgerResult.ledger?.entries || []), entry]),
      updatedAt: entry.observedAt,
    };
    const ledger = Object.freeze({
      ...payload,
      ledgerHash: hashRecord('PersonalDatabaseAntiRollbackLedger', payload),
    });
    const target = antiRollbackPath(core.root);
    const parent = path.dirname(target);
    if (fs.existsSync(parent)) assertOwnerDirectory(parent, {
      errorCode: 'personal_database_anti_rollback_parent_unsafe',
    });
    else assertOwnerDirectory(parent, {
      create: true,
      errorCode: 'personal_database_anti_rollback_parent_unsafe',
    });
    writeDurableJsonSync(target, ledger, { mode: READ_ONLY_RECEIPT_MODE });
    assertOwnerFile(target, {
      errorCode: 'personal_database_anti_rollback_state_publish_failed',
      requireReadOnly: true,
    });
    const verified = readAntiRollbackLedger(core.root);
    if (!verified.ledger || verified.ledger.ledgerHash !== ledger.ledgerHash) {
      fail('personal_database_anti_rollback_state_publish_verification_failed');
    }
    return Object.freeze({
      version: 1,
      kind: 'PersonalDatabaseAntiRollbackRecord',
      status: 'personal_database_anti_rollback_ready',
      ready: true,
      wrote: true,
      sequence: entry.sequence,
      databaseSha256: currentHash,
      ledgerHash: ledger.ledgerHash,
      blockers: Object.freeze([]),
    });
  } finally { cleanupSnapshot(snapshot); }
}

export async function createPersonalDatabaseBackup({
  runtimeRoot,
  clock = null,
  allowLegacySchema = false,
} = {}) {
  const root = assertRuntimeRoot(runtimeRoot);
  const dbPath = path.join(root, PERSONAL_DATABASE_RELATIVE_PATH);
  assertOwnerFile(dbPath, { errorCode: 'personal_database_native_store_unsafe' });
  const sidecars = inspectSidecars(dbPath);
  const inspection = inspectSqlite(dbPath);
  const blockers = [];
  if (inspection.quickCheck !== 'ok') blockers.push('personal_database_quick_check_failed');
  if (inspection.foreignKeyViolationCount !== 0) blockers.push('personal_database_foreign_key_check_failed');
  if (!allowLegacySchema && inspection.schemaVersion < PERSONAL_DATABASE_MIN_SCHEMA_VERSION) {
    blockers.push(`personal_database_schema_version_below_minimum:${inspection.schemaVersion}/${PERSONAL_DATABASE_MIN_SCHEMA_VERSION}`);
  }
  if (inspection.activeLeaseCount !== 0) blockers.push('personal_database_active_leases_present');
  if (sidecars.sidecars.some((entry) => !entry.safe || (entry.suffix === '-wal' && entry.bytes > 0))) {
    blockers.push('personal_database_sidecar_state_not_quiescent');
  }
  if (blockers.length) {
    return Object.freeze({
      version: 1,
      kind: 'PersonalDatabaseBackupReceipt',
      status: 'personal_database_backup_blocked',
      ready: false,
      blockers: Object.freeze([...new Set(blockers)].sort()),
      schemaVersion: inspection.schemaVersion,
      sidecars,
    });
  }
  const backupRoot = assertOwnerDirectory(
    path.join(root, PERSONAL_DATABASE_BACKUP_RELATIVE_DIRECTORY),
    { create: true, errorCode: 'personal_database_backup_root_unsafe' },
  );
  const stamp = nowIso(clock).replace(/[-:.]/g, '');
  const backupPath = path.join(backupRoot, `hepta-paper-${stamp}-${process.pid}-${cryptoRandomId()}.sqlite`);
  const snapshot = await consistentSnapshot({
    dbPath,
    sourceImmutable: sidecars.sidecars.length === 0,
  });
  try {
    // Keep publication atomic when the temporary directory and runtime are
    // on one filesystem, but retain a verified copy fallback for split /tmp
    // mounts (EXDEV is normal on some container hosts).
    try {
      fs.linkSync(snapshot.snapshotPath, backupPath);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      fs.copyFileSync(snapshot.snapshotPath, backupPath, fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(backupPath, OWNER_ONLY_FILE_MODE);
    if (fileSha256HashSync(backupPath) !== snapshot.snapshotSha256) {
      fail('personal_database_backup_publish_hash_mismatch');
    }
    const ledgerResult = readAntiRollbackLedger(root);
    const payload = {
      version: 1,
      kind: 'PersonalDatabaseBackupReceipt',
      status: 'personal_database_backup_recorded',
      databaseRelativePath: PERSONAL_DATABASE_RELATIVE_PATH,
      sourcePath: dbPath,
      sourceSha256: snapshot.snapshotSha256,
      backupPath,
      backupSha256: snapshot.snapshotSha256,
      bytes: fs.statSync(backupPath).size,
      schemaVersion: snapshot.inspection.schemaVersion,
      quickCheck: snapshot.inspection.quickCheck,
      foreignKeyViolationCount: snapshot.inspection.foreignKeyViolationCount,
      antiRollbackSequence: ledgerResult.ledger?.entries?.at(-1)?.sequence || 0,
      sidecarsObserved: sidecars.sidecars,
      createdAt: nowIso(clock),
    };
    const receipt = Object.freeze({
      ...payload,
      receiptHash: hashRecord('PersonalDatabaseBackupReceipt', payload),
    });
    writeDurableJsonSync(`${backupPath}.receipt.json`, receipt, {
      mode: READ_ONLY_RECEIPT_MODE,
    });
    return receipt;
  } catch (error) {
    try { fs.unlinkSync(backupPath); } catch {}
    try { fs.unlinkSync(`${backupPath}.receipt.json`); } catch {}
    throw error;
  } finally { cleanupSnapshot(snapshot); }
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function restoreDrillPersonalDatabase({
  runtimeRoot,
  backupPath,
  clock = null,
} = {}) {
  const root = assertRuntimeRoot(runtimeRoot);
  const ledgerResult = readAntiRollbackLedger(root);
  let backup;
  try { backup = verifyBackupReceipt({ runtimeRoot: root, backupPath }); }
  catch (error) {
    return Object.freeze({
      version: 1,
      kind: 'PersonalDatabaseRestoreDrillReceipt',
      status: 'personal_database_restore_drill_blocked',
      ready: false,
      blockers: Object.freeze([error?.message || 'personal_database_backup_receipt_invalid']),
    });
  }
  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-personal-restore-'));
  fs.chmodSync(drillRoot, 0o700);
  const drillPath = path.join(drillRoot, 'restore.sqlite');
  let inspection;
  let hashMatches = false;
  const blockers = [];
  try {
    fs.copyFileSync(backup.backupPath, drillPath, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(drillPath, OWNER_ONLY_FILE_MODE);
    inspection = inspectSqlite(drillPath);
    hashMatches = fileSha256HashSync(drillPath) === backup.backupSha256;
    if (!hashMatches) blockers.push('personal_database_restore_backup_hash_mismatch');
    if (inspection.quickCheck !== 'ok') blockers.push('personal_database_restore_quick_check_failed');
    if (inspection.foreignKeyViolationCount !== 0) blockers.push('personal_database_restore_foreign_key_check_failed');
    if (inspection.schemaVersion < PERSONAL_DATABASE_MIN_SCHEMA_VERSION) {
      blockers.push('personal_database_restore_schema_below_minimum');
    }
    const currentSequence = ledgerResult.ledger?.entries?.at(-1)?.sequence || 0;
    if (backup.antiRollbackSequence < currentSequence) {
      blockers.push('personal_database_restore_would_rollback_current_head');
    }
    const payload = {
      version: 1,
      kind: 'PersonalDatabaseRestoreDrillReceipt',
      status: blockers.length ? 'personal_database_restore_drill_blocked' : 'personal_database_restore_drill_passed',
      backupPath: backup.backupPath,
      backupSha256: backup.backupSha256,
      backupReceiptHash: backup.receiptHash,
      antiRollbackSequence: backup.antiRollbackSequence,
      hashMatches,
      quickCheck: inspection.quickCheck,
      foreignKeyViolationCount: inspection.foreignKeyViolationCount,
      schemaVersion: inspection.schemaVersion,
      productionDatabaseMutated: false,
      performedAt: nowIso(clock),
      blockers: Object.freeze([...new Set(blockers)].sort()),
    };
    const receipt = Object.freeze({
      ...payload,
      receiptHash: hashRecord('PersonalDatabaseRestoreDrillReceipt', payload),
    });
    writeDurableJsonSync(restoreReceiptPath(backup.backupPath), receipt, {
      mode: READ_ONLY_RECEIPT_MODE,
    });
    return receipt;
  } finally { fs.rmSync(drillRoot, { recursive: true, force: true }); }
}

export async function clearPersonalDatabaseEmptySidecars({
  runtimeRoot,
  backupReceiptPath,
  allowStaleSharedMemory = false,
} = {}) {
  const root = assertRuntimeRoot(runtimeRoot);
  const dbPath = path.join(root, PERSONAL_DATABASE_RELATIVE_PATH);
  const backup = verifyBackupReceipt({
    runtimeRoot: root,
    backupPath: backupReceiptPath,
  });
  const current = sourceIdentity(dbPath);
  const open = openFileDescriptorTargets([
    dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`,
  ]);
  if (open.length) return Object.freeze({
    status: 'personal_database_sidecar_clear_blocked',
    ready: false,
    blockers: Object.freeze(['personal_database_open_file_descriptor_present']),
    openDescriptors: Object.freeze(open),
  });
  const snapshot = await consistentSnapshot({
    dbPath,
    sourceImmutable: false,
  });
  try {
    if (backup.sourceSha256 && backup.sourceSha256 !== snapshot.snapshotSha256) {
      return Object.freeze({
        status: 'personal_database_sidecar_clear_blocked',
        ready: false,
        blockers: Object.freeze(['personal_database_source_changed_since_backup']),
      });
    }
    const removed = [];
    for (const suffix of ['-wal', '-journal', '-shm']) {
    const candidate = `${dbPath}${suffix}`;
    let stat;
    try { stat = fs.lstatSync(candidate, { bigint: true }); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) {
      fail('personal_database_sidecar_unsafe');
    }
      if (suffix !== '-shm' && Number(stat.size) !== 0) {
        return Object.freeze({
          status: 'personal_database_sidecar_clear_blocked',
          ready: false,
          blockers: Object.freeze([`personal_database_nonempty_sidecar:${suffix}`]),
        });
      }
      if (suffix === '-shm' && Number(stat.size) !== 0 && !allowStaleSharedMemory) {
        return Object.freeze({
          status: 'personal_database_sidecar_clear_blocked',
          ready: false,
          blockers: Object.freeze(['personal_database_nonempty_shared_memory_requires_explicit_confirmation']),
        });
      }
      fs.unlinkSync(candidate);
      removed.push(suffix);
    }
    fsyncDirectorySync(root);
    if (!sameIdentity(current, sourceIdentity(dbPath))) {
      fail('personal_database_changed_during_sidecar_clear');
    }
    return Object.freeze({
      status: 'personal_database_sidecars_cleared',
      ready: true,
      removed: Object.freeze(removed),
      backupReceiptHash: backup.receiptHash,
    });
  } finally { cleanupSnapshot(snapshot); }
}
