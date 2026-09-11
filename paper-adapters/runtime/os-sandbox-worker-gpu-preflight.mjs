import fs from 'node:fs';

import {
  verifyGpuDispatchMemoryAdmissionRequirement,
  verifyNvidiaGpuDeviceCapacityObservation,
} from '../../paper-domain/automation/nvidia-gpu-device-capacity-contract.mjs';
import {
  normalizeNvidiaGpuDeviceSelector,
} from './os-sandbox-worker-runtime-support.mjs';

export function observeNvidiaGpuDevicePaths() {
  if (!fs.existsSync('/dev')) return [];
  return fs.readdirSync('/dev')
    .filter((name) => /^nvidia(?:\d+|ctl|uvm|uvm-tools|modeset)$/.test(name))
    .map((name) => `/dev/${name}`);
}

function normalizeObservedNvidiaGpuDevicePaths(observed) {
  if (!Array.isArray(observed) || observed.length > 1024
    || observed.some((candidate) => typeof candidate !== 'string' || candidate.length > 80)) return [];
  const normalized = observed;
  if (normalized.some((candidate) => (
    !/^\/dev\/nvidia(?:\d+|ctl|uvm|uvm-tools|modeset)$/.test(candidate)
  ))) return [];
  return [...new Set(normalized)].sort();
}

// Both preflight and the last dispatch check use the same closed observation contract.
// A failed probe is a typed denial, not an exception that skips sandbox cleanup.
export function observeVerifiedGpuDeviceCapacity(observer, selector) {
  try {
    const observation = observer(selector);
    return verifyNvidiaGpuDeviceCapacityObservation(observation)
      && observation.gpuDeviceSelector === selector ? observation : null;
  } catch {
    return null;
  }
}

export function inspectOsSandboxWorkerGpuPreflight({
  requiresGpu,
  allowGpu,
  executionBackend,
  gpuDeviceSelector,
  gpuDispatchMemoryAdmission = null,
  gpuDeviceCapacityObserver,
  gpuDevicePathObserver,
  gpuSelectorExecutionLease,
  absoluteDeadlineEpochMs,
  environment = {},
  now = Date.now(),
}) {
  const blockers = [];
  const normalizedGpuDeviceSelector = normalizeNvidiaGpuDeviceSelector(gpuDeviceSelector);
  if (requiresGpu && !allowGpu) blockers.push('worker_gpu_not_available_or_not_allowed');
  if (requiresGpu && executionBackend !== 'docker') blockers.push('worker_gpu_requires_docker_device_isolation');
  if (requiresGpu && !normalizedGpuDeviceSelector) blockers.push('worker_gpu_device_selector_invalid');
  if (requiresGpu && (!gpuSelectorExecutionLease
    || gpuSelectorExecutionLease.gpuDeviceSelector !== normalizedGpuDeviceSelector)) {
    blockers.push('worker_gpu_selector_execution_lease_invalid');
  }
  if (requiresGpu && (!Number.isSafeInteger(Number(absoluteDeadlineEpochMs))
    || Number(absoluteDeadlineEpochMs) <= now)) {
    blockers.push('worker_gpu_absolute_deadline_invalid_or_exhausted');
  }
  if (!requiresGpu && gpuDeviceSelector !== null && gpuDeviceSelector !== undefined) {
    blockers.push('worker_gpu_device_selector_without_gpu_request');
  }
  if (!requiresGpu && gpuDispatchMemoryAdmission !== null
    && gpuDispatchMemoryAdmission !== undefined) {
    blockers.push('worker_gpu_dispatch_memory_admission_without_gpu_request');
  }
  if (requiresGpu && gpuDispatchMemoryAdmission !== null
    && !verifyGpuDispatchMemoryAdmissionRequirement(gpuDispatchMemoryAdmission)) {
    blockers.push('worker_gpu_dispatch_memory_admission_invalid');
  }
  if (requiresGpu && gpuDispatchMemoryAdmission !== null
    && gpuDispatchMemoryAdmission?.gpuDeviceSelector !== normalizedGpuDeviceSelector) {
    blockers.push('worker_gpu_dispatch_memory_admission_selector_mismatch');
  }
  if (requiresGpu && Object.prototype.hasOwnProperty.call(environment || {}, 'CUDA_VISIBLE_DEVICES')) {
    blockers.push('worker_gpu_visibility_environment_override_forbidden');
  }

  // CPU work and already-invalid GPU requests must never probe a GPU or driver.
  if (requiresGpu && blockers.length === 0) {
    let devices = [];
    try { devices = normalizeObservedNvidiaGpuDevicePaths(gpuDevicePathObserver()); }
    catch { /* unavailable devices stay a fail-closed denial */ }
    if (devices.length === 0) blockers.push('worker_gpu_not_available_or_not_allowed');
    else if (!observeVerifiedGpuDeviceCapacity(gpuDeviceCapacityObserver, normalizedGpuDeviceSelector)) {
      blockers.push('worker_gpu_device_capacity_observation_invalid');
    }
  }

  return Object.freeze({
    blockers: Object.freeze(blockers),
    normalizedGpuDeviceSelector,
  });
}
