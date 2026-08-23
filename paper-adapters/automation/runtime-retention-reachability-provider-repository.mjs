import fs from 'node:fs';
import path from 'node:path';
import { assertRuntimeRetentionReachabilityProvider } from '../../paper-ports/runtime-retention-reachability-provider-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin, sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import { packageLifecycleDeclaration } from './runtime-retention-package-lifecycle-authority.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from './package-recovery-tree-inventory-repository.mjs';
import {
  assertDetachedRetentionRemovalSourceSync,
} from './runtime-retention-removal-recovery-repository.mjs';
import {
  inspectFencedCampaignReleasePackageTransactionsSync,
} from './campaign-release-package-fenced-transaction-inventory.mjs';
import { verifyWorkspaceRetentionEvidence } from './workspace-retention-evidence.mjs';
import {
  REACHABILITY_GOVERNED_RETENTION_CATEGORIES,
  buildRuntimeRetentionReachabilityManifest,
  listRuntimeRetentionEntries,
  runtimeRetentionCategoryRoot,
  safeRetentionNodeKey,
} from './runtime-retention-scope-repository.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CAS_MANIFEST_NAME = /^[a-f0-9]{64}\.json$/;
const CAS_OBJECT_PATH = /^objects\/sha256\/([a-f0-9]{2})\/([a-f0-9]{62})$/;
const TERMINAL_CAMPAIGN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_NODE_STATUSES = new Set(['completed', 'skipped', 'failed_terminal']);
const EVIDENCE_KIND = Object.freeze({
  'workspace-snapshots': 'workspace_snapshot_superseded_recovery_verified',
  'automation-artifacts': 'artifact_unreachable_complete_inventory',
  packages: 'package_superseded_recovery_verified',
  'artifact-cas': 'cas_prefix_unreachable_complete_inventory',
});

function stableHash(kind, value) {
  return hashRecord(kind, value);
}

function exactJsonFile(candidate) {
  const value = readRegularJsonFileSync(candidate);
  if (!value) throw new Error('runtime_retention_authority_json_invalid');
  return value;
}

function ensureAuthorityRoot(runtimeRoot, authorityRoot, { create = false } = {}) {
  const root = path.resolve(runtimeRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('runtime_retention_authority_runtime_root_unsafe');
  }
  const rootReal = fs.realpathSync.native(root);
  let current = root;
  for (const component of path.relative(root, authorityRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) {
      if (!create) throw new Error('runtime_retention_authority_root_missing');
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || !pathWithin(rootReal, fs.realpathSync.native(current))) {
      throw new Error('runtime_retention_authority_root_unsafe');
    }
  }
}

