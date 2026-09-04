import fs from 'node:fs';

import {
  verifyGpuDispatchMemoryAdmissionRequirement,
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
  if (!Array.isArray(observed)) return [];
  const normalized = observed.map((candidate) => String(candidate));
  if (normalized.some((candidate) => (
    !/^\/dev\/nvidia(?:\d+|ctl|uvm|uvm-tools|modeset)$/.test(candidate)
  ))) return [];
  return [...new Set(normalized)].sort();
}

export function inspectOsSandboxWorkerGpuPreflight({
  requiresGpu,
  allowGpu,
  executionBackend,
  gpuDeviceSelector,
  gpuDispatchMemoryAdmission,
  gpuDeviceCapacityObserver,
  gpuDevicePathObserver,
  gpuSelectorExecutionLease,
  absoluteDeadlineEpochMs,
  environment,
  now = Date.now(),
}) {
  const blockers = [];
  let gpuDevices = [];
  try {
    gpuDevices = normalizeObservedNvidiaGpuDevicePaths(gpuDevicePathObserver());
  } catch {
    gpuDevices = [];
  }
  const normalizedGpuDeviceSelector = normalizeNvidiaGpuDeviceSelector(gpuDeviceSelector);
  const gpuPreflightCapacityObservation = requiresGpu
    ? gpuDeviceCapacityObserver(normalizedGpuDeviceSelector) : null;
  const gpuDeviceSelectorObserved =
    gpuPreflightCapacityObservation?.gpuDeviceSelector === normalizedGpuDeviceSelector;

  if (requiresGpu && (!allowGpu || gpuDevices.length === 0)) blockers.push('worker_gpu_not_available_or_not_allowed');
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
  if (requiresGpu && normalizedGpuDeviceSelector && !gpuDeviceSelectorObserved) {
    blockers.push('worker_gpu_device_capacity_observation_invalid');
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
  if (requiresGpu && Object.prototype.hasOwnProperty.call(environment, 'CUDA_VISIBLE_DEVICES')) {
    blockers.push('worker_gpu_visibility_environment_override_forbidden');
  }

  return Object.freeze({
    blockers: Object.freeze(blockers),
    normalizedGpuDeviceSelector,
  });
}
