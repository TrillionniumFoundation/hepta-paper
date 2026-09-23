import fs from 'node:fs';

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyDockerWorkerContainerOwnership,
} from './docker-worker-container-recovery.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GPU_UUID = /^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const REASON = /^[a-z0-9_:-]{1,256}$/;
const STATE_KEYS = Object.freeze([
  'absoluteDeadlineEpochMs', 'dockerWorkerContainerOwnership', 'fencingToken',
  'gpuDeviceSelector', 'kind', 'leaseId', 'ownerAuthorityHash',
  'ownerProcessIdentity', 'quarantineReason', 'stateHash', 'status',
  'updatedAtEpochMs', 'version', 'workerInvocationAuthorityHash',
]);
const OWNER_KEYS = Object.freeze(['bootId', 'pid', 'processStartTicks', 'uid']);

export const GPU_SELECTOR_EXECUTION_LEASE_MAXIMUM_STATE_BYTES = 64 * 1024;

function processStartTicks(pid) {
  const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
  const ticks = fields[19];
  if (!/^\d+$/.test(String(ticks || ''))) {
    throw new Error('gpu_selector_execution_lease_owner_process_identity_invalid');
  }
  return ticks;
}

function currentOwnerProcessIdentity() {
  const bootId = fs.readFileSync(
    '/proc/sys/kernel/random/boot_id',
    'utf8',
  ).trim().toLowerCase();
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (!BOOT_ID.test(bootId) || !Number.isSafeInteger(process.pid)
    || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('gpu_selector_execution_lease_owner_process_identity_invalid');
  }
  return Object.freeze({
    bootId,
    pid: process.pid,
    processStartTicks: processStartTicks(process.pid),
    uid,
  });
}

function validOwner(value) {
  return hasExactObjectKeys(value, OWNER_KEYS)
    && BOOT_ID.test(String(value?.bootId || ''))
    && Number.isSafeInteger(value?.pid) && value.pid > 0
    && /^\d+$/.test(String(value?.processStartTicks || ''))
    && Number.isSafeInteger(value?.uid) && value.uid >= 0;
}

export function verifyGpuSelectorExecutionLeaseState(value) {
  if (!hasExactObjectKeys(value, STATE_KEYS)
    || value?.version !== 1
    || value?.kind !== 'GpuSelectorExecutionLeaseDurableState'
    || !['held', 'recovery_required'].includes(value?.status)
    || !GPU_UUID.test(String(value?.gpuDeviceSelector || ''))
    || [value?.ownerAuthorityHash, value?.leaseId, value?.fencingToken]
      .some((item) => !SHA256.test(String(item || '')))
    || (value.workerInvocationAuthorityHash !== null
      && !SHA256.test(String(value.workerInvocationAuthorityHash || '')))
    || ((value.workerInvocationAuthorityHash === null)
      !== (value.dockerWorkerContainerOwnership === null))
    || (value.dockerWorkerContainerOwnership !== null
      && (!verifyDockerWorkerContainerOwnership(
        value.dockerWorkerContainerOwnership,
      )
        || value.dockerWorkerContainerOwnership.gpuDeviceSelector
          !== value.gpuDeviceSelector
        || value.dockerWorkerContainerOwnership.gpuSelectorExecutionLeaseId
          !== value.leaseId
        || value.dockerWorkerContainerOwnership
          .gpuSelectorExecutionFencingToken !== value.fencingToken))
    || (value.status === 'held' && value.quarantineReason !== null)
    || (value.status === 'recovery_required'
      && !REASON.test(String(value.quarantineReason || '')))
    || !validOwner(value.ownerProcessIdentity)
    || !Number.isSafeInteger(value.absoluteDeadlineEpochMs)
    || value.absoluteDeadlineEpochMs < 1
    || !Number.isSafeInteger(value.updatedAtEpochMs)
    || value.updatedAtEpochMs < 1
    || !SHA256.test(String(value.stateHash || ''))) return false;
  const { stateHash, ...payload } = value;
  return hashRecord('GpuSelectorExecutionLeaseDurableState', payload) === stateHash;
}

