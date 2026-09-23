import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

function privateOutputParent(candidate, allowedRoot) {
  const target = path.resolve(candidate);
  const root = path.resolve(allowedRoot);
  if (target === root || !isPathWithin(root, target)) {
    throw new Error('local_golden_dataset_output_outside_allowed_root');
  }
  const parent = path.dirname(target);
  const relativeParent = path.relative(root, parent);
  let current = root;
  for (const segment of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const identity = fs.lstatSync(current);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : identity.uid;
    if (!identity.isDirectory() || identity.isSymbolicLink()
      || identity.uid !== currentUid || (identity.mode & 0o777) !== 0o700
      || fs.realpathSync(current) !== current) {
      throw new Error('local_golden_dataset_output_parent_identity_invalid');
    }
  }
  return parent;
}

function existingOutputContent(target, mode) {
  let descriptor = null;
  try {
    const before = fs.lstatSync(target);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : before.uid;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.uid !== currentUid || (before.mode & 0o777) !== mode
      || fs.realpathSync(target) !== target) {
      throw new Error('local_golden_dataset_existing_output_identity_invalid');
    }
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode
      || opened.uid !== before.uid || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error('local_golden_dataset_existing_output_replaced');
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || content.length !== opened.size) {
      throw new Error('local_golden_dataset_existing_output_changed_during_read');
    }
    return content;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function writeLocalGoldenDatasetOutputNoClobber(
  candidate,
  content,
  mode,
  { allowedRoot } = {},
) {
  const target = path.resolve(candidate);
  const parent = privateOutputParent(target, allowedRoot);
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      mode,
    );
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try { fs.linkSync(temporary, target); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = existingOutputContent(target, mode);
      if (!existing.equals(Buffer.from(content))) {
        throw new Error('local_golden_dataset_output_conflict');
      }
    }
    fs.unlinkSync(temporary);
    const parentDescriptor = fs.openSync(
      parent,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
    );
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export function removeLocalGoldenDatasetStagingOutput(candidate, { allowedRoot } = {}) {
  const target = path.resolve(candidate);
  privateOutputParent(target, allowedRoot);
  let identity;
  try { identity = fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : identity.uid;
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
    || identity.uid !== currentUid || (identity.mode & 0o777) !== 0o600
    || fs.realpathSync(target) !== target) {
    throw new Error('local_golden_dataset_staging_output_identity_invalid');
  }
  fs.unlinkSync(target);
}
