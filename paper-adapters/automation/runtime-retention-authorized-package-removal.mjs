import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  retentionMemberHash,
  retentionPathExists,
} from './runtime-retention-scope-repository.mjs';

const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PROC_DESCRIPTOR_PATH = /^\/proc\/self\/fd\/[0-9]+$/;
const MV = '/usr/bin/mv';
const STABLE_FIELDS = Object.freeze([
  'dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink', 'entryKind',
]);

function sameIdentity(left, right) {
  return Boolean(left && right && STABLE_FIELDS.every((field) =>
    String(left[field]) === String(right[field])));
}

function descriptorIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    nlink: String(stat.nlink),
    entryKind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsafe',
  });
}

function sameTreeIdentity(expected, observed, { unsealedDirectory = false } = {}) {
  return sameIdentity(
    unsealedDirectory ? { ...expected, mode: observed?.mode } : expected,
    observed,
  );
}

function sameNames(names, entries) {
  return names.length === entries.length
    && names.every((name, index) => name === entries[index]?.name);
}

function safeNames(directoryDescriptorPath) {
  return fs.readdirSync(directoryDescriptorPath, { encoding: 'buffer' })
    .sort((left, right) => Buffer.compare(left, right))
    .map((rawName) => {
      const name = rawName.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(rawName)
        || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        throw new Error('runtime_retention_package_removal_entry_name_invalid');
      }
      return name;
    });
}

function openPinned(candidate, expectedKind, expectedDevice) {
  const before = fs.lstatSync(candidate, { bigint: true });
  if (before.isSymbolicLink()
    || (expectedKind === 'directory' ? !before.isDirectory() : !before.isFile())) {
    throw new Error('runtime_retention_package_removal_entry_unsafe');
  }
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY
      | (expectedKind === 'directory' ? DIRECTORY_ONLY : 0)
      | NO_FOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino
      || (expectedKind === 'directory' ? !opened.isDirectory() : !opened.isFile())
      || (expectedDevice !== null && opened.dev !== expectedDevice)) {
      throw new Error('runtime_retention_package_removal_entry_identity_changed');
    }
    return Object.freeze({ descriptor, opened });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function openPinnedParent(candidate) {
  if (!PROC_DESCRIPTOR_PATH.test(candidate)) {
    return openPinned(candidate, 'directory', null);
  }
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | DIRECTORY_ONLY);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()) {
      throw new Error('runtime_retention_package_removal_entry_unsafe');
    }
    return Object.freeze({ descriptor, opened });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function trustedMoveBinaryIdentity() {
  const stat = fs.lstatSync(MV, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()
    || stat.uid !== 0n || stat.gid !== 0n
    || stat.nlink !== 1n
    || (Number(stat.mode) & 0o022) !== 0) {
    throw new Error('runtime_retention_package_removal_move_binary_untrusted');
  }
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  });
}

