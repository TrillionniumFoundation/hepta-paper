import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyDeepLearningTrainingExecutionReceipt,
} from '../research/deep-learning-training-execution-contract.mjs';
import {
  verifyPdePoisson2dGpuArtifactManifest,
} from '../research/pde-poisson-2d-gpu-capability-contract.mjs';
import {
  verifyProcessIsolatedPdePoisson2dCpuOracleAssurance,
} from '../research/process-isolated-pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from './os-sandbox-worker-receipt-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function recordHashValid(value, kind, field) {
  if (!value || !SHA256.test(String(value[field] || ''))) return false;
  const { [field]: claimedHash, ...payload } = value;
  return hashRecord(kind, payload) === claimedHash;
}

function pdeAssuranceValid(value, {
  producerSpecification, artifactManifest, deadline,
} = {}) {
  return verifyProcessIsolatedPdePoisson2dCpuOracleAssurance(value)
    && value.producerSpecificationHash
      === producerSpecification?.pdePoisson2dGpuProducerSpecificationHash
    && value.artifactManifestHash === artifactManifest?.pdePoisson2dGpuArtifactManifestHash
    && value.absoluteDeadlineEpochMs === deadline;
}

export function verifyGpuScientificPdeTaskReceipt(value, {
  task, gpuDeviceSelector, deadline, executionAuthorityHash = null,
} = {}) {
  const gpu = value?.gpuReceipt;
  const manifest = gpu?.artifactManifest;
  const requestPayload = {
    version: 1,
    kind: 'CanonicalCupyPoisson2dRequest',
    runId: task?.runId,
    producerSpecification: gpu?.producerSpecification,
    ...(executionAuthorityHash ? { executionAuthorityHash } : {}),
  };
  const requestHash = hashRecord('CanonicalCupyPoisson2dRequest', requestPayload);
  const standardInput = `${JSON.stringify({ ...requestPayload, requestHash })}\n`;
  const standardInputByteLength = Buffer.byteLength(standardInput);
  const standardInputHash = hashBytes(Buffer.from(standardInput, 'utf8'));
  return value?.kind === 'CanonicalPdePoisson2dGpuScientificReceipt'
    && value?.status
      === 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable'
    && value?.productionPromotionEligible === false
    && Array.isArray(value?.blockers) && value.blockers.length > 0
    && recordHashValid(value, 'CanonicalPdePoisson2dGpuScientificReceipt',
      'canonicalPdePoisson2dGpuScientificReceiptHash')
    && gpu?.kind === 'CanonicalCupyPdePoisson2dExecutionReceipt'
    && gpu?.status === 'canonical_cupy_pde_poisson_2d_executed_pending_cpu_oracle'
    && gpu?.runId === task?.runId
    && gpu?.executionAuthorityHash === executionAuthorityHash
    && gpu?.requestHash === requestHash
    && gpu?.absoluteDeadlineEpochMs === deadline
    && recordHashValid(gpu, 'CanonicalCupyPdePoisson2dExecutionReceipt',
      'canonicalCupyPdePoisson2dExecutionReceiptHash')
    && manifest?.version === 3
    && manifest?.requestHash === requestHash
    && manifest?.requestStandardInputHash === standardInputHash
    && manifest?.requestStandardInputByteLength === standardInputByteLength
    && manifest?.osSandboxWorkerReceipt?.executionProcessInvocation
      ?.standardInput?.sha256 === standardInputHash
    && manifest?.osSandboxWorkerReceipt?.executionProcessInvocation
      ?.standardInput?.byteLength === standardInputByteLength
    && manifest?.gpuDeviceIdentityHash === hashRecord('PdePoisson2dGpuDeviceUuid', {
      gpuDeviceSelector,
    })
    && manifest?.osSandboxWorkerReceipt?.gpuDeviceRequest?.deviceSelector
      === gpuDeviceSelector
    && verifyPdePoisson2dGpuArtifactManifest(manifest, {
      producerSpecification: gpu?.producerSpecification,
    })
    && gpu.artifactManifestHash === manifest.pdePoisson2dGpuArtifactManifestHash
    && pdeAssuranceValid(value?.cpuOracleAssurance, {
      producerSpecification: gpu.producerSpecification,
      artifactManifest: manifest,
      deadline,
    });
}

