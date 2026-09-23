import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  normalizeGpuSelectorExecutionLeaseSelector,
} from '../../paper-domain/automation/gpu-selector-execution-lease-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  currentLeaseOwnerUserId as currentUserId,
  gpuSelectorExecutionLeaseFileIdentity as statIdentity,
  gpuSelectorExecutionLeaseRootIdentity as rootIdentity,
  gpuSelectorExecutionLockFileName,
  sameGpuSelectorExecutionLeaseFileIdentity as sameIdentity,
  sameGpuSelectorExecutionLeaseRootIdentity as sameRootIdentity,
} from './gpu-selector-execution-lease-file-identity.mjs';
import {
  GPU_SELECTOR_EXECUTION_LEASE_MAXIMUM_STATE_BYTES,
} from './gpu-selector-execution-lease-state.mjs';

const LOCK_DESCRIPTOR_IN_CHILD = 3;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const FLOCK_CANDIDATES = Object.freeze(['/usr/bin/flock', '/bin/flock']);

export function leaseError(code, retryable = false, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function validateRoot(root) {
  let descriptor = null;
  try {
    const atPath = fs.lstatSync(root, { bigint: true });
    const real = fs.realpathSync.native(root);
    descriptor = fs.openSync(
      root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const owner = currentUserId();
    if (real !== root
      || atPath.isSymbolicLink()
      || !atPath.isDirectory()
      || !opened.isDirectory()
      || !sameRootIdentity(opened, atPath)
      || Number(opened.mode & 0o7777n) !== 0o700
      || (owner !== null && Number(opened.uid) !== owner)) {
      throw leaseError('gpu_selector_execution_lease_root_unsafe');
    }
    return Object.freeze({
      descriptor,
      stat: opened,
      identity: rootIdentity(opened),
      identityHash: hashRecord('GpuSelectorExecutionLeaseRootIdentity', {
        root,
        identity: rootIdentity(opened),
      }),
    });
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve validation error */ }
    }
    if (error?.code === 'gpu_selector_execution_lease_root_unsafe') throw error;
    throw leaseError('gpu_selector_execution_lease_root_unsafe', false, error);
  }
}

export function resolveFlockBackend() {
  for (const candidate of FLOCK_CANDIDATES) {
    try {
      const real = fs.realpathSync.native(candidate);
      const stat = fs.statSync(real);
      fs.accessSync(real, fs.constants.X_OK);
      if (stat.isFile() && (stat.mode & 0o022) === 0) return real;
    } catch { /* try next trusted system location */ }
  }
  throw leaseError('gpu_selector_execution_lease_flock_backend_unavailable');
}

export function openLockFile({ root, rootIdentityHash, gpuDeviceSelector }) {
  const before = validateRoot(root);
  let descriptor = null;
  const lockPath = path.join(root, gpuSelectorExecutionLockFileName(gpuDeviceSelector));
  let existed = true;
  try { fs.lstatSync(lockPath); } catch (error) {
    if (error?.code !== 'ENOENT') {
      fs.closeSync(before.descriptor);
      throw leaseError('gpu_selector_execution_lease_lock_file_unsafe', false, error);
    }
    existed = false;
  }
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const atPath = fs.lstatSync(lockPath, { bigint: true });
    const owner = currentUserId();
    const after = validateRoot(root);
    try {
      if (before.identityHash !== rootIdentityHash
        || after.identityHash !== rootIdentityHash
        || !sameRootIdentity(before.stat, after.stat)
        || !opened.isFile()
        || !atPath.isFile()
        || atPath.isSymbolicLink()
        || !sameIdentity(opened, atPath)
        || Number(opened.nlink) !== 1
        || Number(opened.mode & 0o7777n) !== 0o600
        || opened.size > BigInt(GPU_SELECTOR_EXECUTION_LEASE_MAXIMUM_STATE_BYTES)
        || (owner !== null && Number(opened.uid) !== owner)) {
        throw leaseError('gpu_selector_execution_lease_lock_file_unsafe');
      }
      if (!existed) fs.fsyncSync(before.descriptor);
      const identity = statIdentity(opened);
      return Object.freeze({
        descriptor,
        lockPath,
        identity,
        identityHash: hashRecord('GpuSelectorExecutionLeaseLockIdentity', {
          gpuDeviceSelector,
          lockScopeIdentityHash: rootIdentityHash,
          identity,
        }),
      });
    } finally {
      fs.closeSync(after.descriptor);
    }
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve validation error */ }
    }
    if (error?.code === 'gpu_selector_execution_lease_lock_file_unsafe') throw error;
    throw leaseError('gpu_selector_execution_lease_lock_file_unsafe', false, error);
  } finally {
    fs.closeSync(before.descriptor);
  }
}

