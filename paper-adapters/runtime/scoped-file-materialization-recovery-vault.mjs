import crypto from 'node:crypto';
import fs from 'node:fs';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  currentMaterializationLockOwnerIdentity as currentLockOwnerIdentity,
  materializationIdentityFromStat as identityFromStat,
  sameMaterializationEntryIdentity as sameEntryIdentity,
  sameStableMaterializationEntryIdentity as sameStableEntryIdentity,
  scopedMaterializationOperationDefinitionName,
  scopedMaterializationOperationRecordName,
  verifyScopedMaterializationOperationDefinitionRecord,
  verifyScopedMaterializationOperationRecord,
} from './scoped-file-materialization-recovery-record.mjs';
import {
  descriptorEntryPath,
  errorWithBlockers,
  inspectDescriptorRelativeEntryIdentity,
  openedDescriptorRealPath,
  readDescriptorJsonRecord,
  stableDirectoryIdentity,
  unlinkOwnedDescriptorEntry,
  within,
  writeDescriptorFully,
} from './scoped-file-materialization-path-io.mjs';
import { ownerRecordIsOrphan } from './scoped-file-materialization-target-lock.mjs';

const RECOVERY_DIRECTORY_NAME = '.hepta-materialization-recovery';
const RECOVERY_INTENT_MAX_BYTES = 64 * 1024;
const LOCK_RECORD_MAX_BYTES = 4096;
const ACTIVE_RECOVERY_LEASES = new Set();
export const ACTIVE_OPERATION_RECORD_TEMPS = new Set();

