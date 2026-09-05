import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { currentCodeProvenance } from './code-provenance.mjs';
import {
  materializeImmutableReleaseSubmodules,
} from './immutable-release-submodule-materializer.mjs';
import {
  assertReleaseDependencyTreeContract,
  captureReleaseDependencyTree,
} from './release-dependency-tree.mjs';
import { CODEX_DIRECTORY } from './release-environment-deployment-closure.mjs';

const MAXIMUM_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const NO_CLOBBER_MOVE = '/usr/bin/mv';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function nodeIdentity(stat) {
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

function sameIdentity(stat, expected) {
  return String(stat.dev) === expected?.device && String(stat.ino) === expected?.inode;
}

function exactDirectory(candidate, {
  boundary = path.dirname(candidate),
  expectedUid = null,
  expectedGid = null,
  expectedMode = null,
  code = 'immutable_release_candidate_directory_invalid',
} = {}) {
  const selected = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(selected, { bigint: true }); }
  catch (error) { throw codedError(code, { cause: error }); }
  if (!inside(boundary, selected) || fs.realpathSync(selected) !== selected
    || stat.isSymbolicLink() || !stat.isDirectory()
    || (expectedUid !== null && Number(stat.uid) !== expectedUid)
    || (expectedGid !== null && Number(stat.gid) !== expectedGid)
    || (expectedMode !== null && (Number(stat.mode) & 0o7777) !== expectedMode)) {
    throw codedError(code);
  }
  return Object.freeze({ path: selected, identity: nodeIdentity(stat) });
}

function pathExistsNoFollow(candidate) {
  try { fs.lstatSync(candidate); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function git(repository, operation, args) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null', '-c', `safe.directory=${repository}`,
    '-C', repository, ...args,
  ], {
    encoding: 'utf8', maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES, shell: false,
    env: {
      PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
      LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw codedError(`immutable_release_candidate_git_failed:${operation}`, {
      gitExitStatus: result.status,
    });
  }
  return String(result.stdout || '').trim();
}

function cloneExactCommit(source, target, commit) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null',
    'clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', source, target,
  ], {
    encoding: 'utf8', maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES, shell: false,
    env: {
      PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
      LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw codedError('immutable_release_candidate_git_failed:clone');
  }
  git(target, 'checkout', [
    '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', '--force', commit, '--',
  ]);
  if (git(target, 'head', ['rev-parse', '--verify', 'HEAD^{commit}']) !== commit) {
    throw codedError('immutable_release_candidate_commit_mismatch');
  }
}

function visitRegularFiles(root, visitor) {
  const pending = [root];
  while (pending.length > 0) {
    const candidate = pending.pop();
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) visitor(stat);
    else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(candidate)) pending.push(path.join(candidate, name));
    } else throw codedError('immutable_release_candidate_special_file_forbidden');
  }
}

function assertNoSharedFiles(source, target, code) {
  const identities = new Set();
  visitRegularFiles(source, (stat) => identities.add(`${stat.dev}:${stat.ino}`));
  visitRegularFiles(target, (stat) => {
    if (identities.has(`${stat.dev}:${stat.ino}`)) throw codedError(code);
  });
}

function assertSafeSymlinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const candidate = pending.pop();
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(candidate); } catch (error) {
        throw codedError('immutable_release_candidate_symlink_target_invalid', { cause: error });
      }
      if (!inside(root, target)) {
        throw codedError('immutable_release_candidate_external_symlink_forbidden');
      }
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(candidate)) pending.push(path.join(candidate, name));
    } else if (!stat.isFile()) throw codedError('immutable_release_candidate_special_file_forbidden');
  }
}

