import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  gpuSelectorExecutionLeaseWorkerInvocationAuthorityHash,
  normalizeGpuSelectorExecutionLeaseSelector,
} from '../../paper-domain/automation/gpu-selector-execution-lease-contract.mjs';
import {
  createGpuSelectorExecutionLeaseRepository,
  gpuSelectorExecutionLeaseRootForRuntime,
} from './gpu-selector-execution-lease-repository.mjs';
import {
  recoverAbandonedDockerWorkerContainer,
  recoverDockerWorkerContainerAfterLauncher,
} from './docker-worker-container-recovery.mjs';

function blocked(availability, blockers) {
  return {
    ok: false,
    status: 'os_sandbox_worker_blocked',
    blockers,
    availability,
    isolation: {
      kernelNetworkIsolationVerified: false,
      filesystemNamespaceVerified: false,
      sourceReadOnlyVerified: false,
      resourceLimitsVerified: false,
      gpuSelectorExecutionLeaseVerified: false,
    },
  };
}

function unresolvedContainerRecoveryReason(result) {
  const recovery = result?.dockerWorkerContainerRecoveryReceipt || null;
  if (recovery?.status !== 'docker_worker_container_recovery_blocked') {
    return null;
  }
  return (recovery.blockers || [])
    .map(String)
    .find((reason) => reason.startsWith('worker_container_recovery_'))
    || 'worker_container_recovery_unresolved';
}

export function quarantineOsSandboxWorkerGpuSelectorLeaseForRecovery({
  lease,
  result,
} = {}) {
  const recoveryReason = unresolvedContainerRecoveryReason(result);
  if (recoveryReason) lease?.quarantine(recoveryReason);
  return result;
}

export function recoverDockerWorkerContainerAndFenceGpuSelectorLease({
  result,
  executionBackend,
  docker,
  ownership,
  spawnSyncImpl,
  environment,
  lease,
} = {}) {
  return quarantineOsSandboxWorkerGpuSelectorLeaseForRecovery({
    lease,
    result: recoverDockerWorkerContainerAfterLauncher({
      result,
      executionBackend,
      docker,
      ownership,
      spawnSyncImpl,
      environment,
    }),
  });
}

export function blockedOsSandboxWorkerGpuSelectorLease(
  availability,
  error,
) {
  return blocked(availability, [
    error?.message || 'worker_gpu_selector_execution_lease_invalid',
  ]);
}

export function createDockerWorkerGpuSelectorLeaseStaleRecovery({
  docker = 'docker',
  dockerContainerRecoveryExecutor = null,
  environment = process.env,
} = {}) {
  return function recoverStaleState({ state, absoluteDeadlineEpochMs } = {}) {
    if (Date.now() >= absoluteDeadlineEpochMs) {
      return { recovered: false, receipt: null };
    }
    if (!state?.workerInvocationAuthorityHash) {
      return {
        recovered: state?.status !== 'recovery_required',
        receipt: null,
      };
    }
    const receipt = recoverAbandonedDockerWorkerContainer({
      docker,
      ownership: state.dockerWorkerContainerOwnership,
      trigger: 'gpu_selector_lease_owner_process_lost',
      ...(dockerContainerRecoveryExecutor ? {
        spawnSyncImpl: dockerContainerRecoveryExecutor,
      } : {}),
      environment,
    });
    return {
      recovered: receipt.removalConfirmed === true
        && receipt.blockers.length === 0,
      receipt,
    };
  };
}

