import fs from 'node:fs/promises';
import path from 'node:path';
import { buildExperimentExecutionContract, buildExperimentOutputManifest } from '../../paper-domain/research/experiment-evidence-binding.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const OUTPUTS = Object.freeze([
  'results/empirical_results.csv',
  'results/EMPIRICAL_EVIDENCE_MANIFEST.json',
  'results/REPRODUCIBILITY_STATUS.md',
  'tables/table_empirical_summary.tex',
  'figures/figure_spec.json',
]);

export async function produceTrustedExperimentEvidence({ paperTask, runDir, codeHash, datasetContract, sandboxReceipt, artifactRepository, receiptWriters, seed, clock } = {}) {
  if (!artifactRepository || !receiptWriters?.experimentWorker || !receiptWriters?.experimentReproducibility || !clock) {
    return Object.freeze({ status: 'trusted_experiment_evidence_blocked', blockers: ['trusted_experiment_services_missing'] });
  }
  if (!sandboxReceipt?.ok || sandboxReceipt?.isolation?.kernelNetworkIsolationVerified !== true) {
    return Object.freeze({ status: 'trusted_experiment_evidence_blocked', blockers: ['kernel_sandbox_execution_not_verified'] });
  }
  const experimentId = `empirical:${paperTask.paperId}`;
  const runId = sandboxReceipt.receiptHash;
  const resultPath = 'results/empirical_summary.json';
  const resultReceipt = await artifactRepository.writeBytes(path.join(runDir, resultPath), await fs.readFile(path.join(runDir, resultPath)), { role: `experiment-result:${experimentId}:${runId}`, atomic: true });
  const outputArtifacts = [];
  for (const name of OUTPUTS) {
    const receipt = await artifactRepository.writeBytes(path.join(runDir, name), await fs.readFile(path.join(runDir, name)), { role: `experiment-output:${experimentId}:${runId}:${name}`, atomic: true });
    outputArtifacts.push(Object.freeze({ name, artifactWriteReceipt: receipt, ledgerReceiptId: receipt.ledgerReceiptId }));
  }
  const generatedManifest = outputArtifacts.find((item) => item.name === 'results/EMPIRICAL_EVIDENCE_MANIFEST.json')?.artifactWriteReceipt;
  const datasetHash = datasetContract?.primaryDataset?.hash || generatedManifest?.hash || resultReceipt.hash;
  const datasetManifestHash = datasetContract?.primaryDataset?.hash || generatedManifest?.manifestHash || resultReceipt.manifestHash;
  const datasetLicenseId = datasetContract?.datasetMode === 'authorized_local_dataset' ? 'operator_authorized_local_data' : 'local_generated_no_external_data';
  const datasetMounts = (sandboxReceipt.datasetMounts || []).map((mount) => ({ name: mount.name, manifestHash: mount.manifestHash, licenseId: mount.licenseId, readOnly: true }));
  const metricPredicates = [
    { metric: 'local_execution', comparator: '==', threshold: 1 },
    { metric: 'source_mutation_performed', comparator: '==', threshold: 0 },
    { metric: 'external_action_performed', comparator: '==', threshold: 0 },
  ];
  const acceptanceContract = { deterministicSeedRequired: true, promotionAllowed: false, requiredOutputs: OUTPUTS, metricPredicates };
  const experiment = {
    kind: 'experiment', experimentId, runId, claimIds: [], seed,
    datasetHash, datasetManifestHash, datasetLicenseId, datasetReadOnly: true, datasetMounts,
    networkPolicy: 'none', secretsAllowed: false, externalActionsAllowed: false, providerCallsAllowed: false, sourceMutationAllowed: false,
    sourceReadOnlyRequired: true, ephemeralWorkRootRequired: true, separateOutputRootRequired: true,
    codeHash, resultHash: resultReceipt.hash, resultPath,
    metrics: { local_execution: 1, source_mutation_performed: 0, external_action_performed: 0 },
    metricPredicates, resultClass: 'unclassified', promotionRequested: false, acceptanceContract,
  };
  const expectedRoles = Object.fromEntries(OUTPUTS.map((name) => [name, `experiment-output:${experimentId}:${runId}:${name}`]));
  const expectedPaths = Object.fromEntries(OUTPUTS.map((name) => [name, name]));
  const executionContract = buildExperimentExecutionContract({ experiment, requiredOutputs: OUTPUTS, expectedOutputRoles: expectedRoles, expectedOutputPaths: expectedPaths });
  const outputManifest = buildExperimentOutputManifest({ experimentId, runId, outputArtifacts: outputArtifacts.map((item) => ({ name: item.name, path: item.artifactWriteReceipt.path, hash: item.artifactWriteReceipt.hash, manifestHash: item.artifactWriteReceipt.manifestHash, writeReceiptHash: item.artifactWriteReceipt.writeReceiptHash })) });
  const workerPayload = {
    version: 1, kind: 'ExperimentWorkerExecutionReceipt', status: 'worker_execution_completed', experimentId, runId,
    datasetHash, codeHash, resultHash: resultReceipt.hash, seed,
    executionContractHash: executionContract.experimentExecutionContractHash,
    datasetContractHash: executionContract.datasetContractHash,
    isolationPolicyHash: executionContract.isolationPolicyHash,
    metricPredicateContractHash: executionContract.metricPredicateContractHash,
    isolationReceiptHash: sandboxReceipt.receiptHash, networkPolicy: 'none', secretAccessPerformed: false,
    externalActionPerformed: false, providerCallPerformed: false, sourceMutationDetected: false,
    sourceMerkleHashBefore: sandboxReceipt.sourceMerkleHashBefore, sourceMerkleHashAfter: sandboxReceipt.sourceMerkleHashAfter,
    isolation: sandboxReceipt.isolation, datasetMounts, outputManifestHash: outputManifest.experimentOutputManifestHash,
    resultArtifactWriteReceiptHash: resultReceipt.writeReceiptHash, createdAt: clock.nowIso(),
  };
  const workerReceiptHash = hashRecord('ExperimentWorkerExecutionReceipt', workerPayload);
  const workerLedger = receiptWriters.experimentWorker.record({ ...workerPayload, receiptHash: workerReceiptHash }, { stream: 'experiment-workers', strictInsert: true });
  const workerReceipt = Object.freeze({ ...workerPayload, receiptHash: workerReceiptHash, ledgerReceiptId: workerLedger.receiptId });
  const outputArtifactHashes = [...new Set(outputArtifacts.map((item) => item.artifactWriteReceipt.hash))].sort();
  const reproducibilityPayload = {
    version: 1, kind: 'ExperimentReproducibilityReceipt', status: 'experiment_reproducibility_verified', experimentId, runId, seed,
    workerReceiptHash, resultHash: resultReceipt.hash, outputArtifactHashes,
    executionContractHash: executionContract.experimentExecutionContractHash,
    datasetContractHash: executionContract.datasetContractHash,
    isolationPolicyHash: executionContract.isolationPolicyHash,
    metricPredicateContractHash: executionContract.metricPredicateContractHash,
    isolationReceiptHash: sandboxReceipt.receiptHash, outputManifestHash: outputManifest.experimentOutputManifestHash, createdAt: clock.nowIso(),
  };
  const reproducibilityReceiptHash = hashRecord('ExperimentReproducibilityReceipt', reproducibilityPayload);
  const reproducibilityLedger = receiptWriters.experimentReproducibility.record({ ...reproducibilityPayload, receiptHash: reproducibilityReceiptHash }, { stream: 'experiment-reproducibility', strictInsert: true });
  const reproducibilityReceipt = Object.freeze({ ...reproducibilityPayload, receiptHash: reproducibilityReceiptHash, ledgerReceiptId: reproducibilityLedger.receiptId });
  const artifact = Object.freeze({ ...experiment, workerReceipt, resultArtifact: Object.freeze({ artifactWriteReceipt: resultReceipt, ledgerReceiptId: resultReceipt.ledgerReceiptId, outputArtifacts }), reproducibilityReceipt });
  const evidence = Object.freeze({ version: 1, kind: 'TrustedExperimentEvidence', status: 'trusted_experiment_evidence_recorded', experiments: [artifact], createdAt: clock.nowIso() });
  const evidenceReceipt = await artifactRepository.writeJson(path.join(runDir, 'results', 'TRUSTED_EXPERIMENT_EVIDENCE.json'), evidence, { role: `trusted-experiment-evidence:${experimentId}:${runId}`, atomic: true });
  return Object.freeze({ ...evidence, evidenceReceipt });
}
