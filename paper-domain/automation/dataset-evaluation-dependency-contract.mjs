import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const DATASET_EVALUATION_DEPENDENCY_ASSURANCE_SCOPE =
  'evaluation-result-bound-to-operator-authorized-hidden-harness-v1';

const RECEIPT_KEYS = Object.freeze([
  'version',
  'kind',
  'status',
  'assuranceScope',
  'datasetName',
  'datasetManifestHash',
  'datasetSplitManifestHash',
  'operatorDatasetHarnessAuthorityReceiptHash',
  'operatorDatasetAuthorityDocumentHash',
  'benchmarkHarnessDefinitionHash',
  'analysisProtocolHash',
  'empiricalPreDataAccessFreezeHash',
  'cellDependencyManifest',
  'cellDependencyManifestHash',
  'cellCount',
  'rawEventManifestHash',
  'rawEventArtifactHash',
  'analysisObservationAuthorityHash',
  'academicAnalysisProtocolEvaluationHash',
  'workerDatasetPositiveByteReadObserved',
  'evaluationDependencyProven',
  'candidateTrainingUseProven',
  'candidateAlgorithmDependencyProven',
  'causalModelDependencyProven',
  'hostOnlyHarnessMounted',
  'rawOraclePublished',
  'limitations',
  'blockers',
  'externalActionPerformed',
  'datasetEvaluationDependencyReceiptHash',
]);

const CELL_KEYS = Object.freeze([
  'cellId',
  'systemBenchmarkCellChallengeHash',
  'systemBenchmarkCellOracleHash',
  'rawEventArtifactHash',
  'systemBenchmarkArmProtocolExecutionReceiptHash',
]);

function canonicalCellDependency(cell) {
  const candidate = {
    cellId: String(cell?.cellId || ''),
    systemBenchmarkCellChallengeHash: String(cell?.systemBenchmarkCellChallengeHash || ''),
    systemBenchmarkCellOracleHash: String(cell?.systemBenchmarkCellOracleHash || ''),
    rawEventArtifactHash: String(cell?.rawEventArtifactHash || ''),
    systemBenchmarkArmProtocolExecutionReceiptHash:
      String(cell?.systemBenchmarkArmProtocolExecutionReceiptHash || ''),
  };
  if (!candidate.cellId || candidate.cellId.length > 256
    || Object.entries(candidate).some(([key, value]) => key !== 'cellId' && !SHA256.test(value))) {
    throw new Error('dataset_evaluation_cell_dependency_invalid');
  }
  return Object.freeze(candidate);
}

function dependencyInputs({
  operatorDatasetHarnessAuthority,
  preDataAccessFreeze,
  cells,
  rawEventManifestHash,
  rawEventArtifactHash,
  analysisObservationAuthority,
  analysisProtocolEvaluation,
  workerDatasetPositiveByteReadObserved,
} = {}) {
  const blockers = [];
  const authority = operatorDatasetHarnessAuthority || {};
  const cellDependencyManifest = [];
  try {
    for (const cell of Array.isArray(cells) ? cells : []) {
      cellDependencyManifest.push(canonicalCellDependency(cell));
    }
  } catch (error) {
    blockers.push(String(error?.message || 'dataset_evaluation_cell_dependency_invalid'));
  }
  if (!cellDependencyManifest.length) blockers.push('dataset_evaluation_cell_dependencies_missing');
  if (new Set(cellDependencyManifest.map((cell) => cell.cellId)).size
    !== cellDependencyManifest.length) blockers.push('dataset_evaluation_cell_dependency_duplicate');

  const requiredHashes = {
    datasetManifestHash: authority.datasetManifestHash,
    datasetSplitManifestHash: authority.datasetSplitManifestHash,
    operatorDatasetHarnessAuthorityReceiptHash:
      authority.operatorDatasetHarnessAuthorityReceiptHash,
    operatorDatasetAuthorityDocumentHash: authority.operatorDatasetAuthorityDocumentHash,
    benchmarkHarnessDefinitionHash: authority.benchmarkHarnessDefinitionHash,
    analysisProtocolHash: authority.analysisProtocolHash,
    empiricalPreDataAccessFreezeHash: preDataAccessFreeze?.empiricalPreDataAccessFreezeHash,
    rawEventManifestHash,
    rawEventArtifactHash,
    analysisObservationAuthorityHash:
      analysisObservationAuthority?.analysisObservationAuthorityHash,
    academicAnalysisProtocolEvaluationHash:
      analysisProtocolEvaluation?.academicAnalysisProtocolEvaluationHash,
  };
  for (const [field, value] of Object.entries(requiredHashes)) {
    if (!SHA256.test(String(value || ''))) blockers.push(`dataset_evaluation_${field}_invalid`);
  }
  if (!String(authority.datasetName || '')) blockers.push('dataset_evaluation_dataset_name_missing');
  if (authority.status !== 'operator_dataset_harness_authority_verified'
    || !Array.isArray(authority.blockers) || authority.blockers.length !== 0) {
    blockers.push('dataset_evaluation_operator_authority_unverified');
  }
  if (workerDatasetPositiveByteReadObserved !== true) {
    blockers.push('dataset_evaluation_worker_positive_byte_read_unverified');
  }
  if (analysisProtocolEvaluation?.status !== 'academic_analysis_protocol_verified') {
    blockers.push('dataset_evaluation_analysis_unverified');
  }
  return Object.freeze({
    blockers: Object.freeze([...new Set(blockers)]),
    authority,
    cellDependencyManifest: Object.freeze(cellDependencyManifest),
    requiredHashes,
  });
}

