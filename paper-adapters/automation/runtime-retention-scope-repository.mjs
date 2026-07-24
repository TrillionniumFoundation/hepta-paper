import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin, sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

export const DEFAULT_RETENTION_POLICIES = Object.freeze({
  'automation-workspaces': Object.freeze({ maxBytes: 1024 ** 3, maxAgeMs: 7 * 86400000, keepNewest: 0 }),
  'automation-cache': Object.freeze({ maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000, keepNewest: 10 }),
  'workspace-snapshots': Object.freeze({ maxBytes: 512 * 1024 ** 2, maxAgeMs: 30 * 86400000, keepNewest: 2 }),
  'automation-artifacts': Object.freeze({ maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000, keepNewest: 2 }),
  packages: Object.freeze({ maxBytes: 2 * 1024 ** 3, maxAgeMs: 90 * 86400000, keepNewest: 2 }),
  'artifact-cas': Object.freeze({ maxBytes: 4 * 1024 ** 3, maxAgeMs: 30 * 86400000, keepNewest: 0 }),
  reports: Object.freeze({ maxBytes: 64 * 1024 ** 2, maxAgeMs: 30 * 86400000, keepNewest: 12 }),
  backups: Object.freeze({ maxBytes: 96 * 1024 ** 2, maxAgeMs: 30 * 86400000, keepNewest: 8, minimumRecoverableGenerations: 2 }),
});

export const REACHABILITY_GOVERNED_RETENTION_CATEGORIES = Object.freeze([
  'workspace-snapshots',
  'automation-artifacts',
  'packages',
  'artifact-cas',
]);

const REACHABILITY_GOVERNED = new Set(REACHABILITY_GOVERNED_RETENTION_CATEGORIES);
const CATEGORY_RELATIVE_ROOTS = Object.freeze({
  'artifact-cas': path.join('artifact-cas', 'objects', 'sha256'),
});
const ALLOWED_DELETION_EVIDENCE = Object.freeze({
  'workspace-snapshots': 'workspace_snapshot_superseded_recovery_verified',
  'automation-artifacts': 'artifact_unreachable_complete_inventory',
  packages: 'package_superseded_recovery_verified',
  'artifact-cas': 'cas_prefix_unreachable_complete_inventory',
});
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function runtimeRetentionCategoryRoot(runtimeRoot, category) {
  return path.resolve(runtimeRoot, CATEGORY_RELATIVE_ROOTS[category] || category);
}

export function safeRetentionNodeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function governedEntryPath(runtimeRoot, category, value) {
  if (!REACHABILITY_GOVERNED.has(category)) throw new Error('runtime_retention_reachability_category_invalid');
  const categoryRoot = runtimeRetentionCategoryRoot(runtimeRoot, category);
  const resolved = path.resolve(String(value || ''));
  if (path.dirname(resolved) !== categoryRoot || path.basename(resolved) === '.' || path.basename(resolved) === '..') {
    throw new Error('runtime_retention_reachability_path_invalid');
  }
  return resolved;
}

function normalizedPathList(runtimeRoot, category, values = []) {
  if (!Array.isArray(values)) throw new Error('runtime_retention_reachability_path_list_invalid');
  return [...new Set(values.map((value) => governedEntryPath(runtimeRoot, category, value)))].sort();
}

function deletionEvidence(runtimeRoot, category, value = {}) {
  const pathValue = governedEntryPath(runtimeRoot, category, value.path);
  const sourceEvidenceHashes = [...new Set(value.sourceEvidenceHashes || [])].sort();
  if (value.evidenceKind !== ALLOWED_DELETION_EVIDENCE[category]) {
    throw new Error('runtime_retention_deletion_evidence_kind_invalid');
  }
  if (!SHA256_PATTERN.test(String(value.contentHash || ''))
    || !sourceEvidenceHashes.length
    || sourceEvidenceHashes.some((hash) => !SHA256_PATTERN.test(String(hash)))) {
    throw new Error('runtime_retention_deletion_evidence_binding_invalid');
  }
  const payload = {
    version: 1,
    kind: 'RuntimeRetentionDeletionEvidence',
    status: 'retention_deletion_authorized',
    category,
    path: pathValue,
    contentHash: value.contentHash,
    evidenceKind: value.evidenceKind,
    active: false,
    referenced: false,
    releaseDependent: false,
    recoveryProtected: false,
    sourceEvidenceHashes,
  };
  return Object.freeze({
    ...payload,
    runtimeRetentionDeletionEvidenceHash: hashRecord('RuntimeRetentionDeletionEvidence', payload),
  });
}

