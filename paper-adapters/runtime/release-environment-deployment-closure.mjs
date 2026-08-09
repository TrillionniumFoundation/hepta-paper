import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureReleaseDependencyTree } from './release-dependency-tree.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40}$/u;
const MAXIMUM_CLOSURE_BYTES = 1024 * 1024;
const MAXIMUM_GIT_OUTPUT_BYTES = 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const LEGACY_V1_CLOSURE_HASH =
  'sha256:370574e9ce3cb982917fe2bc0c3a5479f037abbf72843472c5324fd0935568f2';
const DEPLOYED_F24_PREDECESSOR_CLOSURE_HASH =
  'sha256:919eae755c00610947657fa85f7bb3036bbaff8c05246e2ef230fec7f5cf8dc3';
// Every release source explicitly pins the closure hashes from which its v2
// deployment closure may inherit. A later v2 -> v2 release must add or replace
// this entry with the actually deployed predecessor before its source is frozen.
const APPROVED_PREDECESSOR_CLOSURE_HASHES = Object.freeze([
  DEPLOYED_F24_PREDECESSOR_CLOSURE_HASH,
]);
const CODEX_DIRECTORY = 'codex-cli-0.144.1';
const EXACT_SEAL_POLICY = Object.freeze({
  owner: 'root:root',
  directoriesMode: '0555',
  executableFilesMode: '0555',
  nonExecutableFilesMode: '0444',
});

