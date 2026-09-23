import {
  deepFreezeJsonValue,
  isDeeplyFrozenJsonValue,
} from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildExperimentReplayAnalysisProtocolBinding,
  verifyExperimentReplayAnalysisProtocolBinding,
} from './analysis-protocol-run-binding.mjs';
import {
  experimentReplayEnvironmentBomFields,
  verifyExperimentReplayEnvironmentBomBinding,
} from './experiment-environment-bom-binding.mjs';
import { compareExperimentReplayRuns } from './experiment-replay-comparison.mjs';

export function createExperimentReplayReceiptContract({
  verifyExperimentRunReceipt,
} = {}) {
  if (typeof verifyExperimentRunReceipt !== 'function') {
    throw new Error('experiment_replay_run_receipt_verifier_required');
  }
  const verifiedImmutableExperimentReplayReceipts = new WeakSet();

  function buildExperimentReplayReceipt({
    originalRunReceipt,
    replayRunReceipt,
    absoluteTolerance = 1e-9,
    relativeTolerance = 1e-6,
  } = {}) {
    const blockers = [];
    if (!verifyExperimentRunReceipt(originalRunReceipt)) {
      blockers.push('experiment_original_run_receipt_invalid');
    }
    if (!verifyExperimentRunReceipt(replayRunReceipt)) {
      blockers.push('experiment_replay_run_receipt_invalid');
    }
    const comparison = compareExperimentReplayRuns({
      originalRunReceipt,
      replayRunReceipt,
      absoluteTolerance,
      relativeTolerance,
    });
    blockers.push(...comparison.identityBlockers);
    const analysisProtocolReplayBinding =
      buildExperimentReplayAnalysisProtocolBinding({
        originalRunReceipt,
        replayRunReceipt,
      });
    blockers.push(...analysisProtocolReplayBinding.blockers);
    blockers.push(...comparison.comparisonBlockers);
    const payload = {
      version: 1,
      kind: 'ExperimentReplayReceipt',
      status: blockers.length
        ? 'experiment_replay_blocked' : 'experiment_replay_verified',
      originalExperimentRunReceiptHash:
        originalRunReceipt?.experimentRunReceiptHash || null,
      replayExperimentRunReceiptHash:
        replayRunReceipt?.experimentRunReceiptHash || null,
      originalRunReceipt,
      replayRunReceipt,
      originalExecutionReceiptHash:
        originalRunReceipt?.executionReceiptHash || null,
      replayExecutionReceiptHash:
        replayRunReceipt?.executionReceiptHash || null,
      ...experimentReplayEnvironmentBomFields(
        originalRunReceipt,
        replayRunReceipt,
      ),
      absoluteTolerance: Number(absoluteTolerance),
      relativeTolerance: Number(relativeTolerance),
      comparisons: comparison.comparisons,
      analysisProtocolReplayBinding,
      blockers: [...new Set(blockers)],
      externalActionPerformed: false,
    };
    return deepFreezeJsonValue({
      ...payload,
      experimentReplayReceiptHash: hashRecord(
        'ExperimentReplayReceipt',
        payload,
      ),
    });
  }

  function verifyExperimentReplayReceipt(receipt) {
    if (!receipt
      || receipt.kind !== 'ExperimentReplayReceipt'
      || receipt.version !== 1) return false;
    if (verifiedImmutableExperimentReplayReceipts.has(receipt)) return true;
    const rebuilt = buildExperimentReplayReceipt({
      originalRunReceipt: receipt.originalRunReceipt,
      replayRunReceipt: receipt.replayRunReceipt,
      absoluteTolerance: receipt.absoluteTolerance,
      relativeTolerance: receipt.relativeTolerance,
    });
    const valid = receipt.status === 'experiment_replay_verified'
      && verifyExperimentRunReceipt(receipt.originalRunReceipt)
      && verifyExperimentRunReceipt(receipt.replayRunReceipt)
      && receipt.originalExperimentRunReceiptHash
        === receipt.originalRunReceipt.experimentRunReceiptHash
      && receipt.replayExperimentRunReceiptHash
        === receipt.replayRunReceipt.experimentRunReceiptHash
      && receipt.originalRunReceipt.experimentAttemptId
        !== receipt.replayRunReceipt.experimentAttemptId
      && receipt.originalRunReceipt.executionReceiptHash
        !== receipt.replayRunReceipt.executionReceiptHash
      && verifyExperimentReplayEnvironmentBomBinding(receipt)
      && (receipt.originalRunReceipt.harnessExecutionReceipt
        ?.environmentBindingHash
        || receipt.originalRunReceipt.runnerReceipt?.environmentBindingHash)
        !== (receipt.replayRunReceipt.harnessExecutionReceipt
          ?.environmentBindingHash
          || receipt.replayRunReceipt.runnerReceipt?.environmentBindingHash)
      && verifyExperimentReplayAnalysisProtocolBinding(receipt)
      && rebuilt.status === 'experiment_replay_verified'
      && rebuilt.experimentReplayReceiptHash
        === receipt.experimentReplayReceiptHash
      && JSON.stringify(rebuilt) === JSON.stringify(receipt);
    if (valid && isDeeplyFrozenJsonValue(receipt)) {
      verifiedImmutableExperimentReplayReceipts.add(receipt);
    }
    return valid;
  }

  return Object.freeze({
    buildExperimentReplayReceipt,
    verifyExperimentReplayReceipt,
  });
}
