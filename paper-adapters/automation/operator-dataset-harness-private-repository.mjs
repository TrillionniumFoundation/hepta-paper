import fs from 'node:fs';
import path from 'node:path';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

export function operatorDatasetHarnessPrivatePath(runtimeRoot, handle) {
  if (!runtimeRoot || !/^sha256:[0-9a-f]{64}$/i.test(String(handle || ''))) return null;
  return path.join(
    path.resolve(runtimeRoot),
    'private',
    'dataset-harness-envelopes',
    `${String(handle).slice('sha256:'.length).toLowerCase()}.json`,
  );
}

export function persistOperatorDatasetHarnessEnvelope({ runtimeRoot, handle, content } = {}) {
  const target = operatorDatasetHarnessPrivatePath(runtimeRoot, handle);
  if (!target || !content || hashBytes(content) !== handle) {
    throw new Error('operator_dataset_harness_private_registry_inputs_invalid');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(target), 0o700);
  const registryIdentity = fs.lstatSync(path.dirname(target));
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : registryIdentity.uid;
  if (!registryIdentity.isDirectory() || registryIdentity.isSymbolicLink() || registryIdentity.uid !== currentUid
    || (registryIdentity.mode & 0o077) !== 0 || fs.realpathSync(path.dirname(target)) !== path.resolve(path.dirname(target))) {
    throw new Error('operator_dataset_harness_private_registry_identity_invalid');
  }
  try {
    const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing = null;
    try { existing = fs.readFileSync(target); } catch { /* conflict below */ }
    if (!existing || hashBytes(existing) !== handle) throw new Error('operator_dataset_harness_private_registry_conflict');
  }
  return target;
}
