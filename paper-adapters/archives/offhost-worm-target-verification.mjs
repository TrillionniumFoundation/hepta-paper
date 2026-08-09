import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectOffhostWormCustodyEvidence } from './offhost-worm-custody-evidence.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function directoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
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
    return Object.freeze({ path: selected, identity: directoryIdentity(opened) });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
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
  const mountProbe = spawnSync(
    'findmnt',
    [
      '-J', '-n', '--mountpoint', targetMountRoot,
      '-o', 'TARGET,SOURCE,FSTYPE,UUID,PARTUUID',
    ],
    { encoding: 'utf8' },
  );
  let mountedStorage = null;
  try { [mountedStorage] = JSON.parse(mountProbe.stdout).filesystems; } catch { /* blocked below */ }
  const mountAvailable = mountAvailableOverride === null
    ? mountProbe.status === 0 && mountedStorage?.target === targetMountRoot
    : Boolean(mountAvailableOverride);
  let distinctDevice = false;
  let targetPathSafe = false;
  let targetDevice = null;
  if (mountAvailable) {
    try {
      const workspace = assertSafeDirectory(workspaceRoot, 'offhost_worm_workspace_root_unsafe');
      const target = assertSafeDirectory(targetMountRoot, 'offhost_worm_target_root_unsafe');
      const workspaceStat = fs.lstatSync(workspace.path, { bigint: true });
      const targetStat = fs.lstatSync(target.path, { bigint: true });
      distinctDevice = workspaceStat.dev !== targetStat.dev;
      targetDevice = String(targetStat.dev);
      targetPathSafe = true;
    } catch {
      distinctDevice = false;
      targetPathSafe = false;
    }
  }
  if (distinctDeviceOverride !== null) distinctDevice = Boolean(distinctDeviceOverride);
  const mountIdentity = mountedStorage ? JSON.stringify(mountedStorage) : 'test_override';
  const storageIdentityHash = storageIdentityHashOverride || (
    targetPathSafe && mountedStorage && (mountedStorage.uuid || mountedStorage.partuuid)
      ? hashRecord('OffhostWormStorageIdentity', { ...mountedStorage, targetDevice }) : null
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
    ...(mountAvailable && !targetPathSafe ? ['offhost_worm_target_path_unsafe'] : []),
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