export function buildRuntimeRetentionReachabilityManifest({
  runtimeRoot,
  categories = {},
  createdAt = new Date().toISOString(),
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('runtime_retention_reachability_created_at_invalid');
  const declarations = Object.entries(categories).map(([category, declaration]) => {
    if (!REACHABILITY_GOVERNED.has(category) || declaration?.inventoryComplete !== true) {
      throw new Error('runtime_retention_reachability_inventory_incomplete');
    }
    const normalized = {
      category,
      inventoryComplete: true,
      activePaths: normalizedPathList(root, category, declaration.activePaths),
      referencedPaths: normalizedPathList(root, category, declaration.referencedPaths),
      releaseDependentPaths: normalizedPathList(root, category, declaration.releaseDependentPaths),
      recoveryProtectedPaths: normalizedPathList(root, category, declaration.recoveryProtectedPaths),
      deletionEvidence: (declaration.deletionEvidence || [])
        .map((entry) => deletionEvidence(root, category, entry))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    const protectedPaths = new Set([
      ...normalized.activePaths,
      ...normalized.referencedPaths,
      ...normalized.releaseDependentPaths,
      ...normalized.recoveryProtectedPaths,
    ]);
    if (normalized.deletionEvidence.some((entry) => protectedPaths.has(entry.path))) {
      throw new Error('runtime_retention_deletion_evidence_conflicts_with_liveness');
    }
    return Object.freeze(normalized);
  }).sort((left, right) => left.category.localeCompare(right.category));
  const payload = {
    version: 1,
    kind: 'RuntimeRetentionReachabilityManifest',
    runtimeRoot: root,
    categories: declarations,
    createdAt,
  };
  return Object.freeze({
    ...payload,
    runtimeRetentionReachabilityManifestHash: hashRecord('RuntimeRetentionReachabilityManifest', payload),
  });
}

export function verifyRuntimeRetentionDeletionEvidence({
  runtimeRoot,
  category,
  entryPath,
  contentHash,
  reachabilityManifest,
} = {}) {
  const blockers = [];
  const manifestHash = reachabilityManifest?.runtimeRetentionReachabilityManifestHash || null;
  const { runtimeRetentionReachabilityManifestHash: _hash, ...manifestPayload } = reachabilityManifest || {};
  const manifestCategories = Array.isArray(reachabilityManifest?.categories)
    ? reachabilityManifest.categories
    : [];
  const categoryNames = manifestCategories.map((entry) => entry?.category);
  const manifestShapeValid = manifestCategories.every((entry) => {
    if (!REACHABILITY_GOVERNED.has(entry?.category) || entry.inventoryComplete !== true) return false;
    try {
      return ['activePaths', 'referencedPaths', 'releaseDependentPaths', 'recoveryProtectedPaths']
        .every((field) => JSON.stringify(normalizedPathList(runtimeRoot, entry.category, entry[field]))
          === JSON.stringify(entry[field]));
    } catch {
      return false;
    }
  }) && new Set(categoryNames).size === categoryNames.length;
  if (!reachabilityManifest
    || reachabilityManifest.version !== 1
    || reachabilityManifest.kind !== 'RuntimeRetentionReachabilityManifest'
    || path.resolve(String(reachabilityManifest.runtimeRoot || '')) !== path.resolve(runtimeRoot || '.')
    || !Number.isFinite(Date.parse(reachabilityManifest.createdAt || ''))
    || !manifestShapeValid
    || hashRecord('RuntimeRetentionReachabilityManifest', manifestPayload) !== manifestHash) {
    blockers.push('retention_reachability_manifest_invalid_or_missing');
  }
  const declaration = reachabilityManifest?.categories?.find((entry) => entry?.category === category) || null;
  if (!declaration || declaration.inventoryComplete !== true) blockers.push('retention_reachability_inventory_incomplete');
  let normalizedPath = null;
  try { normalizedPath = governedEntryPath(runtimeRoot, category, entryPath); } catch { blockers.push('retention_reachability_path_invalid'); }
  const protectedBindings = [
    ['activePaths', 'retention_entry_active'],
    ['referencedPaths', 'retention_entry_referenced'],
    ['releaseDependentPaths', 'retention_entry_release_dependent'],
    ['recoveryProtectedPaths', 'retention_entry_recovery_protected'],
  ];
  for (const [field, blocker] of protectedBindings) {
    if (!Array.isArray(declaration?.[field])) blockers.push('retention_reachability_manifest_invalid_or_missing');
    else if (normalizedPath && declaration[field].includes(normalizedPath)) blockers.push(blocker);
  }
  if (!Array.isArray(declaration?.deletionEvidence)) blockers.push('retention_reachability_manifest_invalid_or_missing');
  const evidence = Array.isArray(declaration?.deletionEvidence)
    ? declaration.deletionEvidence.find((entry) => entry?.path === normalizedPath) || null
    : null;
  if (!evidence) blockers.push('retention_deletion_evidence_missing');
  else {
    const { runtimeRetentionDeletionEvidenceHash = null, ...payload } = evidence;
    if (evidence.version !== 1
      || evidence.kind !== 'RuntimeRetentionDeletionEvidence'
      || evidence.status !== 'retention_deletion_authorized'
      || evidence.category !== category
      || evidence.contentHash !== contentHash
      || evidence.evidenceKind !== ALLOWED_DELETION_EVIDENCE[category]
      || evidence.active !== false
      || evidence.referenced !== false
      || evidence.releaseDependent !== false
      || evidence.recoveryProtected !== false
      || !Array.isArray(evidence.sourceEvidenceHashes)
      || !evidence.sourceEvidenceHashes.length
      || evidence.sourceEvidenceHashes.some((hash) => !SHA256_PATTERN.test(String(hash)))
      || hashRecord('RuntimeRetentionDeletionEvidence', payload) !== runtimeRetentionDeletionEvidenceHash) {
      blockers.push('retention_deletion_evidence_invalid');
    }
  }
  const uniqueBlockers = [...new Set(blockers)];
  return Object.freeze({
    authorized: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    evidence,
    reachabilityManifestHash: manifestHash,
  });
}

function directoryIdentity(stat, realPath) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    realPath: path.resolve(realPath),
  });
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && path.resolve(String(left.realPath || '')) === path.resolve(String(right.realPath || '')));
}

