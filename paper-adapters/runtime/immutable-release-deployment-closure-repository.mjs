import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { currentCodeProvenance } from './code-provenance.mjs';
import {
  APPROVED_PREDECESSOR_CLOSURE_HASHES,
  CODEX_DIRECTORY,
  EXACT_SEAL_POLICY,
  inspectSealedDeploymentClosure,
} from './release-environment-deployment-closure.mjs';
import {
  assertReleaseDependencyTreeContract,
  captureReleaseDependencyTree,
} from './release-dependency-tree.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_MAXIMUM_SEAL_ENTRIES = 500_000;
const DEFAULT_MAXIMUM_SEAL_DEPTH = 128;
const EXCLUSIONS = Object.freeze([
  '/elan/',
  `/${CODEX_DIRECTORY}/`,
  '/deployment-closure/',
]);

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function identity(stat) {
  return JSON.stringify({
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    uid: String(stat.uid), gid: String(stat.gid), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  });
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function exactRoot(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const stat = fs.lstatSync(root, { bigint: true });
  if (fs.realpathSync(root) !== root || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw codedError('immutable_release_deployment_closure_root_invalid');
  }
  return root;
}

function safePathSnapshot(root, relative, { file = false } = {}) {
  const segments = relative.split('/');
  const snapshot = [];
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segment === '.' || segment === '..') {
      throw codedError('immutable_release_deployment_path_invalid');
    }
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { bigint: true });
    const final = index === segments.length - 1;
    if (stat.isSymbolicLink() || (final && file ? !stat.isFile() : !stat.isDirectory())) {
      throw codedError('immutable_release_deployment_path_unsafe');
    }
    snapshot.push(Object.freeze({ candidate: cursor, identity: identity(stat) }));
  }
  return Object.freeze(snapshot);
}

function assertPathSnapshot(snapshot) {
  for (const entry of snapshot) {
    const stat = fs.lstatSync(entry.candidate, { bigint: true });
    if (stat.isSymbolicLink() || identity(stat) !== entry.identity) {
      throw codedError('immutable_release_deployment_path_drift');
    }
  }
}

