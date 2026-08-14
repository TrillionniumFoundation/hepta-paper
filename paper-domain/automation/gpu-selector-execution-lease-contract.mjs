import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const GPU_SELECTOR_EXECUTION_LEASE_MECHANISM =
  'linux-open-file-description-flock-v1';
export const GPU_SELECTOR_EXECUTION_LEASE_SCOPE =
  'shared-runtime-root-cooperating-processes-per-gpu-uuid-v1';

const ACQUISITION_KEYS = Object.freeze([
  'absoluteDeadlineEpochMs', 'acquiredAtEpochMs', 'fencingToken',
  'gpuDeviceSelector', 'gpuSelectorExecutionLeaseReceiptHash', 'kind',
  'leaseId', 'lockIdentityHash', 'lockScopeIdentityHash', 'mechanism',
  'ownerAuthorityHash', 'productionExclusivityClaimed', 'requestedAtEpochMs',
  'scope', 'selectorKeyHash', 'status', 'version',
]);
const RELEASE_KEYS = Object.freeze([
  'acquisitionReceiptHash', 'fencingToken', 'gpuDeviceSelector',
  'gpuSelectorExecutionLeaseReleaseReceiptHash', 'kind', 'leaseId',
  'productionExclusivityClaimed', 'releasedAtEpochMs', 'status', 'version',
]);
const WORKER_BINDING_KEYS = Object.freeze([
  'absoluteDeadlineEpochMs',
  'dockerDeterministicContainerNameCrashRecoveryBackstopVerified',
  'gpuDeviceSelector', 'gpuSelectorExecutionLeaseBindingHash',
  'gpuSelectorExecutionLeaseReceipt', 'gpuSelectorExecutionLeaseReceiptHash',
  'kind', 'leaseBoundAtLaunchEpochMs', 'leaseHeldAtFinalization',
  'launchTimeoutMs', 'multiTenantExclusivityClaimed',
  'productionExclusivityClaimed', 'residualRiskDisclosures', 'version',
  'workerInvocationAuthorityHash',
]);

export const GPU_SELECTOR_EXECUTION_LEASE_RESIDUAL_RISK_DISCLOSURES =
  Object.freeze([
    'gpu_selector_lease_scope_is_shared_runtime_root_not_host_global',
    'gpu_corrupt_or_unverifiable_lease_state_requires_operator_reconciliation',
    'gpu_same_uid_noncooperating_lock_path_replacement_not_fenced',
  ]);

function safeEpoch(value, blocker) {
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(blocker);
  return selected;
}

function requiredHash(value, blocker) {
  const selected = String(value || '').toLowerCase();
  if (!SHA256.test(selected)) throw new Error(blocker);
  return selected;
}

export function normalizeGpuSelectorExecutionLeaseSelector(value) {
  const candidate = String(value || '').trim();
  if (!GPU_UUID.test(candidate)) return null;
  return `GPU-${candidate.slice(4).toLowerCase()}`;
}

export function gpuSelectorExecutionLeaseSelectorKeyHash(value) {
  const gpuDeviceSelector = normalizeGpuSelectorExecutionLeaseSelector(value);
  if (!gpuDeviceSelector) throw new Error('gpu_selector_execution_lease_selector_invalid');
  return hashRecord('GpuSelectorExecutionLeaseSelectorKey', { gpuDeviceSelector });
}

export function gpuSelectorExecutionLeaseWorkerInvocationAuthorityHash({
  gpuDeviceSelector,
  executionProcessInvocationHash,
  runtimeIdentityHash,
  containerImageDigest,
  absoluteDeadlineEpochMs,
} = {}) {
  const selector = normalizeGpuSelectorExecutionLeaseSelector(gpuDeviceSelector);
  if (!selector) throw new Error('gpu_selector_execution_lease_selector_invalid');
  return hashRecord('GpuSelectorExecutionLeaseWorkerInvocationAuthority', {
    gpuDeviceSelector: selector,
    executionProcessInvocationHash: requiredHash(
      executionProcessInvocationHash,
      'gpu_selector_execution_lease_worker_invocation_hash_invalid',
    ),
    runtimeIdentityHash: requiredHash(
      runtimeIdentityHash,
      'gpu_selector_execution_lease_worker_runtime_identity_invalid',
    ),
    containerImageDigest: requiredHash(
      containerImageDigest,
      'gpu_selector_execution_lease_worker_container_identity_invalid',
    ),
    absoluteDeadlineEpochMs: safeEpoch(
      absoluteDeadlineEpochMs,
      'gpu_selector_execution_lease_deadline_invalid',
    ),
  });
}

