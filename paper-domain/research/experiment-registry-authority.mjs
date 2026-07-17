import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyExperimentReplayReceipt, verifyExperimentRunReceipt } from '../automation/experiment-run-contract.mjs';
import { EXPERIMENT_REPLAY_ASSURANCE_SCOPE } from '../automation/experiment-environment-bom-binding.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';
import {
  empiricalClaimLineageMatches,
  empiricalProtocolBindings,
  expectedCampaignExperimentArtifactRole,
} from './campaign-experiment-claim-lineage.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const RECOMPUTATION_INDEPENDENCE_LEVEL = 'repository-separate-implementation-same-process-v1';

function recomputationIndependenceVerified(verification) {
  const contract = verification?.recomputationIndependenceContract || null;
  const { rawEventRecomputationIndependenceContractHash = null, ...payload } = contract || {};
  return verification?.implementationIndependent === true
    && verification?.recomputationIndependenceLevel === RECOMPUTATION_INDEPENDENCE_LEVEL
    && SHA256.test(String(rawEventRecomputationIndependenceContractHash || ''))
    && verification?.rawEventRecomputationIndependenceContractHash
      === rawEventRecomputationIndependenceContractHash
    && hashRecord('RawEventRecomputationIndependenceContract', payload)
      === rawEventRecomputationIndependenceContractHash
    && contract?.level === RECOMPUTATION_INDEPENDENCE_LEVEL
    && contract?.dataSourceIndependent === true
    && contract?.fixtureOracleBuilderIndependent === true
    && contract?.responseEventEvaluatorIndependent === true
    && contract?.eventMetricAggregatorIndependent === true
    && contract?.producerEvaluatorImportsAllowed === false
    && contract?.processIndependent === false;
}

function primitiveRecomputationVerified(verification, runReceipt, executionRole) {
  return verification?.status === 'independent_raw_event_recomputation_verified'
    && verification?.primitiveRecomputationStatus === 'raw_primitive_recomputation_verified'
    && verification?.dataSourceIndependent === true
    && recomputationIndependenceVerified(verification)
    && verification?.independentExecutionClaimed === false
    && verification?.executionRole === executionRole
    && verification?.promotionTcbImplementationHash === runReceipt?.systemBenchmarkHarnessImplementationHash
    && SHA256.test(String(verification?.rawPrimitiveRecomputationManifestHash || ''))
    && (runReceipt?.academicPromotionEligible !== true
      || SHA256.test(String(verification?.operatorDatasetAuthorityVerificationHash || '')));
}

function addPrefixed(blockers, prefix, values = []) {
  blockers.push(...values.map((item) => `${prefix}:${item}`));
}

function verifyOperatorDatasetAuthorityAtBoundary({ runReceipt, executionRole, verifier, blockers }) {
  if (runReceipt?.academicPromotionEligible !== true) return;
  const harnessReceipt = runReceipt?.harnessExecutionReceipt || null;
  const authorityReceipt = harnessReceipt?.operatorDatasetHarnessAuthority || null;
  const selector = harnessReceipt?.benchmarkSelector || null;
  const dataset = (harnessReceipt?.datasetAuthorizations || [])
    .find((candidate) => candidate?.name === authorityReceipt?.datasetName) || null;
  if (typeof verifier !== 'function') {
    blockers.push(`campaign_experiment_operator_dataset_authority_${executionRole}:trusted_verifier_required`);
    return;
  }
  let verification = null;
  try { verification = verifier(authorityReceipt, { dataset, selector }); }
  catch { verification = null; }
  const operatorAnalysisProtocolHash = selector?.experimentDesign?.analysisProtocolTemplateHash
    || runReceipt?.analysisProtocolHash;
  if (!verification || verification.verified !== true
    || verification.status !== 'operator_dataset_harness_authority_receipt_verified'
    || verification.operatorDatasetHarnessAuthorityReceiptHash !== authorityReceipt?.operatorDatasetHarnessAuthorityReceiptHash
    || verification.operatorDatasetAuthorityDocumentHash !== authorityReceipt?.operatorDatasetAuthorityDocumentHash
    || verification.analysisProtocolHash !== authorityReceipt?.analysisProtocolHash
    || verification.analysisProtocolHash !== operatorAnalysisProtocolHash) {
    const values = verification?.blockers?.length ? verification.blockers : ['trusted_verification_failed'];
    addPrefixed(blockers, `campaign_experiment_operator_dataset_authority_${executionRole}`, values);
  }
}

