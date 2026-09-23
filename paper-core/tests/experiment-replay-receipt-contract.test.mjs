import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeeplyFrozenJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import {
  createExperimentReplayReceiptContract,
} from '../../paper-domain/automation/experiment-replay-receipt-contract.mjs';
import {
  buildExperimentReplayReceipt,
  verifyExperimentReplayReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';

test('split replay receipt contract remains fail-closed behind the run facade', () => {
  assert.throws(
    () => createExperimentReplayReceiptContract(),
    /experiment_replay_run_receipt_verifier_required/,
  );

  const direct = createExperimentReplayReceiptContract({
    verifyExperimentRunReceipt: () => false,
  }).buildExperimentReplayReceipt();
  const facade = buildExperimentReplayReceipt();

  assert.deepEqual(facade, direct);
  assert.equal(facade.status, 'experiment_replay_blocked');
  assert.equal(isDeeplyFrozenJsonValue(facade), true);
  assert.equal(
    facade.blockers.includes('experiment_original_run_receipt_invalid'),
    true,
  );
  assert.equal(
    facade.blockers.includes('experiment_replay_run_receipt_invalid'),
    true,
  );
  assert.equal(verifyExperimentReplayReceipt(facade), false);
});
