import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_CONTRACT_BYTES = 1024 * 1024;

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function statIdentity(stat) {
  return JSON.stringify({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function selectedMode(stat) {
  if (stat.isFile()) return (Number(stat.mode) & 0o111) === 0 ? 0o644 : 0o755;
  if (stat.isDirectory()) return 0o755;
  if (stat.isSymbolicLink()) return 0o777;
  return 0;
}

function regularFileRecord(absolute, relative, initial) {
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(initial)) {
      throw new Error('release_dependency_tree_file_identity_changed');
    }
    const bytes = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(completed) !== statIdentity(opened)
      || BigInt(bytes.length) !== completed.size) {
      throw new Error('release_dependency_tree_file_changed_during_read');
    }
    return Object.freeze({
      path: relative,
      kind: 'file',
      mode: selectedMode(initial),
      size: bytes.length,
      contentHash: sha256(bytes),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function symbolicLinkRecord(absolute, relative, initial) {
  const target = fs.readlinkSync(absolute, { encoding: 'buffer' });
  const completed = fs.lstatSync(absolute, { bigint: true });
  if (!completed.isSymbolicLink() || statIdentity(completed) !== statIdentity(initial)) {
    throw new Error('release_dependency_tree_symlink_changed_during_read');
  }
  return Object.freeze({
    path: relative,
    kind: 'symlink',
    mode: selectedMode(initial),
    size: target.length,
    targetHash: sha256(target),
  });
}

function scanOnce(root, options) {
  const selectedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(selectedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('release_dependency_tree_root_directory_required');
  }
  const records = [];
  const visit = (absolute, relative) => {
    const initial = fs.lstatSync(absolute, { bigint: true });
    if (initial.isFile()) {
      records.push(regularFileRecord(absolute, relative, initial));
      return;
    }
    if (initial.isSymbolicLink()) {
      records.push(symbolicLinkRecord(absolute, relative, initial));
      return;
    }
    if (!initial.isDirectory()) {
      throw new Error('release_dependency_tree_special_file_forbidden');
    }
    let descriptor;
    try {
      descriptor = fs.openSync(
        absolute,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NO_FOLLOW,
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || statIdentity(opened) !== statIdentity(initial)) {
        throw new Error('release_dependency_tree_directory_identity_changed');
      }
      records.push(Object.freeze({
        path: relative,
        kind: 'directory',
        mode: selectedMode(initial),
        size: 0,
      }));
      const pinnedDirectory = `/proc/self/fd/${descriptor}`;
      const entries = fs.readdirSync(pinnedDirectory, { encoding: 'buffer' })
        .sort((left, right) => Buffer.compare(left, right));
      for (const rawName of entries) {
        const name = rawName.toString('utf8');
        if (!Buffer.from(name, 'utf8').equals(rawName)
          || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
          throw new Error('release_dependency_tree_entry_name_invalid');
        }
        visit(
          path.join(pinnedDirectory, name),
          relative === '.' ? name : `${relative}/${name}`,
        );
      }
      const completed = fs.fstatSync(descriptor, { bigint: true });
      if (statIdentity(completed) !== statIdentity(opened)) {
        throw new Error('release_dependency_tree_directory_changed_during_scan');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  visit(selectedRoot, '.');
  const completedRoot = fs.lstatSync(selectedRoot, { bigint: true });
  if (statIdentity(completedRoot) !== statIdentity(rootStat)) {
    throw new Error('release_dependency_tree_root_changed_during_scan');
  }
  const counts = Object.freeze({
    entries: records.length,
    directories: records.filter((record) => record.kind === 'directory').length,
    files: records.filter((record) => record.kind === 'file').length,
    symlinks: records.filter((record) => record.kind === 'symlink').length,
  });
  return Object.freeze({
    rootIdentity: statIdentity(rootStat),
    report: Object.freeze({
      version: 1,
      kind: options.readOnlyProjection
        ? 'ReleaseDependencyReadOnlyTree'
        : 'ReleaseDependencySourceTree',
      counts,
      treeHash: sha256(JSON.stringify(records)),
    }),
  });
}

export function captureReleaseDependencyTree(root, { readOnlyProjection = false } = {}) {
  const options = Object.freeze({ readOnlyProjection: readOnlyProjection === true });
  const first = scanOnce(root, options);
  const second = scanOnce(root, options);
  if (first.rootIdentity !== second.rootIdentity
    || JSON.stringify(first.report) !== JSON.stringify(second.report)) {
    throw new Error('release_dependency_tree_snapshot_unstable');
  }
  return second.report;
}

function parentChain(boundaryRoot, file) {
  const boundary = path.resolve(boundaryRoot);
  const selected = path.resolve(file);
  const relative = path.relative(boundary, selected);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('release_dependency_contract_path_outside_workspace');
  }
  const paths = [boundary];
  let cursor = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    paths.push(cursor);
  }
  return paths.map((candidate, index) => {
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink()
      || (index < paths.length - 1 && !stat.isDirectory())
      || (index === paths.length - 1 && !stat.isFile())) {
      throw new Error('release_dependency_contract_path_unsafe');
    }
    return Object.freeze({ path: candidate, identity: statIdentity(stat) });
  });
}

function assertParentChain(snapshot) {
  for (const entry of snapshot) {
    const stat = fs.lstatSync(entry.path, { bigint: true });
    if (stat.isSymbolicLink() || statIdentity(stat) !== entry.identity) {
      throw new Error('release_dependency_contract_path_changed_during_read');
    }
  }
}

function readRegularFile(file, maximumBytes = MAX_CONTRACT_BYTES, { boundaryRoot } = {}) {
  const chain = parentChain(boundaryRoot, file);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(before) !== chain.at(-1).identity) {
      throw new Error('release_dependency_contract_file_identity_changed');
    }
    if (!before.isFile() || before.size < 1 || before.size > BigInt(maximumBytes)) {
      throw new Error('release_dependency_contract_file_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(before) !== statIdentity(after) || BigInt(bytes.length) !== after.size) {
      throw new Error('release_dependency_contract_file_changed_during_read');
    }
    assertParentChain(chain);
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function treeShape(value, kind) {
  return exactKeys(value, ['counts', 'kind', 'treeHash', 'version'])
    && value.version === 1
    && value.kind === kind
    && SHA256.test(String(value.treeHash || ''))
    && exactKeys(value.counts, ['directories', 'entries', 'files', 'symlinks'])
    && Object.values(value.counts).every((count) => Number.isSafeInteger(count) && count >= 0)
    && value.counts.entries === value.counts.directories
      + value.counts.files + value.counts.symlinks;
}

export function buildReleaseDependencyTreeContract({ workspaceRoot, generatedAt } = {}) {
  const root = path.resolve(workspaceRoot);
  const lockfile = readRegularFile(path.join(root, 'package-lock.json'), 64 * 1024 * 1024, {
    boundaryRoot: root,
  });
  const nodeModules = path.join(root, 'node_modules');
  const payload = {
    version: 1,
    kind: 'ReleaseDependencyTreeContract',
    generatedAt,
    lockfilePath: 'package-lock.json',
    lockfileHash: sha256(lockfile),
    nodeModulesPath: 'node_modules',
    sourceTree: captureReleaseDependencyTree(nodeModules),
    readOnlyTree: captureReleaseDependencyTree(nodeModules, { readOnlyProjection: true }),
  };
  return Object.freeze({
    ...payload,
    releaseDependencyTreeContractHash: sha256(JSON.stringify(payload)),
  });
}

export function assertReleaseDependencyTreeContract({
  workspaceRoot,
  contractPath = path.join(workspaceRoot, 'paper-core', 'config', 'release-dependency-tree.v1.json'),
  nodeModulesPath = path.join(workspaceRoot, 'node_modules'),
  readOnly = false,
} = {}) {
  const root = path.resolve(workspaceRoot);
  const contract = JSON.parse(readRegularFile(contractPath, MAX_CONTRACT_BYTES, {
    boundaryRoot: root,
  }).toString('utf8'));
  const { releaseDependencyTreeContractHash: claimedHash, ...payload } = contract;
  if (!exactKeys(contract, [
    'generatedAt', 'kind', 'lockfileHash', 'lockfilePath', 'nodeModulesPath',
    'readOnlyTree', 'releaseDependencyTreeContractHash', 'sourceTree', 'version',
  ])
    || contract.version !== 1
    || contract.kind !== 'ReleaseDependencyTreeContract'
    || !Number.isFinite(Date.parse(String(contract.generatedAt || '')))
    || contract.lockfilePath !== 'package-lock.json'
    || contract.nodeModulesPath !== 'node_modules'
    || !SHA256.test(String(contract.lockfileHash || ''))
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== sha256(JSON.stringify(payload))
    || !treeShape(contract.sourceTree, 'ReleaseDependencySourceTree')
    || !treeShape(contract.readOnlyTree, 'ReleaseDependencyReadOnlyTree')) {
    throw new Error('release_dependency_tree_contract_invalid');
  }
  const lockfileHash = sha256(readRegularFile(
    path.join(root, contract.lockfilePath),
    64 * 1024 * 1024,
    { boundaryRoot: root },
  ));
  if (lockfileHash !== contract.lockfileHash) {
    throw new Error('release_dependency_tree_lockfile_hash_mismatch');
  }
  const actual = captureReleaseDependencyTree(nodeModulesPath, {
    readOnlyProjection: readOnly === true,
  });
  const expected = readOnly ? contract.readOnlyTree : contract.sourceTree;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('release_dependency_tree_mismatch');
  }
  return Object.freeze({
    version: 1,
    kind: 'ReleaseDependencyTreeInspection',
    status: 'release_dependency_tree_verified',
    contractHash: claimedHash,
    lockfileHash,
    tree: actual,
    readOnly: readOnly === true,
  });
}
