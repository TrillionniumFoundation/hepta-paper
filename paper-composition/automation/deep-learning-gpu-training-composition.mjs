import fs from 'node:fs';
import path from 'node:path';

import {
  CANONICAL_CUPY_DEEP_LEARNING_NON_PROMOTION_BLOCKERS,
  createCanonicalCupyDeepLearningTrainingExecutor,
} from '../../paper-adapters/research-verify/canonical-cupy-deep-learning-training-executor.mjs';

function preparePrivateOutputRoot(selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) {
    throw new Error('deep_learning_gpu_training_composition_output_root_absolute_required');
  }
  const root = path.normalize(selected);
  if (root === path.parse(root).root) {
    throw new Error('deep_learning_gpu_training_composition_output_root_unsafe');
  }
  if (!fs.existsSync(root)) {
    const parent = path.dirname(root);
    const parentIdentity = fs.lstatSync(parent);
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()
      || fs.realpathSync.native(parent) !== parent) {
      throw new Error('deep_learning_gpu_training_composition_output_parent_unsafe');
    }
    fs.mkdirSync(root, { mode: 0o700 });
  }
  const identity = fs.lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || fs.realpathSync.native(root) !== root
    || (typeof process.geteuid === 'function' && identity.uid !== process.geteuid())
    || (identity.mode & 0o077) !== 0) {
    throw new Error('deep_learning_gpu_training_composition_output_root_unsafe');
  }
  return root;
}

export function composeCanonicalDeepLearningGpuTraining({
  outputRoot,
  timeoutMs = 60 * 60 * 1_000,
  memoryBytes = 8 * 1024 ** 3,
  cpuSeconds = 3_600,
  maximumProcesses = 32,
  maximumOutputBytes = 2 * 1024 ** 3,
} = {}) {
  const selectedOutputRoot = preparePrivateOutputRoot(outputRoot);
  const trainingExecutor = createCanonicalCupyDeepLearningTrainingExecutor({
    outputRoot: selectedOutputRoot,
    timeoutMs,
    memoryBytes,
    cpuSeconds,
    maximumProcesses,
    maximumOutputBytes,
  });
  return Object.freeze({
    version: 1,
    kind: 'CanonicalDeepLearningGpuTrainingComposition',
    trainingExecutor,
    predictorAuthority: null,
    hiddenEvaluatorAuthority: null,
    productionPromotionEligible: false,
    blockers: CANONICAL_CUPY_DEEP_LEARNING_NON_PROMOTION_BLOCKERS,
  });
}
