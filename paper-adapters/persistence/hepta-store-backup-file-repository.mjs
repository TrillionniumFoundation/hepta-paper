import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';

function regularFileIdentity(candidate) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('hepta_store_backup_file_unsafe');
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function removeIdentityFile(candidate, identity) {
  if (!identity) return;
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.dev === identity.dev && stat.ino === identity.ino) {
      fs.unlinkSync(candidate);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function backupCandidates(backupRoot, requestedPath) {
  if (requestedPath) return [path.resolve(requestedPath)];
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => path.join(backupRoot, name))
    .filter((candidate) => {
      try {
        const stat = fs.lstatSync(candidate);
        return stat.isFile() && !stat.isSymbolicLink();
      } catch { return false; }
    })
    .sort((left, right) => fs.statSync(right).mtimeMs
      - fs.statSync(left).mtimeMs || right.localeCompare(left));
}

export function createHeptaStoreBackupFileRepository({
  runtimeRoot,
  dbPath,
  copySqliteDatabase,
  fileSha256,
  jsonFile,
  ledgerIdentity,
  assertTrustedStoreReceipt,
} = {}) {
  if (![copySqliteDatabase, fileSha256, jsonFile, ledgerIdentity,
    assertTrustedStoreReceipt].every((value) => typeof value === 'function')) {
    throw new Error('hepta_store_backup_file_repository_invalid');
  }
  const backupRoot = path.resolve(runtimeRoot, 'backups');
  return Object.freeze({
    async liveDatabaseSha256() {
      const snapshotRoot = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'hepta-store-live-hash-',
      ));
      const snapshotPath = path.join(snapshotRoot, 'live.sqlite');
      try {
        await copySqliteDatabase({
          sourcePath: dbPath,
          destinationPath: snapshotPath,
        });
        return `sha256:${fileSha256(snapshotPath)}`;
      } finally {
        fs.rmSync(snapshotRoot, { recursive: true, force: true });
      }
    },
    regularFileIdentity,
    removeIdentityFile,
    resolveBackupReceipt(requestedPath = null) {
      const candidates = backupCandidates(backupRoot, requestedPath);
      if (!candidates.length) return null;
      const backupPath = candidates[0];
      const stat = fs.lstatSync(backupPath);
      if (!pathWithin(backupRoot, backupPath)
        || stat.isSymbolicLink() || !stat.isFile()
        || !pathWithin(backupRoot, fs.realpathSync(backupPath))) {
        throw new Error('hepta_store_backup_path_unsafe');
      }
      const receipt = jsonFile(`${backupPath}.receipt.json`);
      if (receipt?.version !== 1
        || receipt.kind !== 'HeptaStoreBackupReceipt'
        || receipt.status !== 'hepta_store_backup_recorded'
        || path.resolve(String(receipt.sourcePath || '')) !== path.resolve(dbPath)
        || path.resolve(String(receipt.backupPath || '')) !== backupPath
        || receipt.backupSha256 !== `sha256:${fileSha256(backupPath)}`
        || Number(receipt.bytes) !== stat.size) {
        throw new Error('hepta_store_backup_receipt_invalid');
      }
      const identity = ledgerIdentity(receipt, 'backup');
      assertTrustedStoreReceipt(identity, 'HeptaStoreBackupReceipt');
      return Object.freeze({ receipt, identity });
    },
  });
}