export function buildGpuSelectorExecutionLeaseReceipt({
  gpuDeviceSelector,
  ownerAuthorityHash,
  leaseId,
  fencingToken,
  lockScopeIdentityHash,
  lockIdentityHash,
  requestedAtEpochMs,
  acquiredAtEpochMs,
  absoluteDeadlineEpochMs,
} = {}) {
  const selector = normalizeGpuSelectorExecutionLeaseSelector(gpuDeviceSelector);
  if (!selector) throw new Error('gpu_selector_execution_lease_selector_invalid');
  const requestedAt = safeEpoch(
    requestedAtEpochMs,
    'gpu_selector_execution_lease_requested_at_invalid',
  );
  const acquiredAt = safeEpoch(
    acquiredAtEpochMs,
    'gpu_selector_execution_lease_acquired_at_invalid',
  );
  const deadline = safeEpoch(
    absoluteDeadlineEpochMs,
    'gpu_selector_execution_lease_deadline_invalid',
  );
  if (acquiredAt < requestedAt || acquiredAt > deadline) {
    throw new Error('gpu_selector_execution_lease_timeline_invalid');
  }
  const payload = {
    version: 1,
    kind: 'GpuSelectorExecutionLeaseReceipt',
    status: 'gpu_selector_execution_lease_acquired',
    gpuDeviceSelector: selector,
    selectorKeyHash: gpuSelectorExecutionLeaseSelectorKeyHash(selector),
    ownerAuthorityHash: requiredHash(
      ownerAuthorityHash,
      'gpu_selector_execution_lease_owner_authority_invalid',
    ),
    leaseId: requiredHash(leaseId, 'gpu_selector_execution_lease_id_invalid'),
    fencingToken: requiredHash(
      fencingToken,
      'gpu_selector_execution_lease_fencing_token_invalid',
    ),
    lockScopeIdentityHash: requiredHash(
      lockScopeIdentityHash,
      'gpu_selector_execution_lease_scope_identity_invalid',
    ),
    lockIdentityHash: requiredHash(
      lockIdentityHash,
      'gpu_selector_execution_lease_lock_identity_invalid',
    ),
    mechanism: GPU_SELECTOR_EXECUTION_LEASE_MECHANISM,
    scope: GPU_SELECTOR_EXECUTION_LEASE_SCOPE,
    requestedAtEpochMs: requestedAt,
    acquiredAtEpochMs: acquiredAt,
    absoluteDeadlineEpochMs: deadline,
    productionExclusivityClaimed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuSelectorExecutionLeaseReceiptHash:
      hashRecord('GpuSelectorExecutionLeaseReceipt', payload),
  });
}

export function verifyGpuSelectorExecutionLeaseReceipt(value) {
  try {
    if (!hasExactObjectKeys(value, ACQUISITION_KEYS)
      || value?.version !== 1
      || value?.kind !== 'GpuSelectorExecutionLeaseReceipt'
      || value?.status !== 'gpu_selector_execution_lease_acquired'
      || value?.mechanism !== GPU_SELECTOR_EXECUTION_LEASE_MECHANISM
      || value?.scope !== GPU_SELECTOR_EXECUTION_LEASE_SCOPE
      || value?.productionExclusivityClaimed !== false
      || normalizeGpuSelectorExecutionLeaseSelector(value.gpuDeviceSelector)
        !== value.gpuDeviceSelector
      || gpuSelectorExecutionLeaseSelectorKeyHash(value.gpuDeviceSelector)
        !== value.selectorKeyHash
      || [value.ownerAuthorityHash, value.leaseId, value.fencingToken,
        value.lockScopeIdentityHash, value.lockIdentityHash,
        value.gpuSelectorExecutionLeaseReceiptHash]
        .some((item) => !SHA256.test(String(item || '')))
      || !Number.isSafeInteger(value.requestedAtEpochMs)
      || !Number.isSafeInteger(value.acquiredAtEpochMs)
      || !Number.isSafeInteger(value.absoluteDeadlineEpochMs)
      || value.requestedAtEpochMs < 1
      || value.acquiredAtEpochMs < value.requestedAtEpochMs
      || value.acquiredAtEpochMs > value.absoluteDeadlineEpochMs) return false;
    const { gpuSelectorExecutionLeaseReceiptHash, ...payload } = value;
    return hashRecord('GpuSelectorExecutionLeaseReceipt', payload)
      === gpuSelectorExecutionLeaseReceiptHash;
  } catch { return false; }
}