export function buildDatasetEvaluationDependencyReceipt(input = {}) {
  const normalized = dependencyInputs(input);
  const payload = {
    version: 1,
    kind: 'DatasetEvaluationDependencyReceipt',
    status: normalized.blockers.length
      ? 'dataset_evaluation_dependency_blocked'
      : 'dataset_evaluation_dependency_verified',
    assuranceScope: DATASET_EVALUATION_DEPENDENCY_ASSURANCE_SCOPE,
    datasetName: normalized.authority.datasetName || null,
    datasetManifestHash: normalized.requiredHashes.datasetManifestHash || null,
    datasetSplitManifestHash: normalized.requiredHashes.datasetSplitManifestHash || null,
    operatorDatasetHarnessAuthorityReceiptHash:
      normalized.requiredHashes.operatorDatasetHarnessAuthorityReceiptHash || null,
    operatorDatasetAuthorityDocumentHash:
      normalized.requiredHashes.operatorDatasetAuthorityDocumentHash || null,
    benchmarkHarnessDefinitionHash:
      normalized.requiredHashes.benchmarkHarnessDefinitionHash || null,
    analysisProtocolHash: normalized.requiredHashes.analysisProtocolHash || null,
    empiricalPreDataAccessFreezeHash:
      normalized.requiredHashes.empiricalPreDataAccessFreezeHash || null,
    cellDependencyManifest: normalized.cellDependencyManifest,
    cellDependencyManifestHash: hashRecord(
      'DatasetEvaluationCellDependencyManifest',
      normalized.cellDependencyManifest,
    ),
    cellCount: normalized.cellDependencyManifest.length,
    rawEventManifestHash: normalized.requiredHashes.rawEventManifestHash || null,
    rawEventArtifactHash: normalized.requiredHashes.rawEventArtifactHash || null,
    analysisObservationAuthorityHash:
      normalized.requiredHashes.analysisObservationAuthorityHash || null,
    academicAnalysisProtocolEvaluationHash:
      normalized.requiredHashes.academicAnalysisProtocolEvaluationHash || null,
    workerDatasetPositiveByteReadObserved:
      input.workerDatasetPositiveByteReadObserved === true,
    evaluationDependencyProven: normalized.blockers.length === 0,
    candidateTrainingUseProven: false,
    candidateAlgorithmDependencyProven: false,
    causalModelDependencyProven: false,
    hostOnlyHarnessMounted: false,
    rawOraclePublished: false,
    limitations: Object.freeze([
      'does-not-prove-candidate-training-used-dataset-v1',
      'does-not-prove-candidate-algorithm-causally-depends-on-dataset-v1',
      'proves-only-evaluation-binding-to-authorized-hidden-harness-v1',
    ]),
    blockers: normalized.blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    datasetEvaluationDependencyReceiptHash: hashRecord(
      'DatasetEvaluationDependencyReceipt',
      payload,
    ),
  });
}

export function verifyDatasetEvaluationDependencyReceipt(receipt, input = {}) {
  if (!receipt || !exactKeys(receipt, RECEIPT_KEYS)
    || receipt.version !== 1 || receipt.kind !== 'DatasetEvaluationDependencyReceipt'
    || receipt.status !== 'dataset_evaluation_dependency_verified'
    || receipt.assuranceScope !== DATASET_EVALUATION_DEPENDENCY_ASSURANCE_SCOPE
    || !Array.isArray(receipt.blockers) || receipt.blockers.length !== 0
    || !Array.isArray(receipt.cellDependencyManifest)
    || receipt.cellDependencyManifest.some((cell) => !exactKeys(cell, CELL_KEYS))
    || receipt.evaluationDependencyProven !== true
    || receipt.workerDatasetPositiveByteReadObserved !== true
    || receipt.candidateTrainingUseProven !== false
    || receipt.candidateAlgorithmDependencyProven !== false
    || receipt.causalModelDependencyProven !== false
    || receipt.hostOnlyHarnessMounted !== false
    || receipt.rawOraclePublished !== false
    || receipt.externalActionPerformed !== false
    || !SHA256.test(String(receipt.datasetEvaluationDependencyReceiptHash || ''))) return false;
  const { datasetEvaluationDependencyReceiptHash, ...payload } = receipt;
  if (hashRecord('DatasetEvaluationDependencyReceipt', payload)
    !== datasetEvaluationDependencyReceiptHash) return false;
  const expected = buildDatasetEvaluationDependencyReceipt(input);
  return expected.status === 'dataset_evaluation_dependency_verified'
    && JSON.stringify(expected) === JSON.stringify(receipt);
}
