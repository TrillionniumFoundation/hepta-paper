import fs from 'node:fs';
import path from 'node:path';

const JOURNAL_DIRECTORY = 'formal-domain-qualification-recovery-journals';

function privateMode(mode) {
  return typeof mode === 'bigint'
    ? (mode & 0o077n) === 0n
    : (mode & 0o077) === 0;
}

function ownedByCurrentProcess(stat) {
  return typeof process.getuid !== 'function'
    || Number(stat.uid) === process.getuid();
}

function invalid(code) {
  return new Error(code);
}

export function formalDomainQualificationPrivateDirectory(
  candidate,
  stat = fs.lstatSync(candidate),
) {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && fs.realpathSync(candidate) === candidate
    && privateMode(stat.mode)
    && ownedByCurrentProcess(stat);
}

export function formalDomainQualificationPrivateRegularFile(
  stat,
  { allowedLinkCounts = [1] } = {},
) {
  return stat.isFile() && !stat.isSymbolicLink()
    && allowedLinkCounts.includes(Number(stat.nlink))
    && privateMode(stat.mode)
    && ownedByCurrentProcess(stat);
}

export function formalDomainQualificationFileIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    linkCount: String(stat.nlink),
    owner: String(stat.uid),
    size: String(stat.size),
    modifiedAtNanoseconds: String(stat.mtimeNs),
    changedAtNanoseconds: String(stat.ctimeNs),
  });
}

export function sameFormalDomainQualificationFileIdentity(left, right) {
  return JSON.stringify(formalDomainQualificationFileIdentity(left))
    === JSON.stringify(formalDomainQualificationFileIdentity(right));
}

export function readPinnedFormalDomainQualificationPrivateFile({
  candidate,
  maximumBytes,
  invalidCode,
  driftCode = invalidCode,
} = {}) {
  let descriptor;
  try {
    let observedBeforeOpen;
    try {
      observedBeforeOpen = fs.lstatSync(candidate, { bigint: true });
    } catch {
      throw invalid(driftCode);
    }
    if (!formalDomainQualificationPrivateRegularFile(observedBeforeOpen)) {
      throw invalid(invalidCode);
    }
    try {
      descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
    } catch {
      throw invalid(driftCode);
    }
    const before = fs.fstatSync(descriptor, { bigint: true });
    const byteLimit = BigInt(maximumBytes);
    if (!formalDomainQualificationPrivateRegularFile(before)
      || before.size <= 0n || before.size > byteLimit) {
      throw invalid(invalidCode);
    }
    if (!sameFormalDomainQualificationFileIdentity(
      observedBeforeOpen,
      before,
    )) {
      throw invalid(driftCode);
    }
    const expectedBytes = Number(before.size);
    const content = Buffer.allocUnsafe(expectedBytes);
    let bytesRead = 0;
    while (bytesRead < expectedBytes) {
      const count = fs.readSync(
        descriptor,
        content,
        bytesRead,
        expectedBytes - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    let observedPath;
    try {
      observedPath = fs.lstatSync(candidate, { bigint: true });
    } catch {
      throw invalid(driftCode);
    }
    if (bytesRead !== expectedBytes
      || !formalDomainQualificationPrivateRegularFile(after)
      || !formalDomainQualificationPrivateRegularFile(observedPath)
      || !sameFormalDomainQualificationFileIdentity(before, after)
      || !sameFormalDomainQualificationFileIdentity(after, observedPath)) {
      throw invalid(driftCode);
    }
    return Object.freeze({
      source: content.toString('utf8'),
      bytes: expectedBytes,
      identity: formalDomainQualificationFileIdentity(after),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function fsyncFormalDomainQualificationDirectory(candidate) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

export function ensureFormalDomainQualificationJournalDirectory(runtimeRoot) {
  const root = path.resolve(String(runtimeRoot || ''));
  const candidate = path.join(root, JOURNAL_DIRECTORY);
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  if (!formalDomainQualificationPrivateDirectory(candidate)) {
    throw new Error(
      'formal_domain_qualification_recovery_journal_directory_invalid',
    );
  }
  return candidate;
}
