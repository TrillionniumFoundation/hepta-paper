import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_WORKSPACE_FILES = 10_000;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readPinnedRegularFile(candidate) {
  const before = fs.lstatSync(candidate);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('recoverable_reviewer_workspace_snapshot_unsafe');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(candidate, flags);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameFileIdentity(before, opened)) {
      throw new Error('recoverable_reviewer_workspace_snapshot_drift');
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const final = fs.lstatSync(candidate);
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(after, final)
      || content.length !== after.size) {
      throw new Error('recoverable_reviewer_workspace_snapshot_drift');
    }
    return Object.freeze({
      mode: after.mode & 0o777,
      content,
      contentHash: hashBytes(content),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function buildImmutableReviewerWorkspaceSnapshot({
  workspacePath,
  maximumBytes = 16 * 1024 * 1024,
} = {}) {
  const workspace = path.resolve(String(workspacePath || ''));
  const root = fs.lstatSync(workspace);
  if (!root.isDirectory() || root.isSymbolicLink()
    || fs.realpathSync(workspace) !== workspace
    || !Number.isSafeInteger(Number(maximumBytes)) || Number(maximumBytes) < 1) {
    throw new Error('recoverable_reviewer_workspace_snapshot_invalid');
  }
  const files = [];
  let totalBytes = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(workspace, absolute).replace(/\\/g, '/');
      if (!relative || relative.startsWith('/')
        || relative.split('/').some((part) => !part || part === '.' || part === '..')
        || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('recoverable_reviewer_workspace_snapshot_unsafe');
      }
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const pinned = readPinnedRegularFile(absolute);
      totalBytes += pinned.content.length;
      if (files.length >= MAXIMUM_WORKSPACE_FILES
        || totalBytes > Number(maximumBytes)) {
        throw new Error('recoverable_reviewer_workspace_snapshot_limit_exceeded');
      }
      files.push(Object.freeze({
        path: relative,
        mode: pinned.mode,
        size: pinned.content.length,
        contentHash: pinned.contentHash,
        contentBase64: pinned.content.toString('base64'),
      }));
    }
  };
  walk(workspace);
  const payload = {
    version: 1,
    kind: 'ImmutableReviewerWorkspaceSnapshot',
    fileCount: files.length,
    totalBytes,
    files: Object.freeze(files),
  };
  return Object.freeze({
    ...payload,
    immutableReviewerWorkspaceSnapshotHash: hashRecord(
      'ImmutableReviewerWorkspaceSnapshot',
      payload,
    ),
  });
}
