import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin, sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

export const DEFAULT_RETENTION_POLICIES = Object.freeze({
  'automation-workspaces': Object.freeze({ maxBytes: 1024 ** 3, maxAgeMs: 7 * 86400000, keepNewest: 0 }),
  'automation-cache': Object.freeze({ maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000, keepNewest: 10 }),
  reports: Object.freeze({ maxBytes: 64 * 1024 ** 2, maxAgeMs: 30 * 86400000, keepNewest: 12 }),
  backups: Object.freeze({ maxBytes: 96 * 1024 ** 2, maxAgeMs: 30 * 86400000, keepNewest: 8, minimumRecoverableGenerations: 2 }),
});

export function safeRetentionNodeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function directoryIdentity(stat, realPath) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    realPath: path.resolve(realPath),
  });
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && path.resolve(String(left.realPath || '')) === path.resolve(String(right.realPath || '')));
}

function openPinnedDirectory(candidate) {
  const resolved = path.resolve(candidate);
  const before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('runtime_retention_scope_not_regular_directory');
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) {
      throw new Error('runtime_retention_scope_identity_changed');
    }
    const descriptorPath = `/proc/self/fd/${descriptor}`;
    if (!fs.existsSync(descriptorPath)) throw new Error('runtime_retention_descriptor_root_unavailable');
    const realPath = fs.realpathSync.native(descriptorPath);
    if (fs.realpathSync.native(resolved) !== realPath) throw new Error('runtime_retention_scope_realpath_changed');
    return { descriptor, descriptorPath, identity: directoryIdentity(opened, realPath) };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function openPinnedRetentionCategory(runtimeRoot, category, expectedScope = null) {
  const runtime = openPinnedDirectory(runtimeRoot);
  let categoryRoot = null;
  try {
    const categoryPath = path.join(runtime.descriptorPath, category);
    categoryRoot = openPinnedDirectory(categoryPath);
    if (!pathWithin(runtime.identity.realPath, categoryRoot.identity.realPath)) throw new Error('runtime_retention_category_outside_root');
    const scope = Object.freeze({ runtimeRoot: runtime.identity, categoryRoot: categoryRoot.identity });
    if (expectedScope
      && (!sameDirectoryIdentity(scope.runtimeRoot, expectedScope.runtimeRoot)
        || !sameDirectoryIdentity(scope.categoryRoot, expectedScope.categoryRoot))) {
      throw new Error('runtime_retention_scope_identity_changed');
    }
    return {
      scope,
      categoryDescriptor: categoryRoot.descriptor,
      categoryDescriptorPath: categoryRoot.descriptorPath,
      close() {
        fs.closeSync(categoryRoot.descriptor);
        fs.closeSync(runtime.descriptor);
      },
    };
  } catch (error) {
    if (categoryRoot) fs.closeSync(categoryRoot.descriptor);
    fs.closeSync(runtime.descriptor);
    throw error;
  }
}

function entryBytes(candidate) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return fs.readdirSync(candidate).reduce((total, name) => total + entryBytes(path.join(candidate, name)), stat.size);
}

export function retentionMemberHash(candidate) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) return hashRecord('RuntimeRetentionSymlink', { target: fs.readlinkSync(candidate) });
  if (stat.isFile()) return sha256FileSync(candidate);
  const rows = fs.readdirSync(candidate).sort().map((name) => ({ name, hash: retentionMemberHash(path.join(candidate, name)) }));
  return hashRecord('RuntimeRetentionDirectory', rows);
}

export function retentionEntryHash(entry) {
  if (!entry.companionPaths?.length) return retentionMemberHash(entry.path);
  return hashRecord('RuntimeRetentionEntryGroup', [entry.path, ...entry.companionPaths].map((candidate) => ({
    name: path.basename(candidate),
    hash: retentionMemberHash(candidate),
  })));
}

export function listRuntimeRetentionEntries(root, category) {
  const categoryRoot = path.join(root, category);
  if (!fs.existsSync(categoryRoot)) return Object.freeze({ entries: [], scope: null, blocker: null });
  let pinned = null;
  try { pinned = openPinnedRetentionCategory(root, category); } catch (error) {
    return Object.freeze({ entries: [], scope: null, blocker: String(error?.message || error) });
  }
  try {
    const names = fs.readdirSync(pinned.categoryDescriptorPath);
    const entries = names
      .filter((name) => category !== 'backups' || !/\.sqlite(?:\.restore-drill)?\.receipt\.json$/.test(name))
      .map((name) => {
        const candidate = path.join(categoryRoot, name);
        const pinnedCandidate = path.join(pinned.categoryDescriptorPath, name);
        const stat = fs.lstatSync(pinnedCandidate);
        const possibleCompanions = category === 'backups' && name.endsWith('.sqlite')
          ? [`${candidate}.receipt.json`, `${candidate}.restore-drill.receipt.json`]
          : [];
        const companionPaths = possibleCompanions.filter((companionPath) => fs.existsSync(path.join(pinned.categoryDescriptorPath, path.basename(companionPath))));
        const companionPinnedPaths = companionPaths.map((item) => path.join(pinned.categoryDescriptorPath, path.basename(item)));
        const companionStats = companionPinnedPaths.map((item) => fs.lstatSync(item));
        return {
          name,
          path: candidate,
          companionPaths,
          bytes: entryBytes(pinnedCandidate) + companionPinnedPaths.reduce((total, item) => total + entryBytes(item), 0),
          modifiedAtMs: Math.max(stat.mtimeMs, ...companionStats.map((item) => item.mtimeMs)),
          symbolicLink: stat.isSymbolicLink() || companionStats.some((item) => item.isSymbolicLink()),
          contentHash: retentionEntryHash({ path: pinnedCandidate, companionPaths: companionPinnedPaths }),
          categoryScope: pinned.scope,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name));
    return Object.freeze({ entries, scope: pinned.scope, blocker: null });
  } finally {
    pinned.close();
  }
}

export function retentionMemberPaths(entry) {
  return [entry.path, ...(entry.companionPaths || [])].map((candidate) => path.resolve(candidate));
}

export function pinnedRetentionMemberPath(pinned, runtimeRoot, category, candidate) {
  const categoryRoot = path.resolve(runtimeRoot, category);
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== categoryRoot || path.basename(resolved) === '.' || path.basename(resolved) === '..') {
    throw new Error('retention_entry_scope_invalid');
  }
  return path.join(pinned.categoryDescriptorPath, path.basename(resolved));
}

export function retentionRemovalMembers(entry, pinned, runtimeRoot) {
  return retentionMemberPaths(entry).map((candidate) => {
    const descriptorPath = pinnedRetentionMemberPath(pinned, runtimeRoot, entry.category, candidate);
    return {
      path: candidate,
      contentHash: fs.existsSync(descriptorPath) ? retentionMemberHash(descriptorPath) : null,
    };
  });
}

export function retentionPathExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}