function appendGitExclusions(root) {
  const exclude = path.join(root, '.git', 'info', 'exclude');
  const snapshot = safePathSnapshot(root, '.git/info');
  let descriptor;
  try {
    descriptor = fs.openSync(exclude, fs.constants.O_RDWR | NO_FOLLOW);
    const initial = fs.fstatSync(descriptor, { bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n) {
      throw codedError('immutable_release_deployment_git_exclude_invalid');
    }
    const current = fs.readFileSync(descriptor, 'utf8');
    const currentLines = new Set(current.split(/\r?\n/u));
    const missing = EXCLUSIONS.filter((line) => !currentLines.has(line));
    if (missing.length > 0) {
      const prefix = current.endsWith('\n') || current.length === 0 ? '' : '\n';
      fs.writeFileSync(descriptor, `${prefix}${missing.join('\n')}\n`, { flag: 'a' });
      fs.fsyncSync(descriptor);
    }
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (initial.dev !== completed.dev || initial.ino !== completed.ino) {
      throw codedError('immutable_release_deployment_git_exclude_drift');
    }
    assertPathSnapshot(snapshot);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function deploymentProvenance(root) {
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

function captureTreePair(root) {
  return Object.freeze({
    sourceTree: captureReleaseDependencyTree(root),
    readOnlyTree: captureReleaseDependencyTree(root, { readOnlyProjection: true }),
  });
}

function visitAndSeal(candidate, releaseRoot, options, depth = 0) {
  const {
    expectedUid,
    expectedGid,
    sealBudget,
    maximumDepth,
  } = options;
  sealBudget.entries += 1;
  if (sealBudget.entries > sealBudget.maximumEntries || depth > maximumDepth) {
    throw codedError('immutable_release_deployment_seal_budget_exceeded');
  }
  const initial = fs.lstatSync(candidate, { bigint: true });
  if (initial.isSymbolicLink()) {
    let target;
    try {
      target = fs.realpathSync(candidate);
    } catch (error) {
      throw codedError('immutable_release_deployment_symlink_target_invalid', { cause: error });
    }
    if (!within(releaseRoot, target)) {
      throw codedError('immutable_release_deployment_external_symlink_forbidden');
    }
    fs.lchownSync(candidate, expectedUid, expectedGid);
    const completed = fs.lstatSync(candidate, { bigint: true });
    if (!completed.isSymbolicLink()) {
      throw codedError('immutable_release_deployment_symlink_identity_changed');
    }
    return;
  }
  if (!initial.isFile() && !initial.isDirectory()) {
    throw codedError('immutable_release_deployment_special_file_forbidden');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | (initial.isDirectory() ? fs.constants.O_DIRECTORY : 0) | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== initial.dev || opened.ino !== initial.ino
      || opened.isFile() !== initial.isFile() || opened.isDirectory() !== initial.isDirectory()) {
      throw codedError('immutable_release_deployment_entry_identity_changed');
    }
    if (opened.isFile() && opened.nlink !== 1n) {
      throw codedError('immutable_release_deployment_hardlink_forbidden');
    }
    if (opened.isDirectory()) {
      const pinned = `/proc/self/fd/${descriptor}`;
      const entries = fs.readdirSync(pinned, { encoding: 'buffer' })
        .sort((left, right) => Buffer.compare(left, right));
      for (const rawName of entries) {
        const name = rawName.toString('utf8');
        if (!Buffer.from(name, 'utf8').equals(rawName) || name === '.' || name === '..'
          || name.includes('/') || name.includes('\0')) {
          throw codedError('immutable_release_deployment_entry_name_invalid');
        }
        visitAndSeal(path.join(pinned, name), releaseRoot, options, depth + 1);
      }
    }
    fs.fchownSync(descriptor, expectedUid, expectedGid);
    const executable = opened.isFile() && (Number(opened.mode) & 0o111) !== 0;
    fs.fchmodSync(descriptor, opened.isDirectory() ? 0o555 : (executable ? 0o555 : 0o444));
    // Persist the final seal metadata, not merely the pre-seal contents. This
    // fd fsync is intentionally last for both files and directories so a
    // power loss cannot acknowledge a closure whose ownership/mode was only
    // resident in cache.
    fs.fsyncSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const selected = fs.lstatSync(candidate, { bigint: true });
    if (completed.dev !== opened.dev || completed.ino !== opened.ino
      || selected.dev !== opened.dev || selected.ino !== opened.ino
      || Number(completed.uid) !== expectedUid || Number(completed.gid) !== expectedGid) {
      throw codedError('immutable_release_deployment_entry_changed_during_seal');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertSealed(root, { expectedUid, expectedGid }) {
  const pending = [root];
  while (pending.length > 0) {
    const candidate = pending.pop();
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (Number(stat.uid) !== expectedUid || Number(stat.gid) !== expectedGid) {
      throw codedError('immutable_release_deployment_seal_owner_invalid');
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if ((Number(stat.mode) & 0o7777) !== 0o555) {
        throw codedError('immutable_release_deployment_seal_directory_mode_invalid');
      }
      for (const name of fs.readdirSync(candidate)) pending.push(path.join(candidate, name));
    } else if (stat.isFile()) {
      const executable = (Number(stat.mode) & 0o111) !== 0;
      if ((Number(stat.mode) & 0o7777) !== (executable ? 0o555 : 0o444)
        || stat.nlink !== 1n) {
        throw codedError('immutable_release_deployment_seal_file_mode_invalid');
      }
    } else throw codedError('immutable_release_deployment_special_file_forbidden');
  }
}

function writeClosure(root, closure) {
  const directory = path.join(root, 'deployment-closure');
  const file = path.join(directory, 'TOOL-CLOSURE.json');
  try {
    fs.lstatSync(directory);
    throw codedError('immutable_release_deployment_closure_already_exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(closure)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}

export function buildAndSealImmutableReleaseDeploymentClosure({
  workspaceRoot,
  inheritedFromClosureHash,
  expectedUid = process.getuid?.() ?? 0,
  expectedGid = process.getgid?.() ?? 0,
  approvedPredecessorClosureHashes = APPROVED_PREDECESSOR_CLOSURE_HASHES,
  maximumSealEntries = DEFAULT_MAXIMUM_SEAL_ENTRIES,
  maximumSealDepth = DEFAULT_MAXIMUM_SEAL_DEPTH,
  testOnlyAllowNonRoot = false,
} = {}) {
  const root = exactRoot(workspaceRoot);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!SHA256.test(String(inheritedFromClosureHash || ''))
    || !approvedPredecessorClosureHashes.includes(inheritedFromClosureHash)
    || !Number.isSafeInteger(expectedUid) || expectedUid < 0
    || !Number.isSafeInteger(expectedGid) || expectedGid < 0
    || !Number.isSafeInteger(maximumSealEntries) || maximumSealEntries < 1
    || maximumSealEntries > DEFAULT_MAXIMUM_SEAL_ENTRIES
    || !Number.isSafeInteger(maximumSealDepth) || maximumSealDepth < 1
    || maximumSealDepth > DEFAULT_MAXIMUM_SEAL_DEPTH
    || ((expectedUid !== 0 || expectedGid !== 0) && testOnlyAllowNonRoot !== true)
    || Number(rootStat.uid) !== expectedUid || Number(rootStat.gid) !== expectedGid
    || (Number(rootStat.mode) & 0o7777) !== 0o700) {
    throw codedError('immutable_release_deployment_closure_options_invalid');
  }
  const sealOptions = () => ({
    expectedUid,
    expectedGid,
    maximumDepth: maximumSealDepth,
    sealBudget: { entries: 0, maximumEntries: maximumSealEntries },
  });
  appendGitExclusions(root);
  const provenance = deploymentProvenance(root);
  if (provenance.treeDirty) throw codedError('immutable_release_deployment_clean_commit_required');
  const dependencyInspection = assertReleaseDependencyTreeContract({ workspaceRoot: root });
  const toolPairs = Object.freeze({
    elan: captureTreePair(path.join(root, 'elan')),
    codexCli: captureTreePair(path.join(root, CODEX_DIRECTORY)),
  });
  const submodulePairs = Object.freeze({
    core: captureTreePair(path.join(root, 'core')),
    rScientificSourceCas: captureTreePair(
      path.join(root, 'runtime-images', 'r-scientific', 'source-cas'),
    ),
  });

  for (const relative of [
    'elan', CODEX_DIRECTORY, 'core', 'runtime-images/r-scientific/source-cas',
  ]) {
    visitAndSeal(path.join(root, ...relative.split('/')), root, sealOptions());
  }
  const payload = Object.freeze({
    version: 2,
    kind: 'HeptaDeploymentToolClosure',
    inheritedFromClosureHash,
    codeProvenance: provenance,
    dependencyInspection,
    tools: Object.freeze({
      elan: Object.freeze({
        ...toolPairs.elan,
        sealedTree: captureReleaseDependencyTree(path.join(root, 'elan')),
      }),
      codexCli: Object.freeze({
        ...toolPairs.codexCli,
        sealedTree: captureReleaseDependencyTree(path.join(root, CODEX_DIRECTORY)),
      }),
    }),
    submodules: Object.freeze({
      core: Object.freeze({
        path: 'core',
        commit: gitObject(root, 'core', 'HEAD^{commit}'),
        tree: gitObject(root, 'core', 'HEAD^{tree}'),
        ...submodulePairs.core,
        sealedTree: captureReleaseDependencyTree(path.join(root, 'core')),
      }),
      rScientificSourceCas: Object.freeze({
        path: 'runtime-images/r-scientific/source-cas',
        commit: gitObject(root, 'runtime-images/r-scientific/source-cas', 'HEAD^{commit}'),
        tree: gitObject(root, 'runtime-images/r-scientific/source-cas', 'HEAD^{tree}'),
        ...submodulePairs.rScientificSourceCas,
        sealedTree: captureReleaseDependencyTree(
          path.join(root, 'runtime-images', 'r-scientific', 'source-cas'),
        ),
      }),
    }),
    sealPolicy: EXACT_SEAL_POLICY,
  });
  const closure = Object.freeze({ ...payload, closureHash: sha256(JSON.stringify(payload)) });
  writeClosure(root, closure);
  visitAndSeal(root, root, sealOptions());
  assertSealed(root, { expectedUid, expectedGid });

  const immutableProvenance = deploymentProvenance(root);
  if (!same(provenance, immutableProvenance)) {
    throw codedError('immutable_release_deployment_provenance_changed_during_seal');
  }
  const immutableDependencyInspection = assertReleaseDependencyTreeContract({
    workspaceRoot: root,
    readOnly: true,
  });
  const verified = inspectSealedDeploymentClosure({
    workspaceRoot: root,
    provenance: immutableProvenance,
    dependencyInspection: immutableDependencyInspection,
    expectedUid,
    expectedGid,
    approvedPredecessorClosureHashes,
  });
  if (verified.closureHash !== closure.closureHash
    || verified.inheritedFromClosureHash !== inheritedFromClosureHash) {
    throw codedError('immutable_release_deployment_closure_verification_mismatch');
  }
  return Object.freeze({
    status: 'immutable_release_deployment_closure_verified',
    closureHash: closure.closureHash,
    inheritedFromClosureHash,
    provenance: immutableProvenance,
    dependencyInspection: immutableDependencyInspection,
    sealPolicy: EXACT_SEAL_POLICY,
  });
}

function gitObject(workspaceRoot, relative, expression) {
  const repository = path.join(workspaceRoot, ...relative.split('/'));
  const result = spawnSync('/usr/bin/git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null', '-c', `safe.directory=${repository}`,
    '-C', repository, 'rev-parse', '--verify', expression,
  ], {
    encoding: 'utf8', shell: false, maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
      LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    },
  });
  const object = String(result.stdout || '').trim();
  if (result.error || result.signal || result.status !== 0 || !/^[0-9a-f]{40}$/u.test(object)) {
    throw codedError('immutable_release_deployment_submodule_git_invalid');
  }
  return object;
}
