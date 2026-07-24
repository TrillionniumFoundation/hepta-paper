import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const PROCESS_ISOLATED_TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPE =
  'process-isolated-independent-implementation-v1';
export const TYPED_NUMERIC_ORACLE_NETWORK_ISOLATION_POLICY =
  'deny-node-network-client-and-server-apis-v1';

const REQUEST_KEYS = Object.freeze([
  'analysisProtocol', 'experimentIr', 'kind', 'observations', 'pluginProfile', 'production',
  'requestHash', 'version',
]);
const WORKER_IMPLEMENTATION_KEYS = Object.freeze([
  'assuranceScope', 'independentAlgorithmImplementationHash', 'kind',
  'networkIsolationPolicy', 'processContractSourceHash',
  'producerAlgorithmRegistrySourceHash', 'recomputationImplementationSourceHash',
  'requestTransport', 'version', 'workerImplementationHash',
  'workerImplementationSourceHash', 'workerSourceClosureHash',
]);
const WORKER_RECEIPT_KEYS = Object.freeze([
  'assuranceScope', 'blockers', 'externalActionPerformed',
  'independentAlgorithmImplementationHash', 'kind', 'networkActionPerformed',
  'networkGuardInstalled', 'networkIsolationPolicy', 'numericTupleManifest',
  'numericTupleManifestHash', 'parentPid', 'processIndependent', 'recomputation',
  'recomputationHash', 'requestHash', 'status', 'version', 'workerImplementation',
  'workerImplementationHash', 'workerImplementationSourceHash', 'workerPid',
  'workerReceiptHash', 'workerSourceClosureHash',
]);
const PROCESS_RECEIPT_KEYS = Object.freeze([
  'analysisProtocolHash', 'assuranceScope', 'blockers',
  'candidateAuthoredValuesAccepted', 'comparisons', 'externalActionPerformed',
  'empiricalPluginProfileHash', 'experimentId', 'experimentIrVersion',
  'independentAlgorithmImplementationHash',
  'independentTypedNumericOracleRecomputationHash', 'independentlyRecomputed',
  'kind', 'networkActionPerformed', 'networkGuardInstalled',
  'networkIsolationPolicy', 'numericInputManifestHash', 'numericTupleManifest',
  'numericTupleManifestHash', 'parentPid', 'processIndependent', 'productionHash',
  'producerImplementationHash', 'recomputation', 'requestHash', 'status',
  'verifierImplementationHash', 'version', 'workerImplementation',
  'workerImplementationHash', 'workerImplementationSourceHash', 'workerPid',
  'versionedExperimentIrHash', 'workerReceipt', 'workerReceiptHash', 'workerSourceClosureHash',
]);

function unique(values) {
  return Object.freeze([...new Set(values.map(String))]);
}

function finitePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function buildProcessIsolatedTypedNumericOracleRequest({
  production,
  observations,
  analysisProtocol,
  pluginProfile,
  experimentIr,
} = {}) {
  const payload = {
    version: 2,
    kind: 'ProcessIsolatedTypedNumericOracleRecomputationRequest',
    production: production || null,
    observations: observations || [],
    analysisProtocol: analysisProtocol || null,
    pluginProfile: pluginProfile || null,
    experimentIr: experimentIr || null,
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('ProcessIsolatedTypedNumericOracleRecomputationRequest', payload),
  });
}

export function verifyProcessIsolatedTypedNumericOracleRequest(request) {
  if (!hasExactObjectKeys(request, REQUEST_KEYS)
    || request.version !== 2
    || request.kind !== 'ProcessIsolatedTypedNumericOracleRecomputationRequest') return false;
  const { requestHash, ...payload } = request;
  return SHA256.test(String(requestHash || ''))
    && hashRecord('ProcessIsolatedTypedNumericOracleRecomputationRequest', payload)
      === requestHash;
}

