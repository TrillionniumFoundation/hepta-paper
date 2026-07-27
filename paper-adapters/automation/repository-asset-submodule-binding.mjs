import fs from 'node:fs';
import path from 'node:path';

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

function readSubmoduleHead(sourceRoot) {
  const marker = path.join(sourceRoot, '.git');
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
  const resolved = fs.readFileSync(path.join(gitDirectory, symbolic[1]), 'utf8').trim();
  if (!GIT_COMMIT.test(resolved)) throw new Error('repository_asset_submodule_head_invalid');
  return resolved;
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
    if (!binding || binding.url !== reference.repositoryUrl
      || readSubmoduleHead(path.resolve(repositoryRoot, sourcePath))
        !== reference.pinnedCommit) {
      return ['repository_asset_submodule_binding_mismatch'];
    }
  } catch (error) {
    return [String(error?.message || 'repository_asset_submodule_binding_unreadable')];
  }
  return [];
}