function moveNoReplaceSync(
  sourceDirectoryDescriptor,
  sourceName,
  targetDirectoryDescriptor,
  targetName,
) {
  if ([sourceName, targetName].some((name) => !name || name === '.' || name === '..'
    || name.includes('/') || name.includes('\0'))) {
    throw new Error('runtime_retention_package_removal_entry_name_invalid');
  }
  const moveBinaryBefore = trustedMoveBinaryIdentity();
  const moved = spawnSync(MV, [
    '--no-copy',
    '--no-clobber',
    '--no-target-directory',
    '--',
    `/proc/self/fd/3/${sourceName}`,
    `/proc/self/fd/4/${targetName}`,
  ], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: [
      'ignore',
      'pipe',
      'pipe',
      sourceDirectoryDescriptor,
      targetDirectoryDescriptor,
    ],
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  const moveBinaryAfter = trustedMoveBinaryIdentity();
  if (JSON.stringify(moveBinaryBefore) !== JSON.stringify(moveBinaryAfter)
    || moved.error || moved.signal || moved.status !== 0
    || moved.stdout || moved.stderr) {
    throw new Error('runtime_retention_package_removal_no_replace_move_failed');
  }
}

function sealDirectoryTree(directoryDescriptor, expectedDevice) {
  const descriptorPath = `/proc/self/fd/${directoryDescriptor}`;
  for (const name of safeNames(descriptorPath)) {
    const child = path.join(descriptorPath, name);
    const observed = fs.lstatSync(child, { bigint: true });
    if (!observed.isDirectory() || observed.isSymbolicLink()) continue;
    const pinned = openPinned(child, 'directory', expectedDevice);
    try { sealDirectoryTree(pinned.descriptor, expectedDevice); }
    finally { fs.closeSync(pinned.descriptor); }
  }
  const before = fs.fstatSync(directoryDescriptor, { bigint: true });
  fs.fchmodSync(directoryDescriptor, Number(before.mode) & 0o5555);
  fs.fsyncSync(directoryDescriptor);
}

function assertSealedRegularTree(directoryDescriptor, expectedDevice) {
  const directory = fs.fstatSync(directoryDescriptor, { bigint: true });
  if (!directory.isDirectory() || directory.dev !== expectedDevice
    || (Number(directory.mode) & 0o222) !== 0) {
    throw new Error('runtime_retention_package_removal_tree_not_sealed');
  }
  const descriptorPath = `/proc/self/fd/${directoryDescriptor}`;
  const entries = [];
  for (const name of safeNames(descriptorPath)) {
    const child = path.join(descriptorPath, name);
    const initial = fs.lstatSync(child, { bigint: true });
    if (initial.isDirectory() && !initial.isSymbolicLink()) {
      const pinned = openPinned(child, 'directory', expectedDevice);
      try {
        entries.push(Object.freeze({
          name,
          kind: 'directory',
          tree: assertSealedRegularTree(pinned.descriptor, expectedDevice),
        }));
      }
      finally { fs.closeSync(pinned.descriptor); }
    } else if (initial.isFile() && !initial.isSymbolicLink()) {
      const pinned = openPinned(child, 'file', expectedDevice);
      try {
        const completed = fs.fstatSync(pinned.descriptor, { bigint: true });
        if (completed.nlink !== 1n || (Number(completed.mode) & 0o222) !== 0) {
          throw new Error('runtime_retention_package_removal_tree_not_sealed');
        }
        entries.push(Object.freeze({
          name,
          kind: 'file',
          identity: descriptorIdentity(completed),
        }));
      } finally { fs.closeSync(pinned.descriptor); }
    } else {
      throw new Error('runtime_retention_package_removal_entry_unsafe');
    }
    const completed = fs.lstatSync(child, { bigint: true });
    if (initial.dev !== completed.dev || initial.ino !== completed.ino
      || initial.mode !== completed.mode) {
      throw new Error('runtime_retention_package_removal_entry_identity_changed');
    }
  }
  const completed = fs.fstatSync(directoryDescriptor, { bigint: true });
  if (directory.dev !== completed.dev || directory.ino !== completed.ino
    || directory.mode !== completed.mode) {
    throw new Error('runtime_retention_package_removal_entry_identity_changed');
  }
  return Object.freeze({
    identity: descriptorIdentity(completed),
    entries: Object.freeze(entries),
  });
}

function unsealRegularTree(
  directoryDescriptor,
  expectedDevice,
  changedDirectories,
  snapshot,
  relative = '',
) {
  const descriptorPath = `/proc/self/fd/${directoryDescriptor}`;
  const names = safeNames(descriptorPath);
  if (!sameNames(names, snapshot.entries)
    || !sameTreeIdentity(snapshot.identity, descriptorIdentity(
      fs.fstatSync(directoryDescriptor, { bigint: true }),
    ))) {
    throw new Error('runtime_retention_package_removal_entry_identity_changed');
  }
  for (const [index, name] of names.entries()) {
    const expected = snapshot.entries[index];
    const child = path.join(descriptorPath, name);
    const initial = fs.lstatSync(child, { bigint: true });
    if (expected.kind === 'directory'
      && initial.isDirectory() && !initial.isSymbolicLink()) {
      const pinned = openPinned(child, 'directory', expectedDevice);
      try {
        if (!sameTreeIdentity(expected.tree.identity, descriptorIdentity(pinned.opened))
          || (Number(pinned.opened.mode) & 0o222) !== 0) {
          throw new Error('runtime_retention_package_removal_tree_not_sealed');
        }
        unsealRegularTree(
          pinned.descriptor,
          expectedDevice,
          changedDirectories,
          expected.tree,
          relative ? `${relative}/${name}` : name,
        );
      } finally { fs.closeSync(pinned.descriptor); }
    } else if (expected.kind !== 'file'
      || !initial.isFile() || initial.isSymbolicLink()
      || !sameTreeIdentity(expected.identity, descriptorIdentity(initial))
      || initial.nlink !== 1n || (Number(initial.mode) & 0o222) !== 0) {
      throw new Error('runtime_retention_package_removal_tree_not_sealed');
    }
  }
  const before = fs.fstatSync(directoryDescriptor, { bigint: true });
  if ((Number(before.mode) & 0o222) !== 0) {
    throw new Error('runtime_retention_package_removal_tree_not_sealed');
  }
  changedDirectories.push(Object.freeze({
    relative,
    identity: descriptorIdentity(before),
    mode: Number(before.mode) & 0o7777,
  }));
  fs.fchmodSync(directoryDescriptor, (Number(before.mode) & 0o7777) | 0o200);
  fs.fsyncSync(directoryDescriptor);
  const after = fs.fstatSync(directoryDescriptor, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino
    || (Number(after.mode) & 0o200) === 0) {
    throw new Error('runtime_retention_package_removal_unseal_failed');
  }
}

function isolatePinnedEntry(
  source,
  sourceDirectoryDescriptor,
  pinned,
  deletionLaneDescriptor,
) {
  const laneDescriptorPath = `/proc/self/fd/${deletionLaneDescriptor}`;
  const containerEntry = fs.mkdtempSync(path.join(laneDescriptorPath, '.entry-'));
  const container = openPinned(containerEntry, 'directory', pinned.opened.dev);
  fs.fsyncSync(deletionLaneDescriptor);
  const isolatedEntry = path.join(`/proc/self/fd/${container.descriptor}`, 'entry');
  let moved = false;
  try {
    moveNoReplaceSync(
      sourceDirectoryDescriptor,
      path.basename(source),
      container.descriptor,
      'entry',
    );
    moved = true;
    fs.fsyncSync(sourceDirectoryDescriptor);
    fs.fsyncSync(container.descriptor);
    const atPath = fs.lstatSync(isolatedEntry, { bigint: true });
    const opened = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (atPath.dev !== opened.dev || atPath.ino !== opened.ino) {
      throw new Error('runtime_retention_package_removal_isolation_identity_changed');
    }
    if (retentionPathExists(source)) {
      throw new Error('runtime_retention_package_removal_source_advanced');
    }
    return Object.freeze({ container, containerEntry, isolatedEntry });
  } catch (error) {
    if (moved && retentionPathExists(isolatedEntry) && !retentionPathExists(source)) {
      try {
        moveNoReplaceSync(
          container.descriptor,
          'entry',
          sourceDirectoryDescriptor,
          path.basename(source),
        );
        fs.fsyncSync(sourceDirectoryDescriptor);
        fs.fsyncSync(container.descriptor);
      } catch {
        // Preserve both names in quarantine rather than deleting either one.
      }
    }
    if (safeNames(`/proc/self/fd/${container.descriptor}`).length === 0) {
      fs.rmdirSync(containerEntry);
      fs.fsyncSync(deletionLaneDescriptor);
    } else {
      fs.fchmodSync(container.descriptor, 0o500);
      fs.fsyncSync(container.descriptor);
    }
    fs.closeSync(container.descriptor);
    throw error;
  }
}

function removePinnedTreeContents(
  directoryDescriptor,
  expectedDevice,
  snapshot,
  deletionLaneDescriptor,
) {
  const descriptorPath = `/proc/self/fd/${directoryDescriptor}`;
  const directory = descriptorIdentity(fs.fstatSync(directoryDescriptor, { bigint: true }));
  const names = safeNames(descriptorPath);
  if (!sameTreeIdentity(snapshot.identity, directory, { unsealedDirectory: true })
    || !sameNames(names, snapshot.entries)) {
    throw new Error('runtime_retention_package_removal_isolated_tree_changed');
  }
  for (const [index, name] of names.entries()) {
    const expected = snapshot.entries[index];
    const child = path.join(descriptorPath, name);
    const pinned = openPinned(child, expected.kind, expectedDevice);
    try {
      const observed = descriptorIdentity(pinned.opened);
      const identityMatches = expected.kind === 'directory'
        ? sameTreeIdentity(expected.tree.identity, observed, { unsealedDirectory: true })
        : sameTreeIdentity(expected.identity, observed);
      if (!identityMatches || (expected.kind === 'file' && pinned.opened.nlink !== 1n)) {
        throw new Error('runtime_retention_package_removal_isolated_tree_changed');
      }
      const isolated = isolatePinnedEntry(
        child,
        directoryDescriptor,
        pinned,
        deletionLaneDescriptor,
      );
      try {
        if (expected.kind === 'directory') {
          removePinnedTreeContents(
            pinned.descriptor,
            expectedDevice,
            expected.tree,
            deletionLaneDescriptor,
          );
          const pathIdentity = fs.lstatSync(isolated.isolatedEntry, { bigint: true });
          const openIdentity = fs.fstatSync(pinned.descriptor, { bigint: true });
          if (pathIdentity.dev !== openIdentity.dev || pathIdentity.ino !== openIdentity.ino) {
            throw new Error('runtime_retention_package_removal_isolated_tree_changed');
          }
          fs.rmdirSync(isolated.isolatedEntry);
          if (fs.fstatSync(pinned.descriptor, { bigint: true }).nlink !== 0n) {
            throw new Error('runtime_retention_package_removal_isolated_tree_changed');
          }
        } else {
          const completed = fs.lstatSync(isolated.isolatedEntry, { bigint: true });
          if (!sameTreeIdentity(expected.identity, descriptorIdentity(completed))) {
            throw new Error('runtime_retention_package_removal_isolated_tree_changed');
          }
          fs.unlinkSync(isolated.isolatedEntry);
          if (fs.fstatSync(pinned.descriptor, { bigint: true }).nlink !== 0n) {
            throw new Error('runtime_retention_package_removal_isolated_tree_changed');
          }
        }
        fs.fsyncSync(isolated.container.descriptor);
        fs.rmdirSync(isolated.containerEntry);
        fs.fsyncSync(deletionLaneDescriptor);
      } finally {
        fs.closeSync(isolated.container.descriptor);
      }
    } finally { fs.closeSync(pinned.descriptor); }
  }
  if (safeNames(descriptorPath).length !== 0) {
    throw new Error('runtime_retention_package_removal_isolated_tree_changed');
  }
}

function restoreSealedModes(rootDescriptor, changedDirectories) {
  const rootDescriptorPath = `/proc/self/fd/${rootDescriptor}`;
  const failures = [];
  for (const changed of [...changedDirectories].reverse()) {
    try {
      if (!changed.relative) {
        const observed = descriptorIdentity(fs.fstatSync(rootDescriptor, { bigint: true }));
        if (!sameIdentity({ ...changed.identity, mode: observed.mode }, observed)) {
          throw new Error('runtime_retention_package_removal_rollback_identity_changed');
        }
        fs.fchmodSync(rootDescriptor, changed.mode);
        fs.fsyncSync(rootDescriptor);
        continue;
      }
      const candidate = changed.relative
        ? path.join(rootDescriptorPath, ...changed.relative.split('/'))
        : rootDescriptorPath;
      const pinned = openPinned(candidate, 'directory', null);
      try {
        const observed = descriptorIdentity(pinned.opened);
        if (!sameIdentity({ ...changed.identity, mode: observed.mode }, observed)) {
          throw new Error('runtime_retention_package_removal_rollback_identity_changed');
        }
        fs.fchmodSync(pinned.descriptor, changed.mode);
        fs.fsyncSync(pinned.descriptor);
      } finally { fs.closeSync(pinned.descriptor); }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, 'runtime_retention_package_removal_reseal_failed');
  }
}

function assertPackageDeletionAuthorization(authorization, expectedContentHash) {
  const evidence = authorization?.retentionDeletionEvidence;
  const { runtimeRetentionDeletionEvidenceHash = null, ...payload } = evidence || {};
  if (authorization?.authorized !== true
    || authorization.category !== 'packages'
    || evidence?.status !== 'retention_deletion_authorized'
    || evidence.category !== 'packages'
    || path.resolve(String(evidence.path || '')) !== path.resolve(String(authorization.sourcePath || ''))
    || evidence.contentHash !== expectedContentHash
    || !SHA256_PATTERN.test(String(runtimeRetentionDeletionEvidenceHash || ''))
    || hashRecord('RuntimeRetentionDeletionEvidence', payload)
      !== runtimeRetentionDeletionEvidenceHash) {
    throw new Error('runtime_retention_package_removal_authorization_invalid');
  }
}

export function removeAuthorizedSealedPackageTreeSync({
  candidate,
  expectedContentHash,
  expectedIdentity,
  authorization,
} = {}) {
  assertPackageDeletionAuthorization(authorization, expectedContentHash);
  const resolvedCandidate = path.resolve(String(candidate || ''));
  if (path.dirname(resolvedCandidate) === resolvedCandidate) {
    throw new Error('runtime_retention_package_removal_preimage_changed');
  }
  const parent = openPinnedParent(path.dirname(resolvedCandidate));
  const parentDescriptorPath = `/proc/self/fd/${parent.descriptor}`;
  const candidateEntry = path.join(parentDescriptorPath, path.basename(resolvedCandidate));
  let pinned = null;
  let staging = null;
  let deletionLane = null;
  let stagingEntry = null;
  let deletionLaneEntry = null;
  let isolatedEntry = null;
  const changedDirectories = [];
  let isolated = false;
  let removalStarted = false;
  let removed = false;
  try {
    pinned = openPinned(candidateEntry, 'directory', parent.opened.dev);
    const observedIdentity = descriptorIdentity(pinned.opened);
    if (!sameIdentity(observedIdentity, expectedIdentity)
      || retentionMemberHash(candidateEntry) !== expectedContentHash
      || fs.realpathSync.native(candidateEntry)
        !== fs.realpathSync.native(`/proc/self/fd/${pinned.descriptor}`)) {
      throw new Error('runtime_retention_package_removal_preimage_changed');
    }
    const snapshot = assertSealedRegularTree(pinned.descriptor, pinned.opened.dev);
    unsealRegularTree(
      pinned.descriptor,
      pinned.opened.dev,
      changedDirectories,
      snapshot,
    );
    if (retentionMemberHash(candidateEntry) !== expectedContentHash) {
      throw new Error('runtime_retention_package_removal_preimage_changed');
    }
    const pathIdentity = fs.lstatSync(candidateEntry, { bigint: true });
    const openIdentity = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (pathIdentity.dev !== openIdentity.dev || pathIdentity.ino !== openIdentity.ino) {
      throw new Error('runtime_retention_package_removal_preimage_changed');
    }

    stagingEntry = fs.mkdtempSync(path.join(
      parentDescriptorPath,
      '.hepta-retention-package-delete-',
    ));
    staging = openPinned(stagingEntry, 'directory', parent.opened.dev);
    deletionLaneEntry = path.join(`/proc/self/fd/${staging.descriptor}`, 'entries');
    fs.mkdirSync(deletionLaneEntry, { mode: 0o700 });
    deletionLane = openPinned(deletionLaneEntry, 'directory', parent.opened.dev);
    isolatedEntry = path.join(`/proc/self/fd/${staging.descriptor}`, 'package');
    moveNoReplaceSync(
      parent.descriptor,
      path.basename(resolvedCandidate),
      staging.descriptor,
      'package',
    );
    isolated = true;
    fs.fsyncSync(parent.descriptor);
    fs.fsyncSync(staging.descriptor);
    const isolatedIdentity = fs.lstatSync(isolatedEntry, { bigint: true });
    const isolatedOpenIdentity = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (isolatedIdentity.dev !== isolatedOpenIdentity.dev
      || isolatedIdentity.ino !== isolatedOpenIdentity.ino
      || retentionMemberHash(isolatedEntry) !== expectedContentHash) {
      throw new Error('runtime_retention_package_removal_isolation_identity_changed');
    }
    if (retentionPathExists(candidateEntry)) {
      throw new Error('runtime_retention_package_removal_source_advanced');
    }

    removalStarted = true;
    removePinnedTreeContents(
      pinned.descriptor,
      pinned.opened.dev,
      snapshot,
      deletionLane.descriptor,
    );
    if (retentionPathExists(candidateEntry)) {
      throw new Error('runtime_retention_package_removal_source_advanced');
    }
    const isolatedRootIdentity = fs.lstatSync(isolatedEntry, { bigint: true });
    const openRootIdentity = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (isolatedRootIdentity.dev !== openRootIdentity.dev
      || isolatedRootIdentity.ino !== openRootIdentity.ino) {
      throw new Error('runtime_retention_package_removal_isolation_identity_changed');
    }
    fs.rmdirSync(isolatedEntry);
    if (fs.fstatSync(pinned.descriptor, { bigint: true }).nlink !== 0n) {
      throw new Error('runtime_retention_package_removal_postimage_invalid');
    }
    fs.fsyncSync(staging.descriptor);
    if (safeNames(`/proc/self/fd/${deletionLane.descriptor}`).length !== 0) {
      throw new Error('runtime_retention_package_removal_postimage_invalid');
    }
    fs.rmdirSync(deletionLaneEntry);
    fs.fsyncSync(staging.descriptor);
    fs.rmdirSync(stagingEntry);
    fs.fsyncSync(parent.descriptor);
    removed = true;
    if (retentionPathExists(candidateEntry)
      || retentionPathExists(stagingEntry)) {
      throw new Error('runtime_retention_package_removal_postimage_invalid');
    }
  } catch (error) {
    const recoveryErrors = [];
    if (!removed && pinned && changedDirectories.length) {
      try { restoreSealedModes(pinned.descriptor, changedDirectories); }
      catch (restoreError) { recoveryErrors.push(restoreError); }
    }
    if (isolated && !removalStarted && isolatedEntry && retentionPathExists(isolatedEntry)) {
      try {
        if (!retentionPathExists(candidateEntry)) {
          moveNoReplaceSync(
            staging.descriptor,
            'package',
            parent.descriptor,
            path.basename(resolvedCandidate),
          );
          fs.fsyncSync(parent.descriptor);
          fs.fsyncSync(staging.descriptor);
          isolated = false;
        }
      } catch (restoreError) { recoveryErrors.push(restoreError); }
    }
    if (staging && stagingEntry && retentionPathExists(stagingEntry)) {
      try {
        if (safeNames(`/proc/self/fd/${staging.descriptor}`).length === 0) {
          fs.rmdirSync(stagingEntry);
          fs.fsyncSync(parent.descriptor);
        } else {
          sealDirectoryTree(staging.descriptor, parent.opened.dev);
        }
      } catch (quarantineError) { recoveryErrors.push(quarantineError); }
    }
    if (recoveryErrors.length) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        'runtime_retention_package_removal_failed_and_reseal_failed',
      );
    }
    throw error;
  } finally {
    if (pinned) fs.closeSync(pinned.descriptor);
    if (deletionLane) fs.closeSync(deletionLane.descriptor);
    if (staging) fs.closeSync(staging.descriptor);
    fs.closeSync(parent.descriptor);
  }
}
