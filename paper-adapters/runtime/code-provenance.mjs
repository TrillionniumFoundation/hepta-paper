import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HEPTA_WORKSPACE_ROOT } from './workspace-layout.mjs';

function git(args, workspaceRoot, { trim = true } = {}) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = result.status === 0 ? String(result.stdout || '') : '';
  return trim ? output.trim() : output;
}

function hashFilesystemEntry(workspaceRoot, relativePath) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  let stat;
  try { stat = fs.lstatSync(absolutePath); } catch {
    return { path: relativePath, kind: 'missing', mode: null, contentHash: null };
  }
  let kind = 'other';
  let contentHash = null;
  if (stat.isFile()) {
    kind = 'file';
    contentHash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')}`;
  } else if (stat.isSymbolicLink()) {
    kind = 'symlink';
    contentHash = `sha256:${crypto.createHash('sha256').update(fs.readlinkSync(absolutePath)).digest('hex')}`;
  } else if (stat.isDirectory()) kind = 'directory';
  return { path: relativePath, kind, mode: Number(stat.mode), contentHash };
}

function exactRepositoryState(workspaceRoot, commit) {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], workspaceRoot, { trim: false });
  const paths = [...new Set(listed.split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const indexState = git(['diff-index', '--cached', '--raw', '-z', commit || 'HEAD'], workspaceRoot, { trim: false });
  const digest = crypto.createHash('sha256');
  digest.update(indexState);
  digest.update('\0');
  for (const relativePath of paths) {
    digest.update(JSON.stringify(hashFilesystemEntry(workspaceRoot, relativePath)));
    digest.update('\0');
  }
  return Object.freeze({
    indexStateHash: `sha256:${crypto.createHash('sha256').update(indexState).digest('hex')}`,
    repositoryEntryCount: paths.length,
    repositoryContentHash: `sha256:${digest.digest('hex')}`,
  });
}

export function currentCodeProvenance({ workspaceRoot = HEPTA_WORKSPACE_ROOT } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
  const canonicalWorkspace = fs.realpathSync(workspaceRoot) === fs.realpathSync(HEPTA_WORKSPACE_ROOT);
  const commit = (canonicalWorkspace ? process.env.HEPTA_RELEASE_COMMIT : null)
    || git(['rev-parse', 'HEAD'], workspaceRoot)
    || null;
  const commitTree = git(['rev-parse', `${commit || 'HEAD'}^{tree}`], workspaceRoot) || null;
  const tags = git(['tag', '--points-at', 'HEAD'], workspaceRoot).split(/\r?\n/).filter(Boolean);
  const worktreeStatus = git(['status', '--porcelain=v1', '-z'], workspaceRoot, { trim: false });
  const dirty = Boolean(worktreeStatus);
  const repositoryState = exactRepositoryState(workspaceRoot, commit);
  const worktreeStateHash = `sha256:${crypto.createHash('sha256')
    .update(String(commit || ''))
    .update('\0')
    .update(String(commitTree || ''))
    .update('\0')
    .update(worktreeStatus)
    .update('\0')
    .update(repositoryState.indexStateHash)
    .update('\0')
    .update(repositoryState.repositoryContentHash)
    .digest('hex')}`;
  return Object.freeze({
    version: 2,
    kind: 'CodeProvenance',
    packageVersion: pkg.version,
    commit,
    commitTree,
    tags,
    treeDirty: dirty,
    indexStateHash: repositoryState.indexStateHash,
    repositoryEntryCount: repositoryState.repositoryEntryCount,
    repositoryContentHash: repositoryState.repositoryContentHash,
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
