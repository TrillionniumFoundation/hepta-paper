import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  exactPlainObject,
  jsonEqual,
} from './deep-learning-contract-primitives.mjs';
import {
  verifyDeepLearningInlineTrainingDataset,
} from './deep-learning-training-dataset-contract.mjs';
import {
  verifyDeepLearningTrainingExecutionReceipt,
} from './deep-learning-training-execution-contract.mjs';

// This contract is the process boundary for the independent DL CPU oracle.
// The replay implementation itself is intentionally kept in the adapter
// layer.  A producer receipt can therefore never turn a same-process replay
// into independent evidence by merely setting a boolean.

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const PROCESS_ISOLATED_DEEP_LEARNING_CPU_ORACLE_ASSURANCE_SCOPE =
  'process-isolated-independent-cpu-oracle-v1';
export const DEEP_LEARNING_CPU_ORACLE_NETWORK_ISOLATION_POLICY =
  'deny-node-network-client-and-server-apis-v1';
export const DEEP_LEARNING_CPU_ORACLE_REPLAY_SCOPE =
  'independent-cpu-oracle-v1';
export const DEEP_LEARNING_CPU_ORACLE_PRODUCTION_BLOCKERS = Object.freeze([
  'deep_learning_independent_cpu_oracle_external_authority_required',
]);
export const DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  memoryBytes: 512 * 1024 * 1024,
  cpuSeconds: 120,
  maximumProcesses: 2,
});

const SOURCE_RECORD_KEYS = Object.freeze(['role', 'sha256']);
const REQUIRED_SOURCE_ROLES = Object.freeze([
  'worker-entry',
  'process-contract',
  'replay-implementation',
  'execution-contract',
  'dataset-contract',
]);
const IMPLEMENTATION_KEYS = Object.freeze([
  'assuranceScope', 'deepLearningReplayAlgorithmHash', 'kind',
  'networkIsolationPolicy', 'requestTransport', 'sourceManifestHash',
  'sourceRecords', 'version', 'workerImplementationHash',
]);
const RESOURCE_BUDGET_KEYS = Object.freeze([
  'cpuSeconds', 'maximumProcesses', 'memoryBytes', 'timeoutMs',
]);
const REQUEST_KEYS = Object.freeze([
  'errorBudget', 'expectedMetrics', 'expectedPredictions', 'executionReceipt',
  'kind', 'replayRuntimeIdentityHash', 'replayScope', 'requestHash',
  'resourceBudget', 'tensorBundleBase64', 'trainingDataset', 'version',
  'workerImplementationHash',
]);
const RECEIPT_KEYS = Object.freeze([
  'assuranceScope', 'blockers', 'deepLearningIndependentCpuOracleReceiptHash',
  'externalActionPerformed', 'kind', 'networkActionPerformed',
  'networkGuardInstalled', 'networkIsolationPolicy', 'parentPid',
  'processIndependent', 'productionBlockers', 'productionPromotionEligible',
  'replayReceipt', 'replayReceiptHash', 'requestHash', 'resourceBudget',
  'status', 'version', 'workerImplementation', 'workerImplementationHash',
  'workerPid',
]);

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function uniqueSorted(values) {
  return Object.freeze([...new Set((values || []).map(String))].sort());
}

function finitePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function finiteParentPid(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalBase64(value, expectedBytes) {
  if (typeof value !== 'string' || value.length > 8 * 1024 ** 3
    || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  let bytes;
  try { bytes = Buffer.from(value, 'base64'); } catch { return null; }
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== value) return null;
  return value;
}

function exactErrorBudget(value) {
  if (!exactPlainObject(value, [
    'gradientNormComparison', 'kind', 'version',
    'maximumAbsoluteCrossEntropy', 'maximumAbsoluteInitialCrossEntropy',
    'maximumAccuracyDifference', 'maximumRelativeCrossEntropy',
    'maximumRelativeInitialCrossEntropy', 'requirePredictionEquality',
  ])) return false;
  return value.version === 1
    && value.kind === 'DeepLearningReplayErrorBudget'
    && value.gradientNormComparison
      === 'not-derivable-from-final-checkpoint-v1'
    && Number.isFinite(value.maximumAbsoluteCrossEntropy)
    && value.maximumAbsoluteCrossEntropy >= 0
    && Number.isFinite(value.maximumAbsoluteInitialCrossEntropy)
    && value.maximumAbsoluteInitialCrossEntropy >= 0
    && Number.isFinite(value.maximumAccuracyDifference)
    && value.maximumAccuracyDifference >= 0
    && Number.isFinite(value.maximumRelativeCrossEntropy)
    && value.maximumRelativeCrossEntropy >= 0
    && Number.isFinite(value.maximumRelativeInitialCrossEntropy)
    && value.maximumRelativeInitialCrossEntropy >= 0
    && value.requirePredictionEquality === true;
}

export function verifyDeepLearningCpuOracleResourceBudget(value) {
  return hasExactObjectKeys(value, RESOURCE_BUDGET_KEYS)
    && Object.entries(DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS).every(
      ([key, maximum]) => Number.isSafeInteger(value[key])
        && value[key] >= 1 && value[key] <= maximum,
    );
}

function canonicalSourceRecords(value) {
  if (!Array.isArray(value) || value.length < REQUIRED_SOURCE_ROLES.length) {
    throw new Error('deep_learning_cpu_oracle_source_manifest_invalid');
  }
  const required = REQUIRED_SOURCE_ROLES.map((role, index) => {
    const row = value[index];
    if (!hasExactObjectKeys(row, SOURCE_RECORD_KEYS)
      || row.role !== role || !sha(row.sha256)) {
      throw new Error('deep_learning_cpu_oracle_source_manifest_invalid');
    }
    return Object.freeze({ role, sha256: sha(row.sha256) });
  });
  const remainder = value.slice(REQUIRED_SOURCE_ROLES.length).map((row) => {
    if (!hasExactObjectKeys(row, SOURCE_RECORD_KEYS)
      || typeof row.role !== 'string'
      || !/^transitive:[A-Za-z0-9._/-]+\.mjs$/u.test(row.role)
      || row.role.includes('/../') || row.role.includes('\\')
      || !sha(row.sha256)) {
      throw new Error('deep_learning_cpu_oracle_source_manifest_invalid');
    }
    return Object.freeze({ role: row.role, sha256: sha(row.sha256) });
  });
  const roles = remainder.map((row) => row.role);
  if (new Set(roles).size !== roles.length
    || JSON.stringify(roles) !== JSON.stringify([...roles].sort())) {
    throw new Error('deep_learning_cpu_oracle_source_manifest_invalid');
  }
  return Object.freeze([...required, ...remainder]);
}

export function buildDeepLearningCpuOracleWorkerImplementation({
  sourceRecords,
} = {}) {
  const records = canonicalSourceRecords(sourceRecords);
  const algorithmRecord = records.find(
    (row) => row.role === 'replay-implementation',
  );
  const deepLearningReplayAlgorithmHash = hashRecord(
    'DeepLearningIndependentCpuReplayAlgorithm',
    {
      version: 1,
      kind: 'DeepLearningIndependentCpuReplayAlgorithm',
      algorithm: 'checkpoint-inference-and-initial-loss-v1',
      sourceHash: algorithmRecord.sha256,
    },
  );
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedDeepLearningCpuOracleWorkerImplementation',
    assuranceScope: PROCESS_ISOLATED_DEEP_LEARNING_CPU_ORACLE_ASSURANCE_SCOPE,
    networkIsolationPolicy: DEEP_LEARNING_CPU_ORACLE_NETWORK_ISOLATION_POLICY,
    requestTransport: 'bounded-stdin-single-json-document-v1',
    sourceRecords: records,
    sourceManifestHash: hashRecord(
      'DeepLearningCpuOracleWorkerSourceManifest', records,
    ),
    deepLearningReplayAlgorithmHash,
  };
  return Object.freeze({
    ...payload,
    workerImplementationHash: hashRecord(
      'ProcessIsolatedDeepLearningCpuOracleWorkerImplementation', payload,
    ),
  });
}

export function verifyDeepLearningCpuOracleWorkerImplementation(value) {
  if (!hasExactObjectKeys(value, IMPLEMENTATION_KEYS)) return false;
  try {
    return JSON.stringify(buildDeepLearningCpuOracleWorkerImplementation(value))
      === JSON.stringify(value);
  } catch { return false; }
}