export function buildTypedNumericOracleTupleManifest({ production, recomputation } = {}) {
  const outputs = new Map((production?.outputs || []).map((output) => [
    output.oracleType,
    output,
  ]));
  const tuples = (recomputation?.comparisons || []).map((comparison) => {
    const produced = outputs.get(comparison.oracleType);
    return Object.freeze({
      oracleType: comparison.oracleType,
      producerOutputHash: comparison.producerOutputHash,
      produced: Object.freeze({
        quantity: produced?.quantity ?? null,
        observedValue: produced?.observedValue ?? null,
        relation: produced?.relation ?? null,
        lowerBound: produced?.lowerBound ?? null,
        upperBound: produced?.upperBound ?? null,
        unit: produced?.unit ?? null,
      }),
      independentlyRecomputed: Object.freeze({
        quantity: comparison.independentlyRecomputed?.quantity ?? null,
        observedValue: comparison.independentlyRecomputed?.observedValue ?? null,
        relation: comparison.independentlyRecomputed?.relation ?? null,
        lowerBound: comparison.independentlyRecomputed?.lowerBound ?? null,
        upperBound: comparison.independentlyRecomputed?.upperBound ?? null,
        unit: comparison.independentlyRecomputed?.unit ?? null,
      }),
      fieldMatches: comparison.fieldMatches || null,
      match: comparison.match === true,
      comparisonHash: comparison.independentTypedNumericOracleComparisonHash || null,
    });
  }).sort((left, right) => left.oracleType.localeCompare(right.oracleType));
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedTypedNumericOracleTupleManifest',
    productionHash: production?.typedNumericOracleProductionHash || null,
    numericInputManifestHash: production?.numericInputManifestHash || null,
    tupleCount: tuples.length,
    tuples: Object.freeze(tuples),
  };
  return Object.freeze({
    ...payload,
    numericTupleManifestHash: hashRecord(
      'ProcessIsolatedTypedNumericOracleTupleManifest', payload,
    ),
  });
}

export function buildTypedNumericOracleWorkerImplementation({
  workerImplementationSourceHash,
  recomputationImplementationSourceHash,
  processContractSourceHash,
  producerAlgorithmRegistrySourceHash,
  independentAlgorithmImplementationHash,
} = {}) {
  const sourceRecords = Object.freeze([
    Object.freeze({ role: 'worker-entry', sha256: workerImplementationSourceHash }),
    Object.freeze({ role: 'recomputation-implementation', sha256: recomputationImplementationSourceHash }),
    Object.freeze({ role: 'process-contract', sha256: processContractSourceHash }),
    Object.freeze({ role: 'producer-algorithm-registry', sha256: producerAlgorithmRegistrySourceHash }),
  ]);
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedTypedNumericOracleWorkerImplementation',
    assuranceScope: PROCESS_ISOLATED_TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPE,
    networkIsolationPolicy: TYPED_NUMERIC_ORACLE_NETWORK_ISOLATION_POLICY,
    requestTransport: 'bounded-stdin-single-json-document-v1',
    workerImplementationSourceHash: workerImplementationSourceHash || null,
    recomputationImplementationSourceHash: recomputationImplementationSourceHash || null,
    processContractSourceHash: processContractSourceHash || null,
    producerAlgorithmRegistrySourceHash: producerAlgorithmRegistrySourceHash || null,
    independentAlgorithmImplementationHash: independentAlgorithmImplementationHash || null,
    workerSourceClosureHash: hashRecord(
      'ProcessIsolatedTypedNumericOracleWorkerSourceClosure', sourceRecords,
    ),
  };
  return Object.freeze({
    ...payload,
    workerImplementationHash: hashRecord(
      'ProcessIsolatedTypedNumericOracleWorkerImplementation', payload,
    ),
  });
}

export function verifyTypedNumericOracleWorkerImplementation(implementation) {
  if (!hasExactObjectKeys(implementation, WORKER_IMPLEMENTATION_KEYS)
    || implementation.version !== 1
    || implementation.kind !== 'ProcessIsolatedTypedNumericOracleWorkerImplementation'
    || implementation.assuranceScope !== PROCESS_ISOLATED_TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPE
    || implementation.networkIsolationPolicy !== TYPED_NUMERIC_ORACLE_NETWORK_ISOLATION_POLICY
    || implementation.requestTransport !== 'bounded-stdin-single-json-document-v1') return false;
  const hashes = [
    implementation.workerImplementationSourceHash,
    implementation.recomputationImplementationSourceHash,
    implementation.processContractSourceHash,
    implementation.producerAlgorithmRegistrySourceHash,
    implementation.independentAlgorithmImplementationHash,
    implementation.workerSourceClosureHash,
    implementation.workerImplementationHash,
  ];
  if (hashes.some((value) => !SHA256.test(String(value || '')))) return false;
  return JSON.stringify(buildTypedNumericOracleWorkerImplementation(implementation))
    === JSON.stringify(implementation);
}

