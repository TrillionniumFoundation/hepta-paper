#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(workspaceRoot, 'paper-core', 'docs', 'history', 'architecture-p1p2-review-groups-2026-07-14.json');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function git(args, { binary = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: binary ? null : 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(String(result.stderr || result.error?.message || `git ${args.join(' ')} failed`).trim());
  }
  return result;
}

function parseStatus(buffer) {
  const records = buffer.toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const xy = record.slice(0, 2);
    const candidate = record.slice(3);
    if (/[RC]/.test(xy)) {
      entries.push({ xy, path: candidate, renameSource: records[index + 1] || null });
      index += 1;
    } else {
      entries.push({ xy, path: candidate, renameSource: null });
    }
  }
  return entries;
}

function normalizedStatus(entry) {
  if (entry.xy === '??') return 'U';
  if (entry.xy[0] !== ' ') return 'STAGED';
  if (entry.xy[1] === 'M') return 'M';
  if (entry.xy[1] === 'D') return 'D';
  return `UNSUPPORTED:${entry.xy}`;
}

function contentHash(entry, baseCommit) {
  if (entry.disposition === 'review_metadata') return null;
  if (entry.status === 'D') {
    return sha256(git(['show', `${baseCommit}:${entry.path}`], { binary: true }).stdout);
  }
  return sha256(fs.readFileSync(path.join(workspaceRoot, entry.path)));
}