export function waitForFlock({ backend, descriptor, timeoutMs, signal }) {
  if (signal?.aborted) {
    return Promise.reject(leaseError(
      'gpu_selector_execution_lease_acquire_aborted',
      true,
    ));
  }
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let aborted = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {
      aborted = true;
      try { child?.kill('SIGKILL'); } catch { /* exit handler resolves outcome */ }
    };
    try {
      child = spawn(backend, [
        '--exclusive',
        '--timeout',
        (Math.max(1, timeoutMs) / 1000).toFixed(3),
        String(LOCK_DESCRIPTOR_IN_CHILD),
      ], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'ignore', 'ignore', descriptor],
      });
    } catch (error) {
      finish(leaseError(
        'gpu_selector_execution_lease_flock_backend_failed',
        false,
        error,
      ));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => finish(leaseError(
      'gpu_selector_execution_lease_flock_backend_failed',
      false,
      error,
    )));
    child.once('exit', (code, childSignal) => {
      if (aborted) {
        finish(leaseError('gpu_selector_execution_lease_acquire_aborted', true));
      } else if (code === 0 && childSignal === null) {
        finish();
      } else if (code === 1 && childSignal === null) {
        finish(leaseError('gpu_selector_execution_lease_deadline_exhausted'));
      } else {
        finish(leaseError('gpu_selector_execution_lease_flock_backend_failed'));
      }
    });
  });
}

export function validateAcquireRequest(request = {}) {
  const gpuDeviceSelector = normalizeGpuSelectorExecutionLeaseSelector(
    request.gpuDeviceSelector,
  );
  if (!gpuDeviceSelector) {
    throw leaseError('gpu_selector_execution_lease_selector_invalid');
  }
  const ownerAuthorityHash = String(request.ownerAuthorityHash || '').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(ownerAuthorityHash)) {
    throw leaseError('gpu_selector_execution_lease_owner_authority_invalid');
  }
  const absoluteDeadlineEpochMs = Number(request.absoluteDeadlineEpochMs);
  if (!Number.isSafeInteger(absoluteDeadlineEpochMs)
    || absoluteDeadlineEpochMs < 1) {
    throw leaseError('gpu_selector_execution_lease_deadline_invalid');
  }
  const gpuSelectorExecutionLeaseDelegation =
    request.gpuSelectorExecutionLeaseDelegation ?? null;
  const delegationAuthorityCandidate =
    request.gpuSelectorExecutionLeaseDelegationAuthorityHash;
  const gpuSelectorExecutionLeaseDelegationAuthorityHash =
    delegationAuthorityCandidate == null
      ? null : String(delegationAuthorityCandidate).toLowerCase();
  if ((gpuSelectorExecutionLeaseDelegation === null)
      !== (gpuSelectorExecutionLeaseDelegationAuthorityHash === null)
    || (gpuSelectorExecutionLeaseDelegationAuthorityHash !== null
      && !/^sha256:[0-9a-f]{64}$/.test(
        gpuSelectorExecutionLeaseDelegationAuthorityHash,
      ))) {
    throw leaseError('gpu_selector_execution_lease_delegation_invalid');
  }
  return Object.freeze({
    gpuDeviceSelector,
    ownerAuthorityHash,
    absoluteDeadlineEpochMs,
    signal: request.signal || null,
    gpuSelectorExecutionLeaseDelegation,
    gpuSelectorExecutionLeaseDelegationAuthorityHash,
  });
}
