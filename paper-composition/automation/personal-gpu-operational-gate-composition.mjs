// Composition boundary for the private single-host GPU operator.  The
// executable in paper-core/bin stays an operator adapter and does not import
// infrastructure adapters directly; this module owns those bindings.
export { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
export {
  buildDeepLearningReplayPlan,
  DEEP_LEARNING_REPLAY_ERROR_BUDGET,
  DEEP_LEARNING_REPLAY_SCOPES,
  evaluateDeepLearningCheckpointDataset,
  verifyDeepLearningReplayExecutionBinding,
} from '../../paper-adapters/research-verify/deep-learning-independent-replay.mjs';
export {
  runProcessIsolatedDeepLearningIndependentCpuOracle,
} from '../../paper-adapters/research-verify/process-isolated-deep-learning-independent-cpu-oracle.mjs';
export { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