export function openScopeRecoveryVault(scope) {
  let rootDescriptor;
  let descriptor;
  let leaseDescriptor;
  let leaseIdentity;
  const leaseOwner = currentLockOwnerIdentity();
  const leaseToken = crypto.randomUUID();
  const leaseStart = String(leaseOwner.pidStartTime || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  const leaseName = `.lease-${leaseOwner.pid}-${leaseStart}-${leaseToken}.json`;
  const pendingLeaseName = `.pending-lease-${leaseOwner.pid}-${leaseStart}-${leaseToken}.json`;
  let leasePublished = false;
  try {
    rootDescriptor = fs.openSync(
      scope.root,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
    );
    const rootStat = fs.fstatSync(rootDescriptor, { bigint: true });
    const rootRealPath = openedDescriptorRealPath(rootDescriptor);
    if (!rootStat.isDirectory()
      || !stableDirectoryIdentity(scope.identity, rootStat)
      || rootRealPath !== scope.realRoot) {
      throw errorWithBlockers('scoped_materialization_root_changed', '.');
    }
    const recoveryPath = descriptorEntryPath(rootDescriptor, RECOVERY_DIRECTORY_NAME);
    try {
      fs.mkdirSync(recoveryPath, { mode: 0o700 });
      fs.fsyncSync(rootDescriptor);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    descriptor = fs.openSync(
      recoveryPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const realPath = openedDescriptorRealPath(descriptor);
    if (!stat.isDirectory() || !realPath || !within(scope.realRoot, realPath)) {
      throw errorWithBlockers('scoped_materialization_recovery_unsafe', RECOVERY_DIRECTORY_NAME);
    }
    leaseDescriptor = fs.openSync(
      descriptorEntryPath(descriptor, pendingLeaseName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const leaseStat = fs.fstatSync(leaseDescriptor, { bigint: true });
    if (!leaseStat.isFile() || Number(leaseStat.nlink) !== 1) {
      throw errorWithBlockers('scoped_materialization_recovery_lease_unsafe', leaseName);
    }
    leaseIdentity = identityFromStat(leaseStat);
    const leasePayload = Buffer.from(`${JSON.stringify({ version: 2, owner: leaseOwner, leaseName })}\n`);
    writeDescriptorFully(leaseDescriptor, leasePayload, leasePayload.length);
    fs.fsyncSync(leaseDescriptor);
    leaseIdentity = identityFromStat(fs.fstatSync(leaseDescriptor, { bigint: true }));
    ACTIVE_RECOVERY_LEASES.add(pendingLeaseName);
    ACTIVE_RECOVERY_LEASES.add(leaseName);
    fs.linkSync(
      descriptorEntryPath(descriptor, pendingLeaseName),
      descriptorEntryPath(descriptor, leaseName),
    );
    leasePublished = true;
    fs.fsyncSync(descriptor);
    unlinkOwnedDescriptorEntry({ descriptor }, pendingLeaseName, leaseIdentity, { sync: false });
    ACTIVE_RECOVERY_LEASES.delete(pendingLeaseName);
    fs.fsyncSync(descriptor);
    leaseIdentity = identityFromStat(fs.fstatSync(leaseDescriptor, { bigint: true }));
    const vault = {
      rootDescriptor,
      descriptor,
      leaseDescriptor,
      leaseName,
      leaseIdentity,
      scope,
      identity: identityFromStat(stat),
      realPath,
      closed: false,
    };
    cleanupStaleRecoveryLeases(vault);
    cleanupStaleOperationRecordTemps(vault);
    return vault;
  } catch (error) {
    ACTIVE_RECOVERY_LEASES.delete(pendingLeaseName);
    ACTIVE_RECOVERY_LEASES.delete(leaseName);
    try {
      if (descriptor !== undefined && leaseIdentity) {
        if (leasePublished) unlinkOwnedDescriptorEntry({ descriptor }, leaseName, leaseIdentity, { sync: false });
        unlinkOwnedDescriptorEntry({ descriptor }, pendingLeaseName, leaseIdentity);
      }
    } catch {}
    try { if (leaseDescriptor !== undefined) fs.closeSync(leaseDescriptor); } catch {}
    try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch {}
    try { if (rootDescriptor !== undefined) fs.closeSync(rootDescriptor); } catch {}
    throw error;
  }
}
export function assertRecoveryVaultStillScoped(vault) {
  if (!vault || vault.closed) throw new Error('scoped_materialization_recovery_descriptor_invalid');
  const rootStat = fs.fstatSync(vault.rootDescriptor, { bigint: true });
  const stat = fs.fstatSync(vault.descriptor, { bigint: true });
  const rootRealPath = openedDescriptorRealPath(vault.rootDescriptor);
  const realPath = openedDescriptorRealPath(vault.descriptor);
  const currentRoot = inspectScopedPathSync({
    scopeRoot: vault.scope.root,
    candidate: vault.scope.root,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (currentRoot.blockers.length
    || !stableDirectoryIdentity(vault.scope.identity, rootStat)
    || currentRoot.identity?.device !== vault.scope.identity.device
    || currentRoot.identity?.inode !== vault.scope.identity.inode
    || rootRealPath !== vault.scope.realRoot
    || !stableDirectoryIdentity(vault.identity, stat)
    || !realPath
    || !within(vault.scope.realRoot, realPath)) {
    throw errorWithBlockers('scoped_materialization_recovery_changed', RECOVERY_DIRECTORY_NAME);
  }
}

export function closeRecoveryVault(vault) {
  if (!vault || vault.closed) return;
  let failure = null;
  try {
    if (vault.leaseIdentity) {
      unlinkOwnedDescriptorEntry(vault, vault.leaseName, vault.leaseIdentity);
    }
  } catch (error) {
    failure = error;
  } finally {
    ACTIVE_RECOVERY_LEASES.delete(vault.leaseName);
  }
  try { fs.closeSync(vault.leaseDescriptor); } catch (error) { failure ||= error; }
  try { fs.closeSync(vault.descriptor); } catch (error) { failure ||= error; }
  try {
    const recoveryPath = descriptorEntryPath(vault.rootDescriptor, RECOVERY_DIRECTORY_NAME);
    const current = fs.lstatSync(recoveryPath, { bigint: true });
    if (current.isDirectory() && stableDirectoryIdentity(vault.identity, current)) {
      fs.rmdirSync(recoveryPath);
      fs.fsyncSync(vault.rootDescriptor);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) failure ||= error;
  }
  try { fs.closeSync(vault.rootDescriptor); } catch (error) { failure ||= error; }
  vault.closed = true;
  if (failure) throw failure;
}

function leaseOwnerFromName(name) {
  const match = /^\.(?:pending-)?lease-(\d+)-([A-Za-z0-9_.]+)-/.exec(name);
  return match ? { pid: Number(match[1]), pidStartTime: match[2] === 'unknown' ? null : match[2] } : null;
}

function cleanupStaleRecoveryLeases(vault) {
  const directory = descriptorEntryPath(vault.descriptor, '.');
  for (const name of fs.readdirSync(directory).filter((entry) => (
    entry.startsWith('.lease-') || entry.startsWith('.pending-lease-')
  ) && entry !== vault.leaseName)) {
    let lease;
    try {
      lease = readDescriptorJsonRecord(vault.descriptor, name, LOCK_RECORD_MAX_BYTES, 'scoped_materialization_recovery_lease_unsafe');
    } catch {
      const owner = leaseOwnerFromName(name);
      if (ownerRecordIsOrphan(owner, ACTIVE_RECOVERY_LEASES.has(name))) {
        const invalid = inspectDescriptorRelativeEntryIdentity(vault.descriptor, name);
        if (invalid.exists) unlinkOwnedDescriptorEntry(vault, name, invalid.identity, { sync: false });
      }
      continue;
    }
    if (!ownerRecordIsOrphan(lease.record?.owner, ACTIVE_RECOVERY_LEASES.has(name))) continue;
    const confirmed = readDescriptorJsonRecord(vault.descriptor, name, LOCK_RECORD_MAX_BYTES, 'scoped_materialization_recovery_lease_unsafe');
    if (!sameStableEntryIdentity(lease.identity, confirmed.identity)
      || JSON.stringify(lease.record) !== JSON.stringify(confirmed.record)
      || !ownerRecordIsOrphan(confirmed.record?.owner, ACTIVE_RECOVERY_LEASES.has(name))) continue;
    unlinkOwnedDescriptorEntry(vault, name, confirmed.identity, { sync: false });
  }
  fs.fsyncSync(vault.descriptor);
}

function pendingOperationRecordOwner(name) {
  const match = /^\.pending-(?:record|definition)-(\d+)-([A-Za-z0-9_.]+)-/.exec(name);
  return match ? { pid: Number(match[1]), pidStartTime: match[2] === 'unknown' ? null : match[2] } : null;
}

function cleanupStaleOperationRecordTemps(vault) {
  for (const name of fs.readdirSync(descriptorEntryPath(vault.descriptor, '.'))
    .filter((entry) => (
      entry.startsWith('.pending-record-') || entry.startsWith('.pending-definition-')
    ) && entry.endsWith('.json'))) {
    const owner = pendingOperationRecordOwner(name);
    if (!ownerRecordIsOrphan(owner, ACTIVE_OPERATION_RECORD_TEMPS.has(name))) continue;
    let loaded;
    try {
      loaded = readDescriptorJsonRecord(
        vault.descriptor,
        name,
        RECOVERY_INTENT_MAX_BYTES,
        'scoped_materialization_operation_record_unsafe',
      );
    } catch {
      const current = inspectDescriptorRelativeEntryIdentity(vault.descriptor, name);
      if (current.exists && ownerRecordIsOrphan(owner, ACTIVE_OPERATION_RECORD_TEMPS.has(name))) {
        unlinkOwnedDescriptorEntry(vault, name, current.identity, { sync: false });
      }
      continue;
    }
    if (!ownerRecordIsOrphan(owner, ACTIVE_OPERATION_RECORD_TEMPS.has(name))) continue;
    const record = loaded.record;
    const definitionTemp = name.startsWith('.pending-definition-');
    const finalName = definitionTemp
      ? scopedMaterializationOperationDefinitionName(record?.definition?.operationId)
      : scopedMaterializationOperationRecordName(
        record?.binding?.operationId,
        record?.status,
        record?.binding?.relative,
      );
    if (definitionTemp) verifyScopedMaterializationOperationDefinitionRecord(record, finalName);
    else verifyScopedMaterializationOperationRecord(record, finalName, record.status);
    const published = inspectDescriptorRelativeEntryIdentity(vault.descriptor, finalName);
    if (published.exists && !sameEntryIdentity(published.identity, loaded.identity)) {
      throw errorWithBlockers('scoped_materialization_operation_definition_conflict', record.binding.relative);
    }
    unlinkOwnedDescriptorEntry(vault, name, loaded.identity, { sync: false });
  }
  fs.fsyncSync(vault.descriptor);
}
