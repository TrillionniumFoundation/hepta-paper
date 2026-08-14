import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildDatasetAuthorizationSet } from './experiment-run-artifact-contract.mjs';
import { verifyWorkerDatasetRuntimeAccessBinding } from './dataset-runtime-access-contract.mjs';
import { verifyWorkerProcessExecutionIdentity } from './worker-process-execution-contract.mjs';
import { verifyEnvironmentBomAgainstWorkerReceipt } from './environment-bom-contract.mjs';
import {
  verifyGpuDispatchMemoryAdmissionEvaluation,
  verifyGpuDispatchMemoryAdmissionRequirement,
  verifyNvidiaGpuDeviceCapacityObservation,
} from './nvidia-gpu-device-capacity-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const NVIDIA_GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVOCATION_KEYS = Object.freeze([
  'arguments', 'executableTarget', 'executionClass', 'kind',
  'processInvocationId', 'sourceMerkleHash', 'sourceWorkspaceManifestHash',
  'standardInput', 'version', 'workingDirectory',
]);
const STANDARD_INPUT_KEYS = Object.freeze(['byteLength', 'present', 'sha256']);
const CPU_DEVICE_REQUEST_KEYS = Object.freeze([
  'deviceSelector', 'hostDeviceEnumerationMechanism', 'hostDeviceObserved',
  'kind', 'requestedDeviceCount', 'required', 'version',
]);
const GPU_DEVICE_REQUEST_KEYS = Object.freeze([
  'capacityObservation', 'capacityObservationHash', 'deviceSelector',
  'hostDeviceEnumerationMechanism', 'hostDeviceObserved', 'kind',
  'observedFreeMemoryBytes', 'observedTotalMemoryBytes', 'requestedDeviceCount',
  'required', 'version',
]);
const GPU_ADMITTED_DEVICE_REQUEST_KEYS = Object.freeze([
  ...GPU_DEVICE_REQUEST_KEYS,
  'dispatchMemoryAdmissionEvaluation', 'dispatchMemoryAdmissionEvaluationHash',
  'dispatchMemoryAdmissionRequirement',
  'dispatchMemoryAdmissionRequirementHash',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function safeInvocationText(value, maximumBytes = 64 * 1024) {
  return typeof value === 'string' && !/[\0\r\n]/.test(value)
    && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

export function verifyOsSandboxWorkerProcessInvocationBinding(receipt) {
  try {
    const binding = receipt?.executionProcessInvocation;
    const input = binding?.standardInput;
    const expectedClass = receipt.backend === 'docker'
      ? (receipt.runtimeExecutableSnapshotHash ? 'hybrid-docker' : 'explicit-container')
      : 'host';
    if (!exactKeys(binding, INVOCATION_KEYS)
      || binding.version !== 1
      || binding.kind !== 'OsSandboxWorkerProcessInvocationBinding'
      || binding.processInvocationId
        !== receipt.executionProcessIdentity?.processInvocationId
      || binding.executionClass !== expectedClass
      || !safeInvocationText(binding.executableTarget)
      || !Array.isArray(binding.arguments)
      || binding.arguments.length > 4096
      || binding.arguments.some((argument) => (
        typeof argument !== 'string' || /\0/.test(argument)
        || Buffer.byteLength(argument, 'utf8') > 1024 * 1024
      ))
      || !safeInvocationText(binding.workingDirectory)
      || !/^\/work(?:\/[^/\0]+)*$/.test(binding.workingDirectory)
      || binding.workingDirectory.split('/').some((part) => ['.', '..'].includes(part))
      || binding.sourceMerkleHash !== receipt.sourceMerkleHashBefore
      || binding.sourceWorkspaceManifestHash
        !== receipt.sourceWorkspaceManifestHashBefore
      || !exactKeys(input, STANDARD_INPUT_KEYS)
      || typeof input.present !== 'boolean'
      || !Number.isSafeInteger(input.byteLength)
      || input.byteLength < 0
      || (input.present
        ? (!SHA256.test(String(input.sha256 || '')))
        : (input.sha256 !== null || input.byteLength !== 0))
      || !SHA256.test(String(receipt.executionProcessInvocationHash || ''))
      || receipt.executionProcessInvocationHash !== hashRecord(
        'OsSandboxWorkerProcessInvocationBinding', binding,
      )) return false;
    return true;
  } catch { return false; }
}

function verifyGpuDeviceBinding(receipt) {
  const requested = receipt.isolation?.gpuAccessRequested === true;
  const request = receipt.gpuDeviceRequest;
  if (!requested) {
    return request === undefined || (
      exactKeys(request, CPU_DEVICE_REQUEST_KEYS)
      && request?.version === 1
      && request?.kind === 'GpuDeviceRequest'
      && request?.required === false
      && request?.deviceSelector === null
      && request?.requestedDeviceCount === 0
      && request?.hostDeviceObserved === null
      && request?.hostDeviceEnumerationMechanism === null
    );
  }
  const admitted = request?.version === 3;
  return receipt.backend === 'docker'
    && exactKeys(request, admitted
      ? GPU_ADMITTED_DEVICE_REQUEST_KEYS : GPU_DEVICE_REQUEST_KEYS)
    && [2, 3].includes(request?.version)
    && request?.kind === 'GpuDeviceRequest'
    && request?.required === true
    && NVIDIA_GPU_UUID.test(String(request?.deviceSelector || ''))
    && request?.requestedDeviceCount === 1
    && request?.hostDeviceObserved === true
    && request?.hostDeviceEnumerationMechanism
      === 'nvidia-smi-query-gpu-uuid-memory.total-memory.free-v1'
    && verifyNvidiaGpuDeviceCapacityObservation(request?.capacityObservation)
    && request.capacityObservation.gpuDeviceSelector === request.deviceSelector
    && request.capacityObservationHash
      === request.capacityObservation.nvidiaGpuDeviceCapacityObservationHash
    && request.observedTotalMemoryBytes === request.capacityObservation.totalMemoryBytes
    && request.observedFreeMemoryBytes === request.capacityObservation.freeMemoryBytes
    && (!admitted || (
      verifyGpuDispatchMemoryAdmissionRequirement(
        request.dispatchMemoryAdmissionRequirement,
      )
      && request.dispatchMemoryAdmissionRequirementHash
        === request.dispatchMemoryAdmissionRequirement.admissionRequirementHash
      && verifyGpuDispatchMemoryAdmissionEvaluation(
        request.dispatchMemoryAdmissionEvaluation,
        {
          requirement: request.dispatchMemoryAdmissionRequirement,
          dispatchCapacityObservation: request.capacityObservation,
        },
      )
      && request.dispatchMemoryAdmissionEvaluationHash
        === request.dispatchMemoryAdmissionEvaluation.admissionEvaluationHash
      && request.dispatchMemoryAdmissionEvaluation.admissionSatisfied === true
      && request.dispatchMemoryAdmissionEvaluation.gpuDeviceSelector
        === request.deviceSelector
    ))
    && receipt.isolation?.gpuDeviceIsolationVerified === true
    && receipt.isolation?.gpuDeviceSelectionMechanism
      === 'docker-nvidia-explicit-device-v1'
    && receipt.isolation?.gpuDeviceIsolationScope
      === 'single-requested-device-selector-not-mig-or-vram-isolation-v1'
    && receipt.isolation?.gpuMemoryIsolationVerified === false
    && receipt.isolation?.gpuMigIsolationVerified === false;
}

export function verifyOsSandboxWorkerReceipt(receipt) {
  if (!receipt || receipt.ok !== true || receipt.status !== 'os_sandbox_worker_passed') return false;
  if (![4, 5].includes(receipt.version)) return false;
  if (!['production-runtime-observation-v1', 'verification-fixture-v1']
    .includes(receipt.evidenceClass)
    || receipt.productionEvidenceEligible
      !== (receipt.evidenceClass === 'production-runtime-observation-v1')) return false;
  const { receiptHash } = receipt;
  const payload = { ...receipt };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  if (!SHA256.test(String(receiptHash || '')) || hashRecord('OsSandboxWorkerReceipt', payload) !== receiptHash) return false;
  if (!SHA256.test(String(receipt.artifactManifestHash || ''))
    || hashRecord('OsSandboxWorkerArtifactManifest', receipt.artifacts || []) !== receipt.artifactManifestHash) return false;
  const sourceHashes = [receipt.sourceMerkleHashBefore, receipt.sourceMerkleHashAfter, receipt.workSourceMerkleHash,
    receipt.sourceWorkspaceManifestHashBefore, receipt.sourceWorkspaceManifestHashAfter, receipt.workWorkspaceManifestHash];
  if (!SHA256.test(String(receipt.runtimeIdentityHash || ''))
    || !SHA256.test(String(receipt.environmentBindingHash || ''))
    || sourceHashes.some((value) => !SHA256.test(String(value || '')))
    || !verifyWorkerProcessExecutionIdentity(receipt)
    || (receipt.version === 5
      && !verifyOsSandboxWorkerProcessInvocationBinding(receipt))
    || !verifyGpuDeviceBinding(receipt)
    || !verifyEnvironmentBomAgainstWorkerReceipt(receipt.environmentBom, receipt)) return false;
  const datasetAuthorizations = buildDatasetAuthorizationSet(receipt.datasetMounts || []);
  if (receipt.datasetAuthorizationSetHash !== datasetAuthorizations.datasetAuthorizationSetHash
    || receipt.executionBindings?.HEPTA_DATASET_AUTHORIZATION_SET_HASH !== datasetAuthorizations.datasetAuthorizationSetHash) return false;
  if (!verifyWorkerDatasetRuntimeAccessBinding(receipt)) return false;
  return receipt.isolation?.kernelNetworkIsolationVerified === true
    && receipt.isolation?.sourceReadOnlyVerified === true
    && receipt.isolation?.ephemeralWorkRootVerified === true
    && receipt.isolation?.separateOutputRootVerified === true
    && receipt.sourceMerkleHashBefore === receipt.sourceMerkleHashAfter
    && receipt.sourceMerkleHashBefore === receipt.workSourceMerkleHash
    && receipt.sourceWorkspaceManifestHashBefore === receipt.sourceWorkspaceManifestHashAfter
    && receipt.sourceWorkspaceManifestHashBefore === receipt.workWorkspaceManifestHash;
}

export function verifyProductionOsSandboxWorkerReceipt(receipt) {
  try {
    return verifyOsSandboxWorkerReceipt(receipt)
      && receipt.version === 5
      && verifyOsSandboxWorkerProcessInvocationBinding(receipt)
      && receipt.evidenceClass === 'production-runtime-observation-v1'
      && receipt.productionEvidenceEligible === true
      && ['bubblewrap', 'docker'].includes(receipt.backend)
      && receipt.runnerId === `${receipt.backend}-kernel-isolation-worker-v4`
      && receipt.isolation?.memoryLimitVerified === true
      && receipt.isolation?.memoryLimitScope === (receipt.backend === 'docker'
        ? 'container-cgroup-aggregate-v1'
        : 'process-address-space-not-descendant-tree-v1')
      && receipt.isolation?.cpuLimitVerified === true
      && receipt.isolation?.cpuLimitScope
        === 'process-thread-group-not-descendant-tree-v1'
      && receipt.isolation?.processLimitVerified === true
      && receipt.isolation?.resourceLimitsVerified === true
      && receipt.isolation?.processLimitMechanism === (receipt.backend === 'docker'
        ? 'docker-pids-cgroup' : 'rlimit-nproc')
      && receipt.isolation?.processLimitScope === (receipt.backend === 'docker'
        ? 'container-cgroup-concurrent-tasks-v1'
        : 'real-uid-concurrent-processes-not-sandbox-local-v1');
  } catch { return false; }
}
