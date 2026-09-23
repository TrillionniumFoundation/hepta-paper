import crypto from 'node:crypto';
import fs from 'node:fs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const READ_BUFFER_BYTES = 4 * 1024 * 1024;

export function samePinnedFileIdentity(left, right) {
  return Boolean(left && right
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs) === String(right.mtimeNs)
    && String(left.ctimeNs) === String(right.ctimeNs));
}

export function descriptorAccessPathSync(descriptor, { errorCode = 'pinned_file_descriptor_path_unavailable' } = {}) {
  for (const root of ['/proc/self/fd', '/dev/fd']) {
    const candidate = `${root}/${descriptor}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(errorCode);
}

export function descriptorSha256HashSync(descriptor) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
}

export function openPinnedRegularFileSync(candidate, { errorCode = 'pinned_file_not_regular' } = {}) {
  let before;
  try { before = fs.lstatSync(candidate, { bigint: true }); } catch { throw new Error(errorCode); }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(errorCode);
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !samePinnedFileIdentity(before, opened)) throw new Error(errorCode);
    return Object.freeze({ descriptor, before, opened });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

export function fileSha256HashSync(candidate, { prefix = true, errorCode = 'pinned_file_not_regular' } = {}) {
  const pinned = openPinnedRegularFileSync(candidate, { errorCode });
  try {
    const hash = descriptorSha256HashSync(pinned.descriptor);
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (!samePinnedFileIdentity(pinned.opened, after)
      || !samePinnedFileIdentity(after, fs.lstatSync(candidate, { bigint: true }))) {
      throw new Error('pinned_file_changed_while_reading');
    }
    return prefix ? hash : hash.slice('sha256:'.length);
  } finally { fs.closeSync(pinned.descriptor); }
}

export function readRegularJsonFileSync(candidate) {
  let pinned;
  try {
    pinned = openPinnedRegularFileSync(candidate, { errorCode: 'pinned_json_file_not_regular' });
    const value = JSON.parse(fs.readFileSync(pinned.descriptor, 'utf8'));
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (!samePinnedFileIdentity(pinned.opened, after)
      || !samePinnedFileIdentity(after, fs.lstatSync(candidate, { bigint: true }))) return null;
    return value;
  } catch { return null; }
  finally { if (pinned?.descriptor !== undefined) fs.closeSync(pinned.descriptor); }
}
