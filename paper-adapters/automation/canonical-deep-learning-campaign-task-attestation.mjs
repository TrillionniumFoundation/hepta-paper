import {
  GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES,
  verifyGpuScientificCampaignTask,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS,
  verifyCanonicalCupyDeepLearningTrainingReceipt,
} from '../research-verify/canonical-cupy-deep-learning-training-executor.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ATTESTATION_KEYS = Object.freeze([
  'absoluteDeadlineEpochMs', 'artifactManifestHash', 'artifactPaths',
  'artifactSetHash', 'canonicalDeepLearningCampaignTaskAttestationHash',
  'canonicalTrainingReceipt', 'canonicalTrainingReceiptHash',
  'executionProcessInvocationHash', 'finiteTensorScanReceiptHash',
  'gpuCapacityObservationHash', 'gpuDeviceSelectorHash',
  'gpuMemoryCapacityPlanHash', 'kind', 'maximumQualifiedGpuWorkingSetBytes',
  'modelIrHash', 'observedGpuTotalMemoryBytes', 'estimatedPeakVramBytes',
  'processInvocationId',
  'productionPromotionEligible', 'profileHash', 'status', 'taskHash',
  'trainerImplementationMerkleHash', 'trainerImplementationWorkspaceManifestHash',
  'trainingDatasetAuthorityHash', 'trainingDatasetManifestHash',
  'trainingExecutionReceiptHash', 'trainingRequestHash',
  'trainingRequestStandardInputByteLength', 'trainingRequestStandardInputHash',
  'trainingRunId', 'version', 'workerReceiptHash',
]);

function sha(value) {
  return SHA256.test(String(value || ''));
}

export function buildCanonicalDeepLearningCampaignTaskAttestation({
  task,
  canonicalTrainingReceipt,
  gpuDeviceSelector,
  absoluteDeadlineEpochMs,
} = {}) {
  const receipt = canonicalTrainingReceipt;
  const worker = receipt?.workerReceipt;
  if (!verifyGpuScientificCampaignTask(task)
    || task.taskType !== GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[1]
    || !verifyCanonicalCupyDeepLearningTrainingReceipt(receipt)
    || receipt.trainingRunId !== task.trainingRunId
    || receipt.profileHash !== task.profileHash
    || receipt.modelIrHash !== task.modelIrHash
    || receipt.trainingDatasetManifestHash !== task.trainingDatasetManifestHash
    || receipt.trainingDatasetAuthorityHash !== task.trainingDatasetAuthorityHash
    || receipt.trainingDatasetAuthorityHash
      !== receipt.trainingDatasetAuthority?.deepLearningTrainingDatasetAuthorityHash
    || receipt.absoluteDeadlineEpochMs !== absoluteDeadlineEpochMs
    || worker?.gpuDeviceRequest?.deviceSelector !== gpuDeviceSelector
    || receipt.gpuDeviceSelectorHash !== hashRecord('DeepLearningGpuDeviceUuid', {
      gpuDeviceSelector,
    })
    || !sha(worker?.executionProcessInvocationHash)
    || worker.executionProcessInvocation?.processInvocationId
      !== worker.executionProcessIdentity?.processInvocationId
    || !sha(worker?.artifactManifestHash)
    || JSON.stringify(worker.declaredOutputPaths)
      !== JSON.stringify(CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS)
    || JSON.stringify(worker.artifacts?.map(({ path }) => path))
      !== JSON.stringify(CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS)) {
    throw new Error('canonical_deep_learning_campaign_task_attestation_invalid');
  }
  const payload = {
    version: 1,
    kind: 'CanonicalDeepLearningCampaignTaskAttestation',
    status: 'canonical_deep_learning_campaign_task_attested_non_promotable',
    taskHash: task.gpuScientificCampaignTaskHash,
    trainingRunId: receipt.trainingRunId,
    absoluteDeadlineEpochMs,
    profileHash: receipt.profileHash,
    modelIrHash: receipt.modelIrHash,
    trainingDatasetManifestHash: receipt.trainingDatasetManifestHash,
    trainingDatasetAuthorityHash: receipt.trainingDatasetAuthorityHash,
    gpuDeviceSelectorHash: receipt.gpuDeviceSelectorHash,
    gpuCapacityObservationHash: receipt.gpuCapacityObservationHash,
    gpuMemoryCapacityPlanHash: receipt.gpuMemoryCapacityPlanHash,
    observedGpuTotalMemoryBytes: receipt.observedGpuTotalMemoryBytes,
    estimatedPeakVramBytes: receipt.estimatedPeakVramBytes,
    maximumQualifiedGpuWorkingSetBytes:
      receipt.maximumQualifiedGpuWorkingSetBytes,
    trainerImplementationMerkleHash: receipt.trainerImplementationMerkleHash,
    trainerImplementationWorkspaceManifestHash:
      receipt.trainerImplementationWorkspaceManifestHash,
    trainingRequestHash: receipt.trainingRequestHash,
    trainingRequestStandardInputHash: receipt.trainingRequestStandardInputHash,
    trainingRequestStandardInputByteLength:
      receipt.trainingRequestStandardInputByteLength,
    processInvocationId: worker.executionProcessInvocation.processInvocationId,
    executionProcessInvocationHash: worker.executionProcessInvocationHash,
    workerReceiptHash: receipt.workerReceiptHash,
    artifactManifestHash: receipt.workerArtifactManifestHash,
    artifactPaths: CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS,
    artifactSetHash: hashRecord(
      'CanonicalDeepLearningCampaignArtifactSet', receipt.artifacts,
    ),
    finiteTensorScanReceiptHash: receipt.finiteTensorScanReceiptHash,
    trainingExecutionReceiptHash: receipt.trainingExecutionReceiptHash,
    canonicalTrainingReceiptHash:
      receipt.canonicalCupyDeepLearningTrainingReceiptHash,
    canonicalTrainingReceipt: receipt,
    productionPromotionEligible: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    canonicalDeepLearningCampaignTaskAttestationHash: hashRecord(
      'CanonicalDeepLearningCampaignTaskAttestation', payload,
    ),
  });
}

export function verifyCanonicalDeepLearningCampaignTaskAttestation(
  value,
  options = {},
) {
  if (!hasExactObjectKeys(value, ATTESTATION_KEYS)) return false;
  try {
    return JSON.stringify(buildCanonicalDeepLearningCampaignTaskAttestation({
      ...options,
      canonicalTrainingReceipt: value.canonicalTrainingReceipt,
    })) === JSON.stringify(value);
  } catch { return false; }
}
