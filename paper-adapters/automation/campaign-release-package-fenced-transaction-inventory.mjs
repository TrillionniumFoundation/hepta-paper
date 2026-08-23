import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  assertExactBuildingMarkerSync,
  readCampaignReleasePackageBuildingFenceSync,
  readCampaignReleasePackageBuildingTransactionSync,
} from './campaign-release-package-build-transaction-repository.mjs';
import {
  CAMPAIGN_RELEASE_PACKAGE_GENERATION_LOCK_NAME,
  readCampaignReleasePackagePreparedTransactionSync,
} from './campaign-release-package-transaction-repository.mjs';
import {
  retentionMemberHash,
  retentionMemberIdentity,
} from './runtime-retention-scope-repository.mjs';
import {
  assertDetachedRetentionRemovalSourceSync,
} from './runtime-retention-removal-recovery-repository.mjs';

function treeIdentity(candidate, root = candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
    || (stat.isFile() && stat.nlink !== 1n)) {
    throw new Error('campaign_release_package_transaction_inventory_unsafe');
  }
  return Object.freeze({
    relativePath: path.relative(root, candidate).replace(/\\/g, '/'),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    nlink: String(stat.nlink),
    entryKind: stat.isDirectory() ? 'directory' : 'file',
    entries: stat.isDirectory() ? Object.freeze(fs.readdirSync(candidate)
      .sort().map((name) => treeIdentity(path.join(candidate, name), root))) : null,
  });
}

function treeIdentityHash(candidate) {
  return hashRecord(
    'CampaignReleasePackageFencedStagingTreeIdentity',
    treeIdentity(candidate),
  );
}

function stagingIdentityHash(candidate, contentHash, identity, treeHash) {
  return hashRecord('CampaignReleasePackageFencedStagingIdentity', {
    path: path.resolve(candidate),
    contentHash,
    identity,
    treeIdentityHash: treeHash,
  });
}

const STABLE_IDENTITY_FIELDS = Object.freeze([
  'dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink', 'entryKind',
]);

function inspectStagingEntry(runtimeRoot, transaction, candidate, detached = null) {
  const logicalExists = fs.existsSync(candidate);
  if (!logicalExists && !detached) return null;
  const source = logicalExists ? candidate : path.resolve(String(detached?.sourcePath || ''));
  const recoveryRoot = path.join(path.resolve(runtimeRoot), 'retention', 'removal-recovery');
  if (!logicalExists && (path.resolve(String(detached?.path || '')) !== candidate
    || !path.isAbsolute(source)
    || !fs.existsSync(source)
    || !pathWithin(fs.realpathSync.native(recoveryRoot), fs.realpathSync.native(source)))) {
    throw new Error('campaign_release_package_transaction_inventory_unsafe');
  }
  const detachedWitness = !logicalExists
    ? assertDetachedRetentionRemovalSourceSync({
      binding: detached?.recoveryBinding,
      candidate: source,
      expectedIdentity: detached?.identity,
      stageCapability: detached?.recoveryStageCapability,
    })
    : null;
  if (!logicalExists && (detached?.recoveryBinding?.category !== 'packages'
    || detached.recoveryBinding.sourcePath !== candidate
    || detached.recoveryBinding.contentHash !== detached.contentHash
    || (detached.sourceTreeIdentityHash ?? null)
      !== detachedWitness.mutationMarker.sourceTreeIdentityHash)) {
    throw new Error('campaign_release_package_transaction_inventory_unsafe');
  }
  const before = fs.lstatSync(source, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()
    || ![transaction.preparedParent, transaction.abortedParent].includes(candidate)) {
    throw new Error('campaign_release_package_transaction_inventory_unsafe');
  }
  const beforeTreeIdentityHash = treeIdentityHash(source);
  const marker = assertExactBuildingMarkerSync({
    runtimeRoot,
    parent: source,
    record: transaction.record,
  });
  const contentHash = retentionMemberHash(source);
  const physicalIdentity = retentionMemberIdentity(source);
  const rollbackWitness = detachedWitness?.rollbackWitness === true;
  const identity = logicalExists ? physicalIdentity : Object.freeze({
    ...(rollbackWitness ? detached.identity : physicalIdentity),
    realPath: candidate,
  });
  const expectedIdentity = detached?.identity || null;
  if (!logicalExists && (contentHash !== detached.contentHash
    || !expectedIdentity
    || (!rollbackWitness && STABLE_IDENTITY_FIELDS.some((field) =>
      String(identity[field]) !== String(expectedIdentity[field])))
    || path.resolve(String(expectedIdentity.realPath || '')) !== candidate)) {
    throw new Error('campaign_release_package_transaction_inventory_changed');
  }
  const physicalAfterTreeIdentityHash = treeIdentityHash(source);
  const afterTreeIdentityHash = rollbackWitness
    ? String(detached.sourceTreeIdentityHash || '')
    : physicalAfterTreeIdentityHash;
  const after = fs.lstatSync(source, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
    || before.mtimeNs !== after.mtimeNs
    || beforeTreeIdentityHash !== physicalAfterTreeIdentityHash
    || (rollbackWitness && !/^sha256:[a-f0-9]{64}$/.test(afterTreeIdentityHash))) {
    throw new Error('campaign_release_package_transaction_inventory_changed');
  }
  return Object.freeze({
    path: candidate,
    contentHash,
    identity,
    campaignReleasePackageFencedStagingTreeIdentityHash:
      afterTreeIdentityHash,
    campaignReleasePackageFencedStagingIdentityHash:
      stagingIdentityHash(candidate, contentHash, identity, afterTreeIdentityHash),
    campaignReleasePackageBuildingMarkerHash:
      marker.campaignReleasePackageBuildingMarkerHash,
  });
}

