import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  COPY_BUFFER_BYTES,
  assertOpenedParentStillScoped,
  candidateFor,
  descriptorEntryPath,
  ensureSafeParent,
  inspectDescriptorRelativeEntryIdentity,
  inspectDescriptorRelativeRegularFile,
  openVerifiedParentDirectory,
  openVerifiedRegularFile,
  verifyOpenedSourceUnchanged,
  writeDescriptorFully,
} from '../runtime/scoped-file-materialization-path-io.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const NO_CLOBBER_MOVE_EXECUTABLE = '/usr/bin/mv';

function sameDescriptorIdentity(stat, identity) {
  return identity
    && String(stat.dev) === identity.device
    && String(stat.ino) === identity.inode
    && String(stat.mode) === identity.mode;
}

function sameDescriptorObject(stat, identity) {
  return identity
    && String(stat.dev) === identity.device
    && String(stat.ino) === identity.inode;
}

function descriptorIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
  };
}

function cleanupIdentityChanged(name, quarantineName = null) {
  const error = new Error(
    `gpu_scientific_artifact_body_archive_cleanup_identity_changed:${name}`,
  );
  error.code = 'gpu_scientific_artifact_body_archive_cleanup_identity_changed';
  error.entryName = name;
  error.quarantineName = quarantineName;
  return error;
}

