import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-repository.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';
import {
  assertPinnedDirectoryCurrent,
  campaignReleasePackageTransactionError,
  descriptorEntryPath,
  durableIdentity,
  moveEntryNoClobberSync,
  openPinnedScopedDirectory,
  pathEntryExistsNoFollow,
  readCampaignReleasePackagePreparedTransactionSync,
  sameDurableIdentity,
  sameDurableNodeIdentity,
  withCampaignReleasePackageGenerationLockSync,
} from './campaign-release-package-transaction-repository.mjs';
import {
  removeExactCampaignReleasePackageAbortedStagingSync,
  removeExactUnpublishedCampaignReleasePackageBuildingMarkerTemporarySync,
} from './campaign-release-package-building-marker-temporary-recovery.mjs';
import { withHeldCampaignReleasePackageGenerationLeaseSync } from './campaign-release-package-generation-lease.mjs';
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const BUILDING_TRANSACTION_NAME = 'CAMPAIGN_RELEASE_PACKAGE_BUILDING.json';
const BUILDING_FENCE_NAME = 'CAMPAIGN_RELEASE_PACKAGE_BUILDING_FENCED.json';
const BUILDING_MARKER_NAME = '.CAMPAIGN_RELEASE_PACKAGE_BUILDING.json';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
function buildingTransactionPath(releaseRoot) {
  return path.join(path.resolve(releaseRoot), BUILDING_TRANSACTION_NAME);
}
function buildingFencePath(releaseRoot) {
  return path.join(path.resolve(releaseRoot), BUILDING_FENCE_NAME);
}
function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function assertBuildingTransactionRecord(record, { runtimeRoot, releaseRoot }) {
  const root = path.resolve(runtimeRoot || '.');
  const release = path.resolve(releaseRoot || '.');
  const packageDir = path.resolve(record?.packageDir || '.');
  const preparedParent = path.resolve(record?.preparedParent || '.');
  const abortedParent = path.resolve(record?.abortedParent || '.');
  const preparedPackageDir = path.resolve(record?.preparedPackageDir || '.');
  const {
    campaignReleasePackageBuildingTransactionHash: claimedHash,
    ...payload
  } = record || {};
  if (record?.version !== 1
    || record?.kind !== 'CampaignReleasePackageBuildingTransaction'
    || record?.status !== 'campaign_release_package_building'
    || !record?.campaignId || !record?.packageNodeId || !record?.packageAttemptId
    || !SHA256.test(String(record?.campaignPlanHash || ''))
    || !SHA256.test(String(record?.sourceSnapshotHash || ''))
    || !SHA256.test(String(record?.sourceWorkspaceManifestHash || ''))
    || !Number.isSafeInteger(record?.leaseGeneration)
    || record.leaseGeneration < 1
    || !Number.isFinite(Date.parse(record?.createdAt || ''))
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('CampaignReleasePackageBuildingTransaction', payload)
      !== claimedHash
    || record.releaseRoot !== release
    || record.packageDir !== packageDir
    || record.preparedParent !== preparedParent
    || record.abortedParent !== abortedParent
    || record.preparedPackageDir !== preparedPackageDir
    || !isPathWithin(root, release)
    || path.dirname(packageDir) !== path.join(root, 'packages')
    || path.dirname(preparedParent) !== path.dirname(packageDir)
    || !path.basename(preparedParent).startsWith('.package-prepared-')
    || path.dirname(abortedParent) !== path.dirname(packageDir)
    || path.basename(abortedParent) !== path.basename(preparedParent)
      .replace('.package-prepared-', '.package-aborted-')
    || path.dirname(preparedPackageDir) !== preparedParent
    || path.basename(preparedPackageDir) !== path.basename(packageDir)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_transaction_invalid',
    );
  }
  return Object.freeze({
    record: Object.freeze(record),
    path: buildingTransactionPath(release),
    packageDir,
    preparedParent,
    abortedParent,
    preparedPackageDir,
  });
}
export function readCampaignReleasePackageBuildingTransactionSync({
  runtimeRoot,
  releaseRoot,
} = {}) {
  const candidate = buildingTransactionPath(releaseRoot);
  if (!pathEntryExistsNoFollow(candidate)) return null;
  const read = readScopedFileSync({
    scopeRoot: path.resolve(runtimeRoot),
    candidate,
    maximumBytes: 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_transaction_invalid',
      { blockers: read.blockers },
    );
  }
  let record;
  try {
    record = JSON.parse(read.content.toString('utf8'));
  } catch (cause) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_transaction_invalid',
      { cause },
    );
  }
  return Object.freeze({
    ...assertBuildingTransactionRecord(record, { runtimeRoot, releaseRoot }),
    contentHash: read.hash,
    bytes: read.bytes,
  });
}
function writeNoClobberRecordSync({
  runtimeRoot,
  parent,
  name,
  bytes,
  collisionCode,
  invalidCode,
}) {
  const expectedHash = hashBytes(bytes);
  const temporaryName = `.${name}.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  const temporary = path.join(parent, temporaryName);
  let descriptor;
  let temporaryIdentity;
  try {
    const openedParent = openPinnedScopedDirectory(runtimeRoot, parent, invalidCode);
    try {
      descriptor = fs.openSync(
        descriptorEntryPath(openedParent.descriptor, temporaryName),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | NO_FOLLOW,
        0o444,
      );
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n
        || (Number(opened.mode) & 0o777) !== 0o444) {
        throw campaignReleasePackageTransactionError(invalidCode);
      }
      temporaryIdentity = durableIdentity(opened);
      assertPinnedDirectoryCurrent(openedParent, invalidCode);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.closeSync(openedParent.descriptor);
      descriptor = undefined;
    }
    const moved = moveEntryNoClobberSync({
      runtimeRoot,
      sourceParent: parent,
      sourceName: temporaryName,
      targetParent: parent,
      targetName: name,
      expectedSourceIdentity: temporaryIdentity,
      sourceKind: 'file',
      collisionCode,
      invalidCode,
    });
    if (moved.collision) {
      const existing = readScopedFileSync({
        scopeRoot: path.resolve(runtimeRoot),
        candidate: path.join(parent, name),
        maximumBytes: 1024 * 1024,
      });
      if (existing.status !== 'scoped_file_read_verified'
        || existing.hash !== expectedHash
        || !existing.content.equals(bytes)) {
        throw campaignReleasePackageTransactionError(collisionCode);
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (pathEntryExistsNoFollow(temporary)) {
      const remaining = fs.lstatSync(temporary, { bigint: true });
      if (!sameDurableIdentity(remaining, temporaryIdentity)) {
        throw campaignReleasePackageTransactionError(invalidCode);
      }
      fs.unlinkSync(temporary);
      fsyncDirectorySync(parent);
    }
  }
  return expectedHash;
}
function buildingMarker(record) {
  const payload = {
    version: 1,
    kind: 'CampaignReleasePackageBuildingMarker',
    status: 'campaign_release_package_building_marker',
    campaignReleasePackageBuildingTransactionHash:
      record.campaignReleasePackageBuildingTransactionHash,
  };
  return Object.freeze({
    ...payload,
    campaignReleasePackageBuildingMarkerHash: hashRecord(
      'CampaignReleasePackageBuildingMarker',
      payload,
    ),
  });
}
export function assertExactBuildingMarkerSync({ runtimeRoot, parent, record }) {
  const expected = buildingMarker(record);
  const expectedBytes = jsonBytes(expected);
  const candidate = path.join(parent, BUILDING_MARKER_NAME);
  const read = readScopedFileSync({
    scopeRoot: path.resolve(runtimeRoot),
    candidate,
    maximumBytes: 64 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified'
    || !read.content.equals(expectedBytes)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_staging_invalid',
    );
  }
  return expected;
}
function assertBuildingFenceRecord(record, transaction) {
  const {
    campaignReleasePackageBuildingFenceHash: claimedHash,
    ...payload
  } = record || {};
  if (record?.version !== 1
    || record?.kind !== 'CampaignReleasePackageBuildingFence'
    || record?.status !== 'campaign_release_package_building_fenced'
    || record?.campaignId !== transaction?.record?.campaignId
    || record?.packageNodeId !== transaction?.record?.packageNodeId
    || record?.supersededPackageAttemptId
      !== transaction?.record?.packageAttemptId
    || record?.supersededLeaseGeneration
      !== transaction?.record?.leaseGeneration
    || record?.campaignReleasePackageBuildingTransactionHash
      !== transaction?.record
        ?.campaignReleasePackageBuildingTransactionHash
    || !record?.supersedingPackageAttemptId
    || !Number.isSafeInteger(record?.supersedingLeaseGeneration)
    || record.supersedingLeaseGeneration
      <= transaction?.record?.leaseGeneration
    || !Number.isFinite(Date.parse(record?.fencedAt || ''))
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('CampaignReleasePackageBuildingFence', payload)
      !== claimedHash) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_fence_invalid',
    );
  }
  return Object.freeze(record);
}
export function readCampaignReleasePackageBuildingFenceSync({
  runtimeRoot,
  transaction,
} = {}) {
  const candidate = buildingFencePath(transaction?.record?.releaseRoot);
  if (!pathEntryExistsNoFollow(candidate)) return null;
  const read = readScopedFileSync({
    scopeRoot: path.resolve(runtimeRoot),
    candidate,
    maximumBytes: 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_fence_invalid',
    );
  }
  let record;
  try {
    record = JSON.parse(read.content.toString('utf8'));
  } catch (cause) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_fence_invalid',
      { cause },
    );
  }
  return assertBuildingFenceRecord(record, transaction);
}
function writeCampaignReleasePackageBuildingFenceSync({
  runtimeRoot,
  transaction,
  supersedingReleaseRoot,
  binding,
} = {}) {
  const existing = readCampaignReleasePackageBuildingFenceSync({
    runtimeRoot,
    transaction,
  });
  if (existing) return existing;
  const payload = {
    version: 1,
    kind: 'CampaignReleasePackageBuildingFence',
    status: 'campaign_release_package_building_fenced',
    campaignId: transaction.record.campaignId,
    packageNodeId: transaction.record.packageNodeId,
    supersededPackageAttemptId: transaction.record.packageAttemptId,
    supersededLeaseGeneration: transaction.record.leaseGeneration,
    campaignReleasePackageBuildingTransactionHash: transaction.record
      .campaignReleasePackageBuildingTransactionHash,
    supersedingPackageAttemptId: binding?.packageAttemptId,
    supersedingLeaseGeneration: Number(binding?.leaseGeneration),
    supersedingReleaseRoot: path.resolve(supersedingReleaseRoot || '.'),
    fencedAt: binding?.createdAt,
  };
  const record = Object.freeze({
    ...payload,
    campaignReleasePackageBuildingFenceHash: hashRecord(
      'CampaignReleasePackageBuildingFence',
      payload,
    ),
  });
  assertBuildingFenceRecord(record, transaction);
  writeNoClobberRecordSync({
    runtimeRoot,
    parent: transaction.record.releaseRoot,
    name: BUILDING_FENCE_NAME,
    bytes: jsonBytes(record),
    collisionCode: 'campaign_release_package_building_fence_collision',
    invalidCode: 'campaign_release_package_building_fence_invalid',
  });
  return readCampaignReleasePackageBuildingFenceSync({
    runtimeRoot,
    transaction,
  });
}
function removeJournalBoundBuildingStagingSync({ runtimeRoot, transaction }) {
  const source = transaction.preparedParent;
  const sourceStat = fs.lstatSync(source, { bigint: true });
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_staging_invalid',
    );
  }
  assertExactBuildingMarkerSync({
    runtimeRoot,
    parent: source,
    record: transaction.record,
  });
  const target = transaction.abortedParent;
  const targetName = path.basename(target);
  if (pathEntryExistsNoFollow(target)) {
    removeExactCampaignReleasePackageAbortedStagingSync({
      runtimeRoot,
      parent: target,
      expectedMarkerBytes: jsonBytes(buildingMarker(transaction.record)),
    });
  }
  const moved = moveEntryNoClobberSync({
    runtimeRoot,
    sourceParent: path.dirname(source),
    sourceName: path.basename(source),
    targetParent: path.dirname(target),
    targetName,
    expectedSourceIdentity: durableIdentity(sourceStat),
    sourceKind: 'directory',
    collisionCode: 'campaign_release_package_building_staging_collision',
    invalidCode: 'campaign_release_package_building_staging_invalid',
  });
  if (moved.collision) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_staging_collision',
    );
  }
  removeExactCampaignReleasePackageAbortedStagingSync({
    runtimeRoot,
    parent: target,
    expectedMarkerBytes: jsonBytes(buildingMarker(transaction.record)),
  });
}
function removeExistingBuildingStagingSync({ runtimeRoot, transaction }) {
  const staging = fs.lstatSync(transaction.preparedParent, { bigint: true });
  if (!staging.isDirectory() || staging.isSymbolicLink()) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_staging_invalid',
    );
  }
  const names = fs.readdirSync(transaction.preparedParent).sort();
  const recoveredUnpublishedMarker = names.length > 0
    && removeExactUnpublishedCampaignReleasePackageBuildingMarkerTemporarySync({
      runtimeRoot,
      parent: transaction.preparedParent,
      expectedBytes: jsonBytes(buildingMarker(transaction.record)),
    });
  if (names.length === 0 || recoveredUnpublishedMarker) {
    fs.rmdirSync(transaction.preparedParent);
    fsyncDirectorySync(path.dirname(transaction.preparedParent));
    return;
  }
  removeJournalBoundBuildingStagingSync({ runtimeRoot, transaction });
}
function materializeBuildingStagingSync({ runtimeRoot, transaction }) {
  if (pathEntryExistsNoFollow(transaction.packageDir)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_publication_collision',
    );
  }
  if (pathEntryExistsNoFollow(transaction.abortedParent)) {
    removeExactCampaignReleasePackageAbortedStagingSync({
      runtimeRoot,
      parent: transaction.abortedParent,
      expectedMarkerBytes: jsonBytes(buildingMarker(transaction.record)),
    });
  }
  if (pathEntryExistsNoFollow(transaction.preparedParent)) {
    removeExistingBuildingStagingSync({ runtimeRoot, transaction });
  }
  ensureScopedDirectorySync({
    scopeRoot: path.resolve(runtimeRoot),
    relative: path.relative(runtimeRoot, transaction.preparedParent)
      .replace(/\\/g, '/'),
  });
  const parentStat = fs.lstatSync(transaction.preparedParent, { bigint: true });
  const packageParentStat = fs.lstatSync(
    path.dirname(transaction.packageDir),
    { bigint: true },
  );
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || parentStat.dev !== packageParentStat.dev) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_preparation_cross_device',
    );
  }
  const markerBytes = jsonBytes(buildingMarker(transaction.record));
  writeNoClobberRecordSync({
    runtimeRoot,
    parent: transaction.preparedParent,
    name: BUILDING_MARKER_NAME,
    bytes: markerBytes,
    collisionCode: 'campaign_release_package_building_staging_collision',
    invalidCode: 'campaign_release_package_building_staging_invalid',
  });
  assertExactBuildingMarkerSync({
    runtimeRoot,
    parent: transaction.preparedParent,
    record: transaction.record,
  });
  fsyncDirectorySync(transaction.preparedParent);
  fsyncDirectorySync(path.dirname(transaction.preparedParent));
}
function fenceStaleCampaignReleasePackageBuildTransactionsSync({
  runtimeRoot,
  releaseRoot,
  binding,
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const release = path.resolve(releaseRoot || '.');
  const nodeRoot = path.dirname(release);
  if (!isPathWithin(root, nodeRoot)
    || !Number.isSafeInteger(Number(binding?.leaseGeneration))
    || Number(binding.leaseGeneration) < 1) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_transaction_invalid',
    );
  }
  const entries = fs.readdirSync(nodeRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = path.join(nodeRoot, entry.name);
    if (candidate === release) continue;
    if (entry.isSymbolicLink()) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_building_transaction_invalid',
      );
    }
    if (!entry.isDirectory()
      || !pathEntryExistsNoFollow(buildingTransactionPath(candidate))) continue;
    const transaction = readCampaignReleasePackageBuildingTransactionSync({
      runtimeRoot: root,
      releaseRoot: candidate,
    });
    if (transaction.record.campaignId !== binding?.campaignId
      || transaction.record.packageNodeId !== binding?.packageNodeId) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_building_transaction_collision',
      );
    }
    const staleGeneration = transaction.record.leaseGeneration;
    const currentGeneration = Number(binding.leaseGeneration);
    if (staleGeneration >= currentGeneration) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_building_transaction_fenced',
      );
    }
    const fence = writeCampaignReleasePackageBuildingFenceSync({
      runtimeRoot: root,
      transaction,
      supersedingReleaseRoot: release,
      binding,
    });
    if (fence.supersedingLeaseGeneration > currentGeneration) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_building_transaction_fenced',
      );
    }
    const prepared = readCampaignReleasePackagePreparedTransactionSync({
      runtimeRoot: root,
      releaseRoot: candidate,
    });
    if (pathEntryExistsNoFollow(transaction.abortedParent)) {
      removeExactCampaignReleasePackageAbortedStagingSync({
        runtimeRoot: root,
        parent: transaction.abortedParent,
        expectedMarkerBytes: jsonBytes(buildingMarker(transaction.record)),
      });
    }
    if (prepared) continue;
    if (pathEntryExistsNoFollow(transaction.packageDir)) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_building_transaction_completion_invalid',
      );
    }
    if (!pathEntryExistsNoFollow(transaction.preparedParent)) continue;
    removeExistingBuildingStagingSync({
      runtimeRoot: root,
      transaction,
    });
  }
}

export function beginCampaignReleasePackageBuildTransactionSync({
  runtimeRoot,
  releaseRoot,
  packageDir,
  binding,
  generationLease = null,
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const release = path.resolve(releaseRoot || '.');
  const publishedPackageDir = path.resolve(packageDir || '.');
  const beginWhileLocked = ({ assertHeld }) => {
    assertHeld();
    fenceStaleCampaignReleasePackageBuildTransactionsSync({
      runtimeRoot: root,
      releaseRoot: release,
      binding,
    });
    let transaction = readCampaignReleasePackageBuildingTransactionSync({
      runtimeRoot: root,
      releaseRoot: release,
    });
    if (!transaction) {
      const preparationToken = `${process.pid}-${crypto.randomBytes(12)
        .toString('hex')}`;
      const preparedParent = path.join(
        path.dirname(publishedPackageDir),
        `.package-prepared-${preparationToken}`,
      );
      const payload = {
        version: 1,
        kind: 'CampaignReleasePackageBuildingTransaction',
        status: 'campaign_release_package_building',
        campaignId: binding?.campaignId,
        campaignPlanHash: binding?.campaignPlanHash,
        packageNodeId: binding?.packageNodeId,
        packageAttemptId: binding?.packageAttemptId,
        leaseGeneration: Number(binding?.leaseGeneration),
        sourceSnapshotHash: binding?.sourceSnapshotHash,
        sourceWorkspaceManifestHash: binding?.sourceWorkspaceManifestHash,
        releaseRoot: release,
        packageDir: publishedPackageDir,
        preparedParent,
        abortedParent: path.join(
          path.dirname(publishedPackageDir),
          `.package-aborted-${preparationToken}`,
        ),
        preparedPackageDir: path.join(
          preparedParent,
          path.basename(publishedPackageDir),
        ),
        createdAt: binding?.createdAt,
      };
      const record = Object.freeze({
        ...payload,
        campaignReleasePackageBuildingTransactionHash: hashRecord(
          'CampaignReleasePackageBuildingTransaction',
          payload,
        ),
      });
      assertBuildingTransactionRecord(record, {
        runtimeRoot: root,
        releaseRoot: release,
      });
      const bytes = jsonBytes(record);
      writeNoClobberRecordSync({
        runtimeRoot: root,
        parent: release,
        name: BUILDING_TRANSACTION_NAME,
        bytes,
        collisionCode: 'campaign_release_package_building_transaction_collision',
        invalidCode: 'campaign_release_package_building_transaction_invalid',
      });
      transaction = readCampaignReleasePackageBuildingTransactionSync({
        runtimeRoot: root,
        releaseRoot: release,
      });
    }
    if (transaction.packageDir !== publishedPackageDir
      || transaction.record.campaignId !== binding?.campaignId
      || transaction.record.campaignPlanHash !== binding?.campaignPlanHash
      || transaction.record.packageNodeId !== binding?.packageNodeId
      || transaction.record.packageAttemptId !== binding?.packageAttemptId
      || transaction.record.leaseGeneration !== Number(binding?.leaseGeneration)
      || transaction.record.sourceSnapshotHash !== binding?.sourceSnapshotHash
      || transaction.record.sourceWorkspaceManifestHash
        !== binding?.sourceWorkspaceManifestHash) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_building_transaction_collision',
      );
    }
    const prepared = readCampaignReleasePackagePreparedTransactionSync({
      runtimeRoot: root,
      releaseRoot: release,
    });
    if (prepared) {
      if (prepared.publishedPackageDir !== transaction.packageDir
        || prepared.preparedPackageDir !== transaction.preparedPackageDir) {
        throw campaignReleasePackageTransactionError(
          'campaign_release_package_building_transaction_collision',
        );
      }
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_prepared_transaction_exists',
      );
    }
    materializeBuildingStagingSync({ runtimeRoot: root, transaction });
    assertHeld();
    return transaction;
  };
  if (generationLease) {
    return withHeldCampaignReleasePackageGenerationLeaseSync({
      lease: generationLease, runtimeRoot: root, releaseRoot: release,
    }, beginWhileLocked);
  }
  return withCampaignReleasePackageGenerationLockSync({
    runtimeRoot: root, releaseRoot: release,
  }, beginWhileLocked);
}

export function assertCampaignReleasePackageBuildTransactionCurrentSync({
  runtimeRoot,
  releaseRoot,
  expectedTransactionHash,
  requireBuildingMarker = true,
} = {}) {
  const transaction = readCampaignReleasePackageBuildingTransactionSync({
    runtimeRoot,
    releaseRoot,
  });
  if (!transaction
    || transaction.record.campaignReleasePackageBuildingTransactionHash
      !== expectedTransactionHash
    || readCampaignReleasePackageBuildingFenceSync({
      runtimeRoot,
      transaction,
    })) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_transaction_fenced',
    );
  }
  if (requireBuildingMarker) {
    assertExactBuildingMarkerSync({
      runtimeRoot,
      parent: transaction.preparedParent,
      record: transaction.record,
    });
  }
  return transaction;
}

export function completeCampaignReleasePackageBuildTransactionSync({
  runtimeRoot,
  releaseRoot,
  expectedTransactionHash,
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const transaction = readCampaignReleasePackageBuildingTransactionSync({
    runtimeRoot: root,
    releaseRoot,
  });
  if (!transaction) return null;
  assertCampaignReleasePackageBuildTransactionCurrentSync({
    runtimeRoot: root,
    releaseRoot,
    expectedTransactionHash,
    requireBuildingMarker: false,
  });
  if (pathEntryExistsNoFollow(transaction.preparedPackageDir)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_transaction_fenced',
    );
  }
  const prepared = readCampaignReleasePackagePreparedTransactionSync({
    runtimeRoot: root,
    releaseRoot,
  });
  const packageStat = pathEntryExistsNoFollow(transaction.packageDir)
    ? fs.lstatSync(transaction.packageDir, { bigint: true }) : null;
  if (!prepared || prepared.publishedPackageDir !== transaction.packageDir
    || !packageStat || !packageStat.isDirectory() || packageStat.isSymbolicLink()
    || !sameDurableNodeIdentity(
      packageStat,
      prepared.record.preparedPackageIdentity,
    )) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_building_transaction_completion_invalid',
    );
  }
  if (!pathEntryExistsNoFollow(transaction.preparedParent)) return transaction;
  const opened = openPinnedScopedDirectory(
    root,
    transaction.preparedParent,
    'campaign_release_package_building_transaction_completion_invalid',
  );
  try {
    const names = fs.readdirSync(`/proc/self/fd/${opened.descriptor}`).sort();
    if (names.length > 1
      || (names.length === 1 && names[0] !== BUILDING_MARKER_NAME)) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_building_transaction_completion_invalid',
      );
    }
    if (names[0] === BUILDING_MARKER_NAME) {
      assertExactBuildingMarkerSync({
        runtimeRoot: root,
        parent: transaction.preparedParent,
        record: transaction.record,
      });
      fs.unlinkSync(descriptorEntryPath(opened.descriptor, BUILDING_MARKER_NAME));
      fs.fsyncSync(opened.descriptor);
      assertPinnedDirectoryCurrent(
        opened,
        'campaign_release_package_building_transaction_completion_invalid',
      );
    }
  } finally {
    fs.closeSync(opened.descriptor);
  }
  fs.rmdirSync(transaction.preparedParent);
  fsyncDirectorySync(path.dirname(transaction.preparedParent));
  return transaction;
}
