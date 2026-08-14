import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBSERVATION_KEYS = Object.freeze([
  'capacityScope', 'gpuDeviceSelector', 'gpuMemoryIsolationClaimed', 'kind',
  'multiTenantExclusivityClaimed', 'nvidiaGpuDeviceCapacityObservationHash',
  'freeMemoryBytes', 'observationMechanism', 'reportedFreeMemoryMiB',
  'reportedMemoryUnit', 'reportedTotalMemoryMiB', 'status', 'totalMemoryBytes',
  'version',
]);
const MAXIMUM_GPU_TOTAL_MEMORY_BYTES = 16 * 1024 ** 4;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DISPATCH_REQUIREMENT_KEYS = Object.freeze([
  'admissionRequirementHash', 'capacityPolicyId', 'estimatedPeakVramBytes',
  'gpuDeviceSelector', 'gpuMemoryCapacityPlanHash', 'gpuMemoryIsolationClaimed',
  'kind', 'minimumFreeMemoryHeadroomBytes', 'minimumRequiredFreeMemoryBytes',
  'multiTenantExclusivityClaimed', 'planningCapacityObservationHash',
  'planningFreeMemoryBytes', 'planningTotalMemoryBytes', 'version',
]);
const DISPATCH_EVALUATION_KEYS = Object.freeze([
  'admissionEvaluationHash', 'admissionRequirementHash', 'admissionSatisfied',
  'dispatchCapacityObservationHash', 'dispatchFreeMemoryBytes',
  'dispatchTotalMemoryBytes', 'freeMemoryRequirementSatisfied',
  'gpuDeviceSelector', 'gpuMemoryIsolationClaimed', 'kind',
  'minimumRequiredFreeMemoryBytes', 'multiTenantExclusivityClaimed',
  'planningAndDispatchDeviceMatched', 'planningAndDispatchTotalMemoryMatched',
  'status', 'version',
]);

function exactPlainObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function buildNvidiaGpuDeviceCapacityObservation({
  gpuDeviceSelector,
  reportedTotalMemoryMiB,
  reportedFreeMemoryMiB,
} = {}) {
  const totalMemoryBytes = reportedTotalMemoryMiB * 1024 ** 2;
  const freeMemoryBytes = reportedFreeMemoryMiB * 1024 ** 2;
  if (!GPU_UUID.test(String(gpuDeviceSelector || ''))
    || !Number.isSafeInteger(reportedTotalMemoryMiB)
    || reportedTotalMemoryMiB < 256
    || !Number.isSafeInteger(reportedFreeMemoryMiB)
    || reportedFreeMemoryMiB < 0
    || reportedFreeMemoryMiB > reportedTotalMemoryMiB
    || !Number.isSafeInteger(totalMemoryBytes)
    || !Number.isSafeInteger(freeMemoryBytes)
    || totalMemoryBytes > MAXIMUM_GPU_TOTAL_MEMORY_BYTES) {
    throw new Error('nvidia_gpu_device_capacity_observation_invalid');
  }
  const payload = {
    version: 1,
    kind: 'NvidiaGpuDeviceCapacityObservation',
    status: 'nvidia_gpu_total_and_free_memory_capacity_observed',
    gpuDeviceSelector,
    reportedTotalMemoryMiB,
    reportedFreeMemoryMiB,
    reportedMemoryUnit: 'MiB-binary-v1',
    totalMemoryBytes,
    freeMemoryBytes,
    observationMechanism:
      'nvidia-smi-query-gpu-uuid-memory.total-memory.free-v1',
    capacityScope:
      'physical-device-total-and-point-in-time-free-memory-not-exclusive-v1',
    gpuMemoryIsolationClaimed: false,
    multiTenantExclusivityClaimed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    nvidiaGpuDeviceCapacityObservationHash:
      hashRecord('NvidiaGpuDeviceCapacityObservation', payload),
  });
}

