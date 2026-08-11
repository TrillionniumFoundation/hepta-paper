import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectOffhostWormCustodyEvidence } from './offhost-worm-custody-evidence.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MOUNT_BINDING_ERROR = 'offhost_worm_target_mount_binding_changed';

function directoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

function deviceMajorMinor(device) {
  const value = BigInt(device);
  const major = ((value & 0x00000000000fff00n) >> 8n)
    | ((value & 0xfffff00000000000n) >> 32n);
  const minor = (value & 0x00000000000000ffn)
    | ((value & 0x00000ffffff00000n) >> 12n);
  return `${major}:${minor}`;
}

function descriptorMountId(descriptor) {
  const match = fs.readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8')
    .match(/^mnt_id:\s*([0-9]+)$/mu);
  if (!match) throw new Error('offhost_worm_target_mount_id_unavailable');
  return match[1];
}

function mountedStorageObservation(mountedStorage) {
  if (!mountedStorage || typeof mountedStorage !== 'object' || Array.isArray(mountedStorage)) {
    return null;
  }
  return Object.freeze({
    target: String(mountedStorage.target || ''),
    source: String(mountedStorage.source || ''),
    fstype: String(mountedStorage.fstype || ''),
    uuid: String(mountedStorage.uuid || '').toLowerCase(),
    partuuid: String(mountedStorage.partuuid || '').toLowerCase(),
    mountId: String(mountedStorage.id || mountedStorage.mountId || ''),
    majorMinor: String(mountedStorage['maj:min'] || mountedStorage.majorMinor || ''),
    fsRoot: String(mountedStorage.fsroot || mountedStorage.fsRoot || ''),
  });
}

function probeMountedStorage(targetMountRoot, mountedStorageOverride) {
  if (mountedStorageOverride !== null) {
    try {
      const mountedStorage = typeof mountedStorageOverride === 'function'
        ? mountedStorageOverride({ targetMountRoot }) : mountedStorageOverride;
      return Object.freeze({ status: mountedStorage ? 0 : 1, mountedStorage });
    } catch {
      return Object.freeze({ status: 1, mountedStorage: null });
    }
  }
  const probe = spawnSync(
    'findmnt',
    [
      '-J', '-n', '--mountpoint', targetMountRoot,
      '-o', 'TARGET,SOURCE,FSTYPE,UUID,PARTUUID,ID,MAJ:MIN,FSROOT',
    ],
    { encoding: 'utf8' },
  );
  let mountedStorage = null;
  try { [mountedStorage] = JSON.parse(probe.stdout).filesystems; } catch { /* blocked below */ }
  return Object.freeze({ status: probe.status, mountedStorage });
}

