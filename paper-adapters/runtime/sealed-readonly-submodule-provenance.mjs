import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { captureReleaseDependencyTree } from './release-dependency-tree.mjs';

const GIT_OBJECT = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CLOSURE_RELATIVE_PATH = 'deployment-closure/TOOL-CLOSURE.json';
const SEALED_DIRECTORY_MODE = 0o555n;
const SEALED_FILE_MODE = 0o444n;
const SUBMODULES = Object.freeze([
  Object.freeze({ key: 'core', path: 'core' }),
  Object.freeze({
    key: 'rScientificSourceCas',
    path: 'runtime-images/r-scientific/source-cas',
  }),
]);

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function runGit(repository, operation, args) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null',
    '-c', `safe.directory=${repository}`,
    '-C', repository,
    ...args,
  ], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
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
      GIT_LFS_SKIP_SMUDGE: '1',
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw codedError(`code_provenance_sealed_submodule_git_failed:${operation}`, {
      gitExitStatus: result.status,
    });
  }
  return String(result.stdout || '');
}

function gitObject(repository, expression, operation) {
  const value = runGit(repository, operation, ['rev-parse', '--verify', expression]).trim();
  if (!GIT_OBJECT.test(value)) {
    throw codedError(`code_provenance_sealed_submodule_object_invalid:${operation}`);
  }
  return value;
}

function expectedGitlink(superproject, relative) {
  const raw = runGit(superproject, `gitlink:${relative}`, ['ls-tree', '-z', 'HEAD', '--', relative]);
  const match = raw.match(/^160000 commit ([0-9a-f]{40})\t([^\0]+)\0?$/u);
  if (!match || match[2] !== relative) {
    throw codedError(`code_provenance_sealed_submodule_gitlink_invalid:${relative}`);
  }
  return match[1];
}

