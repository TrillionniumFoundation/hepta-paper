import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HEPTA_WORKSPACE_ROOT } from './workspace-layout.mjs';
import {
  inspectSealedReadOnlySubmodules,
} from './sealed-readonly-submodule-provenance.mjs';

const MAX_SNAPSHOT_ATTEMPTS = 3;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function safeErrorToken(value, fallback) {
  const token = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, '_');
  return token || fallback;
}

function git(operation, args, workspaceRoot, { emptyOutputAllowed = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) {
    const systemCode = safeErrorToken(result.error.code, 'unknown');
    throw codedError(`code_provenance_git_spawn_failed:${operation}:${systemCode}`, {
      gitOperation: operation,
      systemCode,
    });
  }
  if (result.status !== 0) {
    const exitStatus = Number.isInteger(result.status) ? result.status : 'no_status';
    const stderrHash = sha256(Buffer.from(result.stderr || ''));
    throw codedError(
      `code_provenance_git_command_failed:${operation}:exit_${exitStatus}:stderr_${stderrHash.slice(7)}`,
      { gitOperation: operation, exitStatus: result.status, stderrHash },
    );
  }
  const output = Buffer.from(result.stdout || '');
  if (!emptyOutputAllowed && output.length === 0) {
    throw codedError(`code_provenance_git_output_required:${operation}`, {
      gitOperation: operation,
    });
  }
  return output;
}

function requiredObjectId(output, operation) {
  const value = output.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw codedError(`code_provenance_git_object_id_invalid:${operation}`, {
      gitOperation: operation,
    });
  }
  return value;
}

function snapshotRace() {
  return codedError('code_provenance_snapshot_changed_during_scan', {
    retryableCodeProvenanceSnapshot: true,
  });
}

function isRaceFilesystemError(error, { symlinkRead = false } = {}) {
  return ['ENOENT', 'ENOTDIR', 'ESTALE', 'ELOOP'].includes(error?.code)
    || (symlinkRead && error?.code === 'EINVAL');
}

function entryReadError(relativePath, error) {
  const operation = safeErrorToken(error?.code, 'unknown');
  const pathHash = sha256(relativePath).slice(7, 23);
  return codedError(`code_provenance_entry_read_failed:${pathHash}:${operation}`, {
    filesystemOperation: operation,
    repositoryPathHash: `sha256:${sha256(relativePath).slice(7)}`,
  });
}

function statIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function repositoryEntryMode(stat) {
  if (stat.isFile()) return (Number(stat.mode) & 0o111) === 0 ? 0o100644 : 0o100755;
  if (stat.isSymbolicLink()) return 0o120000;
  if (stat.isDirectory()) return 0o040000;
  return 0;
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function lstatOrMissing(absolutePath, relativePath) {
  try {
    return fs.lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
    if (isRaceFilesystemError(error)) throw snapshotRace();
    throw entryReadError(relativePath, error);
  }
}

function stableRegularFile(absolutePath, relativePath, initialStat, { includeContent }) {
  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const openedIdentity = statIdentity(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameStatIdentity(statIdentity(initialStat), openedIdentity)) throw snapshotRace();
    const content = fs.readFileSync(descriptor);
    const finalIdentity = statIdentity(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameStatIdentity(openedIdentity, finalIdentity)
      || BigInt(content.length) !== initialStat.size) throw snapshotRace();
    return {
      record: Object.freeze({
        path: relativePath,
        kind: 'file',
        mode: repositoryEntryMode(initialStat),
        contentHash: sha256(content),
      }),
      identity: finalIdentity,
      ...(includeContent ? { content } : {}),
    };
  } catch (error) {
    if (error?.retryableCodeProvenanceSnapshot || isRaceFilesystemError(error)) throw snapshotRace();
    throw entryReadError(relativePath, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function stableSymbolicLink(absolutePath, relativePath, initialStat) {
  try {
    const content = fs.readlinkSync(absolutePath, { encoding: 'buffer' });
    const finalStat = fs.lstatSync(absolutePath, { bigint: true });
    const initialIdentity = statIdentity(initialStat);
    const finalIdentity = statIdentity(finalStat);
    if (!sameStatIdentity(initialIdentity, finalIdentity) || !finalStat.isSymbolicLink()) {
      throw snapshotRace();
    }
    return {
      record: Object.freeze({
        path: relativePath,
        kind: 'symlink',
        mode: repositoryEntryMode(initialStat),
        contentHash: sha256(content),
      }),
      identity: finalIdentity,
    };
  } catch (error) {
    if (error?.retryableCodeProvenanceSnapshot
      || isRaceFilesystemError(error, { symlinkRead: true })) throw snapshotRace();
    throw entryReadError(relativePath, error);
  }
}

function stableMetadataEntry(absolutePath, relativePath, initialStat) {
  const finalStat = lstatOrMissing(absolutePath, relativePath);
  if (!finalStat) throw snapshotRace();
  const initialIdentity = statIdentity(initialStat);
  const finalIdentity = statIdentity(finalStat);
  if (!sameStatIdentity(initialIdentity, finalIdentity)) throw snapshotRace();
  return {
    record: Object.freeze({
      path: relativePath,
      kind: initialStat.isDirectory() ? 'directory' : 'other',
      mode: repositoryEntryMode(initialStat),
      contentHash: null,
    }),
    identity: finalIdentity,
  };
}

function hashFilesystemEntry(workspaceRoot, relativePath, options = {}) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw codedError('code_provenance_repository_path_outside_workspace');
  }
  const initialStat = lstatOrMissing(absolutePath, relativePath);
  if (!initialStat) {
    return {
      record: Object.freeze({
        path: relativePath,
        kind: 'missing',
        mode: null,
        contentHash: null,
      }),
      identity: null,
    };
  }
  if (initialStat.isFile()) {
    return stableRegularFile(absolutePath, relativePath, initialStat, options);
  }
  if (initialStat.isSymbolicLink()) {
    return stableSymbolicLink(absolutePath, relativePath, initialStat);
  }
  return stableMetadataEntry(absolutePath, relativePath, initialStat);
}

function splitRepositoryPaths(listed) {
  if (listed[listed.length - 1] !== 0) {
    throw codedError('code_provenance_git_nul_list_invalid:repository_entries');
  }
  const paths = [];
  let offset = 0;
  for (let index = 0; index < listed.length; index += 1) {
    if (listed[index] !== 0) continue;
    const rawPath = listed.subarray(offset, index);
    offset = index + 1;
    if (rawPath.length === 0) continue;
    const relativePath = rawPath.toString('utf8');
    if (!Buffer.from(relativePath, 'utf8').equals(rawPath)) {
      throw codedError('code_provenance_repository_path_utf8_required');
    }
    if (path.isAbsolute(relativePath)
      || relativePath.split('/').some((segment) => segment === '..')) {
      throw codedError('code_provenance_repository_path_invalid');
    }
    paths.push(relativePath);
  }
  return [...new Set(paths)].sort((left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'),
  ));
}

function repositoryState(indexState, entries) {
  const digest = crypto.createHash('sha256');
  digest.update(indexState);
  digest.update('\0');
  for (const entry of entries) {
    digest.update(JSON.stringify(entry.record));
    digest.update('\0');
  }
  return Object.freeze({
    indexStateHash: sha256(indexState),
    repositoryEntryCount: entries.length,
    repositoryContentHash: `sha256:${digest.digest('hex')}`,
  });
}

function captureRepositorySnapshot(workspaceRoot, {
  ignoreSubmoduleWorktreeStatus = false,
} = {}) {
  const head = requiredObjectId(git('head', ['rev-parse', 'HEAD'], workspaceRoot), 'head');
  const commitTree = requiredObjectId(
    git('head_tree', ['rev-parse', 'HEAD^{tree}'], workspaceRoot),
    'head_tree',
  );
  const tags = git(
    'head_tags', ['tag', '--points-at', 'HEAD'], workspaceRoot, { emptyOutputAllowed: true },
  ).toString('utf8').split(/\r?\n/).filter(Boolean).sort();
  const worktreeStatus = git(
    'worktree_status', [
      'status',
      '--porcelain=v1',
      '-z',
      ...(ignoreSubmoduleWorktreeStatus ? ['--ignore-submodules=dirty'] : []),
    ], workspaceRoot,
    { emptyOutputAllowed: true },
  );
  const paths = splitRepositoryPaths(git(
    'repository_entries',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    workspaceRoot,
  ));
  const indexState = git(
    'index_state', ['diff-index', '--cached', '--raw', '-z', 'HEAD'], workspaceRoot,
    { emptyOutputAllowed: true },
  );
  const entries = paths.map((relativePath) => hashFilesystemEntry(workspaceRoot, relativePath));
  const state = repositoryState(indexState, entries);
  return Object.freeze({
    head,
    commitTree,
    tags: Object.freeze(tags),
    worktreeStatus,
    indexState,
    entries: Object.freeze(entries),
    ...state,
  });
}

function exactSnapshotIdentity(snapshot) {
  return JSON.stringify({
    head: snapshot.head,
    commitTree: snapshot.commitTree,
    tags: snapshot.tags,
    worktreeStatus: snapshot.worktreeStatus.toString('base64'),
    indexState: snapshot.indexState.toString('base64'),
    entries: snapshot.entries,
    indexStateHash: snapshot.indexStateHash,
    repositoryEntryCount: snapshot.repositoryEntryCount,
    repositoryContentHash: snapshot.repositoryContentHash,
  });
}

function packageEntry(snapshot) {
  return snapshot.entries.find((entry) => entry.record.path === 'package.json');
}

function packageMatchesSnapshot(candidate, snapshot) {
  const entry = packageEntry(snapshot);
  return entry?.record.kind === 'file'
    && JSON.stringify({ record: candidate.record, identity: candidate.identity })
      === JSON.stringify({ record: entry.record, identity: entry.identity });
}

function workspaceIsReadOnly(workspaceRoot) {
  try {
    const stat = fs.lstatSync(workspaceRoot, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o222n) === 0n;
  } catch {
    return false;
  }
}

function parsePackage(packageFile) {
  let pkg;
  try {
    pkg = JSON.parse(packageFile.content.toString('utf8'));
  } catch {
    throw codedError('code_provenance_package_json_invalid');
  }
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw codedError('code_provenance_package_version_required');
  }
  return pkg;
}

