import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  GPU_SELECTOR_EXECUTION_LEASE_MECHANISM,
  GPU_SELECTOR_EXECUTION_LEASE_SCOPE,
  buildGpuSelectorExecutionLeaseReceipt,
  buildGpuSelectorExecutionLeaseReleaseReceipt,
  normalizeGpuSelectorExecutionLeaseSelector,
} from '../../paper-domain/automation/gpu-selector-execution-lease-contract.mjs';
import {
  assertGpuSelectorExecutionLeasePort,
} from '../../paper-ports/gpu-selector-execution-lease-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  gpuSelectorExecutionLeaseFileIdentity as statIdentity,
  sameGpuSelectorExecutionLeaseFileIdentity as sameIdentity,
} from './gpu-selector-execution-lease-file-identity.mjs';
import {
  buildGpuSelectorExecutionLeaseState,
  clearGpuSelectorExecutionLeaseStateSync,
  readGpuSelectorExecutionLeaseStateSync,
  writeGpuSelectorExecutionLeaseStateSync,
} from './gpu-selector-execution-lease-state.mjs';
import {
  leaseError,
  openLockFile,
  resolveFlockBackend,
  validateAcquireRequest,
  validateRoot,
  waitForFlock,
} from './gpu-selector-execution-lease-file-lock.mjs';
export {
  GPU_SELECTOR_EXECUTION_LEASE_RUNTIME_DIRECTORY,
  gpuSelectorExecutionLeaseRootForRuntime,
  gpuSelectorExecutionLockFileName,
} from './gpu-selector-execution-lease-file-identity.mjs';

const ACTIVE_GPU_SELECTOR_EXECUTION_LEASE = new AsyncLocalStorage();