function openPinnedDirectory(candidate) {
  const resolved = path.resolve(candidate);
  const before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('runtime_retention_scope_not_regular_directory');
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) {
      throw new Error('runtime_retention_scope_identity_changed');
    }
    const descriptorPath = `/proc/self/fd/${descriptor}`;
    if (!fs.existsSync(descriptorPath)) throw new Error('runtime_retention_descriptor_root_unavailable');
    const realPath = fs.realpathSync.native(descriptorPath);
    if (fs.realpathSync.native(resolved) !== realPath) throw new Error('runtime_retention_scope_realpath_changed');
    return { descriptor, descriptorPath, identity: directoryIdentity(opened, realPath) };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function openPinnedRetentionCategory(runtimeRoot, category, expectedScope = null) {
  const runtime = openPinnedDirectory(runtimeRoot);
  let categoryRoot = null;
  try {
    const relativeRoot = CATEGORY_RELATIVE_ROOTS[category] || category;
    let componentPath = runtime.descriptorPath;
    for (const component of relativeRoot.split(path.sep).filter(Boolean)) {
      componentPath = path.join(componentPath, component);
      const componentStat = fs.lstatSync(componentPath);
      if (!componentStat.isDirectory() || componentStat.isSymbolicLink()) {
        throw new Error('runtime_retention_scope_not_regular_directory');
      }
    }
    const categoryPath = path.join(runtime.descriptorPath, relativeRoot);
    categoryRoot = openPinnedDirectory(categoryPath);
    if (!pathWithin(runtime.identity.realPath, categoryRoot.identity.realPath)) throw new Error('runtime_retention_category_outside_root');
    const scope = Object.freeze({ runtimeRoot: runtime.identity, categoryRoot: categoryRoot.identity });
    if (expectedScope
      && (!sameDirectoryIdentity(scope.runtimeRoot, expectedScope.runtimeRoot)
        || !sameDirectoryIdentity(scope.categoryRoot, expectedScope.categoryRoot))) {
      throw new Error('runtime_retention_scope_identity_changed');
    }
    return {
      scope,
      categoryDescriptor: categoryRoot.descriptor,
      categoryDescriptorPath: categoryRoot.descriptorPath,
      close() {
        fs.closeSync(categoryRoot.descriptor);
        fs.closeSync(runtime.descriptor);
      },
    };
  } catch (error) {
    if (categoryRoot) fs.closeSync(categoryRoot.descriptor);
    fs.closeSync(runtime.descriptor);
    throw error;
  }
}

function entryBytes(candidate) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return fs.readdirSync(candidate).reduce((total, name) => total + entryBytes(path.join(candidate, name)), stat.size);
}

