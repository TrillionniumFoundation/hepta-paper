import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  CANONICAL_CUPY_DEEP_LEARNING_NON_PROMOTION_BLOCKERS,
} from '../../../paper-adapters/research-verify/canonical-cupy-deep-learning-training-executor.mjs';
import {
  composeCanonicalDeepLearningGpuTraining,
} from '../../../paper-composition/automation/deep-learning-gpu-training-composition.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
  verifyDeterministicSupervisedClassificationGpuProfile,
} from '../../../paper-domain/research/deep-learning-gpu-profile-contract.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('research.gpu-deep-learning-training composes a bounded trainer that cannot self-authorize production', async (t) => {
  const root = await temporaryDirectory(t, 'hepta-capability-gpu-dl-');
  assert.throws(
    () => composeCanonicalDeepLearningGpuTraining(),
    /deep_learning_gpu_training_composition_output_root_absolute_required/,
  );

  const composition = composeCanonicalDeepLearningGpuTraining({
    outputRoot: path.join(root, 'training-output'),
  });
  assert.equal(composition.kind,
    'CanonicalDeepLearningGpuTrainingComposition');
  assert.equal(composition.predictorAuthority, null);
  assert.equal(composition.hiddenEvaluatorAuthority, null);
  assert.equal(composition.productionPromotionEligible, false);
  assert.deepEqual(composition.blockers,
    CANONICAL_CUPY_DEEP_LEARNING_NON_PROMOTION_BLOCKERS);

  const capabilities = composition.trainingExecutor.capabilities();
  assert.equal(capabilities.runtimeProfile, 'pythonGpu');
  assert.equal(capabilities.singleGpuUuidRequired, true);
  assert.equal(capabilities.customCodeAllowed, false);
  assert.equal(capabilities.customCudaAllowed, false);
  assert.equal(capabilities.predictorAuthorityProvided, false);
  assert.equal(capabilities.hiddenEvaluationAuthorityProvided, false);
  assert.equal(capabilities.selfAuthorizesProductionPromotion, false);

  assert.equal(verifyDeterministicSupervisedClassificationGpuProfile(
    DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
  ), true);
  assert.equal(
    DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE
      .qualificationPolicy.selfAuthorizesProductionPromotion,
    false,
  );

  const blocked = await composition.trainingExecutor.execute({});
  assert.equal(blocked.status, 'canonical_cupy_deep_learning_training_blocked');
  assert.equal(blocked.productionPromotionEligible, false);
});
