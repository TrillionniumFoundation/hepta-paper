import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { captureReleaseDependencyTree } from './release-dependency-tree.mjs';

const GIT_OBJECT = /^[0-9a-f]{40}$/u;
const MAXIMUM_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export const IMMUTABLE_RELEASE_SUBMODULES = Object.freeze([
  Object.freeze({ key: 'core', path: 'core' }),
  Object.freeze({
    key: 'rScientificSourceCas',
    path: 'runtime-images/r-scientific/source-cas',
  }),
]);

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function exactDirectory(candidate, boundary, code) {
  const selected = path.resolve(candidate);
  let stat;
  try {
    stat = fs.lstatSync(selected, { bigint: true });
  } catch (error) {
    throw codedError(code, { cause: error });
  }
  if (!inside(boundary, selected) || stat.isSymbolicLink() || !stat.isDirectory()
    || fs.realpathSync(selected) !== selected) throw codedError(code);
  return selected;
}

function git(repository, operation, args, { skipLfsSmudge = false } = {}) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null',
    '-c', `safe.directory=${repository}`,
    '-C', repository,
    ...args,
  ], {
    encoding: 'utf8',
    maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
    shell: false,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      XDG_CONFIG_HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      ...(skipLfsSmudge ? { GIT_LFS_SKIP_SMUDGE: '1' } : {}),
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw codedError(`immutable_release_submodule_git_failed:${operation}`, {
      gitExitStatus: result.status,
    });
  }
  return String(result.stdout || '').trim();
}

function gitObject(repository, expression, operation) {
  const result = git(repository, operation, ['rev-parse', '--verify', expression]);
  if (!GIT_OBJECT.test(result)) throw codedError('immutable_release_submodule_object_invalid');
  return result;
}

function expectedGitlink(superproject, relative) {
  const raw = git(superproject, 'gitlink', ['ls-tree', '-z', 'HEAD', '--', relative]);
  const match = raw.match(/^160000 commit ([0-9a-f]{40})\t([^\0]+)\0?$/u);
  if (!match || match[2] !== relative) {
    throw codedError(`immutable_release_submodule_gitlink_invalid:${relative}`);
  }
  return match[1];
}

function gitDirectory(repository, boundary, code) {
  const selected = git(repository, 'git_directory', ['rev-parse', '--absolute-git-dir']);
  let canonical;
  try {
    canonical = fs.realpathSync(selected);
  } catch (error) {
    throw codedError(code, { cause: error });
  }
  if (!path.isAbsolute(selected) || canonical !== path.resolve(selected)
    || !inside(boundary, canonical)) throw codedError(code);
  return exactDirectory(canonical, boundary, code);
}

function assertAdministrativeEntry(repository, code) {
  const administrative = fs.lstatSync(path.join(repository, '.git'), { bigint: true });
  if (administrative.isSymbolicLink()
    || (!administrative.isFile() && !administrative.isDirectory())) throw codedError(code);
}

function visitRegularFiles(root, visitor, relative = '.') {
  const selected = relative === '.' ? root : path.join(root, ...relative.split('/'));
  const stat = fs.lstatSync(selected, { bigint: true });
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    visitor(stat, relative);
    return;
  }
  if (!stat.isDirectory()) throw codedError('immutable_release_submodule_special_file_forbidden');
  for (const name of fs.readdirSync(selected).sort((left, right) => left.localeCompare(right))) {
    visitRegularFiles(root, visitor, relative === '.' ? name : `${relative}/${name}`);
  }
}

function assertNoSharedRegularFiles(source, target, code) {
  const sourceIdentities = new Set();
  visitRegularFiles(source, (stat) => sourceIdentities.add(`${stat.dev}:${stat.ino}`));
  visitRegularFiles(target, (stat) => {
    if (sourceIdentities.has(`${stat.dev}:${stat.ino}`)) throw codedError(code);
  });
}

function assertSafeCopySource(root) {
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(candidate);
      if (path.isAbsolute(target)
        || !inside(root, path.resolve(path.dirname(candidate), target))) {
        throw codedError('immutable_release_submodule_symlink_escape_forbidden');
      }
      return;
    }
    if (stat.isFile()) return;
    if (!stat.isDirectory()) {
      throw codedError('immutable_release_submodule_special_file_forbidden');
    }
    for (const name of fs.readdirSync(candidate)) visit(path.join(candidate, name));
  };
  for (const name of fs.readdirSync(root)) {
    if (name !== '.git') visit(path.join(root, name));
  }
}

