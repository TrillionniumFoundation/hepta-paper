import fs from 'node:fs';
import path from 'node:path';

const MAXIMUM_CREDENTIAL_BYTES = 64 * 1024;

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs) === String(right.mtimeNs)
    && String(left.ctimeNs) === String(right.ctimeNs);
}

export function resolveOpaqueRuntimeCredential({
  environment = process.env,
  variableName,
} = {}) {
  const selectedVariable = String(variableName || '');
  const configured = String(environment[selectedVariable] || '');
  if (!selectedVariable.endsWith('_FILE')) return configured;
  const candidate = path.resolve(configured);
  let descriptor;
  let value;
  try {
    const before = fs.lstatSync(candidate, { bigint: true });
    if (!configured || !path.isAbsolute(configured) || !before.isFile()
      || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(MAXIMUM_CREDENTIAL_BYTES)
      || (Number(before.mode) & 0o077) !== 0
      || String(before.uid) !== String(process.getuid?.())
      || fs.realpathSync(candidate) !== candidate) throw new Error('invalid');
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error('invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const final = fs.lstatSync(candidate, { bigint: true });
    if (bytes.length !== Number(opened.size)
      || !sameIdentity(opened, completed)
      || !sameIdentity(completed, final)) {
      throw new Error('invalid');
    }
    value = bytes.toString('utf8').trim();
  } catch {
    throw new Error('opaque_runtime_credential_file_invalid');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (!value || value.includes('\0')) {
    throw new Error('opaque_runtime_credential_file_invalid');
  }
  return value;
}
