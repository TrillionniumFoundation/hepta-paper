import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { currentCodeProvenance } from './code-provenance.mjs';
import {
  materializeImmutableReleaseSubmodules,
} from './immutable-release-submodule-materializer.mjs';
import { assertReleaseDependencyTreeContract } from './release-dependency-tree.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function identity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function directoryIdentity(directory, code) {
  let stat;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    throw codedError(code, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError(code);
  return identity(stat);
}

function assertDirectoryIdentity(directory, expected, code) {
  if (!sameIdentity(expected, directoryIdentity(directory, code))) throw codedError(code);
}

function pathEntryExistsNoFollow(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function runGit(workspaceRoot, operation, args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) {
    throw codedError(`immutable_release_workspace_git_failed:${operation}`, {
      gitExitStatus: result.status,
    });
  }
  return String(result.stdout || '').trim();
}

function assertPathInside(root, candidate, code) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) throw codedError(code);
  return relative;
}

function visitPinnedTree(root, {
  onDirectory = () => {},
  onFile = () => {},
  onSymlink = () => {},
  faultInjector = null,
} = {}) {
  const selectedRoot = path.resolve(root);
  const visit = (candidate, relative, initial) => {
    faultInjector?.({ stage: 'after_entry_lstat', candidate, relative, stat: initial });
    if (initial.isSymbolicLink()) {
      onSymlink({ candidate, relative, stat: initial });
      const completed = fs.lstatSync(candidate, { bigint: true });
      if (!completed.isSymbolicLink() || !sameIdentity(identity(initial), identity(completed))) {
        throw codedError('immutable_release_workspace_symlink_identity_changed');
      }
      return;
    }
    if (!initial.isFile() && !initial.isDirectory()) {
      throw codedError('immutable_release_workspace_special_file_forbidden');
    }
    let descriptor;
    try {
      descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY
          | (initial.isDirectory() ? fs.constants.O_DIRECTORY : 0)
          | NO_FOLLOW,
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(identity(initial), identity(opened))
        || opened.isDirectory() !== initial.isDirectory()
        || opened.isFile() !== initial.isFile()) {
        throw codedError('immutable_release_workspace_entry_identity_changed');
      }
      if (opened.isDirectory()) {
        const pinnedDirectory = `/proc/self/fd/${descriptor}`;
        const entries = fs.readdirSync(pinnedDirectory, { encoding: 'buffer' })
          .sort((left, right) => Buffer.compare(left, right));
        for (const rawName of entries) {
          const name = rawName.toString('utf8');
          if (!Buffer.from(name, 'utf8').equals(rawName)
            || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
            throw codedError('immutable_release_workspace_entry_name_invalid');
          }
          const child = path.join(pinnedDirectory, name);
          visit(child, relative === '.' ? name : `${relative}/${name}`, fs.lstatSync(child, {
            bigint: true,
          }));
        }
        onDirectory({ descriptor, relative, stat: opened });
      } else onFile({ descriptor, relative, stat: opened });
      const completed = fs.fstatSync(descriptor, { bigint: true });
      const pathCompleted = fs.lstatSync(candidate, { bigint: true });
      if (!sameIdentity(identity(opened), identity(completed))
        || !sameIdentity(identity(completed), identity(pathCompleted))) {
        throw codedError('immutable_release_workspace_entry_changed_during_visit');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  const rootStat = fs.lstatSync(selectedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw codedError('immutable_release_workspace_tree_root_invalid');
  }
  visit(selectedRoot, '.', rootStat);
  const completedRoot = fs.lstatSync(selectedRoot, { bigint: true });
  if (!sameIdentity(identity(rootStat), identity(completedRoot))) {
    throw codedError('immutable_release_workspace_tree_root_identity_changed');
  }
}

function assertSafeDependencyCopy(root) {
  visitPinnedTree(root, {
    onSymlink({ candidate, relative }) {
      const target = fs.readlinkSync(candidate);
      if (path.isAbsolute(target)) {
        throw codedError('immutable_release_workspace_dependency_absolute_symlink_forbidden');
      }
      const logicalPath = path.join(root, relative);
      const resolved = path.resolve(path.dirname(logicalPath), target);
      assertPathInside(
        root,
        resolved,
        'immutable_release_workspace_dependency_symlink_escape_forbidden',
      );
    },
  });
}

function setTreeReadOnly(root, faultInjector = null) {
  const removeWrite = ({ descriptor, stat }) => {
    fs.fchmodSync(descriptor, Number(stat.mode) & 0o555);
  };
  visitPinnedTree(root, {
    onDirectory: removeWrite,
    onFile: removeWrite,
    faultInjector,
  });
}

function assertTreeReadOnly(root) {
  const inspect = ({ stat }) => {
    if ((Number(stat.mode) & 0o222) !== 0) {
      throw codedError('immutable_release_workspace_write_permission_remains');
    }
  };
  visitPinnedTree(root, { onDirectory: inspect, onFile: inspect });
}

function restoreOwnerWrite(root, faultInjector = null) {
  const restore = ({ descriptor, stat }) => {
    const execute = stat.isDirectory() ? 0o100 : 0;
    fs.fchmodSync(descriptor, Number(stat.mode) | 0o600 | execute);
  };
  visitPinnedTree(root, { onDirectory: restore, onFile: restore, faultInjector });
}

function assertNoSharedObjectFiles(candidateRoot, cloneRoot) {
  const candidateObjects = path.join(candidateRoot, '.git', 'objects');
  const cloneObjects = path.join(cloneRoot, '.git', 'objects');
  const sourceIdentities = new Set();
  visitPinnedTree(candidateObjects, { onFile({ stat }) {
    sourceIdentities.add(`${stat.dev}:${stat.ino}`);
  } });
  visitPinnedTree(cloneObjects, { onFile({ stat }) {
    if (sourceIdentities.has(`${stat.dev}:${stat.ino}`)) {
      throw codedError('immutable_release_workspace_git_object_hardlink_forbidden');
    }
  } });
  const alternates = path.join(cloneObjects, 'info', 'alternates');
  try {
    fs.lstatSync(alternates);
    throw codedError('immutable_release_workspace_git_alternates_forbidden');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function assertNoSharedRegularFiles(sourceRoot, copyRoot, code) {
  const sourceIdentities = new Set();
  visitPinnedTree(sourceRoot, { onFile({ stat }) {
    sourceIdentities.add(`${stat.dev}:${stat.ino}`);
  } });
  visitPinnedTree(copyRoot, { onFile({ stat }) {
    if (sourceIdentities.has(`${stat.dev}:${stat.ino}`)) {
      throw codedError(code);
    }
  } });
}

function assertDependencyInspectionMatches(expected, actual, code) {
  const projection = (inspection) => ({
    status: inspection?.status,
    contractHash: inspection?.contractHash,
    lockfileHash: inspection?.lockfileHash,
    tree: inspection?.tree,
    readOnly: inspection?.readOnly,
  });
  if (JSON.stringify(projection(expected)) !== JSON.stringify(projection(actual))) {
    throw codedError(code);
  }
}

export function createNonReentrantCleanup(cleanup) {
  if (typeof cleanup !== 'function') throw codedError('identity_bound_cleanup_function_required');
  let state = 'pending';
  return Object.freeze((...args) => {
    if (state !== 'pending') return;
    state = 'running';
    try {
      cleanup(...args);
    } finally {
      state = 'completed';
    }
  });
}

function verificationProvenance(workspaceRoot) {
  return Object.freeze({
    ...currentCodeProvenance({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
    }),
    evidenceEnvironment: 'verification',
    evidenceClass: 'technical_conformance',
  });
}

function appendNodeModulesExclusion(cloneRoot) {
  const exclude = path.join(cloneRoot, '.git', 'info', 'exclude');
  const descriptor = fs.openSync(exclude, fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW);
  try {
    fs.writeFileSync(descriptor, '\n/node_modules\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function cleanupPreparedRoot({
  tempRoot,
  tempIdentity,
  tempParent,
  tempParentIdentity,
  requiredDirectoryIdentities,
  faultInjector,
}) {
  assertDirectoryIdentity(
    tempParent,
    tempParentIdentity,
    'immutable_release_workspace_temp_parent_identity_changed',
  );
  const currentTempIdentity = directoryIdentity(
    tempRoot,
    'immutable_release_workspace_temp_root_invalid',
  );
  if (!sameIdentity(tempIdentity, currentTempIdentity)) {
    throw codedError('immutable_release_workspace_temp_root_identity_changed');
  }
  const reservation = fs.mkdtempSync(path.join(
    tempParent,
    `.hepta-release-cleanup-${crypto.randomBytes(8).toString('hex')}-`,
  ));
  const reservationIdentity = directoryIdentity(
    reservation,
    'immutable_release_workspace_cleanup_reservation_invalid',
  );
  assertDirectoryIdentity(
    tempParent,
    tempParentIdentity,
    'immutable_release_workspace_temp_parent_identity_changed',
  );
  const quarantineRoot = path.join(reservation, 'quarantined-root');
  fs.renameSync(tempRoot, quarantineRoot);
  faultInjector?.({ stage: 'after_temp_root_quarantined', tempRoot, quarantineRoot });
  const quarantinedIdentity = directoryIdentity(
    quarantineRoot,
    'immutable_release_workspace_quarantine_root_invalid',
  );
  if (!sameIdentity(tempIdentity, quarantinedIdentity)) {
    throw codedError('immutable_release_workspace_quarantine_identity_changed');
  }
  if (pathEntryExistsNoFollow(tempRoot)) {
    throw codedError('immutable_release_workspace_source_reappeared_after_quarantine');
  }
  assertDirectoryIdentity(
    reservation,
    reservationIdentity,
    'immutable_release_workspace_cleanup_reservation_identity_changed',
  );
  for (const required of requiredDirectoryIdentities) {
    const relative = assertPathInside(
      tempRoot,
      path.join(tempRoot, required.relative),
      'immutable_release_workspace_cleanup_required_path_invalid',
    );
    const quarantinedDirectory = path.join(quarantineRoot, relative);
    const currentIdentity = directoryIdentity(
      quarantinedDirectory,
      'immutable_release_workspace_required_directory_invalid',
    );
    if (!sameIdentity(required.identity, currentIdentity)) {
      throw codedError('immutable_release_workspace_required_directory_identity_changed');
    }
  }
  restoreOwnerWrite(quarantineRoot, faultInjector);
  assertDirectoryIdentity(
    quarantineRoot,
    tempIdentity,
    'immutable_release_workspace_quarantine_identity_changed',
  );
  assertDirectoryIdentity(
    reservation,
    reservationIdentity,
    'immutable_release_workspace_cleanup_reservation_identity_changed',
  );
  if (pathEntryExistsNoFollow(tempRoot)) {
    throw codedError('immutable_release_workspace_source_reappeared_after_quarantine');
  }
  fs.rmSync(quarantineRoot, { recursive: true, force: false });
  assertDirectoryIdentity(
    reservation,
    reservationIdentity,
    'immutable_release_workspace_cleanup_reservation_identity_changed',
  );
  fs.rmdirSync(reservation);
}

export function bindIdentityBoundTemporaryDirectory(directory) {
  const root = path.resolve(directory);
  const tempParent = fs.realpathSync(path.dirname(root));
  if (path.dirname(root) !== tempParent) {
    throw codedError('immutable_release_workspace_temp_parent_path_not_canonical');
  }
  const tempParentIdentity = directoryIdentity(
    tempParent,
    'immutable_release_workspace_temp_parent_invalid',
  );
  const tempIdentity = directoryIdentity(root, 'immutable_release_workspace_temp_root_invalid');
  let cleaned = false;
  let cleaning = false;
  return Object.freeze({
    root,
    cleanup({ requiredDirectoryIdentities = [], faultInjector = null } = {}) {
      if (cleaned || cleaning) return;
      cleaning = true;
      try {
        cleanupPreparedRoot({
          tempRoot: root,
          tempIdentity,
          tempParent,
          tempParentIdentity,
          requiredDirectoryIdentities,
          faultInjector,
        });
        cleaned = true;
      } finally {
        cleaning = false;
      }
    },
  });
}

export function prepareImmutableReleaseWorkspace({
  candidateWorkspaceRoot,
  expectedCodeProvenance,
  expectedReleaseStateSnapshot,
  nodeModulesPath,
  temporaryParent = os.tmpdir(),
  captureCodeProvenance = verificationProvenance,
  codeProvenanceMatches,
  inspectReleaseState,
  verifyDependencyTree = assertReleaseDependencyTreeContract,
  materializeSubmodules = materializeImmutableReleaseSubmodules,
  modeMutationFaultInjector = null,
} = {}) {
  const candidateRoot = fs.realpathSync(candidateWorkspaceRoot);
  const candidateRootIdentity = directoryIdentity(
    candidateRoot,
    'immutable_release_workspace_candidate_root_invalid',
  );
  const dependencySource = path.resolve(
    nodeModulesPath || path.join(candidateRoot, 'node_modules'),
  );
  if (fs.realpathSync(dependencySource) !== dependencySource) {
    throw codedError('immutable_release_workspace_node_modules_path_not_canonical');
  }
  const dependencySourceParent = path.dirname(dependencySource);
  const dependencySourceParentIdentity = directoryIdentity(
    dependencySourceParent,
    'immutable_release_workspace_node_modules_parent_invalid',
  );
  const dependencySourceIdentity = directoryIdentity(
    dependencySource,
    'immutable_release_workspace_node_modules_directory_required',
  );
  const assertCandidateAndDependencySourceBound = () => {
    assertDirectoryIdentity(
      candidateRoot,
      candidateRootIdentity,
      'immutable_release_workspace_candidate_root_identity_changed',
    );
    assertDirectoryIdentity(
      dependencySourceParent,
      dependencySourceParentIdentity,
      'immutable_release_workspace_node_modules_parent_identity_changed',
    );
    assertDirectoryIdentity(
      dependencySource,
      dependencySourceIdentity,
      'immutable_release_workspace_node_modules_identity_changed',
    );
  };
  const expectedCommit = String(expectedCodeProvenance?.commit || '');
  if (!/^[0-9a-f]{40,64}$/u.test(expectedCommit)
    || !expectedReleaseStateSnapshot?.workspaceReleaseStateSnapshotHash
    || expectedReleaseStateSnapshot.headCommit !== expectedCommit
    || typeof codeProvenanceMatches !== 'function'
    || typeof inspectReleaseState !== 'function') {
    throw codedError('immutable_release_workspace_expected_identity_invalid');
  }
  const tempParent = fs.realpathSync(temporaryParent);
  const dependencyContractPath = path.join(
    candidateRoot,
    'paper-core',
    'config',
    'release-dependency-tree.v1.json',
  );
  assertCandidateAndDependencySourceBound();
  const dependencyInspection = verifyDependencyTree({
    workspaceRoot: candidateRoot,
    contractPath: dependencyContractPath,
    nodeModulesPath: dependencySource,
  });
  assertCandidateAndDependencySourceBound();
  const tempRoot = fs.mkdtempSync(path.join(tempParent, 'hepta-release-source-'));
  const ownedTempRoot = bindIdentityBoundTemporaryDirectory(tempRoot);
  const cloneRoot = path.join(tempRoot, 'source');
  let cloneIdentity = null;
  let dependencyCopyParentIdentity = null;
  let dependencyTargetIdentity = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    ownedTempRoot.cleanup({
      requiredDirectoryIdentities: [
        { relative: 'source', identity: cloneIdentity },
        { relative: 'dependencies', identity: dependencyCopyParentIdentity },
        { relative: 'dependencies/node_modules', identity: dependencyTargetIdentity },
      ].filter((required) => required.identity),
    });
    cleaned = true;
  };
  try {
    runGit(tempParent, 'clone', [
      'clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', candidateRoot, cloneRoot,
    ]);
    cloneIdentity = directoryIdentity(cloneRoot, 'immutable_release_workspace_clone_root_invalid');
    runGit(cloneRoot, 'checkout', [
      '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', '--force', expectedCommit, '--',
    ]);
    if (runGit(cloneRoot, 'head', ['rev-parse', '--verify', 'HEAD^{commit}']) !== expectedCommit) {
      throw codedError('immutable_release_workspace_detached_commit_mismatch');
    }
    assertCandidateAndDependencySourceBound();
    assertNoSharedObjectFiles(candidateRoot, cloneRoot);
    assertCandidateAndDependencySourceBound();
    const submoduleMaterialization = materializeSubmodules({
      candidateWorkspaceRoot: candidateRoot,
      cloneWorkspaceRoot: cloneRoot,
      expectedCommit,
    });
    if (submoduleMaterialization?.status !== 'immutable_release_submodules_materialized') {
      throw codedError('immutable_release_workspace_submodule_materialization_invalid');
    }
    assertCandidateAndDependencySourceBound();

    const dependencyCopyParent = path.join(tempRoot, 'dependencies');
    const dependencyTarget = path.join(dependencyCopyParent, 'node_modules');
    fs.mkdirSync(dependencyCopyParent, { mode: 0o700 });
    dependencyCopyParentIdentity = directoryIdentity(
      dependencyCopyParent,
      'immutable_release_workspace_dependency_parent_invalid',
    );
    assertCandidateAndDependencySourceBound();
    fs.cpSync(dependencySource, dependencyTarget, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    dependencyTargetIdentity = directoryIdentity(
      dependencyTarget,
      'immutable_release_workspace_dependency_target_invalid',
    );
    assertCandidateAndDependencySourceBound();
    assertSafeDependencyCopy(dependencyTarget);
    assertNoSharedRegularFiles(
      dependencySource,
      dependencyTarget,
      'immutable_release_workspace_dependency_hardlink_forbidden',
    );
    const sourceAfterCopyInspection = verifyDependencyTree({
      workspaceRoot: candidateRoot,
      contractPath: dependencyContractPath,
      nodeModulesPath: dependencySource,
    });
    assertCandidateAndDependencySourceBound();
    assertDependencyInspectionMatches(
      dependencyInspection,
      sourceAfterCopyInspection,
      'immutable_release_workspace_dependency_source_contract_changed',
    );
    const copiedDependencyInspection = verifyDependencyTree({
      workspaceRoot: cloneRoot,
      contractPath: path.join(
        cloneRoot,
        'paper-core',
        'config',
        'release-dependency-tree.v1.json',
      ),
      nodeModulesPath: dependencyTarget,
    });
    assertDependencyInspectionMatches(
      dependencyInspection,
      copiedDependencyInspection,
      'immutable_release_workspace_dependency_copy_contract_mismatch',
    );
    appendNodeModulesExclusion(cloneRoot);
    fs.symlinkSync('../dependencies/node_modules', path.join(cloneRoot, 'node_modules'));
    runGit(cloneRoot, 'node_modules_ignore', [
      'check-ignore', '--quiet', '--no-index', '--', 'node_modules',
    ]);

    const cloneProvenance = captureCodeProvenance(cloneRoot);
    if (!codeProvenanceMatches(expectedCodeProvenance, cloneProvenance)) {
      throw codedError('immutable_release_workspace_code_provenance_mismatch');
    }
    const cloneReleaseState = inspectReleaseState({
      workspaceRoot: cloneRoot,
      expectedSnapshotHash: expectedReleaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    });
    if (cloneReleaseState.headCommit !== expectedCommit) {
      throw codedError('immutable_release_workspace_release_state_commit_mismatch');
    }
    const candidateAfterClone = captureCodeProvenance(candidateRoot);
    if (!codeProvenanceMatches(
      expectedCodeProvenance,
      candidateAfterClone,
    )) throw codedError('immutable_release_workspace_candidate_changed_during_clone');
    inspectReleaseState({
      workspaceRoot: candidateRoot,
      expectedSnapshotHash: expectedReleaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    });

    setTreeReadOnly(dependencyTarget, modeMutationFaultInjector
      ? (event) => modeMutationFaultInjector({ ...event, scope: 'dependencies' })
      : null);
    setTreeReadOnly(cloneRoot, modeMutationFaultInjector
      ? (event) => modeMutationFaultInjector({ ...event, scope: 'source' })
      : null);
    assertTreeReadOnly(dependencyTarget);
    assertTreeReadOnly(cloneRoot);
    const immutableDependencyInspection = verifyDependencyTree({
      workspaceRoot: cloneRoot,
      contractPath: path.join(
        cloneRoot,
        'paper-core',
        'config',
        'release-dependency-tree.v1.json',
      ),
      nodeModulesPath: dependencyTarget,
      readOnly: true,
    });
    if (immutableDependencyInspection?.contractHash !== dependencyInspection?.contractHash
      || immutableDependencyInspection?.lockfileHash !== dependencyInspection?.lockfileHash) {
      throw codedError('immutable_release_workspace_dependency_immutable_contract_mismatch');
    }
    assertNoSharedRegularFiles(
      dependencySource,
      dependencyTarget,
      'immutable_release_workspace_dependency_hardlink_forbidden',
    );
    const sourceFinalInspection = verifyDependencyTree({
      workspaceRoot: candidateRoot,
      contractPath: dependencyContractPath,
      nodeModulesPath: dependencySource,
    });
    assertCandidateAndDependencySourceBound();
    assertDependencyInspectionMatches(
      dependencyInspection,
      sourceFinalInspection,
      'immutable_release_workspace_dependency_source_contract_changed',
    );
    const immutableProvenance = captureCodeProvenance(cloneRoot);
    if (!codeProvenanceMatches(
      expectedCodeProvenance,
      immutableProvenance,
    )) throw codedError('immutable_release_workspace_read_only_provenance_mismatch');
    inspectReleaseState({
      workspaceRoot: cloneRoot,
      expectedSnapshotHash: expectedReleaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    });
    const candidateFinal = captureCodeProvenance(candidateRoot);
    if (!codeProvenanceMatches(expectedCodeProvenance, candidateFinal)) {
      throw codedError('immutable_release_workspace_candidate_changed_during_prepare');
    }
    inspectReleaseState({
      workspaceRoot: candidateRoot,
      expectedSnapshotHash: expectedReleaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    });

    return Object.freeze({
      version: 1,
      kind: 'ImmutableReleaseWorkspace',
      status: 'immutable_release_workspace_ready',
      workspaceRoot: cloneRoot,
      nodeModulesTarget: dependencyTarget,
      codeProvenance: immutableProvenance,
      releaseStateSnapshot: cloneReleaseState,
      dependencyTreeInspection: dependencyInspection,
      dependencyTreeCopyInspection: copiedDependencyInspection,
      immutableDependencyTreeInspection: immutableDependencyInspection,
      submoduleMaterialization,
      cleanup,
    });
  } catch (error) {
    try {
      cleanup();
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}
