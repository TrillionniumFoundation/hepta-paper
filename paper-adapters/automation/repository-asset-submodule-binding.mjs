import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_COMMIT = /^[0-9a-f]{40,64}$/;
const SUBMODULE_TRANSPORTS = new Set(['git-submodule', 'git-lfs-submodule']);

function readSubmoduleBindings(repositoryRoot) {
  const bindings = new Map();
  let current = null;
  for (const rawLine of fs.readFileSync(path.join(repositoryRoot, '.gitmodules'), 'utf8')
    .split(/\r?\n/)) {
    const section = rawLine.match(/^\s*\[submodule "([^"]+)"\]\s*$/);
    if (section) {
      current = { name: section[1], path: null, url: null };
      bindings.set(current.name, current);
      continue;
    }
    const property = rawLine.match(/^\s*(path|url)\s*=\s*(\S+)\s*$/);
    if (current && property) current[property[1]] = property[2];
  }
  return bindings;
}

function boundedGitEnvironment() {
  const environment = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ]) delete environment[key];
  return environment;
}

function readParentGitlink(repositoryRoot, sourcePath, gitExecutor = spawnSync) {
  if (!sourcePath || /[\0\r\n\t]/.test(sourcePath)) {
    throw new Error('repository_asset_submodule_path_invalid');
  }
  const result = gitExecutor(
    'git',
    ['-c', 'core.quotepath=false', '-C', repositoryRoot, 'ls-tree', '-z', 'HEAD', '--', sourcePath],
    {
      encoding: 'utf8',
      env: boundedGitEnvironment(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result?.error || result?.status !== 0) {
    throw new Error('repository_asset_parent_gitlink_unreadable');
  }
  const records = String(result.stdout || '').split('\0').filter(Boolean);
  if (records.length !== 1) {
    throw new Error('repository_asset_parent_gitlink_invalid');
  }
  const match = records[0].match(/^160000 commit ([0-9a-f]{40,64})\t(.+)$/);
  if (!match || match[2] !== sourcePath) {
    throw new Error('repository_asset_parent_gitlink_invalid');
  }
  return match[1];
}

function readMaterializedSubmoduleHead(sourceRoot) {
  const marker = path.join(sourceRoot, '.git');
  if (!fs.existsSync(marker)) return null;
  const markerStat = fs.lstatSync(marker);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error('repository_asset_submodule_git_marker_invalid');
  }
  const match = fs.readFileSync(marker, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
  if (!match) throw new Error('repository_asset_submodule_git_marker_invalid');
  const gitDirectory = path.resolve(sourceRoot, match[1]);
  const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
  if (GIT_COMMIT.test(head)) return head;
  const symbolic = head.match(/^ref:\s*(.+)$/);
  if (!symbolic) throw new Error('repository_asset_submodule_head_invalid');
  const looseRef = path.join(gitDirectory, symbolic[1]);
  if (fs.existsSync(looseRef)) {
    const resolved = fs.readFileSync(looseRef, 'utf8').trim();
    if (!GIT_COMMIT.test(resolved)) {
      throw new Error('repository_asset_submodule_head_invalid');
    }
    return resolved;
  }
  const packedRefs = path.join(gitDirectory, 'packed-refs');
  if (!fs.existsSync(packedRefs)) {
    throw new Error('repository_asset_submodule_head_unresolved');
  }
  for (const line of fs.readFileSync(packedRefs, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const packed = line.match(/^([0-9a-f]{40,64}) (\S+)$/);
    if (packed?.[2] === symbolic[1]) return packed[1];
  }
  throw new Error('repository_asset_submodule_head_unresolved');
}

export function inspectRepositoryAssetSubmoduleBinding(
  repositoryRoot,
  sourcePath,
  asset,
) {
  const reference = asset?.externalReference;
  if (!reference?.transport) return [];
  if (!SUBMODULE_TRANSPORTS.has(reference.transport)) {
    return ['repository_asset_external_transport_invalid'];
  }
  if (!GIT_COMMIT.test(String(reference.pinnedCommit || ''))
    || typeof reference.repositoryUrl !== 'string'
    || !reference.repositoryUrl.trim()
    || reference.location !== `${reference.repositoryUrl}#${reference.pinnedCommit}`
    || reference.digest !== asset.expectedIdentitySha256) {
    return ['repository_asset_submodule_reference_invalid'];
  }
  try {
    const binding = [...readSubmoduleBindings(repositoryRoot).values()]
      .find((candidate) => candidate.path === sourcePath);
    const parentCommit = readParentGitlink(repositoryRoot, sourcePath);
    const materializedCommit = readMaterializedSubmoduleHead(
      path.resolve(repositoryRoot, sourcePath),
    );
    if (!binding || binding.url !== reference.repositoryUrl
      || parentCommit !== reference.pinnedCommit
      || (materializedCommit && materializedCommit !== reference.pinnedCommit)) {
      return ['repository_asset_submodule_binding_mismatch'];
    }
  } catch (error) {
    return [String(error?.message || 'repository_asset_submodule_binding_unreadable')];
  }
  return [];
}