function snapshotHash(entries) {
  const rows = entries
    .map(({ path: entryPath, status, contentHash: hash, group, disposition, pairId = null }) => ({
      path: entryPath,
      status,
      contentHash: hash,
      group,
      disposition,
      pairId,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(JSON.stringify(rows));
}

function deniedPath(candidate) {
  const normalized = candidate.replaceAll('\\', '/');
  const base = path.posix.basename(normalized).toLowerCase();
  return normalized.startsWith('runtime/')
    || normalized.startsWith('node_modules/')
    || normalized.startsWith('core/reports/')
    || normalized.includes('/.lake/')
    || base === '.env'
    || base.startsWith('.env.')
    || /\.(?:sqlite|sqlite-wal|sqlite-shm|pem|key|log)$/i.test(base);
}

function groupDependencyCycles(groups) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(id, trail = []) {
    if (visiting.has(id)) {
      cycles.push([...trail.slice(trail.indexOf(id)), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn || []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const group of groups) visit(group.id);
  return cycles;
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const blockers = [];
const currentHead = git(['rev-parse', 'HEAD']).stdout.trim();
if (currentHead !== manifest.baseCommit) blockers.push(`base_commit_drift:${currentHead}`);

const rawStatus = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { binary: true }).stdout;
const actualEntries = parseStatus(rawStatus);
const staged = actualEntries.filter((entry) => entry.xy !== '??' && entry.xy[0] !== ' ');
if (staged.length) blockers.push(`index_not_clean:${staged.map((entry) => entry.path).join(',')}`);
if (actualEntries.some((entry) => entry.renameSource)) blockers.push('porcelain_rename_requires_manifest_refresh');

const manifestPaths = new Set();
for (const entry of manifest.entries) {
  if (manifestPaths.has(entry.path)) blockers.push(`duplicate_manifest_path:${entry.path}`);
  manifestPaths.add(entry.path);
}
const actualByPath = new Map(actualEntries.map((entry) => [entry.path, entry]));
for (const entry of manifest.entries) {
  const actual = actualByPath.get(entry.path);
  if (!actual) {
    blockers.push(`missing_dirty_path:${entry.path}`);
    continue;
  }
  const status = normalizedStatus(actual);
  if (status !== entry.status) blockers.push(`status_drift:${entry.path}:${entry.status}:${status}`);
  if (status === entry.status && entry.disposition !== 'review_metadata') {
    const actualHash = contentHash(entry, manifest.baseCommit);
    if (actualHash !== entry.contentHash) blockers.push(`content_drift:${entry.path}`);
  }
}
for (const actual of actualEntries) {
  if (!manifestPaths.has(actual.path)) blockers.push(`unclassified_dirty_path:${actual.path}`);
  if (deniedPath(actual.path)) blockers.push(`denied_dirty_path:${actual.path}`);
}
if (manifest.entries.length !== manifest.expectedStatusFileCount) {
  blockers.push(`manifest_entry_count_drift:${manifest.expectedStatusFileCount}:${manifest.entries.length}`);
}
const reviewMetadataCount = manifest.entries.filter((entry) => entry.disposition === 'review_metadata').length;
if (manifest.entries.length - reviewMetadataCount !== manifest.sourceStatusFileCount) {
  blockers.push(`source_status_file_count_drift:${manifest.sourceStatusFileCount}:${manifest.entries.length - reviewMetadataCount}`);
}

const groupIds = new Set(manifest.groups.map((group) => group.id));
for (const entry of manifest.entries) {
  if (!groupIds.has(entry.group)) blockers.push(`unknown_group:${entry.path}:${entry.group}`);
}
for (const group of manifest.groups) {
  const count = manifest.entries.filter((entry) => entry.group === group.id).length;
  if (count !== group.expectedEntryCount) blockers.push(`group_count_drift:${group.id}:${group.expectedEntryCount}:${count}`);
  for (const dependency of group.dependsOn) {
    if (!groupIds.has(dependency)) blockers.push(`unknown_group_dependency:${group.id}:${dependency}`);
  }
}
for (const cycle of groupDependencyCycles(manifest.groups)) blockers.push(`group_dependency_cycle:${cycle.join('>')}`);

const pairs = new Map();
for (const entry of manifest.entries.filter((candidate) => candidate.pairId)) {
  if (!pairs.has(entry.pairId)) pairs.set(entry.pairId, []);
  pairs.get(entry.pairId).push(entry);
}
for (const [pairId, entries] of pairs) {
  if (entries.length !== 2) {
    blockers.push(`move_pair_cardinality:${pairId}:${entries.length}`);
    continue;
  }
  if (new Set(entries.map((entry) => entry.group)).size !== 1) blockers.push(`move_pair_crosses_groups:${pairId}`);
  if (entries.filter((entry) => entry.status === 'D').length !== 1 || entries.filter((entry) => entry.status === 'U').length !== 1) {
    blockers.push(`move_pair_status_invalid:${pairId}`);
  }
}
for (const pair of manifest.movePairs) {
  const entries = pairs.get(pair.id) || [];
  if (entries.length !== 2) continue;
  const from = entries.find((entry) => entry.path === pair.from);
  const to = entries.find((entry) => entry.path === pair.to);
  if (!from || !to) blockers.push(`move_pair_path_mismatch:${pair.id}`);
  if (pair.exactBytes && from?.contentHash !== to?.contentHash) blockers.push(`exact_move_content_mismatch:${pair.id}`);
}

for (const atomicSet of manifest.atomicSets) {
  const entries = atomicSet.paths.map((entryPath) => manifest.entries.find((entry) => entry.path === entryPath));
  if (entries.some((entry) => !entry)) {
    blockers.push(`atomic_set_path_missing:${atomicSet.id}`);
    continue;
  }
  if (atomicSet.sameGroup && new Set(entries.map((entry) => entry.group)).size !== 1) blockers.push(`atomic_set_crosses_groups:${atomicSet.id}`);
}
for (const required of manifest.wholeFileIntegrationPaths) {
  if (!manifestPaths.has(required)) blockers.push(`whole_file_integration_path_missing:${required}`);
}

const computedSnapshotHash = snapshotHash(manifest.entries);
if (computedSnapshotHash !== manifest.snapshotSha256) blockers.push(`snapshot_hash_invalid:${computedSnapshotHash}`);
if (actualEntries.length !== manifest.expectedStatusFileCount) {
  blockers.push(`status_file_count_drift:${manifest.expectedStatusFileCount}:${actualEntries.length}`);
}

const stagedPaths = git(['diff', '--cached', '--name-only', '-z'], { binary: true }).stdout.toString('utf8').split('\0').filter(Boolean);
for (const stagedPath of stagedPaths) {
  if (deniedPath(stagedPath)) blockers.push(`denied_staged_path:${stagedPath}`);
}

for (const candidate of manifest.ignoredSentinels) {
  const result = git(['check-ignore', '--quiet', '--', candidate], { allowFailure: true });
  if (result.status !== 0) blockers.push(`ignored_sentinel_not_ignored:${candidate}`);
}

let productionStoreSha256 = null;
const productionStore = path.join(workspaceRoot, manifest.productionStore.path);
if (fs.existsSync(productionStore)) {
  productionStoreSha256 = sha256(fs.readFileSync(productionStore));
  if (productionStoreSha256 !== manifest.productionStore.sha256) blockers.push(`production_store_hash_drift:${productionStoreSha256}`);
}

const details = process.argv.includes('--details');
const report = {
  ok: blockers.length === 0,
  kind: 'ArchitectureP1P2ReviewGroupCheckpoint',
  baseCommit: currentHead,
  expectedStatusFileCount: manifest.expectedStatusFileCount,
  actualStatusFileCount: actualEntries.length,
  snapshotSha256: computedSnapshotHash,
  indexClean: staged.length === 0,
  productionStoreSha256,
  ignoredSentinelsVerified: manifest.ignoredSentinels.length,
  groups: manifest.groups.map((group) => ({
    id: group.id,
    title: group.title,
    dependsOn: group.dependsOn,
    entryCount: manifest.entries.filter((entry) => entry.group === group.id).length,
    paths: details ? manifest.entries.filter((entry) => entry.group === group.id).map((entry) => entry.path) : undefined,
  })),
  wholeFileIntegrationPaths: manifest.wholeFileIntegrationPaths,
  blockers,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
