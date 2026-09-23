import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateExperimentAcceptance } from './experiment-acceptance-policy.mjs';
import { buildExperimentAcceptanceContract, experimentAcceptanceProfile } from './experiment-profiles.mjs';
import { buildExperimentEvidenceBinding } from './experiment-evidence-binding.mjs';
import { verifyExperimentReplayReceipt, verifyExperimentRunReceipt } from '../automation/experiment-run-contract.mjs';
import { EXPERIMENT_REPLAY_ASSURANCE_SCOPE } from '../automation/experiment-environment-bom-binding.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';
import { deriveExperimentRegistrySummary } from './experiment-registry-verifier.mjs';
import { createExperimentRegistryAuthorityVerifier } from './experiment-registry-authority.mjs';
import {
  empiricalClaimLineageMatches,
  empiricalProtocolBindings,
  expectedCampaignExperimentArtifactRole,
} from './campaign-experiment-claim-lineage.mjs';

const RECOMPUTATION_INDEPENDENCE_LEVEL = 'repository-separate-implementation-same-process-v1';
const RECOMPUTATION_ASSURANCE_PROFILE =
  'system-harness-store-cas-separate-recomputation-plus-trusted-ledger-v6';

function recomputationIndependenceVerified(verification) {
  const contract = verification?.recomputationIndependenceContract || null;
  const { rawEventRecomputationIndependenceContractHash = null, ...payload } = contract || {};
  return verification?.implementationIndependent === true
    && verification?.recomputationIndependenceLevel === RECOMPUTATION_INDEPENDENCE_LEVEL
    && /^sha256:[0-9a-f]{64}$/i.test(String(rawEventRecomputationIndependenceContractHash || ''))
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
    && /^sha256:[0-9a-f]{64}$/i.test(String(verification?.rawPrimitiveRecomputationManifestHash || ''))
    && (runReceipt?.academicPromotionEligible !== true
      || /^sha256:[0-9a-f]{64}$/i.test(String(verification?.operatorDatasetAuthorityVerificationHash || '')));
}