function stableSnapshot(workspaceRoot, options) {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const before = captureRepositorySnapshot(workspaceRoot, options);
      const beforePackage = packageEntry(before);
      if (beforePackage?.record.kind !== 'file') {
        throw codedError('code_provenance_package_file_required');
      }
      const packageFile = hashFilesystemEntry(workspaceRoot, 'package.json', {
        includeContent: true,
      });
      const after = captureRepositorySnapshot(workspaceRoot, options);
      if (exactSnapshotIdentity(before) === exactSnapshotIdentity(after)
        && packageMatchesSnapshot(packageFile, before)
        && packageMatchesSnapshot(packageFile, after)) {
        return Object.freeze({ snapshot: after, pkg: parsePackage(packageFile) });
      }
    } catch (error) {
      if (!error?.retryableCodeProvenanceSnapshot) throw error;
    }
  }
  throw codedError('code_provenance_snapshot_unstable');
}

export function currentCodeProvenance({
  workspaceRoot = HEPTA_WORKSPACE_ROOT,
  allowReleaseCommitEnvironment = true,
  ignoreSubmoduleWorktreeStatus = false,
} = {}) {
  const canonicalRoot = fs.realpathSync(workspaceRoot);
  const canonicalWorkspace = canonicalRoot === fs.realpathSync(HEPTA_WORKSPACE_ROOT);
  // A sealed deployment contains a hydrated Git-LFS/CAS representation whose
  // bytes are intentionally not the pointer worktree.  `git status` attempts
  // to clean those objects and can mutate `.git/modules` even when the parent
  // tree is read-only.  Select the no-status policy only for an explicitly
  // sealed launcher or a read-only root, and verify the deployment closure
  // (submodule commit, tree and content/CAS tree hash) before accepting it.
  const sealedReadOnly = ignoreSubmoduleWorktreeStatus
    || process.env.HEPTA_RELEASE_ENV_LAUNCHER === 'sealed-v1'
    || workspaceIsReadOnly(canonicalRoot);
  if (sealedReadOnly) inspectSealedReadOnlySubmodules({ workspaceRoot: canonicalRoot });
  const { snapshot, pkg } = stableSnapshot(canonicalRoot, {
    ignoreSubmoduleWorktreeStatus: sealedReadOnly,
  });
  const commit = (canonicalWorkspace && allowReleaseCommitEnvironment
    ? process.env.HEPTA_RELEASE_COMMIT
    : null) || snapshot.head;
  const worktreeStateHash = `sha256:${crypto.createHash('sha256')
    .update(String(commit))
    .update('\0')
    .update(snapshot.commitTree)
    .update('\0')
    .update(snapshot.worktreeStatus)
    .update('\0')
    .update(snapshot.indexStateHash)
    .update('\0')
    .update(snapshot.repositoryContentHash)
    .digest('hex')}`;
  return Object.freeze({
    version: 2,
    kind: 'CodeProvenance',
    packageVersion: pkg.version,
    commit,
    commitTree: snapshot.commitTree,
    tags: Object.freeze([...snapshot.tags]),
    treeDirty: snapshot.worktreeStatus.length > 0,
    indexStateHash: snapshot.indexStateHash,
    repositoryEntryCount: snapshot.repositoryEntryCount,
    repositoryContentHash: snapshot.repositoryContentHash,
    worktreeStateHash,
    evidenceEnvironment: process.env.HEPTA_EVIDENCE_ENVIRONMENT || 'production',
    evidenceClass: process.env.HEPTA_EVIDENCE_CLASS || 'runtime_unclassified',
  });
}

export function reportPointerIsCurrent(pointer, provenance = currentCodeProvenance()) {
  const exactWorktreeIdentityRequired = Number(provenance?.version || 0) >= 2;
  return pointer?.kind === 'CurrentReportPointer'
    && pointer?.codeProvenance?.commit === provenance.commit
    && (!exactWorktreeIdentityRequired || (
      pointer?.codeProvenance?.version === provenance.version
      && pointer.codeProvenance.commitTree === provenance.commitTree
      && pointer.codeProvenance.indexStateHash === provenance.indexStateHash
      && pointer.codeProvenance.repositoryContentHash === provenance.repositoryContentHash
      && pointer.codeProvenance.worktreeStateHash === provenance.worktreeStateHash
    ))
    && pointer?.codeProvenance?.packageVersion === provenance.packageVersion
    && pointer?.reportHash
    && Date.parse(pointer.validUntil || '') > Date.now();
}
