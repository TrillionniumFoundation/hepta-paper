import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  ensureScopedDirectorySync,
  inspectScopedRegularFileSync,
  stageScopedRegularFileCopySync,
} from './scoped-file-materialization-repository.mjs';
import { workspaceExecutionManifestHash, workspaceExecutionMerkleHash } from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';

const SOURCE_EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'runtime', 'automation-results', '.hepta-materialization-recovery', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);

function sourceExcludedName(name) {
  return SOURCE_EXCLUDED_NAMES.has(name) || /^\.venv(?:-|$)/.test(name) || name === 'venv';
}

export function sourceTreeExcludedNames(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [...SOURCE_EXCLUDED_NAMES];
  return [...new Set([...SOURCE_EXCLUDED_NAMES, ...fs.readdirSync(root, { withFileTypes: true }).filter((entry) => sourceExcludedName(entry.name)).map((entry) => entry.name)])];
}

export function directoryMerkleHash(root, { excludeRoots = [], excludeNames = [] } = {}) {
  const excluded = excludeRoots.map((candidate) => path.resolve(candidate));
  const names = new Set(excludeNames);
  const records = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (names.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      if (excluded.some((blocked) => isPathWithin(blocked, candidate))) continue;
      const relative = path.relative(root, candidate).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) records.push(`${relative}\0${fileSha256Hash(candidate).slice('sha256:'.length)}`);
      else if (entry.isSymbolicLink()) records.push(`${relative}\0link:${fs.readlinkSync(candidate)}`);
    }
  };
  walk(root);
  return `sha256:${crypto.createHash('sha256').update(records.join('\n')).digest('hex')}`;
}