function replaceWorktreeFromSource(source, target) {
  assertSafeCopySource(source);
  const sourceEntries = fs.readdirSync(source).filter((name) => name !== '.git').sort();
  const targetEntries = fs.readdirSync(target).filter((name) => name !== '.git').sort();
  for (const name of targetEntries) {
    fs.rmSync(path.join(target, name), { recursive: true, force: false });
  }
  for (const name of sourceEntries) {
    fs.cpSync(path.join(source, name), path.join(target, name), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
}

function assertExactCheckout(repository, commit, tree, code) {
  if (gitObject(repository, 'HEAD^{commit}', 'head') !== commit
    || gitObject(repository, 'HEAD^{tree}', 'tree') !== tree) throw codedError(code);
  if (git(repository, 'status', [
    'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
  ]) !== '') throw codedError(`${code}:worktree_dirty`);
}

function cloneSubmodule(source, target, commit) {
  const placeholder = fs.lstatSync(target, { bigint: true });
  if (!placeholder.isDirectory() || placeholder.isSymbolicLink()
    || fs.readdirSync(target).length !== 0) {
    throw codedError('immutable_release_submodule_target_not_empty');
  }
  fs.rmdirSync(target);
  const result = spawnSync('/usr/bin/git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null',
    'clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', source, target,
  ], {
    encoding: 'utf8',
    maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
    shell: false,
    env: {
      PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
      LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw codedError('immutable_release_submodule_git_failed:clone', {
      gitExitStatus: result.status,
    });
  }
  git(target, 'checkout', [
    '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', '--force', commit, '--',
  ], { skipLfsSmudge: true });
}

function materializeOne({ candidateRoot, cloneRoot, key, path: relative }) {
  const source = exactDirectory(path.join(candidateRoot, relative), candidateRoot,
    `immutable_release_submodule_source_invalid:${key}`);
  const target = path.resolve(cloneRoot, relative);
  if (!inside(cloneRoot, target)) throw codedError(`immutable_release_submodule_target_invalid:${key}`);
  const commit = expectedGitlink(cloneRoot, relative);
  if (expectedGitlink(candidateRoot, relative) !== commit) {
    throw codedError(`immutable_release_submodule_candidate_gitlink_changed:${key}`);
  }
  assertAdministrativeEntry(source, `immutable_release_submodule_git_path_invalid:${key}`);
  const sourceGit = gitDirectory(source, candidateRoot,
    `immutable_release_submodule_git_path_invalid:${key}`);
  const tree = gitObject(source, 'HEAD^{tree}', 'source_tree');
  assertExactCheckout(source, commit, tree,
    `immutable_release_submodule_source_identity_mismatch:${key}`);
  const sourceTree = captureReleaseDependencyTree(source);
  const readOnlyTree = captureReleaseDependencyTree(source, { readOnlyProjection: true });

  cloneSubmodule(source, target, commit);
  replaceWorktreeFromSource(source, target);
  assertAdministrativeEntry(target, `immutable_release_submodule_target_git_invalid:${key}`);
  const targetGit = gitDirectory(target, cloneRoot,
    `immutable_release_submodule_target_git_invalid:${key}`);
  assertExactCheckout(target, commit, tree,
    `immutable_release_submodule_target_identity_mismatch:${key}`);
  assertNoSharedRegularFiles(sourceGit, targetGit,
    `immutable_release_submodule_git_object_hardlink_forbidden:${key}`);
  assertNoSharedRegularFiles(source, target,
    `immutable_release_submodule_worktree_hardlink_forbidden:${key}`);
  if (JSON.stringify(captureReleaseDependencyTree(source)) !== JSON.stringify(sourceTree)
    || expectedGitlink(candidateRoot, relative) !== commit) {
    throw codedError(`immutable_release_submodule_source_changed:${key}`);
  }
  return Object.freeze({ key, path: relative, commit, tree, sourceTree, readOnlyTree });
}

export function materializeImmutableReleaseSubmodules({
  candidateWorkspaceRoot,
  cloneWorkspaceRoot,
  expectedCommit,
} = {}) {
  const candidateRoot = exactDirectory(
    fs.realpathSync(candidateWorkspaceRoot),
    fs.realpathSync(candidateWorkspaceRoot),
    'immutable_release_submodule_candidate_root_invalid',
  );
  const cloneRoot = exactDirectory(
    fs.realpathSync(cloneWorkspaceRoot),
    fs.realpathSync(cloneWorkspaceRoot),
    'immutable_release_submodule_clone_root_invalid',
  );
  if (!GIT_OBJECT.test(String(expectedCommit || ''))
    || gitObject(candidateRoot, 'HEAD^{commit}', 'candidate_head') !== expectedCommit
    || gitObject(cloneRoot, 'HEAD^{commit}', 'clone_head') !== expectedCommit) {
    throw codedError('immutable_release_submodule_superproject_identity_invalid');
  }
  const materialized = Object.fromEntries(IMMUTABLE_RELEASE_SUBMODULES.map((specification) => {
    const record = materializeOne({ candidateRoot, cloneRoot, ...specification });
    return [specification.key, record];
  }));
  return Object.freeze({
    version: 1,
    kind: 'ImmutableReleaseSubmoduleMaterialization',
    status: 'immutable_release_submodules_materialized',
    submodules: Object.freeze(materialized),
  });
}