export function buildProcessIsolatedDeepLearningCpuOracleRequest({
  executionReceipt,
  trainingDataset,
  tensorBundleBase64,
  expectedPredictions,
  expectedMetrics,
  replayRuntimeIdentityHash,
  workerImplementationHash,
  errorBudget,
  resourceBudget,
  workerImplementation = null,
} = {}) {
  if (!verifyDeepLearningTrainingExecutionReceipt(executionReceipt)
    || !verifyDeepLearningInlineTrainingDataset(trainingDataset)
    || trainingDataset.deepLearningTrainingDatasetManifestHash
      !== executionReceipt.trainingDatasetManifestHash
    || executionReceipt.checkpointManifest?.tensorBundleArtifactBytes
      === undefined
    || canonicalBase64(
      tensorBundleBase64,
      executionReceipt.checkpointManifest.tensorBundleArtifactBytes,
    ) === null
    || !Array.isArray(expectedPredictions)
    || expectedPredictions.length !== trainingDataset.sampleCount
    || !expectedPredictions.every((value) => Number.isSafeInteger(value)
      && value >= 0 && value < executionReceipt.modelIr.classCount)
    || !exactPlainObject(expectedMetrics, [
      'accuracy', 'crossEntropy', 'gradientNorm', 'initialCrossEntropy',
    ])
    || !jsonEqual(expectedMetrics, executionReceipt.finalMetrics)
    || !sha(replayRuntimeIdentityHash)
    || !sha(workerImplementationHash)
    || !exactErrorBudget(errorBudget)
    || !verifyDeepLearningCpuOracleResourceBudget(resourceBudget)
    || (workerImplementation !== null
      && (!verifyDeepLearningCpuOracleWorkerImplementation(workerImplementation)
        || workerImplementation.workerImplementationHash !== workerImplementationHash))) {
    throw new Error('deep_learning_cpu_oracle_request_invalid');
  }
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedDeepLearningIndependentCpuOracleRequest',
    replayScope: DEEP_LEARNING_CPU_ORACLE_REPLAY_SCOPE,
    replayRuntimeIdentityHash: sha(replayRuntimeIdentityHash),
    executionReceipt,
    trainingDataset,
    tensorBundleBase64,
    expectedPredictions: Object.freeze([...expectedPredictions]),
    expectedMetrics: Object.freeze({ ...expectedMetrics }),
    errorBudget: Object.freeze({ ...errorBudget }),
    workerImplementationHash: sha(workerImplementationHash),
    resourceBudget: Object.freeze({ ...resourceBudget }),
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord(
      'ProcessIsolatedDeepLearningIndependentCpuOracleRequest', payload,
    ),
  });
}

