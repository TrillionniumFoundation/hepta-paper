import fs from 'node:fs';
import path from 'node:path';

const MAXIMUM_CREDENTIAL_BYTES = 64 * 1024;

export function resolveOpaqueRuntimeCredential({
  environment = process.env,
  variableName,
} = {}) {
  const selectedVariable = String(variableName || '');
  const configured = String(environment[selectedVariable] || '');
  if (!selectedVariable.endsWith('_FILE')) return configured;
  const candidate = path.resolve(configured);
  let stat;
  let value;
  try {
    stat = fs.lstatSync(candidate);
    if (!configured || !path.isAbsolute(configured) || !stat.isFile()
      || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size < 1 || stat.size > MAXIMUM_CREDENTIAL_BYTES
      || (stat.mode & 0o077) !== 0
      || stat.uid !== process.getuid?.()
      || fs.realpathSync(candidate) !== candidate) throw new Error('invalid');
    value = fs.readFileSync(candidate, 'utf8').trim();
  } catch {
    throw new Error('opaque_runtime_credential_file_invalid');
  }
  if (!value || value.includes('\0')) {
    throw new Error('opaque_runtime_credential_file_invalid');
  }
  return value;
}