export function retentionMemberHash(candidate) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) return hashRecord('RuntimeRetentionSymlink', { target: fs.readlinkSync(candidate) });
  if (stat.isFile()) return sha256FileSync(candidate);
  const rows = fs.readdirSync(candidate).sort().map((name) => ({ name, hash: retentionMemberHash(path.join(candidate, name)) }));
  return hashRecord('RuntimeRetentionDirectory', rows);
}

export function retentionMemberIdentity(candidate) {
  const resolved = path.resolve(candidate);
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('runtime_retention_member_identity_unsafe');
  }
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    nlink: String(stat.nlink),
    realPath: fs.realpathSync.native(resolved),
    entryKind: stat.isDirectory() ? 'directory' : 'file',
  });
}

export function retentionEntryHash(entry) {
  if (!entry.companionPaths?.length) return retentionMemberHash(entry.path);
  return hashRecord('RuntimeRetentionEntryGroup', [entry.path, ...entry.companionPaths].map((candidate) => ({
    name: path.basename(candidate),
    hash: retentionMemberHash(candidate),
  })));
}

export function listRuntimeRetentionEntries(root, category) {
  const categoryRoot = runtimeRetentionCategoryRoot(root, category);
  if (!fs.existsSync(categoryRoot)) return Object.freeze({ entries: [], scope: null, blocker: null });
  let pinned = null;
  try { pinned = openPinnedRetentionCategory(root, category); } catch (error) {
    return Object.freeze({ entries: [], scope: null, blocker: String(error?.message || error) });
  }
  try {
    const allNames = fs.readdirSync(pinned.categoryDescriptorPath);
    const names = allNames
      .filter((name) => category !== 'workspace-snapshots'
        || !name.endsWith('.manifest.json')
        || !allNames.includes(`${name.slice(0, -'.manifest.json'.length)}.tar.gz`));
    const entries = names
      .filter((name) => category !== 'backups' || !/\.sqlite(?:\.restore-drill)?\.receipt\.json$/.test(name))
      .map((name) => {
        const candidate = path.join(categoryRoot, name);
        const pinnedCandidate = path.join(pinned.categoryDescriptorPath, name);
        const stat = fs.lstatSync(pinnedCandidate);
        const possibleCompanions = category === 'backups' && name.endsWith('.sqlite')
          ? [`${candidate}.receipt.json`, `${candidate}.restore-drill.receipt.json`]
          : category === 'workspace-snapshots' && name.endsWith('.tar.gz')
            ? [`${candidate.slice(0, -'.tar.gz'.length)}.manifest.json`]
            : [];
        const companionPaths = possibleCompanions.filter((companionPath) => fs.existsSync(path.join(pinned.categoryDescriptorPath, path.basename(companionPath))));
        const companionPinnedPaths = companionPaths.map((item) => path.join(pinned.categoryDescriptorPath, path.basename(item)));
        const companionStats = companionPinnedPaths.map((item) => fs.lstatSync(item));
        return {
          name,
          path: candidate,
          companionPaths,
          bytes: entryBytes(pinnedCandidate) + companionPinnedPaths.reduce((total, item) => total + entryBytes(item), 0),
          modifiedAtMs: Math.max(stat.mtimeMs, ...companionStats.map((item) => item.mtimeMs)),
          symbolicLink: stat.isSymbolicLink() || companionStats.some((item) => item.isSymbolicLink()),
          contentHash: retentionEntryHash({ path: pinnedCandidate, companionPaths: companionPinnedPaths }),
          categoryScope: pinned.scope,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name));
    return Object.freeze({ entries, scope: pinned.scope, blocker: null });
  } finally {
    pinned.close();
  }
}

export function retentionMemberPaths(entry) {
  return [entry.path, ...(entry.companionPaths || [])].map((candidate) => path.resolve(candidate));
}

export function pinnedRetentionMemberPath(pinned, runtimeRoot, category, candidate) {
  const categoryRoot = runtimeRetentionCategoryRoot(runtimeRoot, category);
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== categoryRoot || path.basename(resolved) === '.' || path.basename(resolved) === '..') {
    throw new Error('retention_entry_scope_invalid');
  }
  return path.join(pinned.categoryDescriptorPath, path.basename(resolved));
}

export function retentionRemovalMembers(entry, pinned, runtimeRoot) {
  return retentionMemberPaths(entry).map((candidate) => {
    const descriptorPath = pinnedRetentionMemberPath(pinned, runtimeRoot, entry.category, candidate);
    return {
      path: candidate,
      contentHash: fs.existsSync(descriptorPath) ? retentionMemberHash(descriptorPath) : null,
      identity: fs.existsSync(descriptorPath) ? retentionMemberIdentity(descriptorPath) : null,
    };
  });
}

export function retentionPathExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}