export function inspectWorkspaceExecutionSnapshot(root, { excludeRoots = [], excludeNames = [] } = {}) {
  const resolvedRoot = path.resolve(root);
  const excluded = excludeRoots.map((candidate) => path.resolve(candidate));
  const names = new Set(excludeNames);
  const fileRecords = [];
  const directoryRecords = [];
  const blockers = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (names.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      if (excluded.some((blocked) => isPathWithin(blocked, candidate))) continue;
      const relative = path.relative(resolvedRoot, candidate).replace(/\\/g, '/');
      let stat;
      try { stat = fs.lstatSync(candidate); } catch (error) {
        blockers.push(`worker_workspace_entry_unreadable:${relative}:${error?.code || 'lstat_failed'}`);
        continue;
      }
      const mode = Number(stat.mode & 0o777);
      if (stat.isSymbolicLink()) {
        blockers.push(`worker_workspace_symlink_forbidden:${relative}`);
        continue;
      }
      if (stat.isDirectory()) {
        const identity = inspectScopedPathSync({ scopeRoot: resolvedRoot, candidate, expect: 'directory', forbidHardlinks: false });
        if (identity.blockers.length) {
          blockers.push(...identity.blockers.map((blocker) => `worker_workspace_directory_unsafe:${relative}:${blocker}`));
          continue;
        }
        directoryRecords.push(Object.freeze({ path: relative, mode }));
        walk(candidate);
        continue;
      }
      if (!stat.isFile()) {
        blockers.push(`worker_workspace_special_file_forbidden:${relative}`);
        continue;
      }
      try {
        const inspected = inspectScopedRegularFileSync({ scopeRoot: resolvedRoot, relative });
        fileRecords.push(Object.freeze({ path: relative, mode, hash: inspected.hash, bytes: inspected.bytes }));
      } catch (error) {
        blockers.push(`worker_workspace_file_unsafe:${relative}:${error?.code || 'inspection_failed'}`);
      }
    }
  };
  try { walk(resolvedRoot); } catch (error) { blockers.push(`worker_workspace_tree_unreadable:${error?.code || 'scan_failed'}`); }
  const merkleHash = workspaceExecutionMerkleHash(fileRecords);
  const manifestHash = workspaceExecutionManifestHash(fileRecords, directoryRecords);
  return Object.freeze({
    merkleHash,
    manifestHash,
    fileRecords: Object.freeze(fileRecords.sort((left, right) => left.path.localeCompare(right.path))),
    directoryRecords: Object.freeze(directoryRecords.sort((left, right) => left.path.localeCompare(right.path))),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function fileSha256Hash(candidate) {
  return sha256FileSync(candidate);
}

function datasetFileScope(source, allowedDatasetRoot) {
  return path.resolve(source) === path.resolve(allowedDatasetRoot)
    ? path.dirname(source)
    : allowedDatasetRoot;
}

function datasetManifestFromRecords(records) {
  return `sha256:${crypto.createHash('sha256').update(records.join('\n')).digest('hex')}`;
}

export function inspectStrictDatasetManifest(source, allowedDatasetRoot) {
  const resolvedSource = path.resolve(source);
  const resolvedAllowedRoot = path.resolve(allowedDatasetRoot);
  const blockers = [];
  const entries = [];
  let sourceType = null;
  try {
    const rootStat = fs.lstatSync(resolvedSource);
    sourceType = rootStat.isFile() ? 'file' : rootStat.isDirectory() ? 'directory' : null;
    if (!sourceType) blockers.push('worker_dataset_special_file_forbidden');
    if (rootStat.isSymbolicLink()) blockers.push('worker_dataset_symlink_forbidden');
    if (sourceType === 'file') {
      const scopeRoot = datasetFileScope(resolvedSource, resolvedAllowedRoot);
      const relative = path.relative(scopeRoot, resolvedSource).replace(/\\/g, '/');
      const inspected = inspectScopedRegularFileSync({ scopeRoot, relative });
      entries.push(Object.freeze({ type: 'file', relative: path.basename(resolvedSource), sourceRelative: relative, sourceScopeRoot: scopeRoot, hash: inspected.hash, bytes: inspected.bytes }));
      return Object.freeze({ sourceType, hash: inspected.hash, entries: Object.freeze(entries), blockers: Object.freeze(blockers) });
    }
    if (sourceType === 'directory') {
      const rootIdentity = inspectScopedPathSync({ scopeRoot: resolvedAllowedRoot, candidate: resolvedSource, expect: 'directory', forbidHardlinks: false });
      blockers.push(...rootIdentity.blockers);
      const records = [];
      const walk = (current) => {
        const children = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          const candidate = path.join(current, child.name);
          const relative = path.relative(resolvedSource, candidate).replace(/\\/g, '/');
          const stat = fs.lstatSync(candidate);
          if (stat.isSymbolicLink()) {
            blockers.push(`worker_dataset_symlink_forbidden:${relative}`);
            continue;
          }
          if (stat.isDirectory()) {
            const identity = inspectScopedPathSync({ scopeRoot: resolvedSource, candidate, expect: 'directory', forbidHardlinks: false });
            if (identity.blockers.length) {
              blockers.push(...identity.blockers.map((blocker) => `worker_dataset_directory_unsafe:${relative}:${blocker}`));
              continue;
            }
            entries.push(Object.freeze({ type: 'directory', relative }));
            walk(candidate);
            continue;
          }
          if (!stat.isFile()) {
            blockers.push(`worker_dataset_special_file_forbidden:${relative}`);
            continue;
          }
          try {
            const inspected = inspectScopedRegularFileSync({ scopeRoot: resolvedSource, relative });
            entries.push(Object.freeze({ type: 'file', relative, sourceRelative: relative, sourceScopeRoot: resolvedSource, hash: inspected.hash, bytes: inspected.bytes }));
            records.push(`${relative}\0${inspected.hash.slice('sha256:'.length)}`);
          } catch (error) {
            blockers.push(`worker_dataset_file_unsafe:${relative}:${error?.code || 'inspection_failed'}`);
          }
        }
      };
      walk(resolvedSource);
      return Object.freeze({
        sourceType,
        hash: blockers.length ? null : datasetManifestFromRecords(records),
        entries: Object.freeze(entries),
        blockers: Object.freeze([...new Set(blockers)]),
      });
    }
  } catch (error) {
    blockers.push(error?.code || 'dataset_source_unreadable');
  }
  return Object.freeze({ sourceType, hash: null, entries: Object.freeze(entries), blockers: Object.freeze([...new Set(blockers)]) });
}

export function safeStrictDatasetManifestHash(source, allowedDatasetRoot) {
  try { return inspectStrictDatasetManifest(source, allowedDatasetRoot).hash; } catch { return null; }
}

export function materializeDatasetSnapshot(mount, sandboxRoot) {
  const datasetRelative = `datasets/${mount.name}`;
  const bindSource = ensureScopedDirectorySync({ scopeRoot: sandboxRoot, relative: datasetRelative });
  const fileName = mount.sourceType === 'file' ? path.basename(mount.source) : null;
  for (const entry of mount.manifestEntries.filter((candidate) => candidate.type === 'directory')) {
    ensureScopedDirectorySync({ scopeRoot: sandboxRoot, relative: `${datasetRelative}/${entry.relative}` });
  }
  for (const entry of mount.manifestEntries.filter((candidate) => candidate.type === 'file')) {
    const destinationRelative = `${datasetRelative}/${mount.sourceType === 'file' ? fileName : entry.relative}`;
    let staged = null;
    try {
      staged = stageScopedRegularFileCopySync({
        sourceRoot: entry.sourceScopeRoot,
        destinationRoot: sandboxRoot,
        relative: entry.sourceRelative,
        destinationRelative,
      });
      if (staged.hash !== entry.hash || staged.bytes !== entry.bytes) {
        const error = new Error(`worker_dataset_source_changed_during_snapshot:${mount.name}:${entry.relative}`);
        error.code = 'worker_dataset_source_changed_during_snapshot';
        throw error;
      }
      commitStagedScopedFileSync(staged, { destinationRoot: sandboxRoot, expectedHash: null });
    } finally {
      abortStagedScopedFileSync(staged);
    }
  }
  const snapshotSource = mount.sourceType === 'file' ? path.join(bindSource, fileName) : bindSource;
  const snapshotManifest = inspectStrictDatasetManifest(snapshotSource, mount.sourceType === 'file' ? bindSource : snapshotSource);
  return Object.freeze({
    ...mount,
    bindSource,
    fileName,
    snapshotSource,
    mountSource: mount.sourceType === 'file' ? snapshotSource : bindSource,
    snapshotManifestHash: snapshotManifest.hash,
    snapshotBlockers: snapshotManifest.blockers,
  });
}

export function materializeRuntimeExecutableSnapshot({ source, expectedHash, invocationName, sandboxRoot }) {
  if (!source || !expectedHash) {
    const error = new Error('worker_runtime_executable_identity_missing');
    error.code = 'worker_runtime_executable_identity_missing';
    throw error;
  }
  const safeInvocationName = path.basename(String(invocationName || ''));
  if (!safeInvocationName || safeInvocationName !== String(invocationName) || safeInvocationName === '.' || safeInvocationName === '..') {
    const error = new Error('worker_runtime_executable_invocation_name_invalid');
    error.code = 'worker_runtime_executable_invocation_name_invalid';
    throw error;
  }
  const destinationRelative = `runtime/${safeInvocationName}`;
  let staged = null;
  try {
    staged = stageScopedRegularFileCopySync({
      sourceRoot: path.dirname(source),
      destinationRoot: sandboxRoot,
      relative: path.basename(source),
      destinationRelative,
    });
    if (staged.hash !== expectedHash) {
      const error = new Error('worker_runtime_executable_changed_before_snapshot');
      error.code = 'worker_runtime_executable_changed_before_snapshot';
      throw error;
    }
    const persisted = commitStagedScopedFileSync(staged, { destinationRoot: sandboxRoot, expectedHash: null });
    if (persisted.hash !== expectedHash) {
      const error = new Error('worker_runtime_executable_snapshot_hash_mismatch');
      error.code = 'worker_runtime_executable_snapshot_hash_mismatch';
      throw error;
    }
    return Object.freeze({ path: path.join(sandboxRoot, destinationRelative), sandboxPath: `/runtime/${safeInvocationName}`, invocationName: safeInvocationName, hash: persisted.hash });
  } finally {
    abortStagedScopedFileSync(staged);
  }
}

export function mapWorkArgument(argument, sourceRoot) {
  const value = String(argument);
  if (!path.isAbsolute(value)) return value;
  const resolved = path.resolve(value);
  return isPathWithin(sourceRoot, resolved) ? `/work${resolved.slice(sourceRoot.length)}` : value;
}