export function buildProcessIsolatedTypedNumericOracleWorkerReceipt({
  request,
  recomputation = null,
  workerImplementation,
  workerPid,
  parentPid,
  networkGuardInstalled = false,
  networkActionPerformed = false,
  externalActionPerformed = false,
  blockers = [],
} = {}) {
  const tupleManifest = recomputation
    ? buildTypedNumericOracleTupleManifest({
      production: request?.production,
      recomputation,
    }) : null;
  const uniqueBlockers = unique([
    ...blockers,
    ...(!verifyProcessIsolatedTypedNumericOracleRequest(request)
      ? ['process_isolated_typed_numeric_request_invalid'] : []),
    ...(!verifyTypedNumericOracleWorkerImplementation(workerImplementation)
      ? ['process_isolated_typed_numeric_worker_implementation_invalid'] : []),
    ...(!recomputation
      || recomputation.status !== 'independent_typed_numeric_oracle_recomputation_verified'
      ? ['process_isolated_typed_numeric_recomputation_invalid'] : []),
    ...(!finitePid(workerPid) || !finitePid(parentPid) || workerPid === parentPid
      ? ['process_isolated_typed_numeric_process_identity_invalid'] : []),
    ...(networkGuardInstalled === true
      ? [] : ['process_isolated_typed_numeric_network_guard_missing']),
    ...(networkActionPerformed === false
      ? [] : ['process_isolated_typed_numeric_network_action_forbidden']),
    ...(externalActionPerformed === false
      ? [] : ['process_isolated_typed_numeric_external_action_forbidden']),
  ]);
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedTypedNumericOracleWorkerReceipt',
    status: uniqueBlockers.length
      ? 'process_isolated_typed_numeric_oracle_recomputation_blocked'
      : 'process_isolated_typed_numeric_oracle_recomputation_verified',
    assuranceScope: PROCESS_ISOLATED_TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPE,
    requestHash: request?.requestHash || null,
    recomputation,
    recomputationHash:
      recomputation?.independentTypedNumericOracleRecomputationHash || null,
    numericTupleManifest: tupleManifest,
    numericTupleManifestHash: tupleManifest?.numericTupleManifestHash || null,
    workerImplementation,
    workerImplementationHash: workerImplementation?.workerImplementationHash || null,
    workerImplementationSourceHash:
      workerImplementation?.workerImplementationSourceHash || null,
    workerSourceClosureHash: workerImplementation?.workerSourceClosureHash || null,
    independentAlgorithmImplementationHash:
      workerImplementation?.independentAlgorithmImplementationHash || null,
    workerPid: finitePid(workerPid) ? workerPid : null,
    parentPid: finitePid(parentPid) ? parentPid : null,
    processIndependent: finitePid(workerPid) && finitePid(parentPid) && workerPid !== parentPid,
    networkIsolationPolicy: TYPED_NUMERIC_ORACLE_NETWORK_ISOLATION_POLICY,
    networkGuardInstalled: networkGuardInstalled === true,
    networkActionPerformed: networkActionPerformed === true,
    externalActionPerformed: externalActionPerformed === true,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    workerReceiptHash: hashRecord(
      'ProcessIsolatedTypedNumericOracleWorkerReceipt', payload,
    ),
  });
}

