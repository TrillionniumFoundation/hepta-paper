import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDatasetEvaluationDependencyReceipt,
  DATASET_EVALUATION_DEPENDENCY_ASSURANCE_SCOPE,
  verifyDatasetEvaluationDependencyReceipt,
} from '../../paper-domain/automation/dataset-evaluation-dependency-contract.mjs';

const hash = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;

function inputs() {
  return {
    operatorDatasetHarnessAuthority: {
      status: 'operator_dataset_harness_authority_verified',
      blockers: [],
      datasetName: 'signed-academic-dataset',
      datasetManifestHash: hash('1'),
      datasetSplitManifestHash: hash('2'),
      operatorDatasetHarnessAuthorityReceiptHash: hash('3'),
      operatorDatasetAuthorityDocumentHash: hash('4'),
      benchmarkHarnessDefinitionHash: hash('5'),
      analysisProtocolHash: hash('6'),
    },
    preDataAccessFreeze: { empiricalPreDataAccessFreezeHash: hash('7') },
    cells: [{
      cellId: 'cell-1',
      systemBenchmarkCellChallengeHash: hash('8'),
      systemBenchmarkCellOracleHash: hash('9'),
      rawEventArtifactHash: hash('a'),
      systemBenchmarkArmProtocolExecutionReceiptHash: hash('b'),
    }],
    rawEventManifestHash: hash('c'),
    rawEventArtifactHash: hash('d'),
    analysisObservationAuthority: { analysisObservationAuthorityHash: hash('e') },
    analysisProtocolEvaluation: {
      status: 'academic_analysis_protocol_verified',
      academicAnalysisProtocolEvaluationHash: hash('f'),
    },
    workerDatasetPositiveByteReadObserved: true,
  };
}

test('dataset evaluation dependency receipt makes a narrow non-overclaiming assurance', () => {
  const input = inputs();
  const receipt = buildDatasetEvaluationDependencyReceipt(input);
  assert.equal(receipt.status, 'dataset_evaluation_dependency_verified');
  assert.equal(receipt.assuranceScope, DATASET_EVALUATION_DEPENDENCY_ASSURANCE_SCOPE);
  assert.equal(receipt.evaluationDependencyProven, true);
  assert.equal(receipt.workerDatasetPositiveByteReadObserved, true);
  assert.equal(receipt.candidateTrainingUseProven, false);
  assert.equal(receipt.candidateAlgorithmDependencyProven, false);
  assert.equal(receipt.causalModelDependencyProven, false);
  assert.equal(verifyDatasetEvaluationDependencyReceipt(receipt, input), true);

  const overclaim = structuredClone(receipt);
  overclaim.candidateAlgorithmDependencyProven = true;
  assert.equal(verifyDatasetEvaluationDependencyReceipt(overclaim, input), false);

  const rebound = structuredClone(input);
  rebound.cells[0].systemBenchmarkCellOracleHash = hash('0');
  assert.equal(verifyDatasetEvaluationDependencyReceipt(receipt, rebound), false);
});

test('dataset dependency assurance fails closed without observed positive reads', () => {
  const input = inputs();
  input.workerDatasetPositiveByteReadObserved = false;
  const receipt = buildDatasetEvaluationDependencyReceipt(input);
  assert.equal(receipt.status, 'dataset_evaluation_dependency_blocked');
  assert.ok(receipt.blockers.includes('dataset_evaluation_worker_positive_byte_read_unverified'));
  assert.equal(verifyDatasetEvaluationDependencyReceipt(receipt, input), false);
});