export function verifyCampaignExperimentEvidenceAuthority({
  experiment,
  receiptLedger = null,
  artifactVerifier = null,
  rawEventRecomputationVerifier = null,
  operatorDatasetHarnessAuthorityVerifier = null,
  expectedPaperId = null,
  expectedCampaignId = null,
} = {}) {
  const binding = experiment?.evidenceBinding || null;
  const evidence = binding?.authorityEvidence || null;
  const blockers = [];
  if (binding?.kind !== 'CampaignExperimentEvidenceBinding' || evidence?.kind !== 'CampaignExperimentEvidenceAuthorityEvidence') {
    blockers.push('campaign_experiment_authority_evidence_required');
  }
  const runReceipt = evidence?.experimentRunReceipt || null;
  const replayReceipt = evidence?.experimentReplayReceipt || null;
  const replayRunReceipt = replayReceipt?.replayRunReceipt || null;
  const workerReceipt = evidence?.workerReceipt || null;
  const replayWorkerReceipt = evidence?.replayWorkerReceipt || null;
  const reproducibilityLedgerReceipt = evidence?.reproducibilityLedgerReceipt || null;
  const originalRawReceipt = runReceipt?.rawArtifactWriteReceipt || null;
  const replayRawReceipt = replayRunReceipt?.rawArtifactWriteReceipt || null;
  if (!verifyExperimentRunReceipt(runReceipt)) blockers.push('campaign_experiment_run_receipt_invalid');
  if (!verifyExperimentReplayReceipt(replayReceipt)) blockers.push('campaign_experiment_replay_receipt_invalid');
  verifyOperatorDatasetAuthorityAtBoundary({
    runReceipt,
    executionRole: 'original',
    verifier: operatorDatasetHarnessAuthorityVerifier,
    blockers,
  });
  verifyOperatorDatasetAuthorityAtBoundary({
    runReceipt: replayRunReceipt,
    executionRole: 'independent_replay',
    verifier: operatorDatasetHarnessAuthorityVerifier,
    blockers,
  });
  if (replayReceipt?.originalExperimentRunReceiptHash !== runReceipt?.experimentRunReceiptHash) {
    blockers.push('campaign_experiment_replay_original_mismatch');
  }
  if (!runReceipt?.analysisProtocolHash || runReceipt.analysisProtocolHash !== replayRunReceipt?.analysisProtocolHash
    || replayReceipt?.analysisProtocolReplayBinding?.analysisProtocolHash !== runReceipt.analysisProtocolHash) {
    blockers.push('campaign_experiment_analysis_protocol_binding_invalid');
  }
  if (runReceipt?.academicPromotionEligible === true) {
    const empiricalClaimBindings = empiricalProtocolBindings(runReceipt);
    if (!empiricalClaimBindings.length
      || !empiricalClaimLineageMatches(workerReceipt, runReceipt, empiricalClaimBindings)
      || !empiricalClaimLineageMatches(replayWorkerReceipt, runReceipt, empiricalClaimBindings)
      || !empiricalClaimLineageMatches(reproducibilityLedgerReceipt, runReceipt, empiricalClaimBindings)
      || !empiricalClaimLineageMatches(binding, runReceipt, empiricalClaimBindings)
      || !empiricalClaimLineageMatches(experiment, runReceipt, empiricalClaimBindings)) {
      blockers.push('campaign_experiment_empirical_claim_lineage_invalid');
    }
  }
  if (runReceipt?.environmentBomHash !== replayReceipt?.originalEnvironmentBomHash
    || replayRunReceipt?.environmentBomHash !== replayReceipt?.replayEnvironmentBomHash
    || replayReceipt?.replayAssuranceScope !== EXPERIMENT_REPLAY_ASSURANCE_SCOPE) {
    blockers.push('campaign_experiment_environment_bom_binding_invalid');
  }
  const trusted = [
    verifyTrustedLedgerReceipt({
      receipt: workerReceipt, ledgerReceiptId: workerReceipt?.ledgerReceiptId, receiptLedger,
      expectedKinds: ['ExperimentWorkerExecutionReceipt'], expectedStatuses: ['worker_execution_completed'],
      expectedStreams: ['experiment-workers'], expectedWriterKinds: ['experiment-worker'],
      expectedPaperIds: [expectedPaperId].filter(Boolean),
    }),
    verifyTrustedLedgerReceipt({
      receipt: replayWorkerReceipt, ledgerReceiptId: replayWorkerReceipt?.ledgerReceiptId, receiptLedger,
      expectedKinds: ['ExperimentWorkerExecutionReceipt'], expectedStatuses: ['worker_execution_completed'],
      expectedStreams: ['experiment-workers'], expectedWriterKinds: ['experiment-worker'],
      expectedPaperIds: [expectedPaperId].filter(Boolean),
    }),
    verifyTrustedLedgerReceipt({
      receipt: reproducibilityLedgerReceipt, ledgerReceiptId: reproducibilityLedgerReceipt?.ledgerReceiptId, receiptLedger,
      expectedKinds: ['ExperimentReproducibilityReceipt'], expectedStatuses: ['experiment_reproducibility_verified'],
      expectedStreams: ['experiment-reproducibility'], expectedWriterKinds: ['experiment-reproducibility-verifier'],
      expectedPaperIds: [expectedPaperId].filter(Boolean),
    }),
  ];
  trusted.forEach((verification, index) => addPrefixed(blockers, `campaign_experiment_trusted_receipt_${index + 1}`, verification.blockers));
  const rawSources = [
    { role: 'original', receipt: originalRawReceipt, experimentRunReceipt: runReceipt },
    { role: 'independent-replay', receipt: replayRawReceipt, experimentRunReceipt: replayRunReceipt },
  ].map((source) => ({
    ...source,
    sourceVerification: typeof artifactVerifier === 'function'
      ? artifactVerifier({ receipt: source.receipt })
      : { status: 'artifact_write_receipt_source_blocked', blockers: ['artifact_source_verifier_required'] },
    ledgerVerification: verifyTrustedLedgerReceipt({
      receipt: source.receipt,
      ledgerReceiptId: source.receipt?.ledgerReceiptId,
      receiptLedger,
      expectedKinds: ['ArtifactWriteReceipt'],
      expectedStreams: ['artifact-writes'],
      expectedWriterKinds: ['content-addressed-repository'],
    }),
    recomputationVerification: typeof rawEventRecomputationVerifier === 'function'
      ? rawEventRecomputationVerifier({
        receipt: source.receipt,
        experimentRunReceipt: source.experimentRunReceipt,
        executionRole: source.role,
      })
      : {
        status: 'independent_raw_event_recomputation_blocked',
        blockers: ['independent_raw_event_recomputation_verifier_required'],
      },
  }));
  for (const source of rawSources) {
    addPrefixed(blockers, `campaign_experiment_${source.role}_raw_source`, source.sourceVerification?.blockers || []);
    addPrefixed(blockers, `campaign_experiment_${source.role}_raw_ledger`, source.ledgerVerification?.blockers || []);
    addPrefixed(blockers, `campaign_experiment_${source.role}_raw_recomputation`, source.recomputationVerification?.blockers || []);
    if (!primitiveRecomputationVerified(source.recomputationVerification, source.experimentRunReceipt, source.role)) {
      blockers.push(`campaign_experiment_${source.role}_raw_primitive_assurance_invalid`);
    }
  }
  const outputArtifacts = Array.isArray(binding?.outputArtifacts) ? binding.outputArtifacts : [];
  const expectedResultArtifacts = [
    ['results-json-original', 'results.json', 'original', runReceipt?.resultJsonHash, evidence?.originalCampaignNodeId, evidence?.originalCampaignNodeAttemptId],
    ['results-csv-original', 'results.csv', 'original', runReceipt?.resultCsvHash, evidence?.originalCampaignNodeId, evidence?.originalCampaignNodeAttemptId],
    ['results-json-independent-replay', 'results.json', 'independent-replay', replayRunReceipt?.resultJsonHash, evidence?.replayCampaignNodeId, evidence?.replayCampaignNodeAttemptId],
    ['results-csv-independent-replay', 'results.csv', 'independent-replay', replayRunReceipt?.resultCsvHash, evidence?.replayCampaignNodeId, evidence?.replayCampaignNodeAttemptId],
  ].map(([name, artifactName, executionRole, hash, nodeId, attemptId]) => ({
    name,
    path: artifactName,
    hash,
    executionRole,
    role: expectedCampaignExperimentArtifactRole({ paperId: expectedPaperId, campaignId: expectedCampaignId, nodeId, attemptId, executionRole, artifactName }),
  }));
  if (expectedResultArtifacts.some((expected) => {
    const observed = outputArtifacts.find((item) => item?.name === expected.name);
    return !observed || !SHA256.test(String(expected.hash || '')) || !expected.role
      || observed.path !== expected.path || observed.hash !== expected.hash
      || observed.executionRole !== expected.executionRole || observed.role !== expected.role;
  })) blockers.push('campaign_experiment_result_artifact_authority_binding_invalid');
  const originalOutput = outputArtifacts.find((item) => item?.name === 'raw-events-original');
  const replayOutput = outputArtifacts.find((item) => item?.name === 'raw-events-independent-replay');
  const outputMatchesReceipt = (output, receipt) => Boolean(output && receipt
    && output.path === receipt.path
    && output.hash === receipt.hash
    && output.role === receipt.role
    && Number.isSafeInteger(output.bytes) && Number.isSafeInteger(receipt.bytes)
    && output.bytes === receipt.bytes
    && output.artifactWriteReceiptHash === receipt.writeReceiptHash
    && output.ledgerReceiptId === receipt.ledgerReceiptId);
  if (!outputMatchesReceipt(originalOutput, originalRawReceipt)
    || !outputMatchesReceipt(replayOutput, replayRawReceipt)) {
    blockers.push('campaign_experiment_raw_artifact_summary_mismatch');
  }
  if (binding?.trustedLedgerReceiptsVerified !== trusted.every((item) => item.status === 'trusted_ledger_receipt_verified')
    || binding?.rawArtifactSourcesVerified !== rawSources.every((item) => item.sourceVerification?.status === 'artifact_write_receipt_source_verified')
    || binding?.rawArtifactLedgerReceiptsVerified !== rawSources.every((item) => item.ledgerVerification?.status === 'trusted_ledger_receipt_verified')
    || binding?.independentRawEventRecomputationVerified !== rawSources.every((item) =>
      item.recomputationVerification?.status === 'independent_raw_event_recomputation_verified')
    || binding?.primitiveRecomputationVerified !== rawSources.every((item) => primitiveRecomputationVerified(
      item.recomputationVerification,
      item.experimentRunReceipt,
      item.role,
    ))
    || binding?.independentRecomputationImplementationVerified !== rawSources.every((item) =>
      recomputationIndependenceVerified(item.recomputationVerification))
    || binding?.recomputationIndependenceLevel !== RECOMPUTATION_INDEPENDENCE_LEVEL
    || binding?.rawEventRecomputationIndependenceContractHash
      !== rawSources[0]?.recomputationVerification?.rawEventRecomputationIndependenceContractHash
    || binding?.rawEventRecomputationIndependenceContractHash
      !== rawSources[1]?.recomputationVerification?.rawEventRecomputationIndependenceContractHash
    || binding?.recomputationProcessIndependent !== false
    || binding?.originalRawEventRecomputationVerificationHash !== rawSources[0]?.recomputationVerification
      ?.independentRawEventArtifactRecomputationVerificationHash
    || binding?.replayRawEventRecomputationVerificationHash !== rawSources[1]?.recomputationVerification
      ?.independentRawEventArtifactRecomputationVerificationHash
    || binding?.originalRawPrimitiveRecomputationManifestHash !== rawSources[0]?.recomputationVerification
      ?.rawPrimitiveRecomputationManifestHash
    || binding?.replayRawPrimitiveRecomputationManifestHash !== rawSources[1]?.recomputationVerification
      ?.rawPrimitiveRecomputationManifestHash
    || binding?.originalOperatorDatasetAuthorityVerificationHash !== rawSources[0]?.recomputationVerification
      ?.operatorDatasetAuthorityVerificationHash
    || binding?.replayOperatorDatasetAuthorityVerificationHash !== rawSources[1]?.recomputationVerification
      ?.operatorDatasetAuthorityVerificationHash
    || binding?.promotionTcbImplementationHash !== runReceipt?.systemBenchmarkHarnessImplementationHash) {
    blockers.push('campaign_experiment_authority_verification_summary_mismatch');
  }
  if (!expectedPaperId || !expectedCampaignId
    || evidence?.paperId !== expectedPaperId || evidence?.campaignId !== expectedCampaignId
    || workerReceipt?.paperId !== expectedPaperId || replayWorkerReceipt?.paperId !== expectedPaperId
    || reproducibilityLedgerReceipt?.paperId !== expectedPaperId
    || workerReceipt?.campaignId !== expectedCampaignId || replayWorkerReceipt?.campaignId !== expectedCampaignId
    || reproducibilityLedgerReceipt?.campaignId !== expectedCampaignId) blockers.push('campaign_experiment_authority_context_mismatch');
  const originalRole = expectedCampaignExperimentArtifactRole({
    paperId: expectedPaperId, campaignId: expectedCampaignId,
    nodeId: evidence?.originalCampaignNodeId, attemptId: evidence?.originalCampaignNodeAttemptId,
    executionRole: 'original',
  });
  const replayRole = expectedCampaignExperimentArtifactRole({
    paperId: expectedPaperId, campaignId: expectedCampaignId,
    nodeId: evidence?.replayCampaignNodeId, attemptId: evidence?.replayCampaignNodeAttemptId,
    executionRole: 'independent-replay',
  });
  if (!originalRawReceipt || !replayRawReceipt
    || originalRawReceipt.role !== originalRole || replayRawReceipt.role !== replayRole
    || originalRawReceipt.hash !== runReceipt?.rawEventArtifactHash
    || originalRawReceipt.bytes !== runReceipt?.rawEventArtifactBytes
    || replayRawReceipt.hash !== replayRunReceipt?.rawEventArtifactHash
    || replayRawReceipt.bytes !== replayRunReceipt?.rawEventArtifactBytes
    || originalRawReceipt.writeReceiptHash === replayRawReceipt.writeReceiptHash
    || originalRawReceipt.ledgerReceiptId === replayRawReceipt.ledgerReceiptId
    || originalRawReceipt.role === replayRawReceipt.role) blockers.push('campaign_experiment_raw_artifact_authority_binding_invalid');
  if (workerReceipt?.experimentRunReceiptHash !== runReceipt?.experimentRunReceiptHash
    || workerReceipt?.campaignNodeId !== evidence?.originalCampaignNodeId
    || workerReceipt?.campaignNodeAttemptId !== evidence?.originalCampaignNodeAttemptId
    || workerReceipt?.campaignNodeLeaseGeneration !== evidence?.originalCampaignNodeLeaseGeneration
    || workerReceipt?.campaignNodeResultHash !== evidence?.originalCampaignNodeResultHash
    || workerReceipt?.sourceLineageHash !== evidence?.sourceLineageHash
    || workerReceipt?.rawArtifactWriteReceiptHash !== originalRawReceipt?.writeReceiptHash
    || workerReceipt?.rawArtifactLedgerReceiptId !== originalRawReceipt?.ledgerReceiptId
    || workerReceipt?.rawArtifactRole !== originalRole) blockers.push('campaign_experiment_original_store_binding_invalid');
  if (replayWorkerReceipt?.experimentRunReceiptHash !== replayReceipt?.replayExperimentRunReceiptHash
    || replayWorkerReceipt?.campaignNodeId !== evidence?.replayCampaignNodeId
    || replayWorkerReceipt?.campaignNodeAttemptId !== evidence?.replayCampaignNodeAttemptId
    || replayWorkerReceipt?.campaignNodeLeaseGeneration !== evidence?.replayCampaignNodeLeaseGeneration
    || replayWorkerReceipt?.campaignNodeResultHash !== evidence?.replayCampaignNodeResultHash
    || replayWorkerReceipt?.sourceLineageHash !== evidence?.sourceLineageHash
    || replayWorkerReceipt?.rawArtifactWriteReceiptHash !== replayRawReceipt?.writeReceiptHash
    || replayWorkerReceipt?.rawArtifactLedgerReceiptId !== replayRawReceipt?.ledgerReceiptId
    || replayWorkerReceipt?.rawArtifactRole !== replayRole) blockers.push('campaign_experiment_replay_store_binding_invalid');
  if (reproducibilityLedgerReceipt?.workerReceiptHash !== workerReceipt?.receiptHash
    || reproducibilityLedgerReceipt?.replayWorkerReceiptHash !== replayWorkerReceipt?.receiptHash
    || reproducibilityLedgerReceipt?.experimentReplayReceiptHash !== replayReceipt?.experimentReplayReceiptHash
    || reproducibilityLedgerReceipt?.sourceLineageHash !== evidence?.sourceLineageHash
    || reproducibilityLedgerReceipt?.originalCampaignNodeResultHash !== evidence?.originalCampaignNodeResultHash
    || reproducibilityLedgerReceipt?.replayCampaignNodeResultHash !== evidence?.replayCampaignNodeResultHash
    || reproducibilityLedgerReceipt?.originalRawArtifactWriteReceiptHash !== originalRawReceipt?.writeReceiptHash
    || reproducibilityLedgerReceipt?.originalRawArtifactLedgerReceiptId !== originalRawReceipt?.ledgerReceiptId
    || reproducibilityLedgerReceipt?.replayRawArtifactWriteReceiptHash !== replayRawReceipt?.writeReceiptHash
    || reproducibilityLedgerReceipt?.replayRawArtifactLedgerReceiptId !== replayRawReceipt?.ledgerReceiptId) {
    blockers.push('campaign_experiment_reproducibility_authority_binding_invalid');
  }
  for (const field of ['assuranceProfile', 'assuranceScope', 'evidenceClass', 'promotionScope', 'academicPromotionEligible']) {
    if (workerReceipt?.[field] !== runReceipt?.[field]
      || replayWorkerReceipt?.[field] !== replayRunReceipt?.[field]
      || reproducibilityLedgerReceipt?.[field] !== runReceipt?.[field]
      || runReceipt?.[field] !== replayRunReceipt?.[field]
      || binding?.[field === 'assuranceProfile' ? 'executionAssuranceProfile' : field] !== runReceipt?.[field]
      || experiment?.[field] !== runReceipt?.[field]) blockers.push(`campaign_experiment_assurance_binding_invalid:${field}`);
  }
  if (binding?.experimentRunReceiptHash !== runReceipt?.experimentRunReceiptHash
    || binding?.experimentReplayReceiptHash !== replayReceipt?.experimentReplayReceiptHash
    || binding?.workerReceiptHash !== workerReceipt?.receiptHash
    || binding?.replayWorkerReceiptHash !== replayWorkerReceipt?.receiptHash
    || binding?.reproducibilityLedgerReceiptHash !== reproducibilityLedgerReceipt?.receiptHash
    || binding?.originalCampaignNodeResultHash !== evidence?.originalCampaignNodeResultHash
    || binding?.replayCampaignNodeResultHash !== evidence?.replayCampaignNodeResultHash
    || binding?.sourceLineageHash !== evidence?.sourceLineageHash
    || binding?.analysisProtocolHash !== runReceipt?.analysisProtocolHash
    || binding?.originalAnalysisEvaluationHash !== runReceipt?.analysisProtocolEvaluation?.academicAnalysisProtocolEvaluationHash
    || binding?.replayAnalysisEvaluationHash !== replayRunReceipt?.analysisProtocolEvaluation?.academicAnalysisProtocolEvaluationHash
    || binding?.analysisProtocolReplayBindingHash
      !== replayReceipt?.analysisProtocolReplayBinding?.academicAnalysisProtocolReplayBindingHash
    || binding?.originalEnvironmentBomHash !== replayReceipt?.originalEnvironmentBomHash
    || binding?.replayEnvironmentBomHash !== replayReceipt?.replayEnvironmentBomHash
    || binding?.replayAssuranceScope !== EXPERIMENT_REPLAY_ASSURANCE_SCOPE) {
    blockers.push('campaign_experiment_authority_summary_mismatch');
  }
  const uniqueBlockers = [...new Set(blockers)];
  return Object.freeze({
    status: uniqueBlockers.length ? 'experiment_registry_authority_blocked' : 'experiment_registry_authority_verified',
    verified: uniqueBlockers.length === 0,
    experimentId: experiment?.experimentId || null,
    experimentEvidenceBindingHash: binding?.experimentEvidenceBindingHash || null,
    blockers: uniqueBlockers,
  });
}

export function createExperimentRegistryAuthorityVerifier({
  receiptLedger = null,
  artifactVerifier = null,
  rawEventRecomputationVerifier = null,
  operatorDatasetHarnessAuthorityVerifier = null,
  expectedCampaignId = null,
} = {}) {
  return (experiment, { expectedPaperId = null, campaignId = expectedCampaignId } = {}) =>
    verifyCampaignExperimentEvidenceAuthority({
      experiment,
      receiptLedger,
      artifactVerifier,
      rawEventRecomputationVerifier,
      operatorDatasetHarnessAuthorityVerifier,
      expectedPaperId,
      expectedCampaignId: campaignId || null,
    });
}
