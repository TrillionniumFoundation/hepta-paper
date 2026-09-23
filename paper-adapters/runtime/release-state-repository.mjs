import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectReleaseState } from '../../paper-domain/contracts/release-state-contract.mjs';

const defaultWorkspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const MAXIMUM_DOCUMENT_BYTES = 16 * 1024 * 1024;
const REQUIRED_DOCUMENTS = Object.freeze({
  packageJson: 'package.json',
  packageLock: 'package-lock.json',
  currentStatus: 'paper-core/docs/CURRENT_STATUS.md',
  releaseDocument: 'RELEASE.md',
  changelog: 'CHANGELOG.md',
});

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function strictGit(workspaceRoot, args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`release_state_git_query_failed:${args[0] || 'unknown'}`);
  }
  return String(result.stdout || '').trim();
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function readRegularFileNoFollow(workspaceRoot, relativePath) {
  const file = path.resolve(workspaceRoot, relativePath);
  if (!pathWithin(workspaceRoot, file)) throw new Error('release_state_document_path_invalid');
  const selectedRoot = path.resolve(workspaceRoot);
  const rootStat = fs.lstatSync(selectedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('release_state_workspace_root_invalid');
  }
  let cursor = selectedRoot;
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`release_state_document_symlink_forbidden:${relativePath}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`release_state_document_parent_not_directory:${relativePath}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`release_state_document_not_regular:${relativePath}`);
    }
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAXIMUM_DOCUMENT_BYTES) {
      throw new Error(`release_state_document_not_regular:${relativePath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.length !== before.size) {
      throw new Error(`release_state_document_changed_during_read:${relativePath}`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function tagList(value) {
  return value.split(/\r?\n/u).filter(Boolean).sort((left, right) => left.localeCompare(right));
}

function captureOnce(workspaceRoot) {
  const headBefore = strictGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[a-f0-9]{40,64}$/u.test(headBefore)) throw new Error('release_state_head_commit_invalid');
  const documents = Object.fromEntries(Object.entries(REQUIRED_DOCUMENTS).map(([name, relative]) => (
    [name, readRegularFileNoFollow(workspaceRoot, relative)]
  )));
  const headTags = tagList(strictGit(workspaceRoot, ['tag', '--points-at', 'HEAD']));
  const allTags = tagList(strictGit(workspaceRoot, ['tag', '--list']));
  const headAfter = strictGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (headBefore !== headAfter) throw new Error('release_state_head_changed_during_capture');

  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(documents.packageJson.toString('utf8'));
    packageLock = JSON.parse(documents.packageLock.toString('utf8'));
  } catch {
    throw new Error('release_state_package_document_invalid');
  }
  const releaseState = inspectReleaseState({
    packageJson,
    packageLock,
    currentStatus: documents.currentStatus.toString('utf8'),
    releaseDocument: documents.releaseDocument.toString('utf8'),
    changelog: documents.changelog.toString('utf8'),
    headTags,
    allTags,
  });
  const payload = {
    version: 2,
    kind: 'WorkspaceReleaseStateSnapshot',
    status: releaseState.ok
      ? `workspace_release_state_${releaseState.state}`
      : 'workspace_release_state_blocked',
    headCommit: headBefore,
    headTags,
    allTags,
    documentHashes: Object.freeze(Object.fromEntries(
      Object.entries(REQUIRED_DOCUMENTS).map(([name, relative]) => [name, Object.freeze({
        path: relative,
        sha256: sha256(documents[name]),
      })]),
    )),
    releaseState,
  };
  return Object.freeze({
    ...payload,
    workspaceReleaseStateSnapshotHash: sha256(JSON.stringify(payload)),
  });
}

export function inspectWorkspaceReleaseState({
  workspaceRoot = defaultWorkspaceRoot,
  maximumAttempts = 3,
} = {}) {
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 2 || maximumAttempts > 5) {
    throw new Error('release_state_snapshot_attempts_invalid');
  }
  let previous = null;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let current;
    try {
      current = captureOnce(path.resolve(workspaceRoot));
    } catch (error) {
      if (error?.message !== 'release_state_head_changed_during_capture') throw error;
      previous = null;
      continue;
    }
    if (previous?.workspaceReleaseStateSnapshotHash === current.workspaceReleaseStateSnapshotHash) {
      return current;
    }
    previous = current;
  }
  throw new Error('release_state_snapshot_unstable');
}

export function assertWorkspaceReleaseReady({
  workspaceRoot = defaultWorkspaceRoot,
  expectedSnapshotHash = null,
} = {}) {
  const snapshot = inspectWorkspaceReleaseState({ workspaceRoot });
  if (!snapshot.releaseState.ok || snapshot.releaseState.state !== 'release_ready') {
    throw new Error(`workspace_release_state_not_ready:${snapshot.releaseState.state || 'invalid'}`);
  }
  if (expectedSnapshotHash !== null
    && expectedSnapshotHash !== snapshot.workspaceReleaseStateSnapshotHash) {
    throw new Error('workspace_release_state_snapshot_changed');
  }
  return snapshot;
}