export function buildGpuSelectorExecutionLeaseState({
  gpuDeviceSelector,
  ownerAuthorityHash,
  leaseId,
  fencingToken,
  absoluteDeadlineEpochMs,
  status = 'held',
  quarantineReason = null,
  workerInvocationAuthorityHash = null,
  dockerWorkerContainerOwnership = null,
  ownerProcessIdentity = null,
  updatedAtEpochMs = Date.now(),
} = {}) {
  const payload = {
    version: 1,
    kind: 'GpuSelectorExecutionLeaseDurableState',
    status,
    gpuDeviceSelector,
    ownerAuthorityHash,
    leaseId,
    fencingToken,
    absoluteDeadlineEpochMs,
    ownerProcessIdentity: ownerProcessIdentity || currentOwnerProcessIdentity(),
    workerInvocationAuthorityHash,
    dockerWorkerContainerOwnership,
    quarantineReason,
    updatedAtEpochMs,
  };
  const state = Object.freeze({
    ...payload,
    stateHash: hashRecord('GpuSelectorExecutionLeaseDurableState', payload),
  });
  if (!verifyGpuSelectorExecutionLeaseState(state)) {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  return state;
}

function readBytes(descriptor, bytes) {
  const buffer = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const count = fs.readSync(descriptor, buffer, offset, bytes - offset, offset);
    if (!count) break;
    offset += count;
  }
  if (offset !== bytes) throw new Error('gpu_selector_execution_lease_state_invalid');
  return buffer;
}

export function readGpuSelectorExecutionLeaseStateSync(descriptor) {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.size < 0
    || stat.size > GPU_SELECTOR_EXECUTION_LEASE_MAXIMUM_STATE_BYTES) {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  if (stat.size === 0) return null;
  const serialized = readBytes(descriptor, stat.size).toString('utf8');
  if (!serialized.endsWith('\n')) {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  let states;
  try {
    states = serialized.slice(0, -1).split('\n').map((line) => JSON.parse(line));
  } catch {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  if (!states.length || states.some((state) => (
    !verifyGpuSelectorExecutionLeaseState(state)
  ))) {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  return Object.freeze(states.at(-1));
}

export function writeGpuSelectorExecutionLeaseStateSync(descriptor, state) {
  if (!verifyGpuSelectorExecutionLeaseState(state)) {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  const content = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
  const current = readGpuSelectorExecutionLeaseStateSync(descriptor);
  if (current?.stateHash === state.stateHash) return current;
  const size = fs.fstatSync(descriptor).size;
  if (content.length + size
    > GPU_SELECTOR_EXECUTION_LEASE_MAXIMUM_STATE_BYTES) {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  let offset = 0;
  while (offset < content.length) {
    offset += fs.writeSync(
      descriptor,
      content,
      offset,
      content.length - offset,
      size + offset,
    );
  }
  fs.fsyncSync(descriptor);
  const reread = readGpuSelectorExecutionLeaseStateSync(descriptor);
  if (reread?.stateHash !== state.stateHash) {
    throw new Error('gpu_selector_execution_lease_state_invalid');
  }
  return reread;
}

export function clearGpuSelectorExecutionLeaseStateSync(
  descriptor,
  expectedStateHash,
) {
  const current = readGpuSelectorExecutionLeaseStateSync(descriptor);
  if (!current || current.stateHash !== expectedStateHash) {
    throw new Error('gpu_selector_execution_lease_state_changed');
  }
  fs.ftruncateSync(descriptor, 0);
  fs.fsyncSync(descriptor);
  if (readGpuSelectorExecutionLeaseStateSync(descriptor) !== null) {
    throw new Error('gpu_selector_execution_lease_state_changed');
  }
}