export function buildGpuSelectorExecutionLeaseReleaseReceipt({
  acquisitionReceipt,
  releasedAtEpochMs,
} = {}) {
  if (!verifyGpuSelectorExecutionLeaseReceipt(acquisitionReceipt)) {
    throw new Error('gpu_selector_execution_lease_acquisition_receipt_invalid');
  }
  const releasedAt = safeEpoch(
    releasedAtEpochMs,
    'gpu_selector_execution_lease_released_at_invalid',
  );
  if (releasedAt < acquisitionReceipt.acquiredAtEpochMs) {
    throw new Error('gpu_selector_execution_lease_release_timeline_invalid');
  }
  const payload = {
    version: 1,
    kind: 'GpuSelectorExecutionLeaseReleaseReceipt',
    status: 'gpu_selector_execution_lease_released',
    gpuDeviceSelector: acquisitionReceipt.gpuDeviceSelector,
    leaseId: acquisitionReceipt.leaseId,
    fencingToken: acquisitionReceipt.fencingToken,
    acquisitionReceiptHash:
      acquisitionReceipt.gpuSelectorExecutionLeaseReceiptHash,
    releasedAtEpochMs: releasedAt,
    productionExclusivityClaimed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuSelectorExecutionLeaseReleaseReceiptHash:
      hashRecord('GpuSelectorExecutionLeaseReleaseReceipt', payload),
  });
}

export function verifyGpuSelectorExecutionLeaseReleaseReceipt(value, {
  acquisitionReceipt = null,
} = {}) {
  try {
    if (!hasExactObjectKeys(value, RELEASE_KEYS)
      || value?.version !== 1
      || value?.kind !== 'GpuSelectorExecutionLeaseReleaseReceipt'
      || value?.status !== 'gpu_selector_execution_lease_released'
      || value?.productionExclusivityClaimed !== false
      || normalizeGpuSelectorExecutionLeaseSelector(value.gpuDeviceSelector)
        !== value.gpuDeviceSelector
      || [value.leaseId, value.fencingToken, value.acquisitionReceiptHash,
        value.gpuSelectorExecutionLeaseReleaseReceiptHash]
        .some((item) => !SHA256.test(String(item || '')))
      || !Number.isSafeInteger(value.releasedAtEpochMs)
      || value.releasedAtEpochMs < 1) return false;
    const { gpuSelectorExecutionLeaseReleaseReceiptHash, ...payload } = value;
    if (hashRecord('GpuSelectorExecutionLeaseReleaseReceipt', payload)
      !== gpuSelectorExecutionLeaseReleaseReceiptHash) return false;
    return !acquisitionReceipt || (
      verifyGpuSelectorExecutionLeaseReceipt(acquisitionReceipt)
      && value.gpuDeviceSelector === acquisitionReceipt.gpuDeviceSelector
      && value.leaseId === acquisitionReceipt.leaseId
      && value.fencingToken === acquisitionReceipt.fencingToken
      && value.acquisitionReceiptHash
        === acquisitionReceipt.gpuSelectorExecutionLeaseReceiptHash
      && value.releasedAtEpochMs >= acquisitionReceipt.acquiredAtEpochMs
    );
  } catch { return false; }
}

export function buildGpuSelectorExecutionLeaseWorkerBinding({
  acquisitionReceipt,
  workerInvocationAuthorityHash,
  absoluteDeadlineEpochMs,
  leaseBoundAtLaunchEpochMs,
  launchTimeoutMs,
  leaseHeldAtFinalization,
} = {}) {
  if (!verifyGpuSelectorExecutionLeaseReceipt(acquisitionReceipt)) {
    throw new Error('gpu_selector_execution_lease_acquisition_receipt_invalid');
  }
  const deadline = safeEpoch(
    absoluteDeadlineEpochMs,
    'gpu_selector_execution_lease_deadline_invalid',
  );
  const boundAt = safeEpoch(
    leaseBoundAtLaunchEpochMs,
    'gpu_selector_execution_lease_worker_launch_time_invalid',
  );
  const timeout = Number(launchTimeoutMs);
  if (deadline !== acquisitionReceipt.absoluteDeadlineEpochMs
    || boundAt < acquisitionReceipt.acquiredAtEpochMs
    || boundAt >= deadline
    || !Number.isSafeInteger(timeout)
    || timeout < 1
    || timeout > deadline - boundAt
    || leaseHeldAtFinalization !== true) {
    throw new Error('gpu_selector_execution_lease_worker_timeline_invalid');
  }
  const payload = {
    version: 1,
    kind: 'GpuSelectorExecutionLeaseWorkerBinding',
    gpuDeviceSelector: acquisitionReceipt.gpuDeviceSelector,
    workerInvocationAuthorityHash: requiredHash(
      workerInvocationAuthorityHash,
      'gpu_selector_execution_lease_worker_authority_invalid',
    ),
    gpuSelectorExecutionLeaseReceiptHash:
      acquisitionReceipt.gpuSelectorExecutionLeaseReceiptHash,
    gpuSelectorExecutionLeaseReceipt: acquisitionReceipt,
    absoluteDeadlineEpochMs: deadline,
    leaseBoundAtLaunchEpochMs: boundAt,
    launchTimeoutMs: timeout,
    leaseHeldAtFinalization: true,
    productionExclusivityClaimed: false,
    multiTenantExclusivityClaimed: false,
    dockerDeterministicContainerNameCrashRecoveryBackstopVerified: false,
    residualRiskDisclosures:
      GPU_SELECTOR_EXECUTION_LEASE_RESIDUAL_RISK_DISCLOSURES,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuSelectorExecutionLeaseBindingHash:
      hashRecord('GpuSelectorExecutionLeaseWorkerBinding', payload),
  });
}