export function createGpuSelectorExecutionLeaseRepository({
  root,
  recoverStaleState = null,
} = {}) {
  const selectedRoot = path.resolve(String(root || ''));
  if (!root || selectedRoot === path.parse(selectedRoot).root) {
    throw leaseError('gpu_selector_execution_lease_root_unsafe');
  }
  if (recoverStaleState !== null && typeof recoverStaleState !== 'function') {
    throw leaseError('gpu_selector_execution_lease_recovery_handler_invalid');
  }
  let created = false;
  try {
    fs.lstatSync(selectedRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw leaseError('gpu_selector_execution_lease_root_unsafe', false, error);
    }
    fs.mkdirSync(selectedRoot, { recursive: true, mode: 0o700 });
    created = true;
  }
  const initialRoot = validateRoot(selectedRoot);
  const lockScopeIdentityHash = initialRoot.identityHash;
  if (created) fs.fsyncSync(initialRoot.descriptor);
  fs.closeSync(initialRoot.descriptor);
  const backend = resolveFlockBackend();
  const capabilities = Object.freeze({
    version: 1,
    kind: 'GpuSelectorExecutionLeaseCapabilities',
    crossProcess: true,
    perGpuUuid: true,
    deadlineBound: true,
    abortableWait: true,
    asyncContextReentrant: false,
    mechanism: GPU_SELECTOR_EXECUTION_LEASE_MECHANISM,
    scope: GPU_SELECTOR_EXECUTION_LEASE_SCOPE,
    lockScopeIdentityHash,
    productionExclusivityClaimed: false,
  });

  const port = {
    version: 1,
    kind: 'GpuSelectorExecutionLeasePort',
    capabilities: () => capabilities,
    currentLease({ gpuDeviceSelector = null } = {}) {
      const active = ACTIVE_GPU_SELECTOR_EXECUTION_LEASE.getStore() || null;
      if (!active) return null;
      if (active.lockScopeIdentityHash !== lockScopeIdentityHash) {
        throw leaseError('gpu_selector_execution_lease_reentrant_scope_mismatch');
      }
      if (gpuDeviceSelector !== null) {
        const selected = normalizeGpuSelectorExecutionLeaseSelector(gpuDeviceSelector);
        if (!selected) throw leaseError('gpu_selector_execution_lease_selector_invalid');
        if (selected !== active.gpuDeviceSelector) {
          throw leaseError('gpu_selector_execution_lease_reentrant_selector_mismatch');
        }
      }
      active.assertHeld();
      return active;
    },
    async acquire(request = {}) {
      const selected = validateAcquireRequest(request);
      const requestedAtEpochMs = Date.now();
      if (selected.signal?.aborted) {
        throw leaseError('gpu_selector_execution_lease_acquire_aborted', true);
      }
      if (selected.absoluteDeadlineEpochMs <= requestedAtEpochMs) {
        throw leaseError('gpu_selector_execution_lease_deadline_exhausted');
      }
      const opened = openLockFile({
        root: selectedRoot,
        rootIdentityHash: lockScopeIdentityHash,
        gpuDeviceSelector: selected.gpuDeviceSelector,
      });
      let descriptorOpen = true;
      try {
        const remainingMs = selected.absoluteDeadlineEpochMs - Date.now();
        if (remainingMs < 1) {
          throw leaseError('gpu_selector_execution_lease_deadline_exhausted');
        }
        await waitForFlock({
          backend,
          descriptor: opened.descriptor,
          timeoutMs: remainingMs,
          signal: selected.signal,
        });
        if (selected.signal?.aborted) {
          throw leaseError('gpu_selector_execution_lease_acquire_aborted', true);
        }
        let priorState;
        try {
          priorState = readGpuSelectorExecutionLeaseStateSync(opened.descriptor);
        } catch (error) {
          throw leaseError(
            'gpu_selector_execution_lease_state_invalid',
            false,
            error,
          );
        }
        if (priorState) {
          let recovery = null;
          if (recoverStaleState) {
            try {
              recovery = await recoverStaleState({
                state: priorState,
                gpuDeviceSelector: selected.gpuDeviceSelector,
                absoluteDeadlineEpochMs: selected.absoluteDeadlineEpochMs,
              });
            } catch (error) {
              recovery = { recovered: false, error };
            }
          }
          if (recovery?.recovered === true) {
            try {
              clearGpuSelectorExecutionLeaseStateSync(
                opened.descriptor,
                priorState.stateHash,
              );
            } catch (error) {
              throw leaseError(
                'gpu_selector_execution_lease_recovery_clear_failed',
                false,
                error,
              );
            }
          } else {
            const error = leaseError(
              'gpu_selector_execution_lease_recovery_required',
            );
            error.recoveryReceipt = recovery?.receipt || null;
            throw error;
          }
        }
        const acquiredAtEpochMs = Date.now();
        if (acquiredAtEpochMs > selected.absoluteDeadlineEpochMs) {
          throw leaseError('gpu_selector_execution_lease_deadline_exhausted');
        }
        const entropy = crypto.randomUUID();
        const leaseId = hashRecord('GpuSelectorExecutionLeaseId', {
          entropy,
          gpuDeviceSelector: selected.gpuDeviceSelector,
          ownerAuthorityHash: selected.ownerAuthorityHash,
          requestedAtEpochMs,
          acquiredAtEpochMs,
        });
        const fencingToken = hashRecord('GpuSelectorExecutionLeaseFencingToken', {
          entropy,
          leaseId,
          lockIdentityHash: opened.identityHash,
        });
        const receipt = buildGpuSelectorExecutionLeaseReceipt({
          gpuDeviceSelector: selected.gpuDeviceSelector,
          ownerAuthorityHash: selected.ownerAuthorityHash,
          leaseId,
          fencingToken,
          lockScopeIdentityHash,
          lockIdentityHash: opened.identityHash,
          requestedAtEpochMs,
          acquiredAtEpochMs,
          absoluteDeadlineEpochMs: selected.absoluteDeadlineEpochMs,
        });
        let durableState;
        try {
          durableState = writeGpuSelectorExecutionLeaseStateSync(
            opened.descriptor,
            buildGpuSelectorExecutionLeaseState({
              gpuDeviceSelector: selected.gpuDeviceSelector,
              ownerAuthorityHash: selected.ownerAuthorityHash,
              leaseId,
              fencingToken,
              absoluteDeadlineEpochMs: selected.absoluteDeadlineEpochMs,
            }),
          );
        } catch (error) {
          throw leaseError(
            'gpu_selector_execution_lease_state_persist_failed',
            false,
            error,
          );
        }
        let released = false;
        let quarantined = false;
        let delegatedWorkerOperationActive = false;
        let releaseReceipt = null;
        let releaseError = null;
        const assertHeld = () => {
          if (released || !descriptorOpen) {
            throw leaseError('gpu_selector_execution_lease_released');
          }
          let rootIdentity = null;
          try {
            rootIdentity = validateRoot(selectedRoot);
            const held = fs.fstatSync(opened.descriptor, { bigint: true });
            const atPath = fs.lstatSync(opened.lockPath, { bigint: true });
            if (rootIdentity.identityHash !== lockScopeIdentityHash
              || !held.isFile()
              || !atPath.isFile()
              || atPath.isSymbolicLink()
              || !sameIdentity(held, atPath)
              || JSON.stringify(statIdentity(held))
                !== JSON.stringify(opened.identity)) {
              throw leaseError('gpu_selector_execution_lease_identity_changed');
            }
            const persistedState = readGpuSelectorExecutionLeaseStateSync(
              opened.descriptor,
            );
            if (!persistedState
              || persistedState.stateHash !== durableState.stateHash) {
              throw leaseError('gpu_selector_execution_lease_state_changed');
            }
          } catch (error) {
            if (error?.code === 'gpu_selector_execution_lease_identity_changed'
              || error?.code === 'gpu_selector_execution_lease_state_changed') {
              throw error;
            }
            throw leaseError(
              'gpu_selector_execution_lease_state_changed',
              false,
              error,
            );
          } finally {
            if (rootIdentity?.descriptor !== undefined) {
              try { fs.closeSync(rootIdentity.descriptor); } catch { /* identity already failed */ }
            }
          }
          return true;
        };
        const release = ({ recoveryRelinquish = false } = {}) => {
          if (releaseReceipt) return releaseReceipt;
          if (releaseError) throw releaseError;
          try {
            if (quarantined) {
              if (descriptorOpen) fs.closeSync(opened.descriptor);
              descriptorOpen = false;
              released = true;
              if (recoveryRelinquish) return durableState;
              throw leaseError('gpu_selector_execution_lease_recovery_required');
            }
            assertHeld();
            clearGpuSelectorExecutionLeaseStateSync(
              opened.descriptor,
              durableState.stateHash,
            );
            fs.closeSync(opened.descriptor);
            descriptorOpen = false;
            released = true;
            releaseReceipt = buildGpuSelectorExecutionLeaseReleaseReceipt({
              acquisitionReceipt: receipt,
              releasedAtEpochMs: Date.now(),
            });
            return releaseReceipt;
          } catch (error) {
            releaseError = error;
            throw error;
          }
        };
        const bindWorkerInvocationAuthority = (
          workerInvocationAuthorityHash,
          {
            dockerWorkerContainerOwnership = null,
          } = {},
        ) => {
          assertHeld();
          if (quarantined) {
            throw leaseError('gpu_selector_execution_lease_recovery_required');
          }
          try {
            durableState = writeGpuSelectorExecutionLeaseStateSync(
              opened.descriptor,
              buildGpuSelectorExecutionLeaseState({
                ...durableState,
                stateHash: undefined,
                workerInvocationAuthorityHash,
                dockerWorkerContainerOwnership,
                updatedAtEpochMs: Date.now(),
              }),
            );
          } catch (error) {
            throw leaseError(
              'gpu_selector_execution_lease_state_persist_failed',
              false,
              error,
            );
          }
          return durableState;
        };
        const quarantine = (reason) => {
          assertHeld();
          if (quarantined) return durableState;
          try {
            durableState = writeGpuSelectorExecutionLeaseStateSync(
              opened.descriptor,
              buildGpuSelectorExecutionLeaseState({
                ...durableState,
                stateHash: undefined,
                status: 'recovery_required',
                quarantineReason: String(reason || ''),
                updatedAtEpochMs: Date.now(),
              }),
            );
            quarantined = true;
          } catch (error) {
            throw leaseError(
              'gpu_selector_execution_lease_quarantine_failed',
              false,
              error,
            );
          }
          return durableState;
        };
        const workerDelegation = Object.freeze({
          version: 1,
          kind: 'GpuSelectorExecutionLeaseWorkerDelegationCapability',
          gpuDeviceSelector: selected.gpuDeviceSelector,
          ownerAuthorityHash: selected.ownerAuthorityHash,
          absoluteDeadlineEpochMs: selected.absoluteDeadlineEpochMs,
          leaseId,
          fencingToken,
        });
        const runDelegatedWorkerOperation = async ({
          delegation,
          delegationAuthorityHash,
        } = {}, operation) => {
          assertHeld();
          if (quarantined) {
            throw leaseError('gpu_selector_execution_lease_recovery_required');
          }
          if (delegation !== workerDelegation
            || delegationAuthorityHash !== selected.ownerAuthorityHash) {
            throw leaseError('gpu_selector_execution_lease_delegation_invalid');
          }
          if (delegatedWorkerOperationActive) {
            throw leaseError(
              'gpu_selector_execution_lease_nested_worker_operation_forbidden',
            );
          }
          delegatedWorkerOperationActive = true;
          try {
            return await operation(lease);
          } finally {
            delegatedWorkerOperationActive = false;
          }
        };
        const lease = Object.freeze({
          version: 1,
          kind: 'GpuSelectorExecutionLeaseCapability',
          gpuDeviceSelector: selected.gpuDeviceSelector,
          ownerAuthorityHash: selected.ownerAuthorityHash,
          leaseId,
          fencingToken,
          lockScopeIdentityHash,
          lockIdentityHash: opened.identityHash,
          receipt,
          assertHeld,
          workerDelegation: () => workerDelegation,
          runDelegatedWorkerOperation,
          bindWorkerInvocationAuthority,
          hasWorkerInvocationAuthority: () => (
            durableState.workerInvocationAuthorityHash !== null
          ),
          isQuarantined: () => quarantined,
          quarantine,
          release,
        });
        return lease;
      } catch (error) {
        if (descriptorOpen) {
          try { fs.closeSync(opened.descriptor); } catch { /* preserve acquisition error */ }
        }
        throw error;
      }
    },
    async withLease(request, operation) {
      if (typeof operation !== 'function') {
        throw leaseError('gpu_selector_execution_lease_operation_required');
      }
      const selected = validateAcquireRequest(request);
      const active = ACTIVE_GPU_SELECTOR_EXECUTION_LEASE.getStore() || null;
      if (active) {
        if (selected.signal?.aborted) {
          throw leaseError('gpu_selector_execution_lease_acquire_aborted', true);
        }
        if (selected.absoluteDeadlineEpochMs <= Date.now()) {
          throw leaseError('gpu_selector_execution_lease_deadline_exhausted');
        }
        if (active.lockScopeIdentityHash !== lockScopeIdentityHash) {
          throw leaseError('gpu_selector_execution_lease_reentrant_scope_mismatch');
        }
        if (active.gpuDeviceSelector !== selected.gpuDeviceSelector) {
          throw leaseError('gpu_selector_execution_lease_reentrant_selector_mismatch');
        }
        if (selected.gpuSelectorExecutionLeaseDelegation) {
          if (active.receipt.absoluteDeadlineEpochMs
            !== selected.absoluteDeadlineEpochMs) {
            throw leaseError('gpu_selector_execution_lease_reentrant_deadline_mismatch');
          }
          active.assertHeld();
          return active.runDelegatedWorkerOperation({
            delegation: selected.gpuSelectorExecutionLeaseDelegation,
            delegationAuthorityHash:
              selected.gpuSelectorExecutionLeaseDelegationAuthorityHash,
          }, operation);
        }
        if (active.ownerAuthorityHash !== selected.ownerAuthorityHash) {
          throw leaseError('gpu_selector_execution_lease_reentrant_owner_mismatch');
        }
        if (active.receipt.absoluteDeadlineEpochMs
          !== selected.absoluteDeadlineEpochMs) {
          throw leaseError('gpu_selector_execution_lease_reentrant_deadline_mismatch');
        }
        active.assertHeld();
        throw leaseError(
          'gpu_selector_execution_lease_nested_worker_operation_forbidden',
        );
      }
      if (selected.gpuSelectorExecutionLeaseDelegation) {
        throw leaseError(
          'gpu_selector_execution_lease_delegation_without_active_lease',
        );
      }
      const lease = await port.acquire(selected);
      let operationError = null;
      try {
        return await ACTIVE_GPU_SELECTOR_EXECUTION_LEASE.run(
          lease,
          () => operation(lease),
        );
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try {
          lease.release({ recoveryRelinquish: lease.isQuarantined() });
        } catch (error) {
          if (!operationError) throw error;
        }
      }
    },
  };
  return assertGpuSelectorExecutionLeasePort(Object.freeze(port));
}