function immutableJson(candidate, value) {
  const destination = path.resolve(candidate);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('runtime_retention_authority_root_unsafe');
  }
  if (fs.existsSync(destination)) {
    if (JSON.stringify(exactJsonFile(destination)) !== JSON.stringify(value)) {
      throw new Error('runtime_retention_authority_manifest_collision');
    }
    return;
  }
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${process.pid}-${Date.now()}`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try { fs.linkSync(temporary, destination); } catch (error) {
      if (error.code !== 'EEXIST'
        || JSON.stringify(exactJsonFile(destination)) !== JSON.stringify(value)) throw error;
    }
    fsyncDirectorySync(parent);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function manifestHashValid(manifest, runtimeRoot) {
  const { runtimeRetentionReachabilityManifestHash = null, ...payload } = manifest || {};
  return manifest?.version === 1
    && manifest.kind === 'RuntimeRetentionReachabilityManifest'
    && path.resolve(String(manifest.runtimeRoot || '')) === path.resolve(runtimeRoot)
    && Array.isArray(manifest.categories)
    && hashRecord('RuntimeRetentionReachabilityManifest', payload) === runtimeRetentionReachabilityManifestHash;
}

function listAllCampaigns(campaignStore) {
  if (typeof campaignStore?.listCampaigns !== 'function') throw new Error('campaign_inventory_port_unavailable');
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = campaignStore.listCampaigns({ limit: 1000, offset, effectiveOnly: false });
    if (!Array.isArray(page)) throw new Error('campaign_inventory_page_invalid');
    rows.push(...page);
    if (page.length < 1000) break;
    if (offset >= 9_999_000) throw new Error('campaign_inventory_bound_exceeded');
  }
  return rows.map((campaign) => Object.freeze({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    status: campaign.status,
    effectiveStatus: campaign.effectiveStatus,
    parentCampaignId: campaign.parentCampaignId || null,
    supersedesCampaignId: campaign.supersedesCampaignId || null,
    recoveryOfCampaignId: campaign.recoveryOfCampaignId || null,
    campaignPlanHash: campaign.spec?.campaignPlanHash || null,
    revision: Number(campaign.revision || 0),
    updatedAt: campaign.updatedAt || null,
  })).sort((left, right) => left.campaignId.localeCompare(right.campaignId));
}

function stableCampaignInventory(campaignStore) {
  if (typeof campaignStore?.listNodes !== 'function') throw new Error('campaign_node_inventory_port_unavailable');
  const scan = () => {
    const rows = listAllCampaigns(campaignStore);
    const nodes = rows.flatMap((campaign) => campaignStore.listNodes(campaign.campaignId).map((node) => Object.freeze({
      campaignId: campaign.campaignId,
      nodeId: node.nodeId,
      kind: node.kind,
      status: node.status,
      attemptId: node.attemptId || null,
      leaseGeneration: Number(node.leaseGeneration || 0),
      resultSha256: node.resultSha256 || null,
      failureSha256: node.failureSha256 || null,
      updatedAt: node.updatedAt || null,
    }))).sort((left, right) => `${left.campaignId}\0${left.nodeId}`.localeCompare(`${right.campaignId}\0${right.nodeId}`));
    return Object.freeze({ rows, nodes });
  };
  const first = scan();
  const second = scan();
  const firstHash = stableHash('RuntimeRetentionCampaignInventory', first);
  if (firstHash !== stableHash('RuntimeRetentionCampaignInventory', second)) {
    throw new Error('campaign_inventory_changed_during_scan');
  }
  return Object.freeze({ ...first, hash: firstHash });
}

function currentReleaseInventory(campaigns, campaignReleaseQuery) {
  if (typeof campaignReleaseQuery?.getCurrentRelease !== 'function') {
    throw new Error('campaign_release_query_port_unavailable');
  }
  const scan = () => campaigns.map((campaign) => {
    const release = campaignReleaseQuery.getCurrentRelease({ campaignId: campaign.campaignId });
    if (!release) return null;
    return Object.freeze({
      campaignId: release.campaignId,
      paperId: release.paperId,
      campaignPlanHash: release.campaignPlanHash,
      packageNodeId: release.packageNodeId,
      packageResultHash: release.packageResultHash,
      campaignReleaseBundleHash: release.campaignReleaseBundleHash,
      materializationReceiptHash: release.materializationReceiptHash,
      packagePath: release.packagePath || release.releaseBundle?.packageOutput?.packageDir || null,
      immutableCampaignPackageOutputHash: release.immutableCampaignPackageOutputHash
        || release.releaseBundle?.immutableCampaignPackageOutputHash
        || release.releaseBundle?.packageOutput?.immutableCampaignPackageOutputHash
        || null,
      packageNodeStatus: release.packageNodeStatus || null,
      campaignStatus: release.campaignStatus || null,
      status: release.status,
      promotedAt: release.promotedAt,
    });
  }).filter(Boolean).sort((left, right) => left.campaignId.localeCompare(right.campaignId));
  const first = scan();
  const second = scan();
  const firstHash = stableHash('RuntimeRetentionCurrentReleaseInventory', first);
  if (firstHash !== stableHash('RuntimeRetentionCurrentReleaseInventory', second)) {
    throw new Error('campaign_release_inventory_changed_during_scan');
  }
  return Object.freeze({ rows: first, hash: firstHash });
}

function artifactDeclaration({ entries, campaigns, releases }) {
  const campaignByKey = new Map(campaigns.rows.map((campaign) => [safeRetentionNodeKey(campaign.campaignId), campaign]));
  const releaseByCampaign = new Map(releases.rows.map((release) => [release.campaignId, release]));
  const successorRelease = new Map();
  const nodesByCampaign = new Map();
  for (const node of campaigns.nodes) {
    if (!nodesByCampaign.has(node.campaignId)) nodesByCampaign.set(node.campaignId, []);
    nodesByCampaign.get(node.campaignId).push(node);
  }
  for (const successor of campaigns.rows) {
    const replaced = successor.supersedesCampaignId || successor.recoveryOfCampaignId;
    if (replaced && releaseByCampaign.has(successor.campaignId)) successorRelease.set(replaced, successor);
  }
  const declaration = {
    inventoryComplete: true,
    activePaths: [],
    referencedPaths: [],
    releaseDependentPaths: [],
    recoveryProtectedPaths: [],
    deletionEvidence: [],
  };
  for (const entry of entries) {
    const campaign = campaignByKey.get(entry.name);
    if (!campaign) declaration.referencedPaths.push(entry.path);
    else if (!TERMINAL_CAMPAIGN_STATUSES.has(campaign.status)
      || (nodesByCampaign.get(campaign.campaignId) || []).some((node) => !TERMINAL_NODE_STATUSES.has(node.status))) {
      declaration.activePaths.push(entry.path);
    }
    else if (releaseByCampaign.has(campaign.campaignId)) declaration.releaseDependentPaths.push(entry.path);
    else if (campaign.effectiveStatus === 'superseded' && successorRelease.has(campaign.campaignId)) {
      const successor = successorRelease.get(campaign.campaignId);
      const release = releaseByCampaign.get(successor.campaignId);
      declaration.deletionEvidence.push({
        path: entry.path,
        contentHash: entry.contentHash,
        evidenceKind: EVIDENCE_KIND['automation-artifacts'],
        sourceEvidenceHashes: [
          campaigns.hash,
          releases.hash,
          stableHash('RuntimeRetentionSupersededCampaign', campaign),
          stableHash('RuntimeRetentionSuccessorRelease', { successor, release }),
        ],
      });
    } else declaration.recoveryProtectedPaths.push(entry.path);
  }
  return declaration;
}

function normalizedSnapshotRecord(row) {
  return Object.freeze({
    snapshotId: row.snapshotId || row.snapshot_id,
    workspaceId: row.workspaceId || row.workspace_id,
    manifestHash: row.manifestHash || row.manifest_sha256,
    manifestPath: row.manifestPath || row.manifest_path,
    archivePath: row.archivePath || row.archive_path,
    archiveHash: row.archiveHash || row.archive_sha256,
    externalContentHash: row.externalContentHash || row.external_content_sha256,
    exportReceiptHash: row.exportReceiptHash || row.export_receipt_sha256,
    restoreReceiptHash: row.restoreReceiptHash || row.restore_receipt_sha256,
    restoreReceiptJson: row.restoreReceiptJson || row.restore_receipt_json,
    restoreLedgerReceiptId: row.restoreLedgerReceiptId || row.restore_ledger_receipt_id,
    status: row.status,
    createdAt: row.createdAt || row.created_at,
  });
}

function stableSnapshotInventory(workspaceRegistry) {
  if (typeof workspaceRegistry?.snapshotRetentionRecords !== 'function') {
    throw new Error('workspace_snapshot_inventory_port_unavailable');
  }
  const scan = () => workspaceRegistry.snapshotRetentionRecords().map(normalizedSnapshotRecord)
    .sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
  const first = scan();
  const second = scan();
  const firstHash = stableHash('RuntimeRetentionWorkspaceSnapshotInventory', first);
  if (firstHash !== stableHash('RuntimeRetentionWorkspaceSnapshotInventory', second)) {
    throw new Error('workspace_snapshot_inventory_changed_during_scan');
  }
  return Object.freeze({ rows: first, hash: firstHash });
}

function snapshotDeclaration({ entries, snapshots, receiptLedger }) {
  const verified = snapshots.rows.map((row) => ({
    row,
    verification: verifyWorkspaceRetentionEvidence({
      workspace_id: row.workspaceId,
      manifest_sha256: row.manifestHash,
      manifest_path: row.manifestPath,
      archive_path: row.archivePath,
      archive_sha256: row.archiveHash,
      external_content_sha256: row.externalContentHash,
      export_receipt_sha256: row.exportReceiptHash,
      restore_receipt_sha256: row.restoreReceiptHash,
      restore_receipt_json: row.restoreReceiptJson,
      restore_ledger_receipt_id: row.restoreLedgerReceiptId,
    }, receiptLedger),
  }));
  const newestVerified = new Map();
  for (const candidate of verified.filter((item) => item.verification.verified)) {
    const previous = newestVerified.get(candidate.row.workspaceId);
    if (!previous || `${candidate.row.createdAt}\0${candidate.row.snapshotId}`
      > `${previous.row.createdAt}\0${previous.row.snapshotId}`) newestVerified.set(candidate.row.workspaceId, candidate);
  }
  const byArchive = new Map();
  for (const candidate of verified) {
    const key = path.resolve(String(candidate.row.archivePath || ''));
    if (!byArchive.has(key)) byArchive.set(key, []);
    byArchive.get(key).push(candidate);
  }
  const declaration = {
    inventoryComplete: true,
    activePaths: [],
    referencedPaths: [],
    releaseDependentPaths: [],
    recoveryProtectedPaths: [],
    deletionEvidence: [],
  };
  for (const entry of entries) {
    const matches = byArchive.get(path.resolve(entry.path)) || [];
    const candidate = matches.length === 1 ? matches[0] : null;
    const exactCompanion = candidate && entry.companionPaths.length === 1
      && path.resolve(entry.companionPaths[0]) === path.resolve(String(candidate.row.manifestPath || ''));
    const newest = candidate && newestVerified.get(candidate.row.workspaceId);
    if (!candidate || !exactCompanion) declaration.referencedPaths.push(entry.path);
    else if (!candidate.verification.verified || !newest) declaration.recoveryProtectedPaths.push(entry.path);
    else if (newest.row.snapshotId === candidate.row.snapshotId) declaration.recoveryProtectedPaths.push(entry.path);
    else declaration.deletionEvidence.push({
      path: entry.path,
      contentHash: entry.contentHash,
      evidenceKind: EVIDENCE_KIND['workspace-snapshots'],
      sourceEvidenceHashes: [
        snapshots.hash,
        candidate.verification.workspaceRetentionEvidenceHash,
        newest.verification.workspaceRetentionEvidenceHash,
      ],
    });
  }
  return declaration;
}

function stableDirectoryNames(directory) {
  if (!fs.existsSync(directory)) return [];
  const before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('cas_manifest_root_unsafe');
  const names = fs.readdirSync(directory).sort();
  const after = fs.lstatSync(directory, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
    || JSON.stringify(names) !== JSON.stringify(fs.readdirSync(directory).sort())) {
    throw new Error('cas_manifest_inventory_changed_during_scan');
  }
  return names;
}

function casManifestInventory(runtimeRoot) {
  const casRoot = path.join(path.resolve(runtimeRoot), 'artifact-cas');
  const manifestRoot = path.join(casRoot, 'manifests');
  if (fs.existsSync(casRoot)) {
    const runtimeReal = fs.realpathSync.native(path.resolve(runtimeRoot));
    const casStat = fs.lstatSync(casRoot);
    if (!casStat.isDirectory() || casStat.isSymbolicLink()
      || !pathWithin(runtimeReal, fs.realpathSync.native(casRoot))) throw new Error('cas_root_unsafe');
  }
  const rows = [];
  for (const name of stableDirectoryNames(manifestRoot)) {
    if (!CAS_MANIFEST_NAME.test(name)) throw new Error('cas_manifest_name_invalid');
    const candidate = path.join(manifestRoot, name);
    const manifest = exactJsonFile(candidate);
    const { manifestHash = null, ...payload } = manifest;
    const objectMatch = CAS_OBJECT_PATH.exec(String(manifest.objectPath || ''));
    if (!manifestHash || manifestHash !== `sha256:${name.slice(0, -5)}`
      || hashRecord('ImmutableArtifactManifest', payload) !== manifestHash
      || !SHA256.test(String(manifest.contentHash || ''))
      || !objectMatch
      || `${objectMatch[1]}${objectMatch[2]}` !== manifest.contentHash.slice(7)) {
      throw new Error('cas_manifest_binding_invalid');
    }
    const objectPath = path.join(casRoot, ...manifest.objectPath.split('/'));
    const stat = fs.lstatSync(objectPath);
    if (!stat.isFile() || stat.isSymbolicLink()
      || !pathWithin(fs.realpathSync.native(casRoot), fs.realpathSync.native(objectPath))
      || sha256FileSync(objectPath) !== manifest.contentHash) {
      throw new Error('cas_manifest_object_invalid');
    }
    rows.push(Object.freeze({
      name,
      fileHash: sha256FileSync(candidate),
      manifestHash,
      contentHash: manifest.contentHash,
      logicalPath: manifest.logicalPath || null,
      prefix: objectMatch[1],
    }));
  }
  if (JSON.stringify(stableDirectoryNames(manifestRoot)) !== JSON.stringify(rows.map((row) => row.name))) {
    throw new Error('cas_manifest_inventory_changed_during_scan');
  }
  return Object.freeze({ rows, hash: stableHash('RuntimeRetentionCasManifestInventory', rows) });
}

function casDeclaration({ entries, inventory }) {
  const referencedPrefixes = new Set(inventory.rows.map((row) => row.prefix));
  const declaration = {
    inventoryComplete: true,
    activePaths: [],
    referencedPaths: [],
    releaseDependentPaths: [],
    recoveryProtectedPaths: [],
    deletionEvidence: [],
  };
  for (const entry of entries) {
    if (!/^[a-f0-9]{2}$/.test(entry.name)) declaration.recoveryProtectedPaths.push(entry.path);
    else if (referencedPrefixes.has(entry.name)) declaration.referencedPaths.push(entry.path);
    else declaration.deletionEvidence.push({
      path: entry.path,
      contentHash: entry.contentHash,
      evidenceKind: EVIDENCE_KIND['artifact-cas'],
      sourceEvidenceHashes: [inventory.hash, entry.contentHash],
    });
  }
  return declaration;
}

function envelopeFor({ runtimeRoot, manifest, authoritySnapshot }) {
  const payload = {
    version: 1,
    kind: 'RuntimeRetentionReachabilityAuthorityEnvelope',
    runtimeRoot: path.resolve(runtimeRoot),
    manifest,
    authoritySnapshot,
  };
  return Object.freeze({
    ...payload,
    runtimeRetentionReachabilityAuthorityEnvelopeHash: hashRecord(
      'RuntimeRetentionReachabilityAuthorityEnvelope',
      payload,
    ),
  });
}

function withDetachedRetentionRevalidationEntries(
  runtimeRoot,
  inventories,
  detachedEntries,
) {
  if (!Array.isArray(detachedEntries)) {
    throw new Error('runtime_retention_detached_revalidation_invalid');
  }
  const updated = { ...inventories };
  for (const detached of detachedEntries) {
    const category = String(detached?.category || '');
    const candidate = path.resolve(String(detached?.path || ''));
    const binding = detached?.recoveryBinding;
    const categoryRoot = runtimeRetentionCategoryRoot(runtimeRoot, category);
    if (!REACHABILITY_GOVERNED_RETENTION_CATEGORIES.includes(category)
      || path.dirname(candidate) !== categoryRoot
      || detached?.name !== path.basename(candidate)
      || !SHA256.test(String(detached?.contentHash || ''))
      || !Array.isArray(detached?.companionPaths)
      || detached.companionPaths.length !== 0
      || typeof detached?.sourcePath !== 'string'
      || !path.isAbsolute(detached.sourcePath)
      || binding?.sourcePath !== candidate
      || binding?.category !== category
      || binding?.contentHash !== detached.contentHash
      || detached.identity?.realPath !== candidate) {
      throw new Error('runtime_retention_detached_revalidation_invalid');
    }
    const detachedWitness = assertDetachedRetentionRemovalSourceSync({
      binding: detached.recoveryBinding,
      candidate: detached.sourcePath,
      expectedIdentity: detached.identity,
      stageCapability: detached.recoveryStageCapability,
    });
    if ((detached.sourceTreeIdentityHash ?? null)
      !== detachedWitness.mutationMarker.sourceTreeIdentityHash
      || (detachedWitness.rollbackWitness
        && detachedWitness.mutationMarker.sourceTreeIdentityHash === null)) {
      throw new Error('runtime_retention_detached_revalidation_invalid');
    }
    const inventory = updated[category];
    if (!inventory || inventory.blocker) {
      throw new Error('runtime_retention_detached_revalidation_invalid');
    }
    const byPath = new Map(inventory.entries.map((entry) => [path.resolve(entry.path), entry]));
    const existing = byPath.get(candidate);
    if (existing) {
      throw new Error('runtime_retention_detached_revalidation_conflict');
    }
    const packageRecoveryTreeInventoryHash =
      inspectPackageRecoveryTreeInventorySync({
        packagePath: detachedWitness.rollbackWitness
          ? detached.sourcePath
          : path.join(path.dirname(detached.sourcePath), 'rollback'),
      }).inventory.packageRecoveryTreeInventoryHash;
    if (detached.packageRecoveryTreeInventoryHash !== null
      && detached.packageRecoveryTreeInventoryHash !== undefined
      && (!SHA256.test(String(detached.packageRecoveryTreeInventoryHash))
        || detached.packageRecoveryTreeInventoryHash
          !== packageRecoveryTreeInventoryHash)) {
      throw new Error('runtime_retention_detached_revalidation_invalid');
    }
    byPath.set(candidate, Object.freeze({
      path: candidate,
      name: detached.name,
      contentHash: detached.contentHash,
      packageRecoveryTreeInventoryHash,
      companionPaths: Object.freeze([]),
      symbolicLink: false,
    }));
    updated[category] = Object.freeze({
      ...inventory,
      entries: Object.freeze([...byPath.values()].sort((left, right) =>
        left.path.localeCompare(right.path))),
    });
  }
  return updated;
}

export function createLedgerBackedRuntimeRetentionReachabilityProvider({
  runtimeRoot,
  campaignStore,
  campaignReleaseQuery,
  workspaceRegistry,
  receiptLedger,
  packageRecoveryAuthority = null,
  clock = { nowIso: () => new Date().toISOString() },
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const authorityRoot = path.join(root, 'retention-authority', 'manifests');
  const createManifest = (options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.hasOwn(options, 'detachedPackageEntries')) {
      throw new Error('runtime_retention_detached_package_revalidation_invalid');
    }
    const {
      activeNodeIds = [],
      persist = false,
      createdAt: canonicalCreatedAt = null,
      detachedRetentionEntries = [],
    } = options;
    const createdAt = canonicalCreatedAt || clock.nowIso();
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new Error('runtime_retention_authority_created_at_invalid');
    }
    if (!Array.isArray(detachedRetentionEntries)) {
      throw new Error('runtime_retention_detached_package_revalidation_invalid');
    }
    const categories = {};
    const sourceBindings = {};
    const blockers = [];
    let entries = Object.fromEntries(REACHABILITY_GOVERNED_RETENTION_CATEGORIES.map((category) => [
      category,
      listRuntimeRetentionEntries(root, category),
    ]));
    if (detachedRetentionEntries.length) {
      if (persist || canonicalCreatedAt === null) {
        throw new Error('runtime_retention_detached_package_revalidation_invalid');
      }
    }
    if (detachedRetentionEntries.length) {
      entries = withDetachedRetentionRevalidationEntries(
        root,
        entries,
        detachedRetentionEntries,
      );
    }
    for (const [category, inventory] of Object.entries(entries)) {
      if (inventory.blocker) blockers.push(`${category}:${inventory.blocker}`);
    }
    let campaigns = null;
    let releases = null;
    let cas = null;
    try {
      campaigns = stableCampaignInventory(campaignStore);
      releases = currentReleaseInventory(campaigns.rows, campaignReleaseQuery);
      sourceBindings.campaignInventoryHash = campaigns.hash;
      sourceBindings.currentReleaseInventoryHash = releases.hash;
      if (!entries['automation-artifacts'].blocker) categories['automation-artifacts'] = artifactDeclaration({
        entries: entries['automation-artifacts'].entries,
        campaigns,
        releases,
      });
    } catch (error) { blockers.push(`campaign_release_authority:${String(error?.message || error)}`); }
    try {
      const snapshots = stableSnapshotInventory(workspaceRegistry);
      sourceBindings.workspaceSnapshotInventoryHash = snapshots.hash;
      if (!entries['workspace-snapshots'].blocker) categories['workspace-snapshots'] = snapshotDeclaration({
        entries: entries['workspace-snapshots'].entries,
        snapshots,
        receiptLedger,
      });
    } catch (error) { blockers.push(`workspace_snapshot_authority:${String(error?.message || error)}`); }
    try {
      cas = casManifestInventory(root);
      sourceBindings.casManifestInventoryHash = cas.hash;
      if (!entries['artifact-cas'].blocker) categories['artifact-cas'] = casDeclaration({
        entries: entries['artifact-cas'].entries,
        inventory: cas,
      });
    } catch (error) { blockers.push(`cas_authority:${String(error?.message || error)}`); }
    if (campaigns && releases && !entries.packages.blocker) {
      try {
        const fencedTransactions =
          inspectFencedCampaignReleasePackageTransactionsSync({
            runtimeRoot: root,
            detachedStagingEntries: detachedRetentionEntries
              .filter((entry) => entry.category === 'packages'),
          });
        sourceBindings.fencedPackageTransactionInventoryHash =
          fencedTransactions.hash;
        const packages = packageLifecycleDeclaration({
          runtimeRoot: root,
          entries: entries.packages.entries,
          campaigns,
          releases,
          receiptLedger,
          casInventory: cas,
          activeNodeIds,
          fencedTransactions,
          packageRecoveryAuthority,
          now: clock.nowIso(),
        });
        categories.packages = packages.declaration;
        if (packages.authority.ledgerInventoryHash) {
          sourceBindings.packageLifecycleLedgerInventoryHash =
            packages.authority.ledgerInventoryHash;
        }
        if (packages.authority.recoveryAuthoritySnapshotHashes?.length) {
          sourceBindings.packageRecoveryAuthoritySnapshotHashes =
            packages.authority.recoveryAuthoritySnapshotHashes;
        }
        if (packages.authority.recoverySourceInventoryHashes?.length) {
          sourceBindings.packageRecoverySourceInventoryHashes =
            packages.authority.recoverySourceInventoryHashes;
        }
        blockers.push(...packages.authority.blockers.map((blocker) =>
          `package_lifecycle_authority:${blocker}`));
      } catch (error) {
        blockers.push(`package_lifecycle_authority:${String(error?.message || error)}`);
      }
    }
    const authorityPayload = {
      version: 1,
      kind: 'RuntimeRetentionReachabilityAuthoritySnapshot',
      runtimeRoot: root,
      activeNodeIds: [...new Set(activeNodeIds.map(String))].sort(),
      sourceBindings,
      completeCategories: Object.keys(categories).sort(),
      blockers: [...new Set(blockers)].sort(),
      createdAt,
    };
    const authoritySnapshot = Object.freeze({
      ...authorityPayload,
      runtimeRetentionReachabilityAuthoritySnapshotHash: hashRecord(
        'RuntimeRetentionReachabilityAuthoritySnapshot',
        authorityPayload,
      ),
    });
    for (const declaration of Object.values(categories)) {
      for (const evidence of declaration.deletionEvidence) {
        evidence.sourceEvidenceHashes = [...new Set([
          authoritySnapshot.runtimeRetentionReachabilityAuthoritySnapshotHash,
          ...evidence.sourceEvidenceHashes,
        ])].sort();
      }
    }
    const manifest = buildRuntimeRetentionReachabilityManifest({ runtimeRoot: root, categories, createdAt });
    if (persist) {
      const envelope = envelopeFor({ runtimeRoot: root, manifest, authoritySnapshot });
      const digest = manifest.runtimeRetentionReachabilityManifestHash.slice(7);
      ensureAuthorityRoot(root, authorityRoot, { create: true });
      immutableJson(path.join(authorityRoot, `${digest}.json`), envelope);
    }
    return manifest;
  };
  const loadManifest = ({ manifestHash } = {}) => {
    if (!SHA256.test(String(manifestHash || ''))) return null;
    let envelope = null;
    try {
      ensureAuthorityRoot(root, authorityRoot);
      envelope = readRegularJsonFileSync(path.join(authorityRoot, `${manifestHash.slice(7)}.json`));
    } catch { return null; }
    const { runtimeRetentionReachabilityAuthorityEnvelopeHash = null, ...envelopePayload } = envelope || {};
    const snapshot = envelope?.authoritySnapshot;
    const { runtimeRetentionReachabilityAuthoritySnapshotHash = null, ...snapshotPayload } = snapshot || {};
    if (!envelope
      || envelope.version !== 1
      || envelope.kind !== 'RuntimeRetentionReachabilityAuthorityEnvelope'
      || path.resolve(String(envelope.runtimeRoot || '')) !== root
      || hashRecord('RuntimeRetentionReachabilityAuthorityEnvelope', envelopePayload)
        !== runtimeRetentionReachabilityAuthorityEnvelopeHash
      || snapshot?.version !== 1
      || snapshot.kind !== 'RuntimeRetentionReachabilityAuthoritySnapshot'
      || hashRecord('RuntimeRetentionReachabilityAuthoritySnapshot', snapshotPayload)
        !== runtimeRetentionReachabilityAuthoritySnapshotHash
      || envelope.manifest?.runtimeRetentionReachabilityManifestHash !== manifestHash
      || !manifestHashValid(envelope.manifest, root)) return null;
    return envelope.manifest;
  };
  return assertRuntimeRetentionReachabilityProvider(Object.freeze({
    version: 1,
    kind: 'RuntimeRetentionReachabilityProvider',
    createManifest,
    loadManifest,
  }));
}
