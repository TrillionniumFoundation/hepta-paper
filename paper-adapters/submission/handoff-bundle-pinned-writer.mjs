import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const CREATE_EXCLUSIVE = fs.constants.O_CREAT | fs.constants.O_EXCL;

function inodeIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function openPinnedRoot(root, expectedIdentity) {
  const selected = path.resolve(root || '.');
  const before = fs.lstatSync(selected, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()
    || fs.realpathSync.native(selected) !== selected) {
    throw new Error('handoff_bundle_writer_root_unsafe');
  }
  const descriptor = fs.openSync(
    selected,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const identity = inodeIdentity(opened);
  if (!opened.isDirectory()
    || !sameIdentity(inodeIdentity(before), identity)
    || (expectedIdentity && !sameIdentity(expectedIdentity, identity))) {
    fs.closeSync(descriptor);
    throw new Error('handoff_bundle_writer_root_identity_changed');
  }
  return Object.freeze({ descriptor, identity, root: selected });
}

function relativeTarget(root, target) {
  const candidate = path.resolve(target || '.');
  if (candidate === root || !isPathWithin(root, candidate)) {
    throw new Error('handoff_bundle_writer_target_scope_invalid');
  }
  const relative = path.relative(root, candidate).replace(/\\/g, '/');
  const parts = relative.split('/');
  if (!relative || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('handoff_bundle_writer_target_path_invalid');
  }
  return Object.freeze({ candidate, parts, relative });
}

function openPinnedTargetParent(rootDescriptor, directoryParts) {
  const root = fs.fstatSync(rootDescriptor, { bigint: true });
  let descriptor = fs.openSync(
    `/proc/self/fd/${rootDescriptor}`,
    fs.constants.O_RDONLY | DIRECTORY_ONLY,
  );
  try {
    const duplicate = fs.fstatSync(descriptor, { bigint: true });
    if (!duplicate.isDirectory()
      || !sameIdentity(inodeIdentity(root), inodeIdentity(duplicate))) {
      throw new Error('handoff_bundle_writer_root_identity_changed');
    }
    for (const part of directoryParts) {
      const child = path.join(`/proc/self/fd/${descriptor}`, part);
      try {
        fs.mkdirSync(child, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const next = fs.openSync(
        child,
        fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
      );
      const opened = fs.fstatSync(next, { bigint: true });
      const lexical = fs.lstatSync(child, { bigint: true });
      if (!opened.isDirectory() || lexical.isSymbolicLink()
        || !sameIdentity(inodeIdentity(opened), inodeIdentity(lexical))) {
        fs.closeSync(next);
        throw new Error('handoff_bundle_writer_parent_identity_invalid');
      }
      fs.closeSync(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function writeFully(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
  }
}

function removeOwnedTemporary(candidate, expectedIdentity) {
  try {
    const current = fs.lstatSync(candidate, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink()
      && sameIdentity(inodeIdentity(current), expectedIdentity)) {
      fs.unlinkSync(candidate);
    }
  } catch { /* retain anything that is no longer provably the temporary file */ }
}

function writePinnedBytes({ root, expectedIdentity, target, value, role }) {
  if (!role) throw new Error('handoff_bundle_writer_role_required');
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const pinnedRoot = openPinnedRoot(root, expectedIdentity);
  let parentDescriptor;
  let temporaryDescriptor;
  let temporaryPath;
  let temporaryIdentity = null;
  try {
    const selectedTarget = relativeTarget(pinnedRoot.root, target);
    parentDescriptor = openPinnedTargetParent(
      pinnedRoot.descriptor,
      selectedTarget.parts.slice(0, -1),
    );
    const name = selectedTarget.parts.at(-1);
    const pinnedParent = `/proc/self/fd/${parentDescriptor}`;
    const pinnedTarget = path.join(pinnedParent, name);
    temporaryPath = path.join(
      pinnedParent,
      `.${name.slice(0, 80)}.tmp-${process.pid}-${crypto.randomBytes(16).toString('hex')}`,
    );
    temporaryDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | CREATE_EXCLUSIVE | NO_FOLLOW,
      0o400,
    );
    writeFully(temporaryDescriptor, bytes);
    fs.fsyncSync(temporaryDescriptor);
    fs.fchmodSync(temporaryDescriptor, 0o444);
    const temporary = fs.fstatSync(temporaryDescriptor, { bigint: true });
    temporaryIdentity = inodeIdentity(temporary);
    if (!temporary.isFile()
      || temporary.nlink !== 1n || Number(temporary.size) !== bytes.length) {
      throw new Error('handoff_bundle_writer_temporary_identity_invalid');
    }
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    try {
      fs.linkSync(temporaryPath, pinnedTarget);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('handoff_bundle_writer_target_preexisting');
      }
      throw error;
    }
    fs.unlinkSync(temporaryPath);
    temporaryPath = null;
    const published = fs.lstatSync(pinnedTarget, { bigint: true });
    if (!published.isFile() || published.isSymbolicLink()
      || published.nlink !== 1n
      || !sameIdentity(temporaryIdentity, inodeIdentity(published))
      || Number(published.size) !== bytes.length
      || (published.mode & 0o222n) !== 0n) {
      throw new Error('handoff_bundle_writer_target_identity_invalid');
    }
    fs.fsyncSync(parentDescriptor);
    const contentHash = hashBytes(bytes);
    const payload = {
      version: 1,
      kind: 'SubmissionHandoffBundlePinnedWriteReceipt',
      role,
      path: selectedTarget.relative,
      bytes: bytes.length,
      hash: contentHash,
      contentAddress: contentHash,
      rootIdentity: pinnedRoot.identity,
      atomic: true,
      externalActionPerformed: false,
    };
    return Object.freeze({
      ...payload,
      writeReceiptHash: hashRecord(
        'SubmissionHandoffBundlePinnedWriteReceipt',
        payload,
      ),
    });
  } finally {
    if (temporaryDescriptor !== undefined) fs.closeSync(temporaryDescriptor);
    if (temporaryPath && temporaryIdentity) {
      removeOwnedTemporary(temporaryPath, temporaryIdentity);
    }
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
    fs.closeSync(pinnedRoot.descriptor);
  }
}

export function createSubmissionHandoffBundlePinnedWriter({
  bundleRoot,
  expectedRootIdentity = null,
} = {}) {
  const inspected = openPinnedRoot(bundleRoot, expectedRootIdentity);
  fs.closeSync(inspected.descriptor);
  const options = Object.freeze({
    root: inspected.root,
    expectedIdentity: inspected.identity,
  });
  return Object.freeze({
    version: 1,
    kind: 'SubmissionHandoffBundlePinnedWriter',
    scopeRoot: inspected.root,
    rootIdentity: inspected.identity,
    writeBytes(target, value, writeOptions = {}) {
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        throw new Error('handoff_bundle_writer_bytes_required');
      }
      return Promise.resolve(writePinnedBytes({
        ...options,
        target,
        value: Buffer.from(value),
        role: writeOptions.role,
      }));
    },
    writeJson(target, value, writeOptions = {}) {
      return Promise.resolve(writePinnedBytes({
        ...options,
        target,
        value: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
        role: writeOptions.role,
      }));
    },
  });
}