function buildCampaignExperimentEvidenceBinding(artifact, receiptLedger, {
  expectedPaperId = null,
  expectedCampaignId = null,
  artifactVerifier = null,
  rawEventRecomputationVerifier = null,
} = {}) {
  const runReceipt = artifact.experimentRunReceipt || null;
  const replayReceipt = artifact.reproducibilityReceipt || artifact.experimentReplayReceipt || null;
  const workerReceipt = artifact.workerReceipt || null;
  const replayWorkerReceipt = artifact.replayWorkerReceipt || null;
  const reproducibilityLedgerReceipt = artifact.reproducibilityLedgerReceipt || null;
  const originalRawArtifactWriteReceipt = runReceipt?.rawArtifactWriteReceipt || null;
  const replayRunReceipt = replayReceipt?.replayRunReceipt || null;
  const replayRawArtifactWriteReceipt = replayRunReceipt?.rawArtifactWriteReceipt || null;
  const resultArtifacts = [
    ['results-json-original', 'results.json', 'original', runReceipt?.resultJsonHash, artifact.originalCampaignNodeId, artifact.originalCampaignNodeAttemptId],
    ['results-csv-original', 'results.csv', 'original', runReceipt?.resultCsvHash, artifact.originalCampaignNodeId, artifact.originalCampaignNodeAttemptId],
    ['results-json-independent-replay', 'results.json', 'independent-replay', replayRunReceipt?.resultJsonHash, artifact.campaignNodeId, artifact.campaignNodeAttemptId],
    ['results-csv-independent-replay', 'results.csv', 'independent-replay', replayRunReceipt?.resultCsvHash, artifact.campaignNodeId, artifact.campaignNodeAttemptId],
  ].map(([name, path, executionRole, hash, nodeId, attemptId]) => ({
    name, path, hash, executionRole,
    role: expectedCampaignExperimentArtifactRole({ paperId: expectedPaperId, campaignId: expectedCampaignId, nodeId, attemptId, executionRole, artifactName: path }),
  }));
  const blockers = [];
  if (!verifyExperimentRunReceipt(runReceipt)) blockers.push('campaign_experiment_run_receipt_invalid');
  if (!verifyExperimentReplayReceipt(replayReceipt)) blockers.push('campaign_experiment_replay_receipt_invalid');
  if (replayReceipt?.originalExperimentRunReceiptHash !== runReceipt?.experimentRunReceiptHash) blockers.push('campaign_experiment_replay_original_mismatch');
  if (!runReceipt?.analysisProtocolHash || runReceipt.analysisProtocolHash !== replayRunReceipt?.analysisProtocolHash
    || replayReceipt?.analysisProtocolReplayBinding?.analysisProtocolHash !== runReceipt.analysisProtocolHash) {
    blockers.push('campaign_experiment_analysis_protocol_binding_invalid');
  }
  const empiricalClaimBindings = empiricalProtocolBindings(runReceipt);
  if (runReceipt?.academicPromotionEligible === true && !empiricalClaimBindings.length) {
    blockers.push('campaign_experiment_empirical_claim_authority_missing');
  }
  if (runReceipt?.academicPromotionEligible === true && (
    !empiricalClaimLineageMatches(workerReceipt, runReceipt, empiricalClaimBindings)
    || !empiricalClaimLineageMatches(replayWorkerReceipt, runReceipt, empiricalClaimBindings)
    || !empiricalClaimLineageMatches(reproducibilityLedgerReceipt, runReceipt, empiricalClaimBindings)
  )) blockers.push('campaign_experiment_empirical_claim_lineage_invalid');
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
  trusted.forEach((verification, index) => blockers.push(...verification.blockers.map((item) => `campaign_experiment_trusted_receipt_${index + 1}:${item}`)));
  const rawArtifactSources = [
    { executionRole: 'original', receipt: originalRawArtifactWriteReceipt, experimentRunReceipt: runReceipt },
    { executionRole: 'independent-replay', receipt: replayRawArtifactWriteReceipt, experimentRunReceipt: replayRunReceipt },
  ].map(({ executionRole, receipt, experimentRunReceipt }) => ({
    executionRole,
    receipt,
    experimentRunReceipt,
    verification: typeof artifactVerifier === 'function'
      ? artifactVerifier({ receipt })
      : { status: 'artifact_write_receipt_source_blocked', blockers: ['artifact_source_verifier_required'] },
    ledgerVerification: verifyTrustedLedgerReceipt({
      receipt,
      ledgerReceiptId: receipt?.ledgerReceiptId,
      receiptLedger,
      expectedKinds: ['ArtifactWriteReceipt'],
      expectedStreams: ['artifact-writes'],
      expectedWriterKinds: ['content-addressed-repository'],
    }),
    recomputationVerification: typeof rawEventRecomputationVerifier === 'function'
      ? rawEventRecomputationVerifier({ receipt, experimentRunReceipt, executionRole })
      : {
        status: 'independent_raw_event_recomputation_blocked',
        blockers: ['independent_raw_event_recomputation_verifier_required'],
      },
  }));
  for (const source of rawArtifactSources) {
    blockers.push(...(source.verification?.blockers || []).map((item) => `campaign_experiment_${source.executionRole}_raw_source:${item}`));
    blockers.push(...(source.ledgerVerification?.blockers || []).map((item) => `campaign_experiment_${source.executionRole}_raw_ledger:${item}`));
    blockers.push(...(source.recomputationVerification?.blockers || [])
      .map((item) => `campaign_experiment_${source.executionRole}_raw_recomputation:${item}`));
    if (!primitiveRecomputationVerified(
      source.recomputationVerification,
      source.experimentRunReceipt,
      source.executionRole,
    )) blockers.push(`campaign_experiment_${source.executionRole}_raw_primitive_assurance_invalid`);
  }
  if (!expectedPaperId || !expectedCampaignId
    || artifact.paperId !== expectedPaperId || artifact.campaignId !== expectedCampaignId
    || workerReceipt?.paperId !== expectedPaperId || replayWorkerReceipt?.paperId !== expectedPaperId
    || reproducibilityLedgerReceipt?.paperId !== expectedPaperId
    || workerReceipt?.campaignId !== expectedCampaignId || replayWorkerReceipt?.campaignId !== expectedCampaignId
    || reproducibilityLedgerReceipt?.campaignId !== expectedCampaignId) blockers.push('campaign_experiment_authority_context_mismatch');
  const expectedOriginalRawRole = expectedCampaignExperimentArtifactRole({
    paperId: expectedPaperId,
    campaignId: expectedCampaignId,
    nodeId: artifact.originalCampaignNodeId,
    attemptId: artifact.originalCampaignNodeAttemptId,
    executionRole: 'original',
  });
  const expectedReplayRawRole = expectedCampaignExperimentArtifactRole({
    paperId: expectedPaperId,
    campaignId: expectedCampaignId,
    nodeId: artifact.campaignNodeId,
    attemptId: artifact.campaignNodeAttemptId,
    executionRole: 'independent-replay',
  });
  if (!originalRawArtifactWriteReceipt || !replayRawArtifactWriteReceipt
    || originalRawArtifactWriteReceipt.role !== expectedOriginalRawRole
    || replayRawArtifactWriteReceipt.role !== expectedReplayRawRole
    || originalRawArtifactWriteReceipt.hash !== runReceipt?.rawEventArtifactHash
    || originalRawArtifactWriteReceipt.bytes !== runReceipt?.rawEventArtifactBytes
    || replayRawArtifactWriteReceipt.hash !== replayRunReceipt?.rawEventArtifactHash
    || replayRawArtifactWriteReceipt.bytes !== replayRunReceipt?.rawEventArtifactBytes
    || originalRawArtifactWriteReceipt.writeReceiptHash === replayRawArtifactWriteReceipt.writeReceiptHash
    || originalRawArtifactWriteReceipt.ledgerReceiptId === replayRawArtifactWriteReceipt.ledgerReceiptId
    || originalRawArtifactWriteReceipt.role === replayRawArtifactWriteReceipt.role) {
    blockers.push('campaign_experiment_raw_artifact_authority_binding_invalid');
  }
  if (workerReceipt?.experimentRunReceiptHash !== runReceipt?.experimentRunReceiptHash
    || workerReceipt?.campaignNodeId !== artifact.originalCampaignNodeId
    || workerReceipt?.campaignNodeAttemptId !== artifact.originalCampaignNodeAttemptId
    || workerReceipt?.campaignNodeLeaseGeneration !== artifact.originalCampaignNodeLeaseGeneration
    || workerReceipt?.campaignNodeResultHash !== artifact.originalCampaignNodeResultHash
    || workerReceipt?.sourceLineageHash !== artifact.sourceLineageHash
    || workerReceipt?.rawArtifactWriteReceiptHash !== originalRawArtifactWriteReceipt?.writeReceiptHash
    || workerReceipt?.rawArtifactLedgerReceiptId !== originalRawArtifactWriteReceipt?.ledgerReceiptId
    || workerReceipt?.rawArtifactRole !== expectedOriginalRawRole) blockers.push('campaign_experiment_original_store_binding_invalid');
  if (replayWorkerReceipt?.experimentRunReceiptHash !== replayReceipt?.replayExperimentRunReceiptHash
    || replayWorkerReceipt?.campaignNodeId !== artifact.campaignNodeId
    || replayWorkerReceipt?.campaignNodeAttemptId !== artifact.campaignNodeAttemptId
    || replayWorkerReceipt?.campaignNodeLeaseGeneration !== artifact.campaignNodeLeaseGeneration
    || replayWorkerReceipt?.campaignNodeResultHash !== artifact.campaignNodeResultHash
    || replayWorkerReceipt?.sourceLineageHash !== artifact.sourceLineageHash
    || replayWorkerReceipt?.rawArtifactWriteReceiptHash !== replayRawArtifactWriteReceipt?.writeReceiptHash
    || replayWorkerReceipt?.rawArtifactLedgerReceiptId !== replayRawArtifactWriteReceipt?.ledgerReceiptId
    || replayWorkerReceipt?.rawArtifactRole !== expectedReplayRawRole) blockers.push('campaign_experiment_replay_store_binding_invalid');
  if (reproducibilityLedgerReceipt?.workerReceiptHash !== workerReceipt?.receiptHash
    || reproducibilityLedgerReceipt?.replayWorkerReceiptHash !== replayWorkerReceipt?.receiptHash
    || reproducibilityLedgerReceipt?.experimentReplayReceiptHash !== replayReceipt?.experimentReplayReceiptHash
    || reproducibilityLedgerReceipt?.sourceLineageHash !== artifact.sourceLineageHash
    || reproducibilityLedgerReceipt?.originalCampaignNodeResultHash !== artifact.originalCampaignNodeResultHash
    || reproducibilityLedgerReceipt?.replayCampaignNodeResultHash !== artifact.campaignNodeResultHash
    || reproducibilityLedgerReceipt?.originalRawArtifactWriteReceiptHash !== originalRawArtifactWriteReceipt?.writeReceiptHash
    || reproducibilityLedgerReceipt?.originalRawArtifactLedgerReceiptId !== originalRawArtifactWriteReceipt?.ledgerReceiptId
    || reproducibilityLedgerReceipt?.replayRawArtifactWriteReceiptHash !== replayRawArtifactWriteReceipt?.writeReceiptHash
    || reproducibilityLedgerReceipt?.replayRawArtifactLedgerReceiptId !== replayRawArtifactWriteReceipt?.ledgerReceiptId) blockers.push('campaign_experiment_reproducibility_authority_binding_invalid');
  for (const field of ['assuranceProfile', 'assuranceScope', 'evidenceClass', 'promotionScope', 'academicPromotionEligible']) {
    if (workerReceipt?.[field] !== runReceipt?.[field]
      || replayWorkerReceipt?.[field] !== replayRunReceipt?.[field]
      || reproducibilityLedgerReceipt?.[field] !== runReceipt?.[field]
      || runReceipt?.[field] !== replayRunReceipt?.[field]) blockers.push(`campaign_experiment_assurance_binding_invalid:${field}`);
  }
  const payload = {
    version: 8,
    kind: 'CampaignExperimentEvidenceBinding',
    status: blockers.length ? 'experiment_evidence_binding_blocked' : 'experiment_evidence_binding_verified',
    experimentId: artifact.experimentId || artifact.experiment_id || artifact.id || runReceipt?.benchmarkId || null,
    experimentRunReceiptHash: runReceipt?.experimentRunReceiptHash || null,
    experimentReplayReceiptHash: replayReceipt?.experimentReplayReceiptHash || null,
    analysisProtocolHash: runReceipt?.analysisProtocolHash || null,
    originalAnalysisEvaluationHash: runReceipt?.analysisProtocolEvaluation?.academicAnalysisProtocolEvaluationHash || null,
    replayAnalysisEvaluationHash: replayRunReceipt?.analysisProtocolEvaluation?.academicAnalysisProtocolEvaluationHash || null,
    analysisProtocolReplayBindingHash: replayReceipt?.analysisProtocolReplayBinding?.academicAnalysisProtocolReplayBindingHash || null,
    empiricalClaimUniverseHash: runReceipt?.analysisProtocol?.empiricalClaimUniverseHash || null,
    manuscriptCorpusHash: runReceipt?.analysisProtocol?.manuscriptCorpusHash || null,
    claimIds: empiricalClaimBindings.map((binding) => binding.claimId),
    empiricalClaimBindings,
    originalEnvironmentBomHash: replayReceipt?.originalEnvironmentBomHash || null,
    replayEnvironmentBomHash: replayReceipt?.replayEnvironmentBomHash || null,
    replayAssuranceScope: replayReceipt?.replayAssuranceScope || null,
    runnerReceiptHash: runReceipt?.executionReceiptHash || null,
    replayRunnerReceiptHash: replayReceipt?.replayExecutionReceiptHash || null,
    outputArtifacts: [
      { name: 'results.json', path: 'results.json', hash: runReceipt?.resultJsonHash || null },
      { name: 'results.csv', path: 'results.csv', hash: runReceipt?.resultCsvHash || null },
      ...resultArtifacts,
      { name: 'raw-observation-manifest', path: 'embedded:observations', hash: runReceipt?.observationManifestHash || null },
      { name: 'raw-events-original', path: originalRawArtifactWriteReceipt?.path || null, hash: originalRawArtifactWriteReceipt?.hash || null,
        role: originalRawArtifactWriteReceipt?.role || null, bytes: originalRawArtifactWriteReceipt?.bytes || null,
        artifactWriteReceiptHash: originalRawArtifactWriteReceipt?.writeReceiptHash || null,
        ledgerReceiptId: originalRawArtifactWriteReceipt?.ledgerReceiptId || null },
      { name: 'raw-events-independent-replay', path: replayRawArtifactWriteReceipt?.path || null, hash: replayRawArtifactWriteReceipt?.hash || null,
        role: replayRawArtifactWriteReceipt?.role || null, bytes: replayRawArtifactWriteReceipt?.bytes || null,
        artifactWriteReceiptHash: replayRawArtifactWriteReceipt?.writeReceiptHash || null,
        ledgerReceiptId: replayRawArtifactWriteReceipt?.ledgerReceiptId || null },
    ],
    workerReceiptHash: workerReceipt?.receiptHash || null,
    replayWorkerReceiptHash: replayWorkerReceipt?.receiptHash || null,
    reproducibilityLedgerReceiptHash: reproducibilityLedgerReceipt?.receiptHash || null,
    originalCampaignNodeResultHash: artifact.originalCampaignNodeResultHash || null,
    replayCampaignNodeResultHash: artifact.campaignNodeResultHash || null,
    sourceLineageHash: artifact.sourceLineageHash || null,
    trustedLedgerReceiptsVerified: trusted.every((item) => item.status === 'trusted_ledger_receipt_verified'),
    rawArtifactSourcesVerified: rawArtifactSources.every((item) => item.verification?.status === 'artifact_write_receipt_source_verified'),
    rawArtifactLedgerReceiptsVerified: rawArtifactSources.every((item) => item.ledgerVerification?.status === 'trusted_ledger_receipt_verified'),
    independentRawEventRecomputationVerified: rawArtifactSources.every((item) =>
      item.recomputationVerification?.status === 'independent_raw_event_recomputation_verified'),
    primitiveRecomputationVerified: rawArtifactSources.every((item) => primitiveRecomputationVerified(
      item.recomputationVerification,
      item.experimentRunReceipt,
      item.executionRole,
    )),
    independentRecomputationImplementationVerified: rawArtifactSources.every((item) =>
      recomputationIndependenceVerified(item.recomputationVerification)),
    recomputationIndependenceLevel: rawArtifactSources.every((item) =>
      item.recomputationVerification?.recomputationIndependenceLevel === RECOMPUTATION_INDEPENDENCE_LEVEL)
      ? RECOMPUTATION_INDEPENDENCE_LEVEL : null,
    rawEventRecomputationIndependenceContractHash: rawArtifactSources.every((item) =>
      item.recomputationVerification?.rawEventRecomputationIndependenceContractHash
        === rawArtifactSources[0]?.recomputationVerification?.rawEventRecomputationIndependenceContractHash)
      ? rawArtifactSources[0]?.recomputationVerification?.rawEventRecomputationIndependenceContractHash || null
      : null,
    recomputationProcessIndependent: false,
    originalRawEventRecomputationVerificationHash: rawArtifactSources[0]?.recomputationVerification
      ?.independentRawEventArtifactRecomputationVerificationHash || null,
    replayRawEventRecomputationVerificationHash: rawArtifactSources[1]?.recomputationVerification
      ?.independentRawEventArtifactRecomputationVerificationHash || null,
    originalRawPrimitiveRecomputationManifestHash: rawArtifactSources[0]?.recomputationVerification
      ?.rawPrimitiveRecomputationManifestHash || null,
    replayRawPrimitiveRecomputationManifestHash: rawArtifactSources[1]?.recomputationVerification
      ?.rawPrimitiveRecomputationManifestHash || null,
    originalOperatorDatasetAuthorityVerificationHash: rawArtifactSources[0]?.recomputationVerification
      ?.operatorDatasetAuthorityVerificationHash || null,
    replayOperatorDatasetAuthorityVerificationHash: rawArtifactSources[1]?.recomputationVerification
      ?.operatorDatasetAuthorityVerificationHash || null,
    promotionTcbImplementationHash: runReceipt?.systemBenchmarkHarnessImplementationHash || null,
    executionAssuranceProfile: runReceipt?.assuranceProfile || null,
    assuranceScope: runReceipt?.assuranceScope || null,
    evidenceClass: runReceipt?.evidenceClass || null,
    promotionScope: runReceipt?.promotionScope || null,
    academicPromotionEligible: runReceipt?.academicPromotionEligible === true,
    assuranceProfile: RECOMPUTATION_ASSURANCE_PROFILE,
    authorityEvidence: Object.freeze({
      version: 1,
      kind: 'CampaignExperimentEvidenceAuthorityEvidence',
      paperId: expectedPaperId,
      campaignId: expectedCampaignId,
      originalCampaignNodeId: artifact.originalCampaignNodeId || null,
      originalCampaignNodeAttemptId: artifact.originalCampaignNodeAttemptId || null,
      originalCampaignNodeLeaseGeneration: artifact.originalCampaignNodeLeaseGeneration || null,
      originalCampaignNodeResultHash: artifact.originalCampaignNodeResultHash || null,
      replayCampaignNodeId: artifact.campaignNodeId || null,
      replayCampaignNodeAttemptId: artifact.campaignNodeAttemptId || null,
      replayCampaignNodeLeaseGeneration: artifact.campaignNodeLeaseGeneration || null,
      replayCampaignNodeResultHash: artifact.campaignNodeResultHash || null,
      sourceLineageHash: artifact.sourceLineageHash || null,
      experimentRunReceipt: runReceipt,
      experimentReplayReceipt: replayReceipt,
      workerReceipt,
      replayWorkerReceipt,
      reproducibilityLedgerReceipt,
    }),
    blockers,
  };
  return Object.freeze({ ...payload, experimentEvidenceBindingHash: hashRecord('CampaignExperimentEvidenceBinding', payload) });
}