export function verifyGpuSelectorExecutionLeaseWorkerBinding(value, {
  workerReceipt = null,
} = {}) {
  try {
    if (!hasExactObjectKeys(value, WORKER_BINDING_KEYS)
      || value?.version !== 1
      || value?.kind !== 'GpuSelectorExecutionLeaseWorkerBinding'
      || value?.leaseHeldAtFinalization !== true
      || value?.productionExclusivityClaimed !== false
      || value?.multiTenantExclusivityClaimed !== false
      || value?.dockerDeterministicContainerNameCrashRecoveryBackstopVerified
        !== false
      || JSON.stringify(value?.residualRiskDisclosures)
        !== JSON.stringify(GPU_SELECTOR_EXECUTION_LEASE_RESIDUAL_RISK_DISCLOSURES)
      || !verifyGpuSelectorExecutionLeaseReceipt(
        value.gpuSelectorExecutionLeaseReceipt,
      )
      || value.gpuSelectorExecutionLeaseReceiptHash
        !== value.gpuSelectorExecutionLeaseReceipt
          .gpuSelectorExecutionLeaseReceiptHash
      || value.gpuDeviceSelector
        !== value.gpuSelectorExecutionLeaseReceipt.gpuDeviceSelector
      || !SHA256.test(String(value.workerInvocationAuthorityHash || ''))
      || !Number.isSafeInteger(value.absoluteDeadlineEpochMs)
      || value.absoluteDeadlineEpochMs
        !== value.gpuSelectorExecutionLeaseReceipt.absoluteDeadlineEpochMs
      || !Number.isSafeInteger(value.leaseBoundAtLaunchEpochMs)
      || value.leaseBoundAtLaunchEpochMs
        < value.gpuSelectorExecutionLeaseReceipt.acquiredAtEpochMs
      || value.leaseBoundAtLaunchEpochMs >= value.absoluteDeadlineEpochMs
      || !Number.isSafeInteger(value.launchTimeoutMs)
      || value.launchTimeoutMs < 1
      || value.launchTimeoutMs
        > value.absoluteDeadlineEpochMs - value.leaseBoundAtLaunchEpochMs
      || !SHA256.test(String(value.gpuSelectorExecutionLeaseBindingHash || ''))) {
      return false;
    }
    const { gpuSelectorExecutionLeaseBindingHash, ...payload } = value;
    if (hashRecord('GpuSelectorExecutionLeaseWorkerBinding', payload)
      !== gpuSelectorExecutionLeaseBindingHash) return false;
    if (!workerReceipt) return true;
    return workerReceipt.gpuDeviceRequest?.deviceSelector
        === value.gpuDeviceSelector
      && workerReceipt.gpuSelectorExecutionLeaseBindingHash
        === value.gpuSelectorExecutionLeaseBindingHash
      && value.workerInvocationAuthorityHash
        === gpuSelectorExecutionLeaseWorkerInvocationAuthorityHash({
          gpuDeviceSelector: value.gpuDeviceSelector,
          executionProcessInvocationHash:
            workerReceipt.executionProcessInvocationHash,
          runtimeIdentityHash: workerReceipt.runtimeIdentityHash,
          containerImageDigest: workerReceipt.containerImageDigest,
          absoluteDeadlineEpochMs: value.absoluteDeadlineEpochMs,
        });
  } catch { return false; }
}