export function verifyProcessIsolatedTypedNumericOracleWorkerReceipt(
  receipt,
  { request, workerImplementation, verifyRecomputation } = {},
) {
  if (!hasExactObjectKeys(receipt, WORKER_RECEIPT_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'ProcessIsolatedTypedNumericOracleWorkerReceipt'
    || receipt.status !== 'process_isolated_typed_numeric_oracle_recomputation_verified'
    || receipt.assuranceScope !== PROCESS_ISOLATED_TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPE
    || receipt.requestHash !== request?.requestHash
    || receipt.processIndependent !== true
    || receipt.networkIsolationPolicy !== TYPED_NUMERIC_ORACLE_NETWORK_ISOLATION_POLICY
    || receipt.networkGuardInstalled !== true
    || receipt.networkActionPerformed !== false
    || receipt.externalActionPerformed !== false
    || !finitePid(receipt.workerPid) || !finitePid(receipt.parentPid)
    || receipt.workerPid === receipt.parentPid
    || !Array.isArray(receipt.blockers) || receipt.blockers.length !== 0
    || !verifyTypedNumericOracleWorkerImplementation(receipt.workerImplementation)
    || JSON.stringify(receipt.workerImplementation)
      !== JSON.stringify(workerImplementation)
    || receipt.workerImplementationHash !== workerImplementation?.workerImplementationHash
    || receipt.workerImplementationSourceHash
      !== workerImplementation?.workerImplementationSourceHash
    || receipt.workerSourceClosureHash !== workerImplementation?.workerSourceClosureHash
    || receipt.independentAlgorithmImplementationHash
      !== workerImplementation?.independentAlgorithmImplementationHash
    || typeof verifyRecomputation !== 'function'
    || !verifyRecomputation(receipt.recomputation)
    || receipt.recomputationHash
      !== receipt.recomputation?.independentTypedNumericOracleRecomputationHash) return false;
  const tupleManifest = buildTypedNumericOracleTupleManifest({
    production: request?.production,
    recomputation: receipt.recomputation,
  });
  if (JSON.stringify(receipt.numericTupleManifest) !== JSON.stringify(tupleManifest)
    || receipt.numericTupleManifestHash !== tupleManifest.numericTupleManifestHash) return false;
  return JSON.stringify(buildProcessIsolatedTypedNumericOracleWorkerReceipt({
    request,
    recomputation: receipt.recomputation,
    workerImplementation,
    workerPid: receipt.workerPid,
    parentPid: receipt.parentPid,
    networkGuardInstalled: true,
  })) === JSON.stringify(receipt);
}

export function buildProcessIsolatedTypedNumericOracleRecomputationReceipt({
  request,
  workerImplementation,
  workerReceipt = null,
  parentPid,
  workerPid = null,
  blockers = [],
} = {}) {
  const recomputation = workerReceipt?.recomputation || null;
  const tupleManifest = workerReceipt?.numericTupleManifest || null;
  const uniqueBlockers = unique(blockers);
  const verified = uniqueBlockers.length === 0 && Boolean(workerReceipt);
  const payload = {
    version: 2,
    kind: 'IndependentTypedNumericOracleRecomputation',
    status: verified
      ? 'independent_typed_numeric_oracle_recomputation_verified'
      : 'independent_typed_numeric_oracle_recomputation_blocked',
    assuranceScope: PROCESS_ISOLATED_TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPE,
    analysisProtocolHash: request?.analysisProtocol?.analysisProtocolHash || null,
    empiricalPluginProfileHash:
      request?.pluginProfile?.autonomousEmpiricalFamilyPluginProfileHash || null,
    experimentIrVersion: request?.experimentIr?.irVersion || null,
    experimentId: request?.experimentIr?.experimentId || null,
    versionedExperimentIrHash: request?.experimentIr?.versionedExperimentIrHash || null,
    numericInputManifestHash: request?.production?.numericInputManifestHash || null,
    productionHash: request?.production?.typedNumericOracleProductionHash || null,
    producerImplementationHash: request?.production?.producerImplementationHash || null,
    verifierImplementationHash: workerImplementation?.workerImplementationHash || null,
    independentAlgorithmImplementationHash:
      workerImplementation?.independentAlgorithmImplementationHash || null,
    independentlyRecomputed: verified,
    processIndependent: verified,
    candidateAuthoredValuesAccepted: false,
    requestHash: request?.requestHash || null,
    workerReceiptHash: workerReceipt?.workerReceiptHash || null,
    workerImplementation,
    workerImplementationHash: workerImplementation?.workerImplementationHash || null,
    workerImplementationSourceHash:
      workerImplementation?.workerImplementationSourceHash || null,
    workerSourceClosureHash: workerImplementation?.workerSourceClosureHash || null,
    parentPid: finitePid(parentPid) ? parentPid : null,
    workerPid: finitePid(workerPid) ? workerPid : null,
    networkIsolationPolicy: TYPED_NUMERIC_ORACLE_NETWORK_ISOLATION_POLICY,
    networkGuardInstalled: verified && workerReceipt?.networkGuardInstalled === true,
    networkActionPerformed: workerReceipt?.networkActionPerformed === true,
    externalActionPerformed: workerReceipt?.externalActionPerformed === true,
    numericTupleManifest: tupleManifest,
    numericTupleManifestHash: tupleManifest?.numericTupleManifestHash || null,
    recomputation,
    comparisons: Object.freeze(recomputation?.comparisons || []),
    workerReceipt,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    independentTypedNumericOracleRecomputationHash: hashRecord(
      'IndependentTypedNumericOracleRecomputation', payload,
    ),
  });
}

export function verifyProcessIsolatedTypedNumericOracleRecomputationReceiptShape(receipt) {
  return hasExactObjectKeys(receipt, PROCESS_RECEIPT_KEYS)
    && receipt.version === 2
    && receipt.kind === 'IndependentTypedNumericOracleRecomputation'
    && receipt.assuranceScope === PROCESS_ISOLATED_TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPE;
}