export function buildExperimentRegistry({
  paperTask,
  artifacts = [],
  receiptLedger = null,
  artifactVerifier = null,
  rawEventRecomputationVerifier = null,
  operatorDatasetHarnessAuthorityVerifier = null,
  campaignEvidenceContext = null,
  empiricalClaimUniverse = null,
} = {}) {
  const experiments = artifacts.filter((artifact) => artifact && typeof artifact === 'object' && (
    artifact.kind === 'experiment' || artifact.experimentId || artifact.experiment_id || artifact.acceptanceContract
    || artifact.datasetHash || artifact.codeHash || artifact.resultHash
  )).map((artifact, index) => {
    const acceptanceProfileId = artifact.acceptanceProfileId || artifact.experimentProfile || artifact.allowlistedExperimentId || artifact.allowlisted_experiment_id || null;
    const registeredProfile = acceptanceProfileId ? experimentAcceptanceProfile(acceptanceProfileId) : null;
    const contract = registeredProfile
      ? buildExperimentAcceptanceContract({ profileId: acceptanceProfileId, overrides: artifact.acceptanceContract || {} })
      : artifact.acceptanceContract || {};
    const requiredOutputs = (contract.requiredOutputs?.length ? contract.requiredOutputs : artifact.requiredOutputs || []).map(String);
    const record = {
      experimentId: String(artifact.experimentId || artifact.experiment_id || artifact.id || `experiment-${index + 1}`),
      claimIds: (Array.isArray(artifact.claimIds) ? artifact.claimIds : Array.isArray(artifact.claim_ids) ? artifact.claim_ids : []).map(String),
      empiricalClaimBindings: [],
      empiricalClaimUniverseHash: null,
      manuscriptCorpusHash: null,
      runId: String(artifact.runId || artifact.run_id || ''),
      datasetHash: artifact.datasetHash || null,
      metric: artifact.metric || null,
      metrics: artifact.metrics || artifact.metricValues || artifact.metricRows || null,
      seed: artifact.seed ?? null,
      datasetManifestHash: artifact.datasetManifestHash || null,
      datasetLicenseId: artifact.datasetLicenseId || null,
      datasetReadOnly: artifact.datasetReadOnly === true,
      datasetMounts: artifact.datasetMounts || [],
      networkPolicy: artifact.networkPolicy || null,
      secretsAllowed: artifact.secretsAllowed === true,
      externalActionsAllowed: artifact.externalActionsAllowed === true,
      providerCallsAllowed: artifact.providerCallsAllowed === true,
      sourceMutationAllowed: artifact.sourceMutationAllowed === true,
      sourceReadOnlyRequired: artifact.sourceReadOnlyRequired === true,
      ephemeralWorkRootRequired: artifact.ephemeralWorkRootRequired === true,
      separateOutputRootRequired: artifact.separateOutputRootRequired === true,
      metricPredicates: contract.metricPredicates || artifact.metricPredicates || [],
      codeHash: artifact.codeHash || null,
      resultHash: artifact.resultHash || artifact.hash || null,
      resultPath: artifact.resultPath || artifact.path || null,
      observedMetric: artifact.observedMetric ?? artifact.metricValue ?? null,
      resultClass: artifact.resultClass || null,
      availableOutputs: [],
      promotionRequested: artifact.promotionRequested === true,
      acceptanceProfileId,
    };
    const campaignRunReceipt = artifact.experimentRunReceipt || null;
    if (campaignRunReceipt) {
      const claimBindings = empiricalProtocolBindings(campaignRunReceipt);
      record.claimIds = claimBindings.map((binding) => binding.claimId);
      record.empiricalClaimBindings = claimBindings;
      record.empiricalClaimUniverseHash = campaignRunReceipt.analysisProtocol?.empiricalClaimUniverseHash || null;
      record.manuscriptCorpusHash = campaignRunReceipt.analysisProtocol?.manuscriptCorpusHash || null;
      record.runId = campaignRunReceipt.experimentRunReceiptHash;
      record.datasetHash = campaignRunReceipt.datasetAuthorizationSetHash;
      record.datasetManifestHash = campaignRunReceipt.datasetAuthorizations[0]?.manifestHash || campaignRunReceipt.datasetAuthorizationSetHash;
      record.datasetLicenseId = campaignRunReceipt.datasetAuthorizations[0]?.licenseId || 'builtin-benchmark';
      record.datasetReadOnly = true;
      record.datasetMounts = campaignRunReceipt.datasetAuthorizations;
      record.networkPolicy = 'none';
      record.secretsAllowed = false;
      record.externalActionsAllowed = false;
      record.providerCallsAllowed = false;
      record.sourceMutationAllowed = false;
      record.sourceReadOnlyRequired = true;
      record.ephemeralWorkRootRequired = true;
      record.separateOutputRootRequired = true;
      record.codeHash = campaignRunReceipt.sourceMerkleHash;
      record.resultHash = campaignRunReceipt.observationManifestHash;
      record.analysisProtocolHash = campaignRunReceipt.analysisProtocolHash;
      record.resultPath = artifact.resultPath || 'results.json';
      record.seed = campaignRunReceipt.seedSchedule[0] ?? null;
      record.metrics = campaignRunReceipt.aggregateMetrics?.treatment || {};
      record.metric = record.metrics;
      record.promotionRequested = false;
    }
    record.evidenceBinding = campaignRunReceipt ? buildCampaignExperimentEvidenceBinding(artifact, receiptLedger, {
      expectedPaperId: campaignEvidenceContext?.paperId === paperTask?.paperId ? paperTask.paperId : null,
      expectedCampaignId: campaignEvidenceContext?.campaignId || null,
      artifactVerifier,
      rawEventRecomputationVerifier,
    }) : buildExperimentEvidenceBinding({
      experiment: record,
      workerReceipt: artifact.workerReceipt,
      resultArtifact: artifact.resultArtifact,
      reproducibilityReceipt: artifact.reproducibilityReceipt,
      receiptLedger,
      requiredOutputs,
      artifactVerifier,
      expectedOutputRoles: Object.fromEntries(requiredOutputs.map((name) => [name, `experiment-output:${record.experimentId}:${record.runId}:${name}`])),
      expectedOutputPaths: Object.fromEntries(requiredOutputs.map((name) => [name, name])),
    });
    record.availableOutputs = record.evidenceBinding.outputArtifacts?.map((item) => item.name) || [];
    record.assuranceProfile = campaignRunReceipt?.assuranceProfile || null;
    record.assuranceScope = campaignRunReceipt?.assuranceScope || null;
    record.evidenceClass = campaignRunReceipt?.evidenceClass || null;
    record.promotionScope = campaignRunReceipt?.promotionScope || null;
    record.academicPromotionEligible = campaignRunReceipt?.academicPromotionEligible === true;
    const missing = ['runId', 'datasetHash', 'seed', 'codeHash', 'resultHash', 'resultPath']
      .filter((key) => record[key] === null || record[key] === '');
    if (record.metric === null && record.metrics === null) missing.push('metric');
    if (record.acceptanceProfileId && !registeredProfile) missing.push('acceptanceProfile');
    if (record.evidenceBinding.status !== 'experiment_evidence_binding_verified') missing.push('evidenceBinding');
    const acceptancePolicy = evaluateExperimentAcceptance({ experiment: record, contract });
    return { ...record, status: missing.length ? 'experiment_incomplete' : acceptancePolicy.blockers.length ? 'experiment_acceptance_blocked' : 'experiment_reproducible', missing, acceptancePolicy };
  });
  const authorityVerifier = createExperimentRegistryAuthorityVerifier({
    receiptLedger,
    artifactVerifier,
    rawEventRecomputationVerifier,
    operatorDatasetHarnessAuthorityVerifier,
    expectedCampaignId: campaignEvidenceContext?.campaignId || null,
  });
  const summary = deriveExperimentRegistrySummary(experiments, {
    expectedPaperId: paperTask?.paperId || null,
    expectedCampaignId: campaignEvidenceContext?.campaignId || null,
    authorityVerifier,
    empiricalClaimUniverse,
  });
  const record = {
    version: 4,
    kind: 'ExperimentRegistry',
    paperId: paperTask?.paperId || null,
    status: summary.status,
    experiments,
    incompleteExperimentIds: summary.incompleteExperimentIds,
    academicExperimentCount: summary.academicExperimentCount,
    conformanceExperimentCount: summary.conformanceExperimentCount,
    academicPromotionEligibleExperimentIds: summary.academicPromotionEligibleExperimentIds,
    conformanceExperimentIds: summary.conformanceExperimentIds,
    academicPromotionClaimIds: summary.academicPromotionClaimIds,
    empiricalClaimUniverseHash: summary.empiricalClaimUniverseHash,
    manuscriptCorpusHash: summary.manuscriptCorpusHash,
    empiricalClaimUniverse: summary.empiricalClaimUniverseHash ? empiricalClaimUniverse : null,
    empiricalClaimBijectionBlockers: summary.empiricalClaimBijectionBlockers,
  };
  return { ...record, experimentRegistryHash: hashRecord('ExperimentRegistry', record) };
}