function assertSafeDirectory(candidate, errorCode) {
  const selected = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(selected, { bigint: true }); } catch { throw new Error(errorCode); }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(selected) !== selected) throw new Error(errorCode);
  let descriptor;
  try {
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()
      || !sameIdentity(directoryIdentity(stat), directoryIdentity(opened))) {
      throw new Error(errorCode);
    }
    return Object.freeze({
      path: selected,
      identity: directoryIdentity(opened),
      mountId: descriptorMountId(descriptor),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function expectedStorageIdentity(contract) {
  if (contract?.expectedStorageIdentity === undefined) return null;
  const identity = contract.expectedStorageIdentity;
  if (identity === null || typeof identity !== 'object'
    || Array.isArray(identity)
    || Object.keys(identity).sort().join(',')
      !== 'filesystemType,filesystemUuid,partitionUuid'
    || typeof identity.filesystemType !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{1,31}$/u.test(identity.filesystemType)
    || !UUID.test(String(identity.filesystemUuid || '').toLowerCase())
    || !UUID.test(String(identity.partitionUuid || '').toLowerCase())) {
    throw new Error('offhost_worm_storage_identity_contract_invalid');
  }
  return Object.freeze({
    filesystemType: identity.filesystemType,
    filesystemUuid: identity.filesystemUuid.toLowerCase(),
    partitionUuid: identity.partitionUuid.toLowerCase(),
  });
}

function mountedStorageMatchesExpected(mountedStorage, expected) {
  if (!expected) return true;
  return mountedStorage?.fstype === expected.filesystemType
    && String(mountedStorage?.uuid || '').toLowerCase() === expected.filesystemUuid
    && String(mountedStorage?.partuuid || '').toLowerCase() === expected.partitionUuid;
}

export function assertOffhostWormTargetMountBinding({
  target,
  pinnedTargetDirectory,
  mountedStorageOverride = null,
} = {}) {
  let opened;
  let current;
  try {
    opened = fs.fstatSync(pinnedTargetDirectory?.descriptor, { bigint: true });
    current = fs.lstatSync(target?.targetMountRoot, { bigint: true });
  } catch {
    throw new Error(MOUNT_BINDING_ERROR);
  }
  const openedIdentity = directoryIdentity(opened);
  const currentIdentity = directoryIdentity(current);
  const openedMajorMinor = deviceMajorMinor(opened.dev);
  let openedMountId;
  try { openedMountId = descriptorMountId(pinnedTargetDirectory.descriptor); }
  catch { throw new Error(MOUNT_BINDING_ERROR); }
  if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
    || !sameIdentity(openedIdentity, pinnedTargetDirectory?.identity)
    || !sameIdentity(openedIdentity, target?.targetDirectoryIdentity)
    || !sameIdentity(currentIdentity, target?.targetDirectoryIdentity)
    || openedMajorMinor !== target?.targetDeviceMajorMinor
    || openedMountId !== target?.targetMountId) {
    throw new Error(MOUNT_BINDING_ERROR);
  }

  // Explicit mount overrides without a storage observation exist only for
  // isolated repository fixtures. Production observations always carry a
  // hash-bound findmnt record and are re-probed here.
  if (target?.mountObservationHash === null && target?.mountIdentity === 'test_override') {
    return Object.freeze({ status: 'offhost_worm_target_mount_binding_verified' });
  }
  const freshProbe = probeMountedStorage(target.targetMountRoot, mountedStorageOverride);
  const freshObservation = mountedStorageObservation(freshProbe.mountedStorage);
  const freshObservationHash = freshObservation
    ? hashRecord('OffhostWormMountObservation', freshObservation) : null;
  if (freshProbe.status !== 0
    || freshObservation?.target !== target.targetMountRoot
    || freshObservation?.majorMinor !== openedMajorMinor
    || freshObservation?.mountId !== openedMountId
    || freshObservationHash !== target.mountObservationHash) {
    throw new Error(MOUNT_BINDING_ERROR);
  }
  return Object.freeze({ status: 'offhost_worm_target_mount_binding_verified' });
}

export function verifyOffhostWormTarget({
  workspaceRoot,
  contract,
  mountAvailableOverride = null,
  distinctDeviceOverride = null,
  requireCustody = false,
  custodyEvidenceOverride = null,
  custodyTrustStoreOverride = null,
  storageIdentityHashOverride = null,
  custodyImmutableOverride = null,
  mountedStorageOverride = null,
  now = new Date(),
} = {}) {
  if (contract?.kind !== 'OffhostWormSnapshotContract' || contract?.version !== 1) {
    throw new Error('v1 offhost WORM contract required');
  }
  if (typeof requireCustody !== 'boolean') {
    throw new Error('offhost_worm_require_custody_boolean_required');
  }
  const targetMountRoot = path.resolve(
    process.env.HEPTA_OFFHOST_WORM_ROOT || contract.targetMountRoot,
  );
  const mountProbe = probeMountedStorage(targetMountRoot, mountedStorageOverride);
  const mountedStorage = mountProbe.mountedStorage;
  const mountObservation = mountedStorageObservation(mountedStorage);
  const mountAvailable = mountAvailableOverride === null
    ? mountProbe.status === 0 && mountObservation?.target === targetMountRoot
    : Boolean(mountAvailableOverride);
  const expectedIdentity = expectedStorageIdentity(contract);
  const storageIdentityMatchesContract = mountAvailable
    ? mountedStorageMatchesExpected(mountedStorage, expectedIdentity) : false;
  let distinctDevice = false;
  let targetPathSafe = false;
  let targetDevice = null;
  let targetDeviceMajorMinor = null;
  let targetDirectoryIdentity = null;
  let targetMountId = null;
  if (mountAvailable) {
    try {
      const workspace = assertSafeDirectory(workspaceRoot, 'offhost_worm_workspace_root_unsafe');
      const target = assertSafeDirectory(targetMountRoot, 'offhost_worm_target_root_unsafe');
      distinctDevice = workspace.identity.dev !== target.identity.dev;
      targetDevice = target.identity.dev;
      targetDeviceMajorMinor = deviceMajorMinor(target.identity.dev);
      targetDirectoryIdentity = target.identity;
      targetMountId = target.mountId;
      targetPathSafe = true;
    } catch {
      distinctDevice = false;
      targetPathSafe = false;
    }
  }
  if (distinctDeviceOverride !== null) distinctDevice = Boolean(distinctDeviceOverride);
  const mountIdentity = mountObservation ? JSON.stringify(mountObservation) : 'test_override';
  const mountObservationHash = mountObservation
    ? hashRecord('OffhostWormMountObservation', mountObservation) : null;
  const mountDeviceMatchesTarget = targetPathSafe && (
    mountObservation
      ? mountObservation.target === targetMountRoot
        && mountObservation.majorMinor === targetDeviceMajorMinor
      : mountAvailableOverride !== null
  );
  const mountIdMatchesTarget = targetPathSafe && (
    mountObservation
      ? mountObservation.mountId === targetMountId && mountObservation.fsRoot.length > 0
      : mountAvailableOverride !== null
  );
  const storageIdentityHash = storageIdentityHashOverride || (
    targetPathSafe && mountObservation && (mountObservation.uuid || mountObservation.partuuid)
      ? hashRecord('OffhostWormStorageIdentity', {
        target: mountObservation.target,
        source: mountObservation.source,
        fstype: mountObservation.fstype,
        uuid: mountObservation.uuid,
        partuuid: mountObservation.partuuid,
        targetDevice,
      }) : null
  );
  const custodyDeclaredQualified = contract.offHostOrOffsiteCustodyQualified === true;
  const custodyEvidence = inspectOffhostWormCustodyEvidence({
    contract,
    targetMountRoot,
    evidenceOverride: custodyEvidenceOverride,
    trustStoreOverride: custodyTrustStoreOverride,
    storageIdentityHash,
    immutableOverride: custodyImmutableOverride,
    now,
  });
  const custodyQualified = custodyDeclaredQualified && custodyEvidence.qualified;
  const custodyBlockers = [
    ...(custodyDeclaredQualified ? [] : ['offhost_or_offsite_custody_not_qualified']),
    ...custodyEvidence.blockers,
  ];
  const blockers = [
    ...(mountAvailable ? [] : ['offhost_worm_target_unavailable']),
    ...(mountAvailable && expectedIdentity && !storageIdentityMatchesContract
      ? ['offhost_worm_storage_identity_mismatch'] : []),
    ...(mountAvailable && !targetPathSafe ? ['offhost_worm_target_path_unsafe'] : []),
    ...(mountAvailable && targetPathSafe && !mountDeviceMatchesTarget
      ? ['offhost_worm_mount_device_mismatch'] : []),
    ...(mountAvailable && targetPathSafe && !mountIdMatchesTarget
      ? ['offhost_worm_mount_identity_mismatch'] : []),
    ...(contract.requireDistinctFilesystemDevice && !distinctDevice
      ? ['offhost_worm_target_not_distinct_device'] : []),
    ...(requireCustody ? custodyBlockers : []),
  ];
  return Object.freeze({
    version: 1,
    kind: 'OffhostWormTargetStatus',
    status: blockers.length ? 'offhost_worm_target_blocked' : 'offhost_worm_target_ready',
    contractId: contract.contractId,
    targetMountRoot,
    mountAvailable,
    mountIdentity: mountAvailable ? mountIdentity : null,
    mountObservationHash: mountAvailable ? mountObservationHash : null,
    targetDirectoryIdentity: targetPathSafe ? targetDirectoryIdentity : null,
    targetDeviceMajorMinor: targetPathSafe ? targetDeviceMajorMinor : null,
    targetMountId: targetPathSafe ? targetMountId : null,
    mountDeviceMatchesTarget,
    mountIdMatchesTarget,
    expectedStorageIdentityHash: expectedIdentity
      ? hashRecord('OffhostWormExpectedStorageIdentity', expectedIdentity) : null,
    storageIdentityMatchesContract,
    distinctDevice,
    storageIdentityHash,
    custodyRequired: requireCustody,
    currentProtectionLevel: contract.currentProtectionLevel
      || 'external_disk_unspecified_custody',
    custodyDeclaredQualified,
    offHostOrOffsiteCustodyQualified: custodyQualified,
    custodyStatus: custodyQualified
      ? 'offhost_or_offsite_custody_qualified'
      : 'offhost_or_offsite_custody_blocked',
    custodyBlockers,
    custodyEvidenceStatus: custodyEvidence.status,
    custodyEvidenceBundleHash: custodyEvidence.evidenceBundleHash,
    custodyTrustStoreHash: custodyEvidence.trustStoreHash,
    custodyEvidenceExpiresAt: custodyEvidence.expiresAt,
    blockers,
  });
}