export function verifyProcessIsolatedDeepLearningCpuOracleRequest(
  value,
  { workerImplementation = null } = {},
) {
  if (!hasExactObjectKeys(value, REQUEST_KEYS)
    || value.version !== 1
    || value.kind !== 'ProcessIsolatedDeepLearningIndependentCpuOracleRequest'
    || value.replayScope !== DEEP_LEARNING_CPU_ORACLE_REPLAY_SCOPE) return false;
  try {
    return JSON.stringify(buildProcessIsolatedDeepLearningCpuOracleRequest({
      ...value,
      workerImplementation,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function buildProcessIsolatedDeepLearningCpuOracleReceipt({
  request,
  replayReceipt = null,
  workerImplementation,
  workerPid,
  parentPid,
  networkGuardInstalled = false,
  networkActionPerformed = false,
  externalActionPerformed = false,
  blockers = [],
} = {}) {
  const requestValid = verifyProcessIsolatedDeepLearningCpuOracleRequest(request, {
    workerImplementation,
  });
  const replayVerified = replayReceipt?.status
    === 'deep_learning_independent_replay_verified'
    && replayReceipt.scientificChecksPassed === true
    && replayReceipt.productionPromotionEligible === false;
  const processValid = finitePid(workerPid) && finiteParentPid(parentPid)
    && workerPid !== parentPid;
  const selectedBlockers = uniqueSorted([
    ...blockers,
    ...(requestValid ? [] : ['deep_learning_cpu_oracle_request_invalid']),
    ...(verifyDeepLearningCpuOracleWorkerImplementation(workerImplementation)
      ? [] : ['deep_learning_cpu_oracle_worker_implementation_invalid']),
    ...(replayVerified ? [] : ['deep_learning_cpu_oracle_replay_invalid']),
    ...(processValid ? [] : ['deep_learning_cpu_oracle_process_identity_invalid']),
    ...(networkGuardInstalled === true ? [] : ['deep_learning_cpu_oracle_network_guard_missing']),
    ...(networkActionPerformed === false ? [] : ['deep_learning_cpu_oracle_network_action_forbidden']),
    ...(externalActionPerformed === false ? [] : ['deep_learning_cpu_oracle_external_action_forbidden']),
  ]);
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedDeepLearningIndependentCpuOracleReceipt',
    status: selectedBlockers.length
      ? 'deep_learning_independent_cpu_oracle_blocked'
      : 'deep_learning_independent_cpu_oracle_verified',
    assuranceScope: PROCESS_ISOLATED_DEEP_LEARNING_CPU_ORACLE_ASSURANCE_SCOPE,
    requestHash: request?.requestHash || null,
    replayReceipt: replayReceipt || null,
    replayReceiptHash: replayReceipt?.deepLearningIndependentReplayReceiptHash || null,
    workerImplementation: workerImplementation || null,
    workerImplementationHash: workerImplementation?.workerImplementationHash || null,
    workerPid: processValid ? workerPid : null,
    parentPid: processValid ? parentPid : null,
    processIndependent: processValid,
    networkIsolationPolicy: DEEP_LEARNING_CPU_ORACLE_NETWORK_ISOLATION_POLICY,
    networkGuardInstalled: networkGuardInstalled === true,
    networkActionPerformed: networkActionPerformed === true,
    externalActionPerformed: externalActionPerformed === true,
    resourceBudget: request?.resourceBudget || null,
    productionPromotionEligible: false,
    productionBlockers: DEEP_LEARNING_CPU_ORACLE_PRODUCTION_BLOCKERS,
    blockers: selectedBlockers,
  };
  return Object.freeze({
    ...payload,
    deepLearningIndependentCpuOracleReceiptHash: hashRecord(
      'ProcessIsolatedDeepLearningIndependentCpuOracleReceipt', payload,
    ),
  });
}

export function verifyProcessIsolatedDeepLearningCpuOracleReceipt(value, {
  request = null,
  workerImplementation = null,
} = {}) {
  if (!hasExactObjectKeys(value, RECEIPT_KEYS)
    || value.version !== 1
    || value.kind !== 'ProcessIsolatedDeepLearningIndependentCpuOracleReceipt'
    || value.status !== 'deep_learning_independent_cpu_oracle_verified'
    || value.productionPromotionEligible !== false
    || !jsonEqual(value.productionBlockers, DEEP_LEARNING_CPU_ORACLE_PRODUCTION_BLOCKERS)
    || value.requestHash !== request?.requestHash
    || value.processIndependent !== true
    || value.networkGuardInstalled !== true
    || value.networkActionPerformed !== false
    || value.externalActionPerformed !== false
    || !finitePid(value.workerPid)
    || !finiteParentPid(value.parentPid)
    || value.workerPid === value.parentPid
    || !Array.isArray(value.blockers) || value.blockers.length !== 0
    || !verifyDeepLearningCpuOracleWorkerImplementation(value.workerImplementation)
    || JSON.stringify(value.workerImplementation)
      !== JSON.stringify(workerImplementation)
    || value.workerImplementationHash !== workerImplementation?.workerImplementationHash
    || !value.replayReceipt
    || value.replayReceiptHash
      !== value.replayReceipt.deepLearningIndependentReplayReceiptHash) return false;
  try {
    return JSON.stringify(buildProcessIsolatedDeepLearningCpuOracleReceipt({
      request,
      replayReceipt: value.replayReceipt,
      workerImplementation,
      workerPid: value.workerPid,
      parentPid: value.parentPid,
      networkGuardInstalled: true,
    })) === JSON.stringify(value);
  } catch { return false; }
}
