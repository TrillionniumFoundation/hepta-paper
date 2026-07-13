import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/i;
const validHash = (value) => HASH.test(String(value || ''));
const hashes = (values) => [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))].sort();

function normalizeDatasetMounts(values = []) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    name: String(item?.name || ''),
    manifestHash: item?.manifestHash || null,
    licenseId: item?.licenseId || null,
    readOnly: item?.readOnly === true,
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeMetricPredicates(values = []) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    metric: String(item?.metric || item?.name || ''),
    comparator: item?.comparator || item?.operator || null,
    threshold: Number.isFinite(Number(item?.threshold)) ? Number(item.threshold) : null,
  })).sort((left, right) => `${left.metric}:${left.comparator}:${left.threshold}`.localeCompare(`${right.metric}:${right.comparator}:${right.threshold}`));
}

function experimentExecutionSubjects(experiment = {}) {
  const datasetContract = {
    datasetHash: experiment.datasetHash || null,
    datasetManifestHash: experiment.datasetManifestHash || null,
    licenseId: experiment.datasetLicenseId || null,
    readOnly: experiment.datasetReadOnly === true,
    mounts: normalizeDatasetMounts(experiment.datasetMounts),
  };
  const isolationPolicy = {
    networkPolicy: experiment.networkPolicy || null,
    secretsAllowed: experiment.secretsAllowed === true,
    externalActionsAllowed: experiment.externalActionsAllowed === true,
    providerCallsAllowed: experiment.providerCallsAllowed === true,
    sourceMutationAllowed: experiment.sourceMutationAllowed === true,
    sourceReadOnlyRequired: experiment.sourceReadOnlyRequired === true,
    ephemeralWorkRootRequired: experiment.ephemeralWorkRootRequired === true,
    separateOutputRootRequired: experiment.separateOutputRootRequired === true,
  };
  const metricPredicates = normalizeMetricPredicates(experiment.metricPredicates);
  return {
    datasetContract,
    datasetContractHash: hashRecord('ExperimentDatasetContract', datasetContract),
    isolationPolicy,
    isolationPolicyHash: hashRecord('ExperimentIsolationPolicy', isolationPolicy),
    metricPredicates,
    metricPredicateContractHash: hashRecord('ExperimentMetricPredicateContract', metricPredicates),
  };
}

export function buildExperimentExecutionContract({ experiment = {}, requiredOutputs = [], expectedOutputRoles = {}, expectedOutputPaths = {} } = {}) {
  const subjects = experimentExecutionSubjects(experiment);
  const outputs = [...new Set(requiredOutputs.map(String))].sort().map((name) => ({
    name,
    path: expectedOutputPaths[name] || name,
    role: expectedOutputRoles[name] || `experiment-output:${experiment.experimentId}:${experiment.runId}:${name}`,
  }));
  const payload = {
    version: 2,
    kind: 'ExperimentExecutionContract',
    experimentId: experiment.experimentId || null,
    runId: experiment.runId || null,
    datasetHash: experiment.datasetHash || null,
    codeHash: experiment.codeHash || null,
    resultHash: experiment.resultHash || null,
    resultPath: experiment.resultPath || null,
    acceptanceProfileId: experiment.acceptanceProfileId || null,
    deterministicSeed: experiment.seed ?? null,
    ...subjects,
    outputs,
  };
  return Object.freeze({ ...payload, experimentExecutionContractHash: hashRecord('ExperimentExecutionContract', payload) });
}