function cleanupQuarantineName(openedParent) {
  const packagePathHash = crypto.createHash('sha256')
    .update(path.resolve(openedParent.scope.root), 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `.gpu-archive-cleanup-${packagePathHash}`;
}

function trustedNoClobberMoveExecutable(stat) {
  return stat.isFile() && !stat.isSymbolicLink()
    && stat.uid === 0n && stat.gid === 0n && stat.nlink === 1n
    && (stat.mode & 0o022n) === 0n;
}

function moveOwnedEntryNoClobber(openedParent, name, quarantine) {
  let executableDescriptor;
  try {
    const selected = fs.lstatSync(NO_CLOBBER_MOVE_EXECUTABLE, { bigint: true });
    if (!trustedNoClobberMoveExecutable(selected)) {
      throw cleanupIdentityChanged(name, quarantine.name);
    }
    executableDescriptor = fs.openSync(
      NO_CLOBBER_MOVE_EXECUTABLE,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(executableDescriptor, { bigint: true });
    if (!trustedNoClobberMoveExecutable(opened)
      || !sameDescriptorIdentity(selected, descriptorIdentity(opened))) {
      throw cleanupIdentityChanged(name, quarantine.name);
    }
    const result = spawnSync(NO_CLOBBER_MOVE_EXECUTABLE, [
      '-n', '--no-copy', '-T', '--',
      `/proc/self/fd/3/${name}`,
      '/proc/self/fd/4/owned-entry',
    ], {
      encoding: 'utf8',
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      stdio: [
        'ignore', 'pipe', 'pipe',
        openedParent.descriptor, quarantine.descriptor,
      ],
      timeout: 10_000,
      windowsHide: true,
    });
    const selectedAfter = fs.lstatSync(
      NO_CLOBBER_MOVE_EXECUTABLE,
      { bigint: true },
    );
    const openedAfter = fs.fstatSync(executableDescriptor, { bigint: true });
    if (!trustedNoClobberMoveExecutable(selectedAfter)
      || !trustedNoClobberMoveExecutable(openedAfter)
      || !sameDescriptorIdentity(selectedAfter, descriptorIdentity(selected))
      || !sameDescriptorIdentity(openedAfter, descriptorIdentity(selected))) {
      throw cleanupIdentityChanged(name, quarantine.name);
    }
    return {
      errorCode: result.error?.code || null,
      signal: result.signal || null,
      status: result.status,
    };
  } catch (error) {
    if (error?.code === 'gpu_scientific_artifact_body_archive_cleanup_identity_changed') {
      throw error;
    }
    const wrapped = cleanupIdentityChanged(name, quarantine.name);
    wrapped.moveError = error;
    throw wrapped;
  } finally {
    if (executableDescriptor !== undefined) fs.closeSync(executableDescriptor);
  }
}

function preserveQuarantinedReplacement(openedParent, name, quarantine) {
  try {
    fs.linkSync(
      descriptorEntryPath(quarantine.descriptor, 'owned-entry'),
      descriptorEntryPath(openedParent.descriptor, name),
    );
    fs.fsyncSync(openedParent.descriptor);
    fs.fsyncSync(quarantine.descriptor);
  } catch (error) {
    if (error?.code !== 'EEXIST') return error;
  }
  return null;
}

function assertCleanupQuarantineCurrent(openedParent, quarantine, {
  empty = false,
} = {}) {
  assertOpenedParentStillScoped(openedParent);
  assertOpenedParentStillScoped(quarantine.parent);
  let packageRoot;
  try {
    packageRoot = fs.lstatSync(
      descriptorEntryPath(
        quarantine.parent.descriptor,
        path.basename(openedParent.scope.root),
      ),
      { bigint: true },
    );
  } catch {
    throw cleanupIdentityChanged(quarantine.entryName, quarantine.name);
  }
  if (!packageRoot.isDirectory() || packageRoot.isSymbolicLink()
    || !sameDescriptorIdentity(packageRoot, openedParent.scope.identity)) {
    throw cleanupIdentityChanged(quarantine.entryName, quarantine.name);
  }
  let selected;
  try {
    selected = fs.lstatSync(quarantine.path, { bigint: true });
  } catch {
    throw cleanupIdentityChanged(quarantine.entryName, quarantine.name);
  }
  const opened = fs.fstatSync(quarantine.descriptor, { bigint: true });
  if (!selected.isDirectory() || selected.isSymbolicLink()
    || !opened.isDirectory()
    || !sameDescriptorIdentity(selected, quarantine.identity)
    || !sameDescriptorIdentity(opened, quarantine.identity)
    || (empty && fs.readdirSync(
      descriptorEntryPath(quarantine.descriptor, '.'),
    ).length !== 0)) {
    throw cleanupIdentityChanged(quarantine.entryName, quarantine.name);
  }
}

function openCleanupQuarantine(openedParent, name) {
  const quarantineName = cleanupQuarantineName(openedParent);
  let parent;
  let descriptor;
  try {
    parent = openVerifiedParentDirectory(
      path.dirname(openedParent.scope.root),
      openedParent.scope.root,
    );
    const quarantinePath = descriptorEntryPath(parent.descriptor, quarantineName);
    fs.mkdirSync(quarantinePath, { mode: 0o700 });
    descriptor = fs.openSync(
      quarantinePath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
        | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory()) throw cleanupIdentityChanged(name, quarantineName);
    const quarantine = {
      descriptor,
      entryName: name,
      identity: descriptorIdentity(stat),
      name: quarantineName,
      parent,
      path: quarantinePath,
    };
    assertCleanupQuarantineCurrent(openedParent, quarantine, { empty: true });
    return quarantine;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (parent?.descriptor !== undefined) fs.closeSync(parent.descriptor);
    if (error?.code === 'gpu_scientific_artifact_body_archive_cleanup_identity_changed') {
      throw error;
    }
    const wrapped = cleanupIdentityChanged(name, quarantineName);
    wrapped.quarantineError = error;
    throw wrapped;
  }
}

function removeEmptyCleanupQuarantine(openedParent, quarantine, {
  faultInjector = null,
} = {}) {
  assertCleanupQuarantineCurrent(openedParent, quarantine, { empty: true });
  faultInjector?.({
    stage: 'before_cleanup_quarantine_directory_remove',
    entryName: quarantine.entryName,
    quarantineName: quarantine.name,
    quarantinePath: quarantine.path,
  });
  assertCleanupQuarantineCurrent(openedParent, quarantine, { empty: true });
  fs.rmdirSync(descriptorEntryPath(quarantine.parent.descriptor, quarantine.name));
  fs.fsyncSync(quarantine.parent.descriptor);
  const opened = fs.fstatSync(quarantine.descriptor, { bigint: true });
  let replacementExists = false;
  try {
    fs.lstatSync(
      descriptorEntryPath(quarantine.parent.descriptor, quarantine.name),
      { bigint: true },
    );
    replacementExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw cleanupIdentityChanged(quarantine.entryName, quarantine.name);
    }
  }
  if (!opened.isDirectory()
    || !sameDescriptorIdentity(opened, quarantine.identity)
    || Number(opened.nlink) !== 0
    || replacementExists) {
    throw cleanupIdentityChanged(quarantine.entryName, quarantine.name);
  }
}

function unlinkOwnedEntry(openedParent, name, identity, {
  faultInjector = null,
} = {}) {
  let descriptor;
  let quarantine;
  try {
    descriptor = fs.openSync(
      descriptorEntryPath(openedParent.descriptor, name),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || Number(opened.nlink) !== 1
      || !sameDescriptorIdentity(opened, identity)) {
      throw cleanupIdentityChanged(name);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    if (error?.code === 'ENOENT') return false;
    if (error?.code === 'gpu_scientific_artifact_body_archive_cleanup_identity_changed') {
      throw error;
    }
    throw cleanupIdentityChanged(name);
  }
  try {
    assertOpenedParentStillScoped(openedParent);
    quarantine = openCleanupQuarantine(openedParent, name);
    const openedBeforeMove = fs.fstatSync(descriptor, { bigint: true });
    if (!openedBeforeMove.isFile() || Number(openedBeforeMove.nlink) !== 1
      || !sameDescriptorIdentity(openedBeforeMove, identity)) {
      throw cleanupIdentityChanged(name, quarantine.name);
    }
    assertCleanupQuarantineCurrent(openedParent, quarantine, { empty: true });
    faultInjector?.({
      stage: 'before_owned_entry_no_clobber_move',
      entryName: name,
      quarantineName: quarantine.name,
      quarantinePath: quarantine.path,
    });
    const moveResult = moveOwnedEntryNoClobber(
      openedParent,
      name,
      quarantine,
    );
    fs.fsyncSync(openedParent.descriptor);
    fs.fsyncSync(quarantine.descriptor);
    assertCleanupQuarantineCurrent(openedParent, quarantine);
    let movedStat;
    try {
      movedStat = fs.lstatSync(
        descriptorEntryPath(quarantine.descriptor, 'owned-entry'),
        { bigint: true },
      );
    } catch {
      const error = cleanupIdentityChanged(name, quarantine.name);
      error.moveResult = moveResult;
      throw error;
    }
    const openedAfterMove = fs.fstatSync(descriptor, { bigint: true });
    if (!movedStat.isFile() || movedStat.isSymbolicLink()
      || Number(movedStat.nlink) !== 1
      || !sameDescriptorIdentity(movedStat, identity)
      || !sameDescriptorIdentity(openedAfterMove, identity)
      || moveResult.errorCode !== null || moveResult.signal !== null
      || moveResult.status !== 0) {
      const preservationError = preserveQuarantinedReplacement(
        openedParent,
        name,
        quarantine,
      );
      const error = cleanupIdentityChanged(name, quarantine.name);
      if (preservationError) error.preservationError = preservationError;
      error.moveResult = moveResult;
      throw error;
    }
    faultInjector?.({
      stage: 'before_quarantine_unlink',
      entryName: name,
      quarantineName: quarantine.name,
      quarantinePath: quarantine.path,
      unlinkAuthorized: true,
    });
    assertCleanupQuarantineCurrent(openedParent, quarantine);
    const retainedStat = fs.lstatSync(
      descriptorEntryPath(quarantine.descriptor, 'owned-entry'),
      { bigint: true },
    );
    const retainedDescriptorStat = fs.fstatSync(descriptor, { bigint: true });
    if (!retainedStat.isFile() || retainedStat.isSymbolicLink()
      || Number(retainedStat.nlink) !== 1
      || !sameDescriptorIdentity(retainedStat, identity)
      || !sameDescriptorIdentity(retainedDescriptorStat, identity)) {
      throw cleanupIdentityChanged(name, quarantine.name);
    }
    fs.unlinkSync(descriptorEntryPath(quarantine.descriptor, 'owned-entry'));
    fs.fsyncSync(quarantine.descriptor);
    const removedDescriptorStat = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDescriptorIdentity(removedDescriptorStat, identity)
      || Number(removedDescriptorStat.nlink) !== 0) {
      throw cleanupIdentityChanged(name, quarantine.name);
    }
    removeEmptyCleanupQuarantine(openedParent, quarantine, { faultInjector });
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (quarantine?.descriptor !== undefined) {
      fs.closeSync(quarantine.descriptor);
    }
    if (quarantine?.parent?.descriptor !== undefined) {
      fs.closeSync(quarantine.parent.descriptor);
    }
  }
}

export function installGpuScientificArtifactBodyArchiveFileSync({
  packageDir,
  destinationRelative,
  maximumBytes,
  expectedHash,
  expectedBytes,
  sourceRoot = null,
  sourceRelative = null,
  content = null,
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1
    || expectedBytes > maximumBytes
    || !SHA256.test(String(expectedHash || ''))) {
    throw new Error('gpu_scientific_artifact_body_archive_copy_authority_invalid');
  }
  const destination = candidateFor(path.resolve(packageDir), destinationRelative);
  ensureSafeParent(packageDir, destination.candidate);
  const openedParent = openVerifiedParentDirectory(packageDir, destination.candidate);
  const targetName = path.basename(destination.candidate);
  const temporaryName = `.${targetName}.gpu-archive-${crypto.randomUUID()}`;
  let source;
  let outputDescriptor;
  let temporaryIdentity;
  let targetIdentity;
  let targetCreated = false;
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  try {
    if (inspectDescriptorRelativeEntryIdentity(
      openedParent.descriptor,
      targetName,
    ).exists) {
      throw new Error('gpu_scientific_artifact_body_archive_immutable_collision');
    }
    if (sourceRoot !== null) {
      source = openVerifiedRegularFile(sourceRoot, sourceRelative);
      if (Number(source.before.identity?.size) !== expectedBytes
        || Number(source.before.identity?.size) > maximumBytes) {
        throw new Error('gpu_scientific_artifact_body_archive_source_size_invalid');
      }
    } else if (!Buffer.isBuffer(content)
      || content.length !== expectedBytes
      || content.length > maximumBytes) {
      throw new Error('gpu_scientific_artifact_body_archive_content_invalid');
    }
    outputDescriptor = fs.openSync(
      descriptorEntryPath(openedParent.descriptor, temporaryName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o400,
    );
    const initial = fs.fstatSync(outputDescriptor, { bigint: true });
    if (!initial.isFile() || Number(initial.nlink) !== 1) {
      throw new Error('gpu_scientific_artifact_body_archive_temporary_unsafe');
    }
    temporaryIdentity = descriptorIdentity(initial);
    if (source) {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let count;
      do {
        count = fs.readSync(source.descriptor, buffer, 0, buffer.length, null);
        if (count) {
          bytes += count;
          if (bytes > maximumBytes || bytes > expectedBytes) {
            throw new Error('gpu_scientific_artifact_body_archive_source_size_invalid');
          }
          writeDescriptorFully(outputDescriptor, buffer, count);
          digest.update(buffer.subarray(0, count));
        }
      } while (count);
      verifyOpenedSourceUnchanged(source);
    } else {
      writeDescriptorFully(outputDescriptor, content);
      digest.update(content);
      bytes = content.length;
    }
    const observedHash = `sha256:${digest.digest('hex')}`;
    if (bytes !== expectedBytes || observedHash !== expectedHash) {
      throw new Error('gpu_scientific_artifact_body_archive_source_receipt_mismatch');
    }
    fs.fchmodSync(outputDescriptor, 0o444);
    fs.fsyncSync(outputDescriptor);
    const persisted = fs.fstatSync(outputDescriptor, { bigint: true });
    if (!persisted.isFile() || Number(persisted.nlink) !== 1
      || Number(persisted.size) !== expectedBytes
      || !sameDescriptorObject(persisted, temporaryIdentity)) {
      throw new Error('gpu_scientific_artifact_body_archive_temporary_changed');
    }
    temporaryIdentity = descriptorIdentity(persisted);
    assertOpenedParentStillScoped(openedParent);
    fs.linkSync(
      descriptorEntryPath(openedParent.descriptor, temporaryName),
      descriptorEntryPath(openedParent.descriptor, targetName),
    );
    targetCreated = true;
    targetIdentity = descriptorIdentity(persisted);
    fs.fsyncSync(openedParent.descriptor);
    fs.unlinkSync(descriptorEntryPath(openedParent.descriptor, temporaryName));
    fs.fsyncSync(openedParent.descriptor);
    const final = inspectDescriptorRelativeRegularFile(
      openedParent.descriptor,
      targetName,
    );
    if (!final.exists || final.hash !== expectedHash || final.bytes !== expectedBytes
      || final.identity?.device !== targetIdentity?.device
      || final.identity?.inode !== targetIdentity?.inode
      || final.identity?.mode !== targetIdentity?.mode) {
      throw new Error('gpu_scientific_artifact_body_archive_destination_invalid');
    }
    return {
      relative: destinationRelative,
      hash: final.hash,
      bytes: final.bytes,
      owner: { openedParent, targetName, targetIdentity },
    };
  } catch (error) {
    try {
      if (targetCreated) unlinkOwnedEntry(openedParent, targetName, targetIdentity);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    try {
      if (temporaryIdentity) {
        unlinkOwnedEntry(openedParent, temporaryName, temporaryIdentity);
      }
    } catch (cleanupError) {
      error.cleanupError ||= cleanupError;
    }
    try { fs.closeSync(openedParent.descriptor); } catch {}
    throw error;
  } finally {
    if (outputDescriptor !== undefined) fs.closeSync(outputDescriptor);
    if (source?.descriptor !== undefined) fs.closeSync(source.descriptor);
  }
}

export function closeGpuScientificArtifactBodyArchiveFileOwner(owner) {
  if (!owner?.openedParent || owner.closed) return;
  fs.closeSync(owner.openedParent.descriptor);
  owner.closed = true;
}

export function rollbackGpuScientificArtifactBodyArchiveFilesSync(owners, {
  faultInjector = null,
} = {}) {
  let cleanupError = null;
  for (const owner of [...owners].reverse()) {
    try {
      unlinkOwnedEntry(owner.openedParent, owner.targetName, owner.targetIdentity, {
        faultInjector,
      });
    } catch (error) {
      cleanupError ||= error;
    } finally {
      try { closeGpuScientificArtifactBodyArchiveFileOwner(owner); }
      catch (error) { cleanupError ||= error; }
    }
  }
  if (cleanupError) throw cleanupError;
}
