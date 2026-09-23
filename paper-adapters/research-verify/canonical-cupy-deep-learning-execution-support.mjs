import fs from 'node:fs';

import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

export function buildBlockedCanonicalCupyDeepLearningExecution(
  blockers,
  workerReceipt = null,
) {
  return Object.freeze({
    version: 1,
    kind: 'CanonicalCupyDeepLearningTrainingBlockedReceipt',
    status: 'canonical_cupy_deep_learning_training_blocked',
    productionPromotionEligible: false,
    workerReceipt,
    blockers: Object.freeze([...new Set(blockers.map(String))]),
  });
}

export function removeOwnedCanonicalCupyDeepLearningOutput(
  outputRoot,
  outputDirectory,
) {
  if (isPathWithin(outputRoot, outputDirectory)) {
    try {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    } catch { /* blocked */ }
  }
}
