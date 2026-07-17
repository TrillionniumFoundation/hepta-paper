import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function empiricalClaimBindings(runReceipt) {
  return Object.freeze((runReceipt.analysisProtocol?.hypotheses || []).map((hypothesis) => Object.freeze({
    hypothesisId: hypothesis.hypothesisId,
    claimId: hypothesis.claimId,
    manuscriptClaimHash: hypothesis.manuscriptClaimHash,
    proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
  })));
}

function recordWorkerReceipt({ campaign, experimentId, authoritativeNode, runReceipt,
  executionRole, claimIds, empiricalBindings, writers }) {
  const payload = {
    version: 2, kind: 'ExperimentWorkerExecutionReceipt', status: 'worker_execution_completed',
    paperId: campaign.paperId, campaignId: campaign.campaignId, experimentId,
    runId: runReceipt.experimentRunReceiptHash, executionRole,
    campaignNodeId: authoritativeNode.nodeId, campaignNodeAttemptId: authoritativeNode.attemptId,
    campaignNodeLeaseGeneration: authoritativeNode.leaseGeneration,
    campaignNodeResultHash: authoritativeNode.resultSha256,
    experimentRunReceiptHash: runReceipt.experimentRunReceiptHash,
    systemBenchmarkHarnessExecutionReceiptHash:
      runReceipt.harnessExecutionReceipt.systemBenchmarkHarnessExecutionReceiptHash,
    assuranceProfile: runReceipt.assuranceProfile,
    assuranceScope: runReceipt.assuranceScope,
    evidenceClass: runReceipt.evidenceClass,
    promotionScope: runReceipt.promotionScope,
    academicPromotionEligible: runReceipt.academicPromotionEligible === true,
    rawArtifactWriteReceiptHash: runReceipt.rawArtifactWriteReceipt?.writeReceiptHash || null,
    rawArtifactLedgerReceiptId: runReceipt.rawArtifactWriteReceipt?.ledgerReceiptId || null,
    rawArtifactContentHash: runReceipt.rawArtifactWriteReceipt?.hash || null,
    rawArtifactBytes: runReceipt.rawArtifactWriteReceipt?.bytes || null,
    rawArtifactRole: runReceipt.rawArtifactWriteReceipt?.role || null,
    sourceLineageHash: runReceipt.sourceLineageHash,
    resultHash: runReceipt.observationManifestHash,
    analysisProtocolHash: runReceipt.analysisProtocolHash,
    empiricalClaimUniverseHash: runReceipt.analysisProtocol?.empiricalClaimUniverseHash || null,
    manuscriptCorpusHash: runReceipt.analysisProtocol?.manuscriptCorpusHash || null,
    claimIds,
    empiricalClaimBindings: empiricalBindings,
    createdAt: authoritativeNode.updatedAt,
    externalActionPerformed: false,
  };
  const sealed = Object.freeze({
    ...payload,
    receiptHash: hashRecord('ExperimentWorkerExecutionReceipt', payload),
  });
  const recorded = writers.experimentWorker.record(sealed, {
    stream: 'experiment-workers', paperId: campaign.paperId,
  });
  return Object.freeze({ ...sealed, ledgerReceiptId: recorded.receiptId });
}

export function recordCampaignExperimentReceipts({ campaign, originalNode, replayNode,
  originalRunReceipt, replayRunReceipt, replayReceipt, writers }) {
  if (!writers?.experimentWorker?.record || !writers?.experimentReproducibility?.record) {
    throw new Error('campaign_experiment_trusted_receipt_writers_required');
  }
  const experimentId = `${originalRunReceipt.benchmarkId}:${replayNode.nodeId}`;
  const empiricalBindings = empiricalClaimBindings(originalRunReceipt);
  const claimIds = Object.freeze(empiricalBindings.map((binding) => binding.claimId));
  const originalWorkerReceipt = recordWorkerReceipt({
    campaign, experimentId, authoritativeNode: originalNode, runReceipt: originalRunReceipt,
    executionRole: 'original', claimIds, empiricalBindings, writers,
  });
  const replayWorkerReceipt = recordWorkerReceipt({
    campaign, experimentId, authoritativeNode: replayNode, runReceipt: replayRunReceipt,
    executionRole: 'independent-replay', claimIds, empiricalBindings, writers,
  });
  const reproducibilityPayload = {
    version: 2, kind: 'ExperimentReproducibilityReceipt', status: 'experiment_reproducibility_verified',
    paperId: campaign.paperId, campaignId: campaign.campaignId, experimentId,
    runId: replayRunReceipt.experimentRunReceiptHash,
    workerReceiptHash: originalWorkerReceipt.receiptHash,
    replayWorkerReceiptHash: replayWorkerReceipt.receiptHash,
    originalCampaignNodeId: originalNode.nodeId, originalCampaignNodeAttemptId: originalNode.attemptId,
    originalCampaignNodeLeaseGeneration: originalNode.leaseGeneration,
    originalCampaignNodeResultHash: originalNode.resultSha256,
    replayCampaignNodeId: replayNode.nodeId, replayCampaignNodeAttemptId: replayNode.attemptId,
    replayCampaignNodeLeaseGeneration: replayNode.leaseGeneration,
    replayCampaignNodeResultHash: replayNode.resultSha256,
    experimentReplayReceiptHash: replayReceipt.experimentReplayReceiptHash,
    originalExperimentRunReceiptHash: originalRunReceipt.experimentRunReceiptHash,
    replayExperimentRunReceiptHash: replayRunReceipt.experimentRunReceiptHash,
    assuranceProfile: originalRunReceipt.assuranceProfile,
    assuranceScope: originalRunReceipt.assuranceScope,
    evidenceClass: originalRunReceipt.evidenceClass,
    promotionScope: originalRunReceipt.promotionScope,
    academicPromotionEligible: originalRunReceipt.academicPromotionEligible === true,
    originalRawArtifactWriteReceiptHash: originalRunReceipt.rawArtifactWriteReceipt?.writeReceiptHash || null,
    originalRawArtifactLedgerReceiptId: originalRunReceipt.rawArtifactWriteReceipt?.ledgerReceiptId || null,
    replayRawArtifactWriteReceiptHash: replayRunReceipt.rawArtifactWriteReceipt?.writeReceiptHash || null,
    replayRawArtifactLedgerReceiptId: replayRunReceipt.rawArtifactWriteReceipt?.ledgerReceiptId || null,
    sourceLineageHash: replayRunReceipt.sourceLineageHash,
    resultHash: replayRunReceipt.observationManifestHash,
    analysisProtocolHash: originalRunReceipt.analysisProtocolHash,
    empiricalClaimUniverseHash: originalRunReceipt.analysisProtocol?.empiricalClaimUniverseHash || null,
    manuscriptCorpusHash: originalRunReceipt.analysisProtocol?.manuscriptCorpusHash || null,
    claimIds,
    empiricalClaimBindings: empiricalBindings,
    createdAt: replayNode.updatedAt,
    externalActionPerformed: false,
  };
  const sealed = Object.freeze({
    ...reproducibilityPayload,
    receiptHash: hashRecord('ExperimentReproducibilityReceipt', reproducibilityPayload),
  });
  const recorded = writers.experimentReproducibility.record(sealed, {
    stream: 'experiment-reproducibility', paperId: campaign.paperId,
  });
  return Object.freeze({
    experimentId,
    originalWorkerReceipt,
    replayWorkerReceipt,
    reproducibilityReceipt: Object.freeze({ ...sealed, ledgerReceiptId: recorded.receiptId }),
  });
}