function stableDirectoryNames(directory, { allowGenerationLock = false } = {}) {
  if (!fs.existsSync(directory)) return [];
  const before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('campaign_release_package_transaction_inventory_unsafe');
  }
  const read = () => fs.readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (allowGenerationLock
        && entry.name === CAMPAIGN_RELEASE_PACKAGE_GENERATION_LOCK_NAME) {
        const lock = fs.lstatSync(path.join(directory, entry.name), { bigint: true });
        const owner = typeof process.geteuid === 'function' ? process.geteuid() : null;
        if (!entry.isFile() || entry.isSymbolicLink()
          || !lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1n
          || (lock.mode & 0o7777n) !== 0o600n || lock.size !== 0n
          || (owner !== null && Number(lock.uid) !== owner)) {
          throw new Error('campaign_release_package_transaction_inventory_unsafe');
        }
        return null;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || entry.name === '.' || entry.name === '..'
        || entry.name.includes('/') || entry.name.includes('\0')) {
        throw new Error('campaign_release_package_transaction_inventory_unsafe');
      }
      return entry.name;
    }).filter(Boolean).sort();
  const names = read();
  const after = fs.lstatSync(directory, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeNs !== after.mtimeNs
    || JSON.stringify(names) !== JSON.stringify(read())) {
    throw new Error('campaign_release_package_transaction_inventory_changed');
  }
  return names;
}

function releaseRoots(runtimeRoot) {
  const releaseBase = path.join(path.resolve(runtimeRoot), 'campaign-releases');
  const roots = [];
  for (const campaign of stableDirectoryNames(releaseBase)) {
    const campaignRoot = path.join(releaseBase, campaign);
    for (const node of stableDirectoryNames(campaignRoot)) {
      const nodeRoot = path.join(campaignRoot, node);
      for (const attempt of stableDirectoryNames(nodeRoot, {
        allowGenerationLock: true,
      })) {
        roots.push(path.join(nodeRoot, attempt));
      }
    }
  }
  return roots.sort();
}

function scanFencedTransactions(runtimeRoot, detachedStagingEntries = []) {
  const detachedByPath = new Map(detachedStagingEntries.map((entry) => [
    path.resolve(String(entry?.path || '')),
    entry,
  ]));
  const rows = [];
  for (const releaseRoot of releaseRoots(runtimeRoot)) {
    const transaction = readCampaignReleasePackageBuildingTransactionSync({
      runtimeRoot,
      releaseRoot,
    });
    if (!transaction) continue;
    const fence = readCampaignReleasePackageBuildingFenceSync({
      runtimeRoot,
      transaction,
    });
    if (!fence) continue;
    const prepared = readCampaignReleasePackagePreparedTransactionSync({
      runtimeRoot,
      releaseRoot,
    });
    if (prepared && (prepared.publishedPackageDir !== transaction.packageDir
      || prepared.record.campaignReleaseBundleHash
        !== prepared.record.bundle?.campaignReleaseBundleHash)) {
      throw new Error('campaign_release_package_transaction_inventory_invalid');
    }
    rows.push(Object.freeze({
      campaignId: transaction.record.campaignId,
      packageNodeId: transaction.record.packageNodeId,
      packageAttemptId: transaction.record.packageAttemptId,
      leaseGeneration: transaction.record.leaseGeneration,
      releaseRoot: transaction.record.releaseRoot,
      packageDir: transaction.packageDir,
      preparedParent: transaction.preparedParent,
      abortedParent: transaction.abortedParent,
      campaignReleasePackageBuildingTransactionHash: transaction.record
        .campaignReleasePackageBuildingTransactionHash,
      campaignReleasePackageBuildingFenceHash: fence
        .campaignReleasePackageBuildingFenceHash,
      supersedingPackageAttemptId: fence.supersedingPackageAttemptId,
      supersedingLeaseGeneration: fence.supersedingLeaseGeneration,
      campaignReleasePackagePreparedTransactionHash: prepared?.record
        ?.campaignReleasePackagePreparedTransactionHash || null,
      stagingEntries: Object.freeze([
        inspectStagingEntry(
          runtimeRoot,
          transaction,
          transaction.preparedParent,
          detachedByPath.get(transaction.preparedParent),
        ),
        inspectStagingEntry(
          runtimeRoot,
          transaction,
          transaction.abortedParent,
          detachedByPath.get(transaction.abortedParent),
        ),
      ].filter(Boolean).sort((left, right) => left.path.localeCompare(right.path))),
    }));
  }
  return rows.sort((left, right) => (
    `${left.campaignId}\0${left.packageNodeId}\0${left.leaseGeneration}`
      .localeCompare(
        `${right.campaignId}\0${right.packageNodeId}\0${right.leaseGeneration}`,
      )
  ));
}

export function inspectFencedCampaignReleasePackageTransactionsSync({
  runtimeRoot,
  detachedStagingEntries = [],
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  if (!Array.isArray(detachedStagingEntries)) {
    throw new Error('campaign_release_package_transaction_inventory_unsafe');
  }
  const first = scanFencedTransactions(root, detachedStagingEntries);
  const second = scanFencedTransactions(root, detachedStagingEntries);
  const firstHash = hashRecord(
    'FencedCampaignReleasePackageTransactionInventory',
    first,
  );
  if (firstHash !== hashRecord(
    'FencedCampaignReleasePackageTransactionInventory',
    second,
  )) {
    throw new Error('campaign_release_package_transaction_inventory_changed');
  }
  return Object.freeze({
    rows: Object.freeze(first),
    hash: firstHash,
  });
}