function regularClosureFile(root, relative) {
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw codedError('code_provenance_sealed_closure_path_invalid');
  let stat;
  try { stat = fs.lstatSync(candidate, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw codedError('code_provenance_sealed_closure_read_failed', { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate) {
    throw codedError('code_provenance_sealed_closure_file_invalid');
  }
  return candidate;
}

function assertSealedClosurePath(root, closurePath) {
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || fs.realpathSync(root) !== root
    || (rootStat.mode & 0o7777n) !== SEALED_DIRECTORY_MODE) {
    throw codedError('code_provenance_sealed_workspace_root_not_read_only');
  }
  const relative = path.relative(root, closurePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { bigint: true });
    const final = index === segments.length - 1;
    if (stat.isSymbolicLink() || fs.realpathSync(cursor) !== cursor
      || (final ? !stat.isFile() : !stat.isDirectory())) {
      throw codedError('code_provenance_sealed_closure_path_invalid');
    }
    const expectedMode = final ? SEALED_FILE_MODE : SEALED_DIRECTORY_MODE;
    if ((stat.mode & 0o7777n) !== expectedMode) {
      throw codedError(final
        ? 'code_provenance_sealed_closure_file_not_read_only'
        : 'code_provenance_sealed_closure_directory_not_read_only');
    }
    if (final && stat.nlink !== 1n) {
      throw codedError('code_provenance_sealed_closure_file_link_count_invalid');
    }
  }
}

function readClosure(root, closurePath) {
  const candidate = regularClosureFile(root, closurePath);
  if (!candidate) return null;
  assertSealedClosurePath(root, candidate);
  let raw;
  let parsed;
  try {
    raw = fs.readFileSync(candidate, 'utf8');
    parsed = JSON.parse(raw);
  }
  catch (error) {
    throw codedError('code_provenance_sealed_closure_json_invalid', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object'
    || ![1, 2].includes(parsed.version)
    || parsed.kind !== 'HeptaDeploymentToolClosure'
    || !parsed.submodules
    || typeof parsed.closureHash !== 'string' || !SHA256.test(parsed.closureHash)) {
    throw codedError('code_provenance_sealed_closure_schema_invalid');
  }
  const canonical = JSON.stringify(parsed);
  const pretty = JSON.stringify(parsed, null, 2);
  if (raw !== `${canonical}\n` && raw !== `${pretty}\n`) {
    throw codedError('code_provenance_sealed_closure_json_noncanonical');
  }
  const expectedSubmoduleKeys = SUBMODULES.map(({ key }) => key).sort();
  const actualSubmoduleKeys = Object.keys(parsed.submodules).sort();
  if (JSON.stringify(actualSubmoduleKeys) !== JSON.stringify(expectedSubmoduleKeys)) {
    throw codedError('code_provenance_sealed_closure_submodule_set_invalid');
  }
  const { closureHash, ...payload } = parsed;
  if (sha256(JSON.stringify(payload)) !== closureHash) {
    throw codedError('code_provenance_sealed_closure_hash_mismatch');
  }
  return parsed;
}

function inspectOne(root, definition, expected) {
  const submoduleRoot = path.resolve(root, definition.path);
  if (!inside(root, submoduleRoot)) {
    throw codedError(`code_provenance_sealed_submodule_path_invalid:${definition.key}`);
  }
  let stat;
  try { stat = fs.lstatSync(submoduleRoot, { bigint: true }); }
  catch (error) {
    throw codedError(`code_provenance_sealed_submodule_missing:${definition.key}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(submoduleRoot) !== submoduleRoot) {
    throw codedError(`code_provenance_sealed_submodule_root_invalid:${definition.key}`);
  }
  if ((stat.mode & 0o7777n) !== SEALED_DIRECTORY_MODE) {
    throw codedError(`code_provenance_sealed_submodule_root_not_read_only:${definition.key}`);
  }
  const gitlink = expectedGitlink(root, definition.path);
  if (!GIT_OBJECT.test(String(expected.commit || ''))
    || !GIT_OBJECT.test(String(expected.tree || ''))) {
    throw codedError(`code_provenance_sealed_submodule_closure_identity_invalid:${definition.key}`);
  }
  const expectedTree = expected.sealedTree || expected.readOnlyTree || expected.sourceTree;
  if (!expectedTree || !SHA256.test(String(expectedTree.treeHash || ''))) {
    throw codedError(`code_provenance_sealed_submodule_closure_content_hash_invalid:${definition.key}`);
  }
  if (gitlink !== expected.commit) {
    throw codedError(`code_provenance_sealed_submodule_commit_mismatch:${definition.key}`);
  }
  const commit = gitObject(submoduleRoot, 'HEAD^{commit}', `${definition.key}:head`);
  const tree = gitObject(submoduleRoot, 'HEAD^{tree}', `${definition.key}:tree`);
  if (commit !== expected.commit) {
    throw codedError(`code_provenance_sealed_submodule_worktree_commit_mismatch:${definition.key}`);
  }
  if (tree !== expected.tree) {
    throw codedError(`code_provenance_sealed_submodule_tree_mismatch:${definition.key}`);
  }
  const observedTree = captureReleaseDependencyTree(submoduleRoot);
  if (JSON.stringify(observedTree) !== JSON.stringify(expectedTree)) {
    throw codedError(`code_provenance_sealed_submodule_content_mismatch:${definition.key}`);
  }
  return Object.freeze({
    key: definition.key,
    path: definition.path,
    commit,
    tree,
    contentTreeHash: observedTree.treeHash,
  });
}

/**
 * Verify the immutable deployment's submodule closure without invoking
 * `git status`.  This is deliberately separate from the ordinary worktree
 * status probe: a hydrated Git-LFS/CAS representation is allowed to differ
 * from the pointer worktree, but only after commit, tree and content-tree
 * hashes have been checked against the sealed deployment closure.
 *
 * A development checkout has no deployment closure and returns a typed
 * not-configured result.  Callers entering a sealed/read-only release must
 * require `status === 'sealed_readonly_submodules_verified'`.
 */
export function inspectSealedReadOnlySubmodules({
  workspaceRoot,
  closurePath = CLOSURE_RELATIVE_PATH,
} = {}) {
  const root = path.resolve(String(workspaceRoot || ''));
  if (!root || root === path.parse(root).root) {
    throw codedError('code_provenance_sealed_workspace_root_invalid');
  }
  const closure = readClosure(root, closurePath);
  if (!closure) {
    return Object.freeze({
      version: 1,
      kind: 'SealedReadOnlySubmoduleInspection',
      status: 'sealed_readonly_submodules_not_configured',
      submodules: Object.freeze([]),
      inspectionHash: sha256(JSON.stringify({ version: 1, root })),
    });
  }
  const observations = SUBMODULES.map((definition) => {
    const expected = closure.submodules?.[definition.key];
    if (!expected || expected.path !== definition.path) {
      throw codedError(`code_provenance_sealed_submodule_closure_entry_invalid:${definition.key}`);
    }
    return inspectOne(root, definition, expected);
  });
  const payload = {
    version: 1,
    kind: 'SealedReadOnlySubmoduleInspection',
    status: 'sealed_readonly_submodules_verified',
    closureHash: closure.closureHash,
    submodules: observations,
  };
  return Object.freeze({
    ...payload,
    inspectionHash: sha256(JSON.stringify(payload)),
  });
}

export function sealedReadOnlySubmoduleClosurePath() {
  return CLOSURE_RELATIVE_PATH;
}
