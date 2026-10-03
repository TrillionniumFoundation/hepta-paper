// Content-only observation of the one repository-owned historical R route.
// It cannot qualify the external gitlink HEAD, a runtime, or package execution.
import fs from 'node:fs';
import path from 'node:path';

const ROUTE = 'docs/rust/qualification/r-source-route.v1.json';
const TARGET = 'runtime-images/r-scientific/source-cas';

function routeFromCommittedFile(root, selected, owners) {
  const pin = selected.get(ROUTE);
  if (!pin || pin.mode !== '100644') owners.fail('public_r_profile_missing');
  const route = JSON.parse(owners.readPinnedSource(root, ROUTE, pin));
  const historical = route.publicHistoricalRoute, bounds = route.contentObservation;
  if (route.schemaVersion !== 1 || route.kind !== 'HeptaRSourceRouteV1'
      || route.repository !== 'TrillionniumFoundation/hepta-paper' || route.targetPath !== TARGET
      || !historical || historical.repository !== route.repository || historical.path !== TARGET
      || ![historical.commit, historical.subtree, historical.manifestBlob, route.originalGitlink?.commit]
        .every(value => /^[0-9a-f]{40}$/u.test(value))
      || historical.fileCount !== 107 || historical.packageCount !== 104
      || !bounds || !Number.isSafeInteger(bounds.maximumFileBytes) || bounds.maximumFileBytes < 1
      || bounds.maximumFileBytes > 16 * 1024 * 1024
      || !Number.isSafeInteger(bounds.maximumTotalBytes) || bounds.maximumTotalBytes < 1
      || bounds.maximumTotalBytes > 128 * 1024 * 1024
      || bounds.gitlinkCommitQualified !== false || bounds.productionAuthorized !== false
      || bounds.packageExecutionAllowed !== false || route.originalGitlink.verified !== false
      || route.originalGitlink.equivalenceClaimed !== false
      || !route.authority || Object.keys(route.authority).sort().join(',')
        !== 'externalAuthorityClaimed,originalGitlinkVerified,productionAuthorized,sourceContentVerified'
      || Object.values(route.authority).some(value => value !== false)) {
    owners.fail('public_r_profile_scope');
  }
  if (owners.git(root, ['rev-parse', `${historical.commit}:${historical.path}`]) !== historical.subtree) {
    owners.fail('public_r_historical_tree_mismatch');
  }
  owners.git(root, ['fsck', '--strict', '--no-reflogs', '--no-dangling', historical.subtree]);
  return route;
}

function originalMembers(root, route, owners) {
  const output = owners.git(root, ['ls-tree', '-r', '-l', '-z', '--full-tree', route.publicHistoricalRoute.subtree]);
  if (!output.endsWith('\0')) owners.fail('public_r_tree_invalid');
  const rows = output.slice(0, -1).split('\0'), members = new Map();
  if (rows.length !== route.publicHistoricalRoute.fileCount) owners.fail('public_r_count_mismatch');
  let total = 0;
  for (const row of rows) {
    const match = /^100644 blob ([0-9a-f]{40}) +([0-9]+)\t([A-Za-z0-9_.\-/]+)$/u.exec(row);
    if (!match || match[3].split('/').some(value => !value || value === '.' || value === '..')
        || members.has(match[3])) owners.fail('public_r_member_invalid');
    const size = Number(match[2]);
    total += size;
    if (!Number.isSafeInteger(size) || size > route.contentObservation.maximumFileBytes
        || total > route.contentObservation.maximumTotalBytes) owners.fail('public_r_byte_limit');
    members.set(match[3], { mode: '100644', blob: match[1], size });
  }
  if (members.get('manifest.json')?.blob !== route.publicHistoricalRoute.manifestBlob) {
    owners.fail('public_r_manifest_mismatch');
  }
  return { members, total };
}

function inventory(root, members, owners) {
  const directory = path.join(root, TARGET), directories = new Set(['']);
  for (const relative of members.keys()) {
    let parent = path.posix.dirname(relative);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  const pending = [''], seen = new Set(), pins = [];
  while (pending.length) {
    const parent = pending.pop(), named = path.join(directory, parent);
    const stat = fs.lstatSync(named, { bigint: true });
    if (!stat.isDirectory() || (stat.mode & 0o7777n) !== 0o755n || fs.realpathSync(named) !== named) {
      owners.fail('public_r_directory_invalid', parent);
    }
    pins.push([named, stat]);
    for (const name of fs.readdirSync(named).sort()) {
      const relative = parent ? `${parent}/${name}` : name, file = path.join(directory, relative);
      const info = fs.lstatSync(file, { bigint: true });
      if (info.isDirectory() && directories.has(relative)) pending.push(relative);
      else {
        const expected = members.get(relative);
        if (!expected || !info.isFile() || info.nlink !== 1n || info.size !== BigInt(expected.size)
            || (info.mode & 0o7777n) !== 0o644n || seen.has(relative)) owners.fail('public_r_inventory_invalid', relative);
        seen.add(relative); pins.push([file, info]);
      }
    }
  }
  if (seen.size !== members.size || pins.filter(([, value]) => value.isDirectory()).length !== directories.size) {
    owners.fail('public_r_inventory_incomplete');
  }
  return pins;
}

export function observePublicRSourceContent(root, relative, expected, selected, owners) {
  if (relative !== TARGET) return null;
  const leaf = path.join(root, relative);
  try {
    if (fs.lstatSync(leaf).isDirectory() && !fs.readdirSync(leaf).length) return null;
  } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  const route = routeFromCommittedFile(root, selected, owners);
  if (route.originalGitlink.commit !== expected.blob) owners.fail('public_r_gitlink_reference_mismatch');
  const { members, total } = originalMembers(root, route, owners);
  const before = inventory(root, members, owners);
  const batch = owners.readPinnedSourceBatch(root, [...members].map(([name, pin]) => [`${relative}/${name}`, pin]));
  const fields = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
  const assertCurrent = () => {
    const after = inventory(root, members, owners);
    if (after.length !== before.length || after.some(([named, stat], index) => named !== before[index][0]
        || fields.some(key => stat[key] !== before[index][1][key]))) owners.fail('source_subject_changed', relative);
    owners.assertSourceBatchInputsCurrent([batch]);
  };
  assertCurrent();
  const physicalInputs = before.map(([named, stat]) => ({
    path: path.relative(root, named),
    ...Object.fromEntries(fields.map(key => [key, String(stat[key])])),
    ...(stat.isFile() ? { blob: members.get(path.relative(leaf, named).split(path.sep).join('/')).blob } : {}),
  }));
  return { assertCurrent, close() {}, value: { version: 1, kind: 'PublicHistoricalRSourceContent',
    path: relative, gitlinkReference: expected.blob, sourceTree: route.publicHistoricalRoute.subtree,
    manifestBlob: route.publicHistoricalRoute.manifestBlob, fileCount: members.size, totalBytes: total,
    routeBlob: selected.get(ROUTE).blob, physicalInputs, physicalAfterMatched: true,
    gitlinkCommitQualified: false, productionAuthorized: false, packageExecutionAllowed: false } };
}