function codedError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function requireCondition(condition, code) {
  if (!condition) throw codedError(code);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, code) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  requireCondition(same(Object.keys(value).sort(), [...keys].sort()), code);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function statIdentity(stat) {
  return JSON.stringify({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function validateCounts(counts, code) {
  exactKeys(counts, ['entries', 'directories', 'files', 'symlinks'], code);
  for (const key of ['entries', 'directories', 'files', 'symlinks']) {
    requireCondition(Number.isSafeInteger(counts[key]) && counts[key] >= 0, code);
  }
  requireCondition(
    counts.entries === counts.directories + counts.files + counts.symlinks,
    code,
  );
}

function validateTree(tree, expectedKind, code) {
  exactKeys(tree, ['version', 'kind', 'counts', 'treeHash'], code);
  requireCondition(tree.version === 1 && tree.kind === expectedKind, code);
  requireCondition(SHA256.test(String(tree.treeHash || '')), code);
  validateCounts(tree.counts, code);
}

function sameTreeMaterial(left, right) {
  return left.treeHash === right.treeHash && same(left.counts, right.counts);
}

function validateCodeProvenance(provenance) {
  const code = 'release_environment_deployment_provenance_schema_invalid';
  exactKeys(provenance, [
    'version',
    'kind',
    'packageVersion',
    'commit',
    'commitTree',
    'tags',
    'treeDirty',
    'indexStateHash',
    'repositoryEntryCount',
    'repositoryContentHash',
    'worktreeStateHash',
    'evidenceEnvironment',
    'evidenceClass',
  ], code);
  requireCondition(provenance.version === 2 && provenance.kind === 'CodeProvenance', code);
  requireCondition(typeof provenance.packageVersion === 'string'
    && provenance.packageVersion.length > 0, code);
  requireCondition(GIT_OBJECT.test(String(provenance.commit || ''))
    && GIT_OBJECT.test(String(provenance.commitTree || '')), code);
  requireCondition(Array.isArray(provenance.tags)
    && provenance.tags.every((tag) => typeof tag === 'string')
    && same(provenance.tags, [...new Set(provenance.tags)].sort()), code);
  requireCondition(provenance.treeDirty === false, code);
  requireCondition(SHA256.test(String(provenance.indexStateHash || ''))
    && SHA256.test(String(provenance.repositoryContentHash || ''))
    && SHA256.test(String(provenance.worktreeStateHash || '')), code);
  requireCondition(Number.isSafeInteger(provenance.repositoryEntryCount)
    && provenance.repositoryEntryCount >= 0, code);
  requireCondition(typeof provenance.evidenceEnvironment === 'string'
    && provenance.evidenceEnvironment.length > 0
    && typeof provenance.evidenceClass === 'string'
    && provenance.evidenceClass.length > 0, code);
}

function validateDependencyInspection(inspection, { readOnly }) {
  const code = 'release_environment_deployment_dependency_schema_invalid';
  exactKeys(inspection, [
    'version', 'kind', 'status', 'contractHash', 'lockfileHash', 'tree', 'readOnly',
  ], code);
  requireCondition(inspection.version === 1
    && inspection.kind === 'ReleaseDependencyTreeInspection'
    && inspection.status === 'release_dependency_tree_verified'
    && inspection.readOnly === readOnly, code);
  requireCondition(SHA256.test(String(inspection.contractHash || ''))
    && SHA256.test(String(inspection.lockfileHash || '')), code);
  validateTree(
    inspection.tree,
    readOnly ? 'ReleaseDependencyReadOnlyTree' : 'ReleaseDependencySourceTree',
    code,
  );
}

function validateTool(tool, code) {
  exactKeys(tool, ['sourceTree', 'readOnlyTree', 'sealedTree'], code);
  validateTree(tool.sourceTree, 'ReleaseDependencySourceTree', code);
  validateTree(tool.readOnlyTree, 'ReleaseDependencyReadOnlyTree', code);
  validateTree(tool.sealedTree, 'ReleaseDependencySourceTree', code);
  requireCondition(sameTreeMaterial(tool.sourceTree, tool.readOnlyTree), code);
}

function validateSubmodule(submodule, expectedPath, code) {
  exactKeys(submodule, [
    'path', 'commit', 'tree', 'sourceTree', 'readOnlyTree', 'sealedTree',
  ], code);
  requireCondition(submodule.path === expectedPath, code);
  requireCondition(GIT_OBJECT.test(String(submodule.commit || ''))
    && GIT_OBJECT.test(String(submodule.tree || '')), code);
  validateTree(submodule.sourceTree, 'ReleaseDependencySourceTree', code);
  validateTree(submodule.readOnlyTree, 'ReleaseDependencyReadOnlyTree', code);
  validateTree(submodule.sealedTree, 'ReleaseDependencySourceTree', code);
  requireCondition(sameTreeMaterial(submodule.sourceTree, submodule.readOnlyTree), code);
}

function validateClosureSchema(closure, {
  legacyV1ClosureHash,
  approvedPredecessorClosureHashes,
}) {
  const code = 'release_environment_deployment_closure_invalid';
  requireCondition(closure?.version === 1 || closure?.version === 2, code);
  exactKeys(closure, [
    'version',
    'kind',
    ...(closure.version === 2 ? ['inheritedFromClosureHash'] : []),
    'codeProvenance',
    'dependencyInspection',
    'tools',
    'submodules',
    'sealPolicy',
    'closureHash',
  ], code);
  requireCondition(closure.kind === 'HeptaDeploymentToolClosure'
    && SHA256.test(String(closure.closureHash || '')), code);
  const { closureHash, ...payload } = closure;
  requireCondition(closureHash === sha256(JSON.stringify(payload)), code);
  if (closure.version === 1) {
    requireCondition(closureHash === legacyV1ClosureHash,
      'release_environment_deployment_legacy_anchor_mismatch');
  } else {
    requireCondition(approvedPredecessorClosureHashes.includes(
      closure.inheritedFromClosureHash,
    )
      && closure.closureHash !== closure.inheritedFromClosureHash,
    'release_environment_deployment_lineage_mismatch');
  }
  validateCodeProvenance(closure.codeProvenance);
  validateDependencyInspection(closure.dependencyInspection, { readOnly: false });
  exactKeys(closure.tools, ['elan', 'codexCli'], code);
  validateTool(closure.tools.elan, 'release_environment_deployment_tool_schema_invalid:elan');
  validateTool(
    closure.tools.codexCli,
    'release_environment_deployment_tool_schema_invalid:codexCli',
  );
  exactKeys(closure.submodules, ['core', 'rScientificSourceCas'], code);
  validateSubmodule(
    closure.submodules.core,
    'core',
    'release_environment_deployment_submodule_schema_invalid:core',
  );
  validateSubmodule(
    closure.submodules.rScientificSourceCas,
    'runtime-images/r-scientific/source-cas',
    'release_environment_deployment_submodule_schema_invalid:rScientificSourceCas',
  );
  exactKeys(closure.sealPolicy, Object.keys(EXACT_SEAL_POLICY),
    'release_environment_deployment_seal_policy_invalid');
  requireCondition(same(closure.sealPolicy, EXACT_SEAL_POLICY),
    'release_environment_deployment_seal_policy_invalid');
}

function safePathSnapshot(workspaceRoot, relative, { expectedUid, expectedGid, file = false }) {
  const selected = path.join(workspaceRoot, ...relative.split('/'));
  requireCondition(path.resolve(selected) === selected,
    'release_environment_deployment_path_unsafe');
  const chain = [workspaceRoot];
  let cursor = workspaceRoot;
  for (const segment of relative.split('/')) {
    requireCondition(segment.length > 0 && segment !== '.' && segment !== '..',
      'release_environment_deployment_path_unsafe');
    cursor = path.join(cursor, segment);
    chain.push(cursor);
  }
  const snapshot = chain.map((candidate, index) => {
    const stat = fs.lstatSync(candidate, { bigint: true });
    const final = index === chain.length - 1;
    requireCondition(!stat.isSymbolicLink()
      && (final && file ? stat.isFile() : stat.isDirectory()),
    'release_environment_deployment_path_unsafe');
    requireCondition(stat.uid === BigInt(expectedUid) && stat.gid === BigInt(expectedGid),
      'release_environment_deployment_path_owner_invalid');
    return Object.freeze({ candidate, identity: statIdentity(stat) });
  });
  return Object.freeze(snapshot);
}

function assertPathSnapshot(snapshot) {
  for (const { candidate, identity } of snapshot) {
    const stat = fs.lstatSync(candidate, { bigint: true });
    requireCondition(!stat.isSymbolicLink() && statIdentity(stat) === identity,
      'release_environment_deployment_path_drift');
  }
}

function readClosure(workspaceRoot, metadata) {
  const relative = 'deployment-closure/TOOL-CLOSURE.json';
  const snapshot = safePathSnapshot(workspaceRoot, relative, { ...metadata, file: true });
  for (const { candidate } of snapshot.slice(0, -1)) {
    const stat = fs.lstatSync(candidate, { bigint: true });
    requireCondition((stat.mode & 0o7777n) === 0o555n,
      'release_environment_deployment_closure_directory_mode_invalid');
  }
  const file = path.join(workspaceRoot, ...relative.split('/'));
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    requireCondition(before.isFile()
      && before.nlink === 1n
      && before.size > 0n
      && before.size <= BigInt(MAXIMUM_CLOSURE_BYTES)
      && (before.mode & 0o7777n) === 0o444n,
    'release_environment_deployment_closure_file_invalid');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    requireCondition(statIdentity(before) === statIdentity(after)
      && BigInt(bytes.length) === before.size,
    'release_environment_deployment_closure_file_drift');
    assertPathSnapshot(snapshot);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const closure = JSON.parse(raw);
    requireCondition(raw === `${JSON.stringify(closure)}\n`
      || raw === `${JSON.stringify(closure, null, 2)}\n`,
    'release_environment_deployment_closure_json_noncanonical');
    return closure;
  } catch (error) {
    if (error?.code?.startsWith?.('release_environment_')) throw error;
    throw codedError('release_environment_deployment_closure_invalid', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function captureBoundTree(workspaceRoot, relative, metadata) {
  const snapshot = safePathSnapshot(workspaceRoot, relative, metadata);
  const selected = path.join(workspaceRoot, ...relative.split('/'));
  const first = captureReleaseDependencyTree(selected);
  assertPathSnapshot(snapshot);
  const second = captureReleaseDependencyTree(selected);
  assertPathSnapshot(snapshot);
  requireCondition(same(first, second), 'release_environment_deployment_tree_drift');
  return Object.freeze({ selected, tree: second });
}

function gitOutput(selected, argumentsList) {
  const result = spawnSync('/usr/bin/git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null',
    '-c', `safe.directory=${selected}`,
    '-C', selected,
    ...argumentsList,
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
    },
  });
  requireCondition(!result.error && result.status === 0,
    'release_environment_deployment_submodule_git_invalid');
  return String(result.stdout || '').trim();
}

function gitObject(selected, expression) {
  const object = gitOutput(selected, ['rev-parse', '--verify', expression]);
  requireCondition(GIT_OBJECT.test(object),
    'release_environment_deployment_submodule_git_invalid');
  return object;
}

function gitDirectorySnapshot(workspaceRoot, selected, metadata) {
  const administrativeEntry = fs.lstatSync(path.join(selected, '.git'), { bigint: true });
  requireCondition(!administrativeEntry.isSymbolicLink()
    && (administrativeEntry.isFile() || administrativeEntry.isDirectory()),
  'release_environment_deployment_submodule_git_path_unsafe');
  const gitDirectory = gitOutput(selected, ['rev-parse', '--absolute-git-dir']);
  const relative = path.relative(workspaceRoot, gitDirectory);
  requireCondition(path.isAbsolute(gitDirectory)
    && path.resolve(gitDirectory) === gitDirectory
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative),
  'release_environment_deployment_submodule_git_path_unsafe');
  return safePathSnapshot(workspaceRoot, relative.split(path.sep).join('/'), metadata);
}

function verifyTool(workspaceRoot, relative, claim, key, metadata) {
  const actual = captureBoundTree(workspaceRoot, relative, metadata).tree;
  requireCondition(same(actual, claim.sealedTree),
    `release_environment_deployment_tool_mismatch:${key}`);
}

function verifySubmodule(workspaceRoot, relative, claim, key, metadata) {
  const before = captureBoundTree(workspaceRoot, relative, metadata);
  const gitDirectory = gitDirectorySnapshot(workspaceRoot, before.selected, metadata);
  requireCondition(gitObject(before.selected, 'HEAD^{commit}') === claim.commit,
    `release_environment_deployment_submodule_commit_mismatch:${key}`);
  requireCondition(gitObject(before.selected, 'HEAD^{tree}') === claim.tree,
    `release_environment_deployment_submodule_tree_mismatch:${key}`);
  assertPathSnapshot(gitDirectory);
  const after = captureBoundTree(workspaceRoot, relative, metadata);
  requireCondition(same(before.tree, after.tree),
    `release_environment_deployment_submodule_drift:${key}`);
  requireCondition(same(after.tree, claim.sealedTree),
    `release_environment_deployment_submodule_content_mismatch:${key}`);
}

export function inspectSealedDeploymentClosure({
  workspaceRoot,
  provenance,
  dependencyInspection,
  expectedUid = 0,
  expectedGid = 0,
  legacyV1ClosureHash = LEGACY_V1_CLOSURE_HASH,
  approvedPredecessorClosureHashes = APPROVED_PREDECESSOR_CLOSURE_HASHES,
}) {
  requireCondition(typeof workspaceRoot === 'string'
    && path.isAbsolute(workspaceRoot)
    && path.resolve(workspaceRoot) === workspaceRoot
    && fs.realpathSync(workspaceRoot) === workspaceRoot,
  'release_environment_deployment_root_unsafe');
  requireCondition(Number.isSafeInteger(expectedUid) && expectedUid >= 0
    && Number.isSafeInteger(expectedGid) && expectedGid >= 0
    && SHA256.test(String(legacyV1ClosureHash || ''))
    && Array.isArray(approvedPredecessorClosureHashes)
    && approvedPredecessorClosureHashes.length > 0
    && approvedPredecessorClosureHashes.every((hash) => SHA256.test(String(hash || '')))
    && same(approvedPredecessorClosureHashes, [...new Set(approvedPredecessorClosureHashes)]),
  'release_environment_deployment_inspection_options_invalid');
  const metadata = Object.freeze({ expectedUid, expectedGid });
  const closure = readClosure(workspaceRoot, metadata);
  validateClosureSchema(closure, {
    legacyV1ClosureHash,
    approvedPredecessorClosureHashes,
  });
  validateCodeProvenance(provenance);
  requireCondition(same(closure.codeProvenance, provenance),
    'release_environment_deployment_provenance_mismatch');
  validateDependencyInspection(dependencyInspection, { readOnly: true });
  requireCondition(closure.dependencyInspection.contractHash === dependencyInspection.contractHash
    && closure.dependencyInspection.lockfileHash === dependencyInspection.lockfileHash
    && sameTreeMaterial(closure.dependencyInspection.tree, dependencyInspection.tree),
  'release_environment_deployment_dependency_mismatch');
  verifyTool(workspaceRoot, 'elan', closure.tools.elan, 'elan', metadata);
  verifyTool(workspaceRoot, CODEX_DIRECTORY, closure.tools.codexCli, 'codexCli', metadata);
  verifySubmodule(workspaceRoot, 'core', closure.submodules.core, 'core', metadata);
  verifySubmodule(
    workspaceRoot,
    'runtime-images/r-scientific/source-cas',
    closure.submodules.rScientificSourceCas,
    'rScientificSourceCas',
    metadata,
  );
  return Object.freeze({
    status: 'release_environment_deployment_closure_verified',
    version: closure.version,
    closureHash: closure.closureHash,
    inheritedFromClosureHash: closure.version === 2
      ? closure.inheritedFromClosureHash
      : null,
  });
}
