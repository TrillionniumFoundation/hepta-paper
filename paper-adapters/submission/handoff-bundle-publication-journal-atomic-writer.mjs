import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const CREATE_EXCLUSIVE = fs.constants.O_CREAT | fs.constants.O_EXCL;
const MOVE_TIMEOUT_MS = 30_000;
const TRUSTED_MOVE_EXECUTABLE = '/usr/bin/mv';

function inodeIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function executableIdentity(stat) {
  return Object.freeze({
    ...inodeIdentity(stat),
    gid: String(stat.gid),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
  });
}

function sameExecutableIdentity(left, right) {
  return sameIdentity(left, right)
    && left?.gid === right?.gid
    && left?.mode === right?.mode
    && left?.nlink === right?.nlink
    && left?.uid === right?.uid;
}

function trustedOwner(stat) {
  return typeof process.geteuid !== 'function'
    || Number(stat.uid) === process.geteuid();
}

function trustedJournalFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && trustedOwner(stat)
    && (stat.mode & 0o777n) === 0o444n && stat.nlink === 1n;
}

function writeFully(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
    );
    if (written <= 0) {
      throw new Error('handoff_bundle_publication_journal_write_failed');
    }
    offset += written;
  }
}

function openTrustedMoveExecutable() {
  const before = fs.lstatSync(TRUSTED_MOVE_EXECUTABLE, { bigint: true });
  const identity = executableIdentity(before);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.uid !== 0n || before.gid !== 0n
    || (before.mode & 0o777n) !== 0o755n) {
    throw new Error('handoff_bundle_publication_journal_move_untrusted');
  }
  const descriptor = fs.openSync(
    TRUSTED_MOVE_EXECUTABLE,
    fs.constants.O_RDONLY | NO_FOLLOW,
  );
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile()
    || !sameExecutableIdentity(identity, executableIdentity(opened))) {
    fs.closeSync(descriptor);
    throw new Error('handoff_bundle_publication_journal_move_changed');
  }
  return Object.freeze({ descriptor, identity });
}

function assertTrustedMoveExecutable(executable) {
  const opened = fs.fstatSync(executable.descriptor, { bigint: true });
  const lexical = fs.lstatSync(TRUSTED_MOVE_EXECUTABLE, { bigint: true });
  if (!sameExecutableIdentity(executable.identity, executableIdentity(opened))
    || !sameExecutableIdentity(
      executable.identity,
      executableIdentity(lexical),
    )) {
    throw new Error('handoff_bundle_publication_journal_move_changed');
  }
}

function removeOwnedTemporary(candidate, expectedIdentity) {
  try {
    const current = fs.lstatSync(candidate, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink()
      && current.nlink === 1n
      && sameIdentity(inodeIdentity(current), expectedIdentity)) {
      fs.unlinkSync(candidate);
    }
  } catch { /* ignore absent or no-longer-owned temporary entries */ }
}

export function writeAtomicPreparedSubmissionHandoffJournal({
  bytes,
  parentDescriptor,
  preparedPath,
} = {}) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('handoff_bundle_publication_journal_bytes_invalid');
  }
  const parentBefore = fs.fstatSync(parentDescriptor, { bigint: true });
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error('handoff_bundle_publication_journal_parent_untrusted');
  }
  const pinnedParent = `/proc/self/fd/${parentDescriptor}`;
  const preparedName = path.basename(preparedPath);
  const pinnedPrepared = path.join(pinnedParent, preparedName);
  const temporaryName = `.${preparedName.slice(0, 120)}.tmp-`
    + `${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  const temporaryPath = path.join(pinnedParent, temporaryName);
  let descriptor;
  let temporaryIdentity = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | CREATE_EXCLUSIVE | NO_FOLLOW,
      0o444,
    );
    temporaryIdentity = inodeIdentity(fs.fstatSync(descriptor, {
      bigint: true,
    }));
    writeFully(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    const temporary = fs.fstatSync(descriptor, { bigint: true });
    if (!trustedJournalFile(temporary)
      || !sameIdentity(temporaryIdentity, inodeIdentity(temporary))
      || temporary.size !== BigInt(bytes.length)) {
      throw new Error('handoff_bundle_publication_journal_file_invalid');
    }
    const parentPrepared = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!sameIdentity(inodeIdentity(parentBefore), inodeIdentity(parentPrepared))) {
      throw new Error('handoff_bundle_publication_journal_parent_untrusted');
    }
    try {
      fs.lstatSync(pinnedPrepared);
      throw new Error('handoff_bundle_publication_journal_preexisting');
    } catch (error) {
      if (error?.message === 'handoff_bundle_publication_journal_preexisting') {
        throw error;
      }
      if (error?.code !== 'ENOENT') throw error;
    }
    const executable = openTrustedMoveExecutable();
    try {
      const result = spawnSync(
        '/proc/self/fd/4',
        [
          '--no-clobber',
          '--no-copy',
          '--no-target-directory',
          '--',
          path.join('/proc/self/fd/3', temporaryName),
          path.join('/proc/self/fd/3', preparedName),
        ],
        {
          encoding: 'buffer',
          env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
          maxBuffer: 1024 * 1024,
          stdio: [
            'ignore',
            'pipe',
            'pipe',
            parentDescriptor,
            executable.descriptor,
          ],
          timeout: MOVE_TIMEOUT_MS,
        },
      );
      assertTrustedMoveExecutable(executable);
      let remainingTemporary = null;
      let published = null;
      try {
        remainingTemporary = fs.lstatSync(temporaryPath, { bigint: true });
      } catch { /* absent after rename */ }
      try {
        published = fs.lstatSync(pinnedPrepared, { bigint: true });
      } catch { /* validated below */ }
      if (remainingTemporary && published) {
        throw new Error('handoff_bundle_publication_journal_preexisting');
      }
      if (result.error || result.signal || result.status !== 0
        || remainingTemporary || !published) {
        throw new Error('handoff_bundle_publication_journal_publish_failed');
      }
      if (!trustedJournalFile(published)
        || !sameIdentity(inodeIdentity(published), temporaryIdentity)
        || published.size !== BigInt(bytes.length)) {
        throw new Error('handoff_bundle_publication_journal_file_invalid');
      }
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(executable.descriptor);
    }
    const parentCompleted = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!sameIdentity(inodeIdentity(parentBefore), inodeIdentity(parentCompleted))) {
      throw new Error('handoff_bundle_publication_journal_parent_untrusted');
    }
    return Object.freeze({
      identity: temporaryIdentity,
      size: bytes.length,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryIdentity) {
      removeOwnedTemporary(temporaryPath, temporaryIdentity);
    }
  }
}
