import { experimentObservationKey } from './experiment-observation-contract.mjs';
import {
  productionExperimentResearchBindingsMatch,
} from './experiment-research-binding-contract.mjs';

const IDENTITY_FIELDS = Object.freeze([
  'campaignBenchmarkSelectorHash',
  'experimentDesignHash',
  'benchmarkHarnessHash',
  'systemBenchmarkHarnessImplementationHash',
  'datasetAuthorizationSetHash',
  'datasetAccessSupervisorIdentityHash',
  'sourceMerkleHash',
  'sourceWorkspaceManifestHash',
  'sourceLineageHash',
  'assuranceProfile',
  'assuranceScope',
  'evidenceClass',
  'promotionScope',
  'academicPromotionEligible',
]);

export function compareExperimentReplayRuns({
  originalRunReceipt,
  replayRunReceipt,
  absoluteTolerance,
  relativeTolerance,
} = {}) {
  const identityBlockers = [];
  for (const field of IDENTITY_FIELDS) {
    if (originalRunReceipt?.[field] !== replayRunReceipt?.[field]) {
      identityBlockers.push(`experiment_replay_identity_mismatch:${field}`);
    }
  }
  const originalIr = originalRunReceipt?.harnessExecutionReceipt?.experimentIr;
  const replayIr = replayRunReceipt?.harnessExecutionReceipt?.experimentIr;
  if (originalIr?.experimentPlanHash !== replayIr?.experimentPlanHash) {
    identityBlockers.push('experiment_replay_identity_mismatch:experimentPlanHash');
  }
  if (originalIr?.version === 3 || replayIr?.version === 3) {
    if (originalIr?.version !== 3 || replayIr?.version !== 3
      || !productionExperimentResearchBindingsMatch(
        originalIr.researchBinding,
        replayIr.researchBinding,
      )) {
      identityBlockers.push('experiment_replay_identity_mismatch:experimentResearchBinding');
    }
  }
  if (originalRunReceipt?.executionReceiptHash === replayRunReceipt?.executionReceiptHash
    || originalRunReceipt?.experimentAttemptId === replayRunReceipt?.experimentAttemptId
    || (originalRunReceipt?.harnessExecutionReceipt?.environmentBindingHash
      || originalRunReceipt?.runnerReceipt?.environmentBindingHash)
      === (replayRunReceipt?.harnessExecutionReceipt?.environmentBindingHash
        || replayRunReceipt?.runnerReceipt?.environmentBindingHash)) {
    identityBlockers.push('experiment_replay_execution_not_independent');
  }
  if (originalRunReceipt?.rawEventManifestHash !== replayRunReceipt?.rawEventManifestHash
    || originalRunReceipt?.rawEventArtifactHash !== replayRunReceipt?.rawEventArtifactHash
    || originalRunReceipt?.rawEventArtifactBytes !== replayRunReceipt?.rawEventArtifactBytes) {
    identityBlockers.push('experiment_replay_raw_event_artifact_mismatch');
  }
  if (!originalRunReceipt?.rawArtifactWriteReceipt || !replayRunReceipt?.rawArtifactWriteReceipt
    || originalRunReceipt.rawArtifactWriteReceipt.writeReceiptHash
      === replayRunReceipt.rawArtifactWriteReceipt.writeReceiptHash
    || originalRunReceipt.rawArtifactWriteReceipt.ledgerReceiptId
      === replayRunReceipt.rawArtifactWriteReceipt.ledgerReceiptId
    || originalRunReceipt.rawArtifactWriteReceipt.role
      === replayRunReceipt.rawArtifactWriteReceipt.role) {
    identityBlockers.push('experiment_replay_raw_artifact_authority_not_independent');
  }

  const comparisons = [];
  const comparisonBlockers = [];
  const replayObservations = new Map((replayRunReceipt?.observations || []).map(
    (item) => [experimentObservationKey(item), item],
  ));
  for (const original of originalRunReceipt?.observations || []) {
    for (const metric of originalRunReceipt?.requiredMetrics || []) {
      const replay = replayObservations.get(experimentObservationKey(original));
      const expected = Number(original.metrics?.[metric]);
      const observed = Number(replay?.metrics?.[metric]);
      const delta = Math.abs(expected - observed);
      const allowed = Math.max(
        Number(absoluteTolerance),
        Number(relativeTolerance) * Math.max(Math.abs(expected), Math.abs(observed)),
      );
      const consistent = Number.isFinite(expected) && Number.isFinite(observed) && delta <= allowed;
      comparisons.push({
        seed: original.seed,
        repetition: original.repetition,
        arm: original.arm,
        metric,
        expected,
        observed,
        delta,
        allowed,
        consistent,
      });
      if (!consistent) {
        comparisonBlockers.push(
          `experiment_replay_observation_inconsistent:${original.seed}:${original.repetition}:${original.arm}:${metric}`,
        );
      }
    }
  }
  return Object.freeze({
    identityBlockers: Object.freeze(identityBlockers),
    comparisons: Object.freeze(comparisons),
    comparisonBlockers: Object.freeze(comparisonBlockers),
  });
}