function deepLearningTaskRequestBinding({
  value,
  task,
  gpuDeviceSelector,
  deadline,
  executionAuthorityHash,
} = {}) {
  const request = {
    version: 1,
    kind: 'CanonicalCupyMlpTrainingRequest',
    trainingRunId: task?.trainingRunId,
    gpuDeviceSelector,
    absoluteDeadlineEpochMs: deadline,
    profile: task?.profile,
    modelIr: task?.modelIr,
    trainingDataset: task?.trainingDataset,
    trainingDatasetAuthority: task?.trainingDatasetAuthority,
    gpuMemoryCapacityPlan: value?.gpuMemoryCapacityPlan,
    ...(executionAuthorityHash ? { executionAuthorityHash } : {}),
  };
  const standardInput = `${JSON.stringify(request)}\n`;
  return Object.freeze({
    request,
    standardInputByteLength: Buffer.byteLength(standardInput),
    standardInputHash: hashBytes(Buffer.from(standardInput, 'utf8')),
  });
}

export function verifyGpuScientificDeepLearningTaskReceiptRequestBinding(
  value,
  {
    task,
    gpuDeviceSelector,
    deadline,
    executionAuthorityHash = null,
  } = {},
) {
  try {
    const binding = deepLearningTaskRequestBinding({
      value,
      task,
      gpuDeviceSelector,
      deadline,
      executionAuthorityHash,
    });
    const execution = value?.trainingExecutionReceipt;
    return value?.trainingRunId === task?.trainingRunId
      && value?.executionAuthorityHash === executionAuthorityHash
      && value?.profileHash === task?.profileHash
      && value?.modelIrHash === task?.modelIrHash
      && value?.trainingDatasetManifestHash === task?.trainingDatasetManifestHash
      && value?.trainingDatasetAuthorityHash === task?.trainingDatasetAuthorityHash
      && value?.absoluteDeadlineEpochMs === deadline
      && value?.trainingRequestStandardInputByteLength
        === binding.standardInputByteLength
      && value?.trainingRequestStandardInputHash === binding.standardInputHash
      && value?.trainingRequestHash === hashRecord(
        'CanonicalCupyMlpTrainingRequestInvocation', {
          standardInputHash: binding.standardInputHash,
          standardInputByteLength: binding.standardInputByteLength,
        },
      )
      && value?.workerReceipt?.executionProcessInvocation?.standardInput?.sha256
        === binding.standardInputHash
      && value?.workerReceipt?.executionProcessInvocation?.standardInput?.byteLength
        === binding.standardInputByteLength
      && value?.gpuDeviceSelectorHash === hashRecord('DeepLearningGpuDeviceUuid', {
        gpuDeviceSelector,
      })
      && value?.workerReceipt?.gpuDeviceRequest?.deviceSelector
        === gpuDeviceSelector
      && execution?.trainingRunId === task?.trainingRunId
      && execution?.profileHash === task?.profileHash
      && execution?.modelIrHash === task?.modelIrHash
      && JSON.stringify(execution?.modelIr) === JSON.stringify(task?.modelIr)
      && execution?.trainingDatasetManifestHash
        === task?.trainingDatasetManifestHash;
  } catch {
    return false;
  }
}

export function verifyGpuScientificDeepLearningTaskReceipt(value, {
  task, gpuDeviceSelector, deadline, executionAuthorityHash = null,
} = {}) {
  return value?.kind === 'CanonicalCupyDeepLearningTrainingReceipt'
    && value?.status
      === 'canonical_cupy_deep_learning_training_recorded_non_promotable'
    && value?.productionPromotionEligible === false
    && Array.isArray(value?.blockers) && value.blockers.length > 0
    && recordHashValid(value, 'CanonicalCupyDeepLearningTrainingReceipt',
      'canonicalCupyDeepLearningTrainingReceiptHash')
    && verifyGpuScientificDeepLearningTaskReceiptRequestBinding(value, {
      task,
      gpuDeviceSelector,
      deadline,
      executionAuthorityHash,
    })
    && verifyProductionOsSandboxWorkerReceipt(value.workerReceipt)
    && verifyDeepLearningTrainingExecutionReceipt(value?.trainingExecutionReceipt);
}
