import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../record-hash.mjs';
import { isPathWithin } from './path-utils.mjs';

function statIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    linkCount: Number(stat.nlink),
  };
}

function componentSymlinks(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  const found = [];
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) found.push(cursor); } catch { break; }
  }
  return found;
}

export function inspectScopedPathSync({
  scopeRoot,
  candidate,
  expect = 'file',
  forbidHardlinks = expect === 'file',
} = {}) {
  const lexicalRoot = path.resolve(scopeRoot || '.');
  const lexicalPath = path.resolve(candidate || '');
  const blockers = [];
  if (!isPathWithin(lexicalRoot, lexicalPath)) blockers.push('scoped_path_lexical_escape');
  let rootRealPath = null;
  let realPath = null;
  let stat = null;
  try { if (fs.lstatSync(lexicalRoot).isSymbolicLink()) blockers.push('scoped_root_symlink_forbidden'); }
  catch { blockers.push('scoped_root_unreadable'); }
  try { rootRealPath = fs.realpathSync.native(lexicalRoot); } catch { blockers.push('scoped_root_unreadable'); }
  try { stat = fs.lstatSync(lexicalPath, { bigint: true }); } catch { blockers.push('scoped_path_missing_or_unreadable'); }
  const symlinkComponents = blockers.includes('scoped_path_lexical_escape') ? [] : componentSymlinks(lexicalRoot, lexicalPath);
  if (symlinkComponents.length) blockers.push('scoped_path_symlink_forbidden');
  try { realPath = fs.realpathSync.native(lexicalPath); } catch { if (stat) blockers.push('scoped_path_realpath_unreadable'); }
  if (rootRealPath && realPath && !isPathWithin(rootRealPath, realPath)) blockers.push('scoped_path_realpath_escape');
  if (stat) {
    if (expect === 'file' && !stat.isFile()) blockers.push('scoped_path_regular_file_required');
    if (expect === 'directory' && !stat.isDirectory()) blockers.push('scoped_path_directory_required');
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) blockers.push('scoped_path_special_file_forbidden');
    if (forbidHardlinks && stat.isFile() && Number(stat.nlink) > 1) blockers.push('scoped_path_hardlink_forbidden');
  }
  const payload = {
    version: 1,
    kind: 'ScopedFileIdentity',
    status: blockers.length ? 'scoped_file_identity_blocked' : 'scoped_file_identity_verified',
    scopeRoot: lexicalRoot,
    path: lexicalPath,
    rootRealPath,
    realPath,
    identity: stat ? statIdentity(stat) : null,
    symlinkComponents,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, scopedFileIdentityHash: hashRecord('ScopedFileIdentity', payload) });
}

export function readScopedFileSync({ scopeRoot, candidate, maximumBytes = 256 * 1024 * 1024 } = {}) {
  const before = inspectScopedPathSync({ scopeRoot, candidate, expect: 'file', forbidHardlinks: true });
  const blockers = [...before.blockers];
  let bytes = null;
  if (!blockers.length && Number(before.identity?.size || 0) > maximumBytes) blockers.push('scoped_file_size_limit_exceeded');
  if (!blockers.length) {
    try {
      const descriptor = fs.openSync(before.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { bytes = fs.readFileSync(descriptor); } finally { fs.closeSync(descriptor); }
    } catch { blockers.push('scoped_file_read_failed'); }
  }
  const after = inspectScopedPathSync({ scopeRoot, candidate, expect: 'file', forbidHardlinks: true });
  blockers.push(...after.blockers);
  if (before.identity && after.identity && JSON.stringify(before.identity) !== JSON.stringify(after.identity)) {
    blockers.push('scoped_file_identity_changed_during_read');
  }
  const payload = {
    version: 1,
    kind: 'ScopedFileReadReceipt',
    status: blockers.length ? 'scoped_file_read_blocked' : 'scoped_file_read_verified',
    beforeIdentityHash: before.scopedFileIdentityHash,
    afterIdentityHash: after.scopedFileIdentityHash,
    bytes: bytes?.length ?? null,
    hash: bytes ? hashBytes(bytes) : null,
    blockers: [...new Set(blockers)],
  };
  return { ...payload, content: blockers.length ? null : bytes, scopedFileReadReceiptHash: hashRecord('ScopedFileReadReceipt', payload) };
}

export function inspectScopedWriteTargetSync({ scopeRoot, candidate } = {}) {
  const root = path.resolve(scopeRoot || '.');
  const target = path.resolve(candidate || '');
  const blockers = [];
  if (!isPathWithin(root, target) || target === root) blockers.push('scoped_write_target_lexical_escape');
  let parent = path.dirname(target);
  while (isPathWithin(root, parent) && !fs.existsSync(parent) && parent !== root) parent = path.dirname(parent);
  const parentIdentity = inspectScopedPathSync({ scopeRoot: root, candidate: parent, expect: 'directory', forbidHardlinks: false });
  blockers.push(...parentIdentity.blockers.map((item) => `scoped_write_parent:${item}`));
  let targetIdentity = null;
  if (fs.existsSync(target)) {
    targetIdentity = inspectScopedPathSync({ scopeRoot: root, candidate: target, expect: 'file', forbidHardlinks: true });
    blockers.push(...targetIdentity.blockers.map((item) => `scoped_write_existing_target:${item}`));
  }
  const payload = {
    version: 1,
    kind: 'ScopedWriteTargetIdentity',
    status: blockers.length ? 'scoped_write_target_blocked' : 'scoped_write_target_verified',
    scopeRoot: root,
    target,
    existingParent: parent,
    parentIdentityHash: parentIdentity.scopedFileIdentityHash,
    targetIdentityHash: targetIdentity?.scopedFileIdentityHash || null,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, scopedWriteTargetIdentityHash: hashRecord('ScopedWriteTargetIdentity', payload) });
}
