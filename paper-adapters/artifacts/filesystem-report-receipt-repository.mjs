import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  ensureScopedDirectorySync,
  inspectScopedRegularFileWithRecoverySync,
  stageScopedRegularFileCopySync,
} from '../runtime/scoped-file-materialization-repository.mjs';

function relativeWithin(scopeRoot, candidate) {
  const relative = path.relative(scopeRoot, candidate).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error('report_receipt_root_outside_scope');
  }
  return relative;
}

function assertEntryName(name) {
  const normalized = String(name || '');
  if (!/^[a-f0-9]{64}\.json$/.test(normalized)) throw new Error('report_receipt_entry_name_invalid');
  return normalized;
}

function writePrivateSource(root, bytes) {
  const name = 'receipt.json';
  const candidate = path.join(root, name);
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || Number(opened.nlink) !== 1) throw new Error('report_receipt_source_not_regular');
    writeDescriptorFullySync(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    const persisted = fs.fstatSync(descriptor);
    if (!persisted.isFile() || Number(persisted.nlink) !== 1 || Number(persisted.size) !== bytes.length) {
      throw new Error('report_receipt_source_changed');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return name;
}

export function createFilesystemReportReceiptRepository({ scopeRoot, receiptRoot } = {}) {
  if (!scopeRoot || !receiptRoot) throw new Error('report receipt repository requires scopeRoot and receiptRoot');
  const scope = path.resolve(scopeRoot);
  const receiptDirectory = path.resolve(receiptRoot);
  const receiptDirectoryRelative = relativeWithin(scope, receiptDirectory);

  function inspect(relative, expectedHash, expectedBytes) {
    const current = inspectScopedRegularFileWithRecoverySync({ scopeRoot: scope, relative });
    if (!current.exists) return false;
    if (current.hash !== expectedHash || current.bytes !== expectedBytes) {
      throw new Error('report_receipt_immutable_collision');
    }
    return true;
  }

  return Object.freeze({
    version: 1,
    kind: 'FilesystemReportReceiptRepository',
    putImmutable(name, value) {
      const entryName = assertEntryName(name);
      const relative = `${receiptDirectoryRelative}/${entryName}`;
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      const expectedContentHash = hashBytes(bytes);
      ensureScopedDirectorySync({ scopeRoot: scope, relative: receiptDirectoryRelative });
      if (inspect(relative, expectedContentHash, bytes.length)) {
        return Object.freeze({ relative, hash: expectedContentHash, bytes: bytes.length, created: false });
      }

      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-report-receipt-source-'));
      let staged;
      try {
        const sourceName = writePrivateSource(sourceRoot, bytes);
        staged = stageScopedRegularFileCopySync({
          sourceRoot,
          destinationRoot: scope,
          relative: sourceName,
          destinationRelative: relative,
          stageId: `report-receipt:${entryName}`,
          expectedHash: null,
        });
        const persisted = commitStagedScopedFileSync(staged, { destinationRoot: scope, expectedHash: null });
        if (persisted.hash !== expectedContentHash || persisted.bytes !== bytes.length) {
          throw new Error('report_receipt_postimage_mismatch');
        }
        return Object.freeze({ relative, hash: persisted.hash, bytes: persisted.bytes, created: true });
      } catch (error) {
        try { if (staged && !staged.committed) abortStagedScopedFileSync(staged); } catch {}
        if (['scoped_materialization_preimage_conflict', 'scoped_materialization_operation_target_advanced'].includes(error?.code)
          && inspect(relative, expectedContentHash, bytes.length)) {
          return Object.freeze({ relative, hash: expectedContentHash, bytes: bytes.length, created: false });
        }
        throw error;
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    },
  });
}