export function createOsSandboxWorkerGpuSelectorLeaseCoordinator({
  allowGpu,
  runtimeRoot,
  availability,
  docker = 'docker',
  dockerContainerRecoveryExecutor = null,
  environment = process.env,
} = {}) {
  const repository = allowGpu && runtimeRoot
    ? createGpuSelectorExecutionLeaseRepository({
      root: gpuSelectorExecutionLeaseRootForRuntime(runtimeRoot),
      recoverStaleState: createDockerWorkerGpuSelectorLeaseStaleRecovery({
        docker,
        dockerContainerRecoveryExecutor,
        environment,
      }),
    }) : null;
  return Object.freeze({
    run(spec, operation) {
      if (typeof operation !== 'function') {
        throw new Error('os_sandbox_worker_gpu_lease_operation_required');
      }
      if (spec?.requiresGpu !== true) return operation(null);
      const gpuDeviceSelector = normalizeGpuSelectorExecutionLeaseSelector(
        spec.gpuDeviceSelector,
      );
      const absoluteDeadlineEpochMs = Number(spec.absoluteDeadlineEpochMs);
      const blockers = [
        ...(!gpuDeviceSelector ? ['worker_gpu_device_selector_invalid'] : []),
        ...(!Number.isSafeInteger(absoluteDeadlineEpochMs)
          || absoluteDeadlineEpochMs <= Date.now()
          ? ['worker_gpu_absolute_deadline_invalid_or_exhausted'] : []),
        ...(!repository
          ? ['worker_gpu_selector_execution_lease_runtime_root_required'] : []),
      ];
      if (blockers.length) return blocked(availability, blockers);
      const ownerAuthorityHash = hashRecord(
        'OsSandboxWorkerGpuSelectorLeaseAcquisitionAuthority',
        {
          gpuDeviceSelector,
          absoluteDeadlineEpochMs,
          executable: String(spec.executable || ''),
          arguments: Array.isArray(spec.args) ? spec.args.map(String) : [],
          cwd: path.resolve(spec.cwd || '.'),
          sourceRoot: path.resolve(spec.sourceRoot || spec.cwd || '.'),
          containerImage: spec.containerImage ? String(spec.containerImage) : null,
          runtimeIdentityHash: spec.executionIdentity?.runtimeIdentityHash || null,
        },
      );
      return repository.withLease({
        gpuDeviceSelector,
        ownerAuthorityHash,
        absoluteDeadlineEpochMs,
        signal: spec.signal || null,
        gpuSelectorExecutionLeaseDelegation:
          spec.gpuSelectorExecutionLeaseDelegation ?? null,
        gpuSelectorExecutionLeaseDelegationAuthorityHash:
          spec.gpuSelectorExecutionLeaseDelegationAuthorityHash ?? null,
      }, async (lease) => {
        try {
          const result = await operation(lease);
          return quarantineOsSandboxWorkerGpuSelectorLeaseForRecovery({
            lease,
            result,
          });
        } catch (error) {
          if (lease.hasWorkerInvocationAuthority()) {
            lease.quarantine('worker_execution_outcome_unresolved');
          }
          throw error;
        }
      });
    },
  });
}

export function bindOsSandboxWorkerGpuSelectorLeaseAtLaunch({
  lease,
  gpuDeviceSelector,
  absoluteDeadlineEpochMs,
  boundedTimeout,
  processInvocationBinding,
  runtimeIdentityHash,
  containerImageDigest,
  dockerContainerOwnership,
} = {}) {
  lease?.assertHeld();
  const deadline = Number(absoluteDeadlineEpochMs);
  const selector = normalizeGpuSelectorExecutionLeaseSelector(gpuDeviceSelector);
  if (!selector || lease?.gpuDeviceSelector !== selector) {
    throw new Error('gpu_selector_execution_lease_selector_mismatch');
  }
  if (lease.receipt.absoluteDeadlineEpochMs !== deadline) {
    throw new Error('gpu_selector_execution_lease_deadline_mismatch');
  }
  const leaseBoundAtLaunchEpochMs = Date.now();
  const remainingDeadlineMs = deadline - leaseBoundAtLaunchEpochMs;
  if (remainingDeadlineMs < 1) {
    throw new Error('gpu_selector_execution_lease_deadline_exhausted');
  }
  const launchTimeoutMs = Math.min(boundedTimeout, remainingDeadlineMs);
  const workerInvocationAuthorityHash =
    gpuSelectorExecutionLeaseWorkerInvocationAuthorityHash({
      gpuDeviceSelector: selector,
      executionProcessInvocationHash:
        processInvocationBinding.executionProcessInvocationHash,
      runtimeIdentityHash,
      containerImageDigest,
      absoluteDeadlineEpochMs: deadline,
    });
  lease.bindWorkerInvocationAuthority(workerInvocationAuthorityHash, {
    dockerWorkerContainerOwnership: dockerContainerOwnership || null,
  });
  return Object.freeze({
    leaseBoundAtLaunchEpochMs,
    launchTimeoutMs,
    workerInvocationAuthorityHash,
  });
}
