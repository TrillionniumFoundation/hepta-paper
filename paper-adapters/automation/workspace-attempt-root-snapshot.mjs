import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { inspectScopedRegularFileSync } from '../runtime/scoped-file-materialization-repository.mjs';
import { workspaceAttemptIntegrationError as integrationError } from './workspace-attempt-errors.mjs';

const MANDATORY_EXCLUDED_NAMES = new Set(['.hepta-materialization-recovery']);

export const DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES = new Set([
  ...MANDATORY_EXCLUDED_NAMES,
  '.git', 'node_modules', 'runtime', '.artifact-cas', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
]);

export function workspaceAttemptRelativePath(root, candidate) {
  return path.relative(root, candidate).replace(/\\/g, '/');
}

export function isWorkspaceAttemptEntryExcluded(entry, relative, excludedNames) {
  return MANDATORY_EXCLUDED_NAMES.has(entry.name)
    || excludedNames.has(entry.name)
    || /^\.venv(?:-|$)/.test(entry.name)
    || entry.name === 'venv'
    || relative.split('/').some((part) => excludedNames.has(part));
}

export function effectiveWorkspaceAttemptExcludedNames(excludedNames) {
  const configured = excludedNames instanceof Set ? excludedNames : new Set(excludedNames || []);
  return new Set([...MANDATORY_EXCLUDED_NAMES, ...configured]);
}

export function workspaceAttemptPathEntryExistsSync(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function workspaceAttemptRootIdentitySync(root, label = 'workspace') {
  const lexicalPath = path.resolve(root || '.');
  let lexicalStat;
  try {
    lexicalStat = fs.lstatSync(lexicalPath, { bigint: true });
  } catch {
    throw integrationError(`workspace_attempt_${label}_root_unreadable`);
  }
  if (lexicalStat.isSymbolicLink() || !lexicalStat.isDirectory()) {
    throw integrationError(`workspace_attempt_${label}_root_unsafe`);
  }
  const realPath = fs.realpathSync.native(lexicalPath);
  const stat = fs.statSync(realPath, { bigint: true });
  if (!stat.isDirectory()) throw integrationError(`workspace_attempt_${label}_root_unsafe`);
  const payload = {
    version: 1,
    kind: 'WorkspaceAttemptRootIdentity',
    realPath,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
  };
  return Object.freeze({
    ...payload,
    workspaceAttemptRootIdentityHash: hashRecord('WorkspaceAttemptRootIdentity', payload),
  });
}

export function verifyWorkspaceAttemptRootIdentityClaim(claim, label) {
  const { workspaceAttemptRootIdentityHash: claimed, ...payload } = claim || {};
  if (!claimed || hashRecord('WorkspaceAttemptRootIdentity', payload) !== claimed) {
    throw integrationError(`workspace_attempt_${label}_root_identity_hash_invalid`);
  }
  if (payload.kind !== 'WorkspaceAttemptRootIdentity'
    || payload.version !== 1
    || !path.isAbsolute(payload.realPath || '')) {
    throw integrationError(`workspace_attempt_${label}_root_identity_invalid`);
  }
  return claim;
}

export function assertCurrentWorkspaceAttemptRootIdentity(root, expected, label) {
  verifyWorkspaceAttemptRootIdentityClaim(expected, label);
  const current = workspaceAttemptRootIdentitySync(root, label);
  if (current.workspaceAttemptRootIdentityHash !== expected.workspaceAttemptRootIdentityHash) {
    throw integrationError(`workspace_attempt_${label}_root_identity_changed`);
  }
  return current;
}

export function assertDisjointWorkspaceAttemptRoots(leftIdentity, rightIdentity) {
  const left = leftIdentity.realPath;
  const right = rightIdentity.realPath;
  if (isPathWithin(left, right) || isPathWithin(right, left)) {
    throw integrationError('workspace_attempt_roots_overlap');
  }
}

export function snapshotWorkspaceFilesSync({
  root,
  excludedNames = DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
} = {}) {
  const workspaceIdentity = workspaceAttemptRootIdentitySync(root, 'snapshot');
  const workspace = workspaceIdentity.realPath;
  const excluded = effectiveWorkspaceAttemptExcludedNames(excludedNames);
  const rows = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(directory, entry.name);
      const relative = workspaceAttemptRelativePath(workspace, candidate);
      if (isWorkspaceAttemptEntryExcluded(entry, relative, excluded)) continue;
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory()) walk(candidate);
      else if (stat.isFile()) {
        try {
          rows.set(relative, inspectScopedRegularFileSync({ scopeRoot: workspace, relative }).hash);
        } catch (error) {
          rows.set(relative, `unsafe:${error?.code || 'file_identity_failed'}`);
        }
      } else if (stat.isSymbolicLink()) rows.set(relative, `unsafe:symlink:${fs.readlinkSync(candidate)}`);
      else rows.set(relative, `unsafe:special:${stat.mode}`);
    }
  };
  walk(workspace);
  assertCurrentWorkspaceAttemptRootIdentity(workspace, workspaceIdentity, 'snapshot');
  return rows;
}
