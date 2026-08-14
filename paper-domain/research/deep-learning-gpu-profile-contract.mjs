import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  exactPlainObject,
  jsonEqual,
} from './deep-learning-contract-primitives.mjs';

const PROFILE_KEYS = Object.freeze([
  'checkpointPolicy', 'dataPipelinePolicy', 'deepLearningGpuProfileHash',
  'devicePolicy', 'extensionPolicy', 'framework', 'kind', 'modelFamily',
  'networkPolicy', 'numericPolicy', 'profileId', 'qualificationPolicy',
  'runtimeProfile', 'task', 'version',
]);

export function buildDeterministicSupervisedClassificationGpuProfile() {
  const payload = {
    version: 1,
    kind: 'DeterministicSupervisedClassificationGpuProfile',
    profileId: 'cupy-single-gpu-supervised-classification-fp32-v1',
    task: 'supervised-classification',
    modelFamily: 'declarative-sequential-mlp-v1',
    runtimeProfile: 'pythonGpu',
    framework: 'cupy',
    devicePolicy: {
      accelerator: 'cuda',
      deviceCount: 1,
      deviceSelection: 'uuid-pinned-single-device-v1',
      replayScope: 'same-device-uuid-and-runtime-bom-v1',
      crossDeviceBitwiseEquivalenceRequired: false,
    },
    numericPolicy: {
      computeDtype: 'float32',
      parameterDtype: 'float32',
      deterministicAlgorithmsRequired: true,
      automaticMixedPrecisionEnabled: false,
      tensorFloat32Enabled: false,
      finiteTensorScanRequired: true,
    },
    dataPipelinePolicy: {
      dataLoaderWorkers: 0,
      batchOrder: 'seeded-fisher-yates-v1',
      asynchronousPrefetchEnabled: false,
      hiddenEvaluationMountedDuringTraining: false,
    },
    checkpointPolicy: {
      format: 'hepta-tensor-bundle-v1',
      byteOrder: 'little-endian',
      pickleAllowed: false,
      executablePayloadAllowed: false,
    },
    extensionPolicy: {
      customCodeAllowed: false,
      customCudaAllowed: false,
      dynamicLibraryLoadingAllowed: false,
    },
    networkPolicy: 'none',
    qualificationPolicy: {
      runtimeQualificationRequired: true,
      independentReplayAuthorityRequired: true,
      hiddenEvaluationAuthorityRequired: true,
      selfAuthorizesProductionPromotion: false,
    },
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningGpuProfileHash:
      hashRecord('DeterministicSupervisedClassificationGpuProfile', payload),
  });
}

export const DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE =
  buildDeterministicSupervisedClassificationGpuProfile();

export function verifyDeterministicSupervisedClassificationGpuProfile(value) {
  try {
    return exactPlainObject(value, PROFILE_KEYS)
      && jsonEqual(value, DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE);
  } catch {
    return false;
  }
}