function copyTreeNoHardlinks(source, target, code) {
  const sourceRoot = exactDirectory(source, { boundary: source, code: `${code}:source_invalid` });
  if (pathExistsNoFollow(target)) throw codedError(`${code}:target_exists`);
  assertSafeSymlinks(sourceRoot.path);
  const before = captureReleaseDependencyTree(sourceRoot.path);
  fs.cpSync(sourceRoot.path, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  if (!sameIdentity(fs.lstatSync(sourceRoot.path, { bigint: true }), sourceRoot.identity)
    || JSON.stringify(captureReleaseDependencyTree(sourceRoot.path)) !== JSON.stringify(before)
    || JSON.stringify(captureReleaseDependencyTree(target)) !== JSON.stringify(before)) {
    throw codedError(`${code}:copy_mismatch`);
  }
  assertNoSharedFiles(sourceRoot.path, target, `${code}:hardlink_forbidden`);
  return before;
}

function productionProvenance(root) {
  return Object.freeze({
    ...currentCodeProvenance({
      workspaceRoot: root,
      allowReleaseCommitEnvironment: false,
      ignoreSubmoduleWorktreeStatus: true,
    }),
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
  });
}

function restoreOwnerWrite(root) {
  if (!pathExistsNoFollow(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(root, stat.mode | 0o700);
    for (const name of fs.readdirSync(root)) restoreOwnerWrite(path.join(root, name));
  } else fs.chmodSync(root, stat.mode | 0o600);
}

function cleanupContainer(container, identity, storeRoot) {
  if (!pathExistsNoFollow(container)) return;
  const current = fs.lstatSync(container, { bigint: true });
  if (!inside(storeRoot, container) || !current.isDirectory() || current.isSymbolicLink()
    || !sameIdentity(current, identity)) {
    throw codedError('immutable_release_candidate_cleanup_identity_changed');
  }
  restoreOwnerWrite(container);
  fs.rmSync(container, { recursive: true, force: false });
}

export function materializeImmutableReleaseCandidate({
  plan,
  candidateWorkspaceRoot,
  inspectReleaseState,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  if (typeof inspectReleaseState !== 'function') {
    throw codedError('immutable_release_candidate_release_state_inspector_required');
  }
  const source = exactDirectory(fs.realpathSync(candidateWorkspaceRoot), {
    boundary: fs.realpathSync(candidateWorkspaceRoot),
    code: 'immutable_release_candidate_source_invalid',
  });
  const store = exactDirectory(path.dirname(plan.target.releasePath), {
    boundary: path.dirname(plan.target.releasePath),
    expectedUid,
    expectedGid,
    expectedMode: 0o755,
    code: 'immutable_release_candidate_store_invalid',
  });
  const predecessor = exactDirectory(plan.predecessor.releasePath, {
    boundary: store.path,
    expectedUid,
    expectedGid,
    expectedMode: 0o555,
    code: 'immutable_release_candidate_predecessor_invalid',
  });
  if (pathExistsNoFollow(plan.target.releasePath)) {
    throw codedError('immutable_release_candidate_target_exists');
  }
  const sourceProvenance = productionProvenance(source.path);
  if (hashRecord('ImmutableReleaseDeploymentCodeProvenance', sourceProvenance)
      !== plan.codeProvenanceHash || sourceProvenance.treeDirty) {
    throw codedError('immutable_release_candidate_source_provenance_mismatch');
  }
  inspectReleaseState({
    workspaceRoot: source.path,
    expectedSnapshotHash: plan.releaseStateSnapshotHash,
  });
  const sourceDependency = assertReleaseDependencyTreeContract({ workspaceRoot: source.path });
  const releaseRoot = path.join(store.path, `.hepta-release-${plan.commit}.staging`);
  if (pathExistsNoFollow(releaseRoot)) {
    throw codedError('immutable_release_candidate_staging_exists');
  }
  fs.mkdirSync(releaseRoot, { mode: 0o700 });
  fs.chmodSync(releaseRoot, 0o700);
  fs.chownSync(releaseRoot, expectedUid, expectedGid);
  const releaseIdentity = nodeIdentity(fs.lstatSync(releaseRoot, { bigint: true }));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return false;
    cleanupContainer(releaseRoot, releaseIdentity, store.path);
    cleaned = true;
    return true;
  };
  try {
    cloneExactCommit(source.path, releaseRoot, plan.commit);
    fs.chmodSync(releaseRoot, 0o700);
    fs.chownSync(releaseRoot, expectedUid, expectedGid);
    if (!sameIdentity(fs.lstatSync(releaseRoot, { bigint: true }), releaseIdentity)) {
      throw codedError('immutable_release_candidate_staging_identity_changed');
    }
    const submodules = materializeImmutableReleaseSubmodules({
      candidateWorkspaceRoot: source.path,
      cloneWorkspaceRoot: releaseRoot,
      expectedCommit: plan.commit,
    });
    const dependencyTarget = path.join(releaseRoot, 'node_modules');
    copyTreeNoHardlinks(
      path.join(source.path, 'node_modules'),
      dependencyTarget,
      'immutable_release_candidate_dependency_copy',
    );
    const dependencyCopy = assertReleaseDependencyTreeContract({
      workspaceRoot: releaseRoot,
      nodeModulesPath: dependencyTarget,
    });
    if (sourceDependency.contractHash !== dependencyCopy.contractHash
      || sourceDependency.lockfileHash !== dependencyCopy.lockfileHash
      || sourceDependency.tree.treeHash !== dependencyCopy.tree.treeHash) {
      throw codedError('immutable_release_candidate_dependency_contract_mismatch');
    }
    const clonedProvenance = productionProvenance(releaseRoot);
    if (hashRecord('ImmutableReleaseDeploymentCodeProvenance', clonedProvenance)
      !== plan.codeProvenanceHash || clonedProvenance.treeDirty) {
      throw codedError('immutable_release_candidate_clone_provenance_mismatch');
    }
    inspectReleaseState({
      workspaceRoot: releaseRoot,
      expectedSnapshotHash: plan.releaseStateSnapshotHash,
    });
    copyTreeNoHardlinks(
      path.join(predecessor.path, 'elan'),
      path.join(releaseRoot, 'elan'),
      'immutable_release_candidate_elan_copy',
    );
    copyTreeNoHardlinks(
      path.join(predecessor.path, CODEX_DIRECTORY),
      path.join(releaseRoot, CODEX_DIRECTORY),
      'immutable_release_candidate_codex_copy',
    );
    if (!sameIdentity(fs.lstatSync(releaseRoot, { bigint: true }), releaseIdentity)) {
      throw codedError('immutable_release_candidate_staging_identity_changed');
    }
    return Object.freeze({
      status: 'immutable_release_candidate_materialized',
      stagingContainer: releaseRoot,
      stagingContainerIdentity: releaseIdentity,
      releaseRoot,
      releaseRootIdentity: releaseIdentity,
      dependencyInspection: dependencyCopy,
      submoduleMaterialization: submodules,
      cleanup,
    });
  } catch (error) {
    try { cleanup(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function assertTrustedMove() {
  const stat = fs.lstatSync(NO_CLOBBER_MOVE, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n
    || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n
    || fs.realpathSync(NO_CLOBBER_MOVE) !== NO_CLOBBER_MOVE) {
    throw codedError('immutable_release_candidate_move_invalid');
  }
}

export function publishSealedImmutableReleaseCandidate({ plan, prepared } = {}) {
  assertTrustedMove();
  const storeRoot = path.dirname(plan.target.releasePath);
  const source = fs.lstatSync(prepared.releaseRoot, { bigint: true });
  if (!source.isDirectory() || source.isSymbolicLink()
    || !sameIdentity(source, prepared.releaseRootIdentity)
    || (Number(source.mode) & 0o7777) !== 0o555
    || pathExistsNoFollow(plan.target.releasePath)) {
    throw codedError('immutable_release_candidate_publish_precondition_invalid');
  }
  const moved = spawnSync(NO_CLOBBER_MOVE, [
    '--no-clobber', '--no-target-directory', '--', prepared.releaseRoot, plan.target.releasePath,
  ], {
    encoding: 'utf8', shell: false,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeout: 60_000, maxBuffer: 16 * 1024,
  });
  if (moved.error || moved.signal || moved.status !== 0 || moved.stdout || moved.stderr
    || pathExistsNoFollow(prepared.releaseRoot) || !pathExistsNoFollow(plan.target.releasePath)) {
    throw codedError('immutable_release_candidate_publish_failed', {
      moveStatus: moved.status,
      moveSignal: moved.signal || null,
      moveError: moved.error?.code || null,
      moveStdout: String(moved.stdout || ''),
      moveStderr: String(moved.stderr || ''),
      sourceRemains: pathExistsNoFollow(prepared.releaseRoot),
      targetExists: pathExistsNoFollow(plan.target.releasePath),
      sourceParent: identityWithMode(fs.lstatSync(path.dirname(prepared.releaseRoot), { bigint: true })),
      targetParent: identityWithMode(fs.lstatSync(path.dirname(plan.target.releasePath), { bigint: true })),
    });
  }
  const published = fs.lstatSync(plan.target.releasePath, { bigint: true });
  if (!sameIdentity(published, prepared.releaseRootIdentity)) {
    throw codedError('immutable_release_candidate_publish_failed');
  }
  fsyncDirectory(storeRoot);
  return Object.freeze({
    status: 'immutable_release_candidate_published',
    releasePath: plan.target.releasePath,
    publicationIdentityHash: hashRecord('ImmutableReleasePublicationIdentity', {
      commit: plan.commit,
      releasePath: plan.target.releasePath,
      identity: prepared.releaseRootIdentity,
    }),
  });
}

export function cleanupImmutableReleaseCandidateForPlan({
  plan,
  expectedUid = 0,
  expectedGid = 0,
  removePublishedTarget = false,
  expectedPublicationIdentityHash = null,
} = {}) {
  const storeRoot = path.dirname(plan.target.releasePath);
  exactDirectory(storeRoot, {
    boundary: storeRoot,
    expectedUid,
    expectedGid,
    expectedMode: 0o755,
    code: 'immutable_release_candidate_cleanup_store_invalid',
  });
  const staging = path.join(storeRoot, `.hepta-release-${plan.commit}.staging`);
  let stagingCleaned = false;
  if (pathExistsNoFollow(staging)) {
    const stat = fs.lstatSync(staging, { bigint: true });
    if (fs.realpathSync(staging) !== staging || stat.isSymbolicLink() || !stat.isDirectory()
      || Number(stat.uid) !== expectedUid || Number(stat.gid) !== expectedGid
      || ![0o700, 0o555].includes(Number(stat.mode) & 0o7777)) {
      throw codedError('immutable_release_candidate_plan_cleanup_unsafe');
    }
    cleanupContainer(staging, nodeIdentity(stat), storeRoot);
    stagingCleaned = true;
  }
  let publishedCleaned = false;
  if (removePublishedTarget && pathExistsNoFollow(plan.target.releasePath)) {
    const target = fs.lstatSync(plan.target.releasePath, { bigint: true });
    const targetIdentity = nodeIdentity(target);
    const publicationIdentityHash = hashRecord('ImmutableReleasePublicationIdentity', {
      commit: plan.commit,
      releasePath: plan.target.releasePath,
      identity: targetIdentity,
    });
    if (plan.target.releasePath === plan.predecessor.releasePath
      || path.dirname(plan.target.releasePath) !== storeRoot
      || path.basename(plan.target.releasePath) !== plan.commit
      || fs.realpathSync(plan.target.releasePath) !== plan.target.releasePath
      || target.isSymbolicLink() || !target.isDirectory()
      || Number(target.uid) !== expectedUid || Number(target.gid) !== expectedGid
      || (Number(target.mode) & 0o7777) !== 0o555
      || (expectedPublicationIdentityHash !== null
        && publicationIdentityHash !== expectedPublicationIdentityHash)) {
      throw codedError('immutable_release_candidate_published_cleanup_unsafe');
    }
    cleanupContainer(plan.target.releasePath, targetIdentity, storeRoot);
    publishedCleaned = true;
  }
  fsyncDirectory(storeRoot);
  return Object.freeze({
    cleaned: stagingCleaned || publishedCleaned,
    staging,
    stagingCleaned,
    publishedTarget: plan.target.releasePath,
    publishedCleaned,
  });
}

function identityWithMode(stat) {
  return {
    device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode) & 0o7777,
    uid: Number(stat.uid), gid: Number(stat.gid),
  };
}