export function buildExperimentOutputManifest({ experimentId, runId, outputArtifacts = [] } = {}) {
  const payload = {
    version: 1,
    kind: 'ExperimentOutputManifest',
    experimentId: experimentId || null,
    runId: runId || null,
    outputs: outputArtifacts.map((item) => ({
      name: item.name,
      path: item.path,
      hash: item.hash,
      manifestHash: item.manifestHash,
      writeReceiptHash: item.writeReceiptHash,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
  return Object.freeze({ ...payload, experimentOutputManifestHash: hashRecord('ExperimentOutputManifest', payload) });
}

export function buildExperimentEvidenceBinding({
  experiment = {},
  workerReceipt = null,
  resultArtifact = null,
  reproducibilityReceipt = null,
  receiptLedger = null,
  requiredOutputs = [],
  artifactVerifier = null,
  expectedOutputRoles = {},
  expectedOutputPaths = {},
} = {}) {
  const blockers = [];
  const workerReceiptHash = workerReceipt?.receiptHash || workerReceipt?.workerReceiptHash || null;
  const resultWriteReceipt = resultArtifact?.artifactWriteReceipt || resultArtifact?.receipt || resultArtifact;
  const resultArtifactHash = resultWriteReceipt?.hash || null;
  const reproducibilityReceiptHash = reproducibilityReceipt?.receiptHash || reproducibilityReceipt?.reproducibilityReceiptHash || null;
  const outputArtifacts = (Array.isArray(resultArtifact?.outputArtifacts) ? resultArtifact.outputArtifacts : []).map((item) => ({
    name: String(item?.name || ''),
    path: item?.artifactWriteReceipt?.path || item?.receipt?.path || null,
    hash: item?.artifactWriteReceipt?.hash || item?.receipt?.hash || null,
    manifestHash: item?.artifactWriteReceipt?.manifestHash || item?.receipt?.manifestHash || null,
    writeReceiptHash: item?.artifactWriteReceipt?.writeReceiptHash || item?.receipt?.writeReceiptHash || null,
    ledgerReceiptId: item?.ledgerReceiptId || null,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const outputArtifactHashes = hashes(outputArtifacts.map((item) => item.hash));
  const executionContract = buildExperimentExecutionContract({ experiment, requiredOutputs, expectedOutputRoles, expectedOutputPaths });
  const outputManifest = buildExperimentOutputManifest({ experimentId: experiment.experimentId, runId: experiment.runId, outputArtifacts });
  if (!experiment.experimentId) blockers.push('experiment_evidence_experiment_id_missing');
  if (!experiment.runId) blockers.push('experiment_evidence_run_id_missing');
  if (experiment.seed === null || experiment.seed === undefined || experiment.seed === '') blockers.push('experiment_execution_seed_missing');
  if (!validHash(executionContract.datasetContract.datasetManifestHash)) blockers.push('experiment_dataset_manifest_hash_invalid');
  if (!executionContract.datasetContract.licenseId) blockers.push('experiment_dataset_license_missing');
  if (executionContract.datasetContract.readOnly !== true) blockers.push('experiment_dataset_read_only_required');
  if (executionContract.datasetContract.mounts.some((item) => !item.name || !validHash(item.manifestHash) || !item.licenseId || item.readOnly !== true)) blockers.push('experiment_dataset_mount_contract_invalid');
  if (executionContract.isolationPolicy.networkPolicy !== 'none') blockers.push('experiment_network_isolation_required');
  if (executionContract.isolationPolicy.secretsAllowed || executionContract.isolationPolicy.externalActionsAllowed || executionContract.isolationPolicy.providerCallsAllowed || executionContract.isolationPolicy.sourceMutationAllowed) blockers.push('experiment_forbidden_capability_allowed');
  if (!executionContract.isolationPolicy.sourceReadOnlyRequired || !executionContract.isolationPolicy.ephemeralWorkRootRequired || !executionContract.isolationPolicy.separateOutputRootRequired) blockers.push('experiment_filesystem_isolation_policy_incomplete');
  if (!executionContract.metricPredicates.length || executionContract.metricPredicates.some((item) => !item.metric || !['==', '>=', '<=', '>', '<'].includes(item.comparator) || item.threshold === null)) blockers.push('experiment_metric_predicate_contract_invalid');
  for (const [name, value] of Object.entries({
    datasetHash: experiment.datasetHash,
    codeHash: experiment.codeHash,
    resultHash: experiment.resultHash,
    workerReceiptHash,
    resultArtifactHash,
    reproducibilityReceiptHash,
  })) if (!validHash(value)) blockers.push(`experiment_evidence_${name}_invalid`);
  if (!['worker_execution_completed', 'experiment_execution_completed', 'completed'].includes(workerReceipt?.status)) {
    blockers.push('experiment_worker_receipt_not_completed');
  }
  if (workerReceipt?.datasetHash !== experiment.datasetHash) blockers.push('experiment_worker_dataset_hash_mismatch');
  if (workerReceipt?.codeHash !== experiment.codeHash) blockers.push('experiment_worker_code_hash_mismatch');
  if (workerReceipt?.resultHash !== experiment.resultHash) blockers.push('experiment_worker_result_hash_mismatch');
  if (workerReceipt?.experimentId !== experiment.experimentId) blockers.push('experiment_worker_experiment_id_mismatch');
  if (workerReceipt?.runId !== experiment.runId) blockers.push('experiment_worker_run_id_mismatch');
  if (workerReceipt?.seed !== experiment.seed) blockers.push('experiment_worker_seed_mismatch');
  if (workerReceipt?.executionContractHash !== executionContract.experimentExecutionContractHash) blockers.push('experiment_worker_execution_contract_mismatch');
  if (workerReceipt?.datasetContractHash !== executionContract.datasetContractHash) blockers.push('experiment_worker_dataset_contract_mismatch');
  if (workerReceipt?.isolationPolicyHash !== executionContract.isolationPolicyHash) blockers.push('experiment_worker_isolation_policy_mismatch');
  if (workerReceipt?.metricPredicateContractHash !== executionContract.metricPredicateContractHash) blockers.push('experiment_worker_metric_predicate_contract_mismatch');
  if (!validHash(workerReceipt?.isolationReceiptHash)) blockers.push('experiment_worker_isolation_receipt_hash_invalid');
  if (workerReceipt?.networkPolicy !== 'none' || workerReceipt?.secretAccessPerformed !== false || workerReceipt?.externalActionPerformed !== false || workerReceipt?.providerCallPerformed !== false || workerReceipt?.sourceMutationDetected !== false) blockers.push('experiment_worker_isolation_claim_invalid');
  if (workerReceipt?.isolation?.kernelNetworkIsolationVerified !== true || workerReceipt?.isolation?.sourceReadOnlyVerified !== true || workerReceipt?.isolation?.ephemeralWorkRootVerified !== true || workerReceipt?.isolation?.separateOutputRootVerified !== true) blockers.push('experiment_worker_isolation_not_verified');
  if (!validHash(workerReceipt?.sourceMerkleHashBefore) || workerReceipt?.sourceMerkleHashBefore !== workerReceipt?.sourceMerkleHashAfter) blockers.push('experiment_worker_source_integrity_invalid');
  if (JSON.stringify(normalizeDatasetMounts(workerReceipt?.datasetMounts)) !== JSON.stringify(executionContract.datasetContract.mounts)) blockers.push('experiment_worker_dataset_mounts_mismatch');
  if (workerReceipt?.outputManifestHash !== outputManifest.experimentOutputManifestHash) blockers.push('experiment_worker_output_manifest_mismatch');
  if (workerReceipt?.resultArtifactWriteReceiptHash !== resultWriteReceipt?.writeReceiptHash) blockers.push('experiment_worker_result_artifact_receipt_mismatch');
  if (resultArtifactHash !== experiment.resultHash) blockers.push('experiment_result_artifact_hash_mismatch');
  if (reproducibilityReceipt?.status !== 'experiment_reproducibility_verified') blockers.push('experiment_reproducibility_not_verified');
  if (reproducibilityReceipt?.workerReceiptHash !== workerReceiptHash) blockers.push('experiment_reproducibility_worker_receipt_mismatch');
  if (reproducibilityReceipt?.resultHash !== experiment.resultHash) blockers.push('experiment_reproducibility_result_hash_mismatch');
  if (reproducibilityReceipt?.experimentId !== experiment.experimentId) blockers.push('experiment_reproducibility_experiment_id_mismatch');
  if (reproducibilityReceipt?.runId !== experiment.runId) blockers.push('experiment_reproducibility_run_id_mismatch');
  if (reproducibilityReceipt?.seed !== experiment.seed) blockers.push('experiment_reproducibility_seed_mismatch');
  if (reproducibilityReceipt?.executionContractHash !== executionContract.experimentExecutionContractHash) blockers.push('experiment_reproducibility_execution_contract_mismatch');
  if (reproducibilityReceipt?.datasetContractHash !== executionContract.datasetContractHash) blockers.push('experiment_reproducibility_dataset_contract_mismatch');
  if (reproducibilityReceipt?.isolationPolicyHash !== executionContract.isolationPolicyHash) blockers.push('experiment_reproducibility_isolation_policy_mismatch');
  if (reproducibilityReceipt?.metricPredicateContractHash !== executionContract.metricPredicateContractHash) blockers.push('experiment_reproducibility_metric_predicate_contract_mismatch');
  if (reproducibilityReceipt?.isolationReceiptHash !== workerReceipt?.isolationReceiptHash) blockers.push('experiment_reproducibility_isolation_receipt_mismatch');
  if (reproducibilityReceipt?.outputManifestHash !== outputManifest.experimentOutputManifestHash) blockers.push('experiment_reproducibility_output_manifest_mismatch');
  if (!outputArtifactHashes.length || outputArtifactHashes.some((value) => !validHash(value))) {
    blockers.push('experiment_output_artifact_hashes_invalid');
  }
  const workerLedger = verifyTrustedLedgerReceipt({ receipt: workerReceipt, ledgerReceiptId: workerReceipt?.ledgerReceiptId, receiptLedger, expectedKinds: ['ExperimentWorkerExecutionReceipt'], expectedStatuses: ['worker_execution_completed', 'experiment_execution_completed', 'completed'], expectedStreams: ['experiment-workers'], expectedWriterKinds: ['experiment-worker'] });
  const resultLedger = verifyTrustedLedgerReceipt({ receipt: resultWriteReceipt, ledgerReceiptId: resultArtifact?.ledgerReceiptId, receiptLedger, expectedKinds: ['ArtifactWriteReceipt'], expectedStreams: ['artifact-writes'], expectedWriterKinds: ['content-addressed-repository'] });
  const reproducibilityLedger = verifyTrustedLedgerReceipt({ receipt: reproducibilityReceipt, ledgerReceiptId: reproducibilityReceipt?.ledgerReceiptId, receiptLedger, expectedKinds: ['ExperimentReproducibilityReceipt'], expectedStatuses: ['experiment_reproducibility_verified'], expectedStreams: ['experiment-reproducibility'], expectedWriterKinds: ['experiment-reproducibility-verifier'] });
  blockers.push(...workerLedger.blockers.map((item) => `experiment_worker:${item}`));
  blockers.push(...resultLedger.blockers.map((item) => `experiment_result:${item}`));
  blockers.push(...reproducibilityLedger.blockers.map((item) => `experiment_reproducibility:${item}`));
  const outputLedgerVerifications = (Array.isArray(resultArtifact?.outputArtifacts) ? resultArtifact.outputArtifacts : []).map((item) => verifyTrustedLedgerReceipt({
    receipt: item?.artifactWriteReceipt || item?.receipt,
    ledgerReceiptId: item?.ledgerReceiptId,
    receiptLedger,
    expectedKinds: ['ArtifactWriteReceipt'],
    expectedStreams: ['artifact-writes'],
    expectedWriterKinds: ['content-addressed-repository'],
  }));
  for (const verification of outputLedgerVerifications) blockers.push(...verification.blockers.map((item) => `experiment_output:${item}`));
  const outputNames = new Set(outputArtifacts.map((item) => item.name));
  if (outputNames.size !== outputArtifacts.length) blockers.push('experiment_output_manifest_duplicate_name');
  for (const name of requiredOutputs.map(String)) if (!outputNames.has(name)) blockers.push(`experiment_output_manifest_missing:${name}`);
  if (outputArtifacts.some((item) => !item.name || !validHash(item.hash) || !validHash(item.manifestHash) || !validHash(item.writeReceiptHash))) blockers.push('experiment_output_manifest_invalid');
  const sourceReceipts = [
    { label: 'result', receipt: resultWriteReceipt },
    ...(Array.isArray(resultArtifact?.outputArtifacts) ? resultArtifact.outputArtifacts : []).map((item) => ({ label: `output:${item?.name || 'unknown'}`, receipt: item?.artifactWriteReceipt || item?.receipt })),
  ].map(({ label, receipt }) => ({ label, verification: typeof artifactVerifier === 'function' ? artifactVerifier({ receipt }) : { status: 'artifact_write_receipt_source_blocked', blockers: ['artifact_source_verifier_required'] } }));
  for (const item of sourceReceipts) blockers.push(...(item.verification.blockers || []).map((blocker) => `experiment_${item.label}:${blocker}`));
  for (const item of outputArtifacts) {
    const expectedRole = expectedOutputRoles[item.name] || `experiment-output:${experiment.experimentId}:${experiment.runId}:${item.name}`;
    const expectedPath = expectedOutputPaths[item.name] || item.name;
    const original = (resultArtifact?.outputArtifacts || []).find((candidate) => String(candidate?.name || '') === item.name);
    const receipt = original?.artifactWriteReceipt || original?.receipt;
    if (receipt?.role !== expectedRole) blockers.push(`experiment_output_role_mismatch:${item.name}`);
    if (item.path !== expectedPath || pathBasename(item.path) !== pathBasename(expectedPath)) blockers.push(`experiment_output_path_mismatch:${item.name}`);
  }
  const expectedResultRole = `experiment-result:${experiment.experimentId}:${experiment.runId}`;
  if (resultWriteReceipt?.role !== expectedResultRole) blockers.push('experiment_result_artifact_role_mismatch');
  if (resultWriteReceipt?.path !== experiment.resultPath) blockers.push('experiment_result_artifact_path_mismatch');
  if (Array.isArray(reproducibilityReceipt?.outputArtifactHashes)) {
    const reproducibilityHashes = hashes(reproducibilityReceipt.outputArtifactHashes);
    if (reproducibilityHashes.length !== outputArtifactHashes.length || reproducibilityHashes.some((value, index) => value !== outputArtifactHashes[index])) blockers.push('experiment_reproducibility_output_hashes_mismatch');
  }
  const payload = {
    version: 1,
    kind: 'ExperimentEvidenceBinding',
    experimentId: experiment.experimentId || null,
    runId: experiment.runId || null,
    status: blockers.length ? 'experiment_evidence_binding_blocked' : 'experiment_evidence_binding_verified',
    acceptanceProfileId: experiment.acceptanceProfileId || null,
    deterministicSeed: experiment.seed ?? null,
    datasetHash: experiment.datasetHash || null,
    codeHash: experiment.codeHash || null,
    resultHash: experiment.resultHash || null,
    workerReceiptHash,
    resultArtifactHash,
    reproducibilityReceiptHash,
    executionContractHash: executionContract.experimentExecutionContractHash,
    datasetContractHash: executionContract.datasetContractHash,
    isolationPolicyHash: executionContract.isolationPolicyHash,
    metricPredicateContractHash: executionContract.metricPredicateContractHash,
    isolationReceiptHash: workerReceipt?.isolationReceiptHash || null,
    outputManifestHash: outputManifest.experimentOutputManifestHash,
    outputArtifactHashes,
    outputArtifacts,
    workerLedgerReceiptId: workerReceipt?.ledgerReceiptId || null,
    resultArtifactLedgerReceiptId: resultArtifact?.ledgerReceiptId || null,
    reproducibilityLedgerReceiptId: reproducibilityReceipt?.ledgerReceiptId || null,
    trustedLedgerReceiptsVerified: [workerLedger, resultLedger, reproducibilityLedger, ...outputLedgerVerifications].every((item) => item.status === 'trusted_ledger_receipt_verified'),
    artifactSourcesVerified: sourceReceipts.every((item) => item.verification.status === 'artifact_write_receipt_source_verified'),
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, experimentEvidenceBindingHash: hashRecord('ExperimentEvidenceBinding', payload) });
}

function pathBasename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '';
}
