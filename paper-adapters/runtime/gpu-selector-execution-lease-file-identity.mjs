import path from 'node:path';

import {
  gpuSelectorExecutionLeaseSelectorKeyHash,
} from '../../paper-domain/automation/gpu-selector-execution-lease-contract.mjs';

export const GPU_SELECTOR_EXECUTION_LEASE_RUNTIME_DIRECTORY =
  'gpu-selector-execution-leases';

export function currentLeaseOwnerUserId() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

export function gpuSelectorExecutionLeaseFileIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    nlink: String(stat.nlink), uid: String(stat.uid), gid: String(stat.gid),
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'regular_file' : 'other',
  });
}

export function sameGpuSelectorExecutionLeaseFileIdentity(left, right) {
  return JSON.stringify(gpuSelectorExecutionLeaseFileIdentity(left))
    === JSON.stringify(gpuSelectorExecutionLeaseFileIdentity(right));
}

export function gpuSelectorExecutionLeaseRootIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    uid: String(stat.uid), gid: String(stat.gid),
    type: stat.isDirectory() ? 'directory' : 'other',
  });
}

export function sameGpuSelectorExecutionLeaseRootIdentity(left, right) {
  return JSON.stringify(gpuSelectorExecutionLeaseRootIdentity(left))
    === JSON.stringify(gpuSelectorExecutionLeaseRootIdentity(right));
}

export function gpuSelectorExecutionLockFileName(gpuDeviceSelector) {
  const keyHash = gpuSelectorExecutionLeaseSelectorKeyHash(gpuDeviceSelector);
  return `.hepta-gpu-selector-${keyHash.slice('sha256:'.length)}.lock`;
}

export function gpuSelectorExecutionLeaseRootForRuntime(runtimeRoot) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) {
    throw new Error('gpu_selector_execution_lease_runtime_root_absolute_required');
  }
  const selected = path.normalize(runtimeRoot);
  if (selected === path.parse(selected).root) {
    throw new Error('gpu_selector_execution_lease_runtime_root_unsafe');
  }
  return path.join(selected, GPU_SELECTOR_EXECUTION_LEASE_RUNTIME_DIRECTORY);
}