export function verifyNvidiaGpuDeviceCapacityObservation(value) {
  try {
    return exactPlainObject(value, OBSERVATION_KEYS)
      && JSON.stringify(buildNvidiaGpuDeviceCapacityObservation({
        gpuDeviceSelector: value.gpuDeviceSelector,
        reportedTotalMemoryMiB: value.reportedTotalMemoryMiB,
        reportedFreeMemoryMiB: value.reportedFreeMemoryMiB,
      })) === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function buildGpuDispatchMemoryAdmissionRequirement({
  gpuDeviceSelector,
  gpuMemoryCapacityPlanHash,
  capacityPolicyId,
  planningCapacityObservationHash,
  planningTotalMemoryBytes,
  planningFreeMemoryBytes,
  estimatedPeakVramBytes,
  minimumFreeMemoryHeadroomBytes,
} = {}) {
  const minimumRequiredFreeMemoryBytes = estimatedPeakVramBytes
    + minimumFreeMemoryHeadroomBytes;
  if (!GPU_UUID.test(String(gpuDeviceSelector || ''))
    || !SHA256.test(String(gpuMemoryCapacityPlanHash || ''))
    || !SHA256.test(String(planningCapacityObservationHash || ''))
    || typeof capacityPolicyId !== 'string' || capacityPolicyId.length < 1
    || capacityPolicyId.length > 160
    || !Number.isSafeInteger(planningTotalMemoryBytes)
    || planningTotalMemoryBytes < 256 * 1024 ** 2
    || planningTotalMemoryBytes > MAXIMUM_GPU_TOTAL_MEMORY_BYTES
    || !Number.isSafeInteger(planningFreeMemoryBytes)
    || planningFreeMemoryBytes < 0
    || planningFreeMemoryBytes > planningTotalMemoryBytes
    || !Number.isSafeInteger(estimatedPeakVramBytes) || estimatedPeakVramBytes < 1
    || !Number.isSafeInteger(minimumFreeMemoryHeadroomBytes)
    || minimumFreeMemoryHeadroomBytes < 1
    || !Number.isSafeInteger(minimumRequiredFreeMemoryBytes)) {
    throw new Error('gpu_dispatch_memory_admission_requirement_invalid');
  }
  const payload = {
    version: 1,
    kind: 'GpuDispatchMemoryAdmissionRequirement',
    gpuDeviceSelector,
    gpuMemoryCapacityPlanHash,
    capacityPolicyId,
    planningCapacityObservationHash,
    planningTotalMemoryBytes,
    planningFreeMemoryBytes,
    estimatedPeakVramBytes,
    minimumFreeMemoryHeadroomBytes,
    minimumRequiredFreeMemoryBytes,
    gpuMemoryIsolationClaimed: false,
    multiTenantExclusivityClaimed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    admissionRequirementHash:
      hashRecord('GpuDispatchMemoryAdmissionRequirement', payload),
  });
}

export function verifyGpuDispatchMemoryAdmissionRequirement(value) {
  try {
    return exactPlainObject(value, DISPATCH_REQUIREMENT_KEYS)
      && JSON.stringify(buildGpuDispatchMemoryAdmissionRequirement(value))
        === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function buildGpuDispatchMemoryAdmissionEvaluation({
  requirement,
  dispatchCapacityObservation,
} = {}) {
  if (!verifyGpuDispatchMemoryAdmissionRequirement(requirement)
    || !verifyNvidiaGpuDeviceCapacityObservation(dispatchCapacityObservation)) {
    throw new Error('gpu_dispatch_memory_admission_evaluation_input_invalid');
  }
  const planningAndDispatchDeviceMatched =
    requirement.gpuDeviceSelector === dispatchCapacityObservation.gpuDeviceSelector;
  const planningAndDispatchTotalMemoryMatched =
    requirement.planningTotalMemoryBytes === dispatchCapacityObservation.totalMemoryBytes;
  const freeMemoryRequirementSatisfied = dispatchCapacityObservation.freeMemoryBytes
    >= requirement.minimumRequiredFreeMemoryBytes;
  const admissionSatisfied = planningAndDispatchDeviceMatched
    && planningAndDispatchTotalMemoryMatched && freeMemoryRequirementSatisfied;
  const payload = {
    version: 1,
    kind: 'GpuDispatchMemoryAdmissionEvaluation',
    status: admissionSatisfied
      ? 'gpu_dispatch_memory_admission_satisfied'
      : 'gpu_dispatch_memory_admission_blocked',
    admissionRequirementHash: requirement.admissionRequirementHash,
    gpuDeviceSelector: dispatchCapacityObservation.gpuDeviceSelector,
    dispatchCapacityObservationHash:
      dispatchCapacityObservation.nvidiaGpuDeviceCapacityObservationHash,
    dispatchTotalMemoryBytes: dispatchCapacityObservation.totalMemoryBytes,
    dispatchFreeMemoryBytes: dispatchCapacityObservation.freeMemoryBytes,
    minimumRequiredFreeMemoryBytes: requirement.minimumRequiredFreeMemoryBytes,
    planningAndDispatchDeviceMatched,
    planningAndDispatchTotalMemoryMatched,
    freeMemoryRequirementSatisfied,
    admissionSatisfied,
    gpuMemoryIsolationClaimed: false,
    multiTenantExclusivityClaimed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    admissionEvaluationHash:
      hashRecord('GpuDispatchMemoryAdmissionEvaluation', payload),
  });
}

export function verifyGpuDispatchMemoryAdmissionEvaluation(value, {
  requirement,
  dispatchCapacityObservation,
} = {}) {
  try {
    return exactPlainObject(value, DISPATCH_EVALUATION_KEYS)
      && JSON.stringify(buildGpuDispatchMemoryAdmissionEvaluation({
        requirement,
        dispatchCapacityObservation,
      })) === JSON.stringify(value);
  } catch {
    return false;
  }
}
