import { verifyCampaignReleasePortableEnvironmentBindings } from '../../paper-domain/automation/campaign-release-evidence-capsule-contract.mjs';
import { researchEvidenceRecomputationIndependenceMatches } from './research-evidence-recomputation-binding.mjs';

export function portableExperimentBindingsValid({ manifest, registry, environment, authority } = {}) {
  if (!verifyCampaignReleasePortableEnvironmentBindings({ manifest, registry, environment, authority }).valid) return false;
  const registryExperiments = new Map((registry?.document?.experiments || []).map((item) => [item?.experimentId, item]));
  const environmentExperiments = new Map((environment?.experiments || []).map((item) => [item?.experimentId, item]));
  const authorityExperiments = new Map((authority?.experiments || []).map((item) => [item?.experimentId, item]));
  for (const experiment of manifest?.experiments || []) {
    const registered = registryExperiments.get(experiment.experimentId);
    const runtime = environmentExperiments.get(experiment.experimentId);
    const publicAuthority = authorityExperiments.get(experiment.experimentId);
    const offlineOriginal = publicAuthority?.offlineOperatorDatasetAuthorityEvidence?.executions?.original;
    const operatorAnalysisProtocolTemplateHash = offlineOriginal?.benchmarkSelector?.experimentDesign?.analysisProtocolTemplateHash
      || experiment.analysisProtocolHash;
    if (registered?.evidenceBinding?.experimentEvidenceBindingHash !== experiment.experimentEvidenceBindingHash
      || registered?.evidenceBinding?.sourceLineageHash !== experiment.sourceLineageHash
      || runtime?.sourceLineageHash !== experiment.sourceLineageHash
      || publicAuthority?.experimentEvidenceBindingHash !== experiment.experimentEvidenceBindingHash
      || publicAuthority?.experimentReplayReceiptHash !== experiment.experimentReplayReceiptHash
      || publicAuthority?.sourceLineageHash !== experiment.sourceLineageHash
      || registered?.evidenceBinding?.analysisProtocolHash !== experiment.analysisProtocolHash
      || registered?.evidenceBinding?.originalAnalysisEvaluationHash !== experiment.originalAnalysisEvaluationHash
      || registered?.evidenceBinding?.replayAnalysisEvaluationHash !== experiment.replayAnalysisEvaluationHash
      || registered?.evidenceBinding?.analysisProtocolReplayBindingHash !== experiment.analysisProtocolReplayBindingHash
      || !researchEvidenceRecomputationIndependenceMatches(registered?.evidenceBinding, experiment)
      || publicAuthority?.analysisProtocolHash !== experiment.analysisProtocolHash
      || publicAuthority?.originalAnalysisEvaluationHash !== experiment.originalAnalysisEvaluationHash
      || publicAuthority?.replayAnalysisEvaluationHash !== experiment.replayAnalysisEvaluationHash
      || publicAuthority?.analysisProtocolReplayBindingHash !== experiment.analysisProtocolReplayBindingHash
      || !researchEvidenceRecomputationIndependenceMatches(publicAuthority, experiment)
      || publicAuthority?.offlineOperatorDatasetAuthorityEvidence?.executions?.original?.authorityReceipt?.analysisProtocolHash
        !== operatorAnalysisProtocolTemplateHash
      || publicAuthority?.offlineOperatorDatasetAuthorityEvidence?.executions?.['independent-replay']?.authorityReceipt?.analysisProtocolHash
        !== operatorAnalysisProtocolTemplateHash
      || publicAuthority?.offlineOperatorDatasetAuthorityEvidence?.kind !== 'OfflineOperatorDatasetAuthorityEvidence'
      || publicAuthority?.ledgerEvidenceAssurance !== 'structural-receipt-summaries-not-cryptographic-inclusion-proof-v1'
      || !Array.isArray(publicAuthority?.trustedLedgerReceiptSummaries)
      || publicAuthority.trustedLedgerReceiptSummaries.length !== 3
      || publicAuthority.trustedLedgerReceiptSummaries
        .some((item) => item?.writerTrusted !== true || !item?.receiptHash || !item?.receiptId)) return false;
    const runtimeExecutions = new Map((runtime.executions || []).map((item) => [item?.executionRole, item]));
    for (const execution of experiment.executions) {
      const runtimeExecution = runtimeExecutions.get(execution.executionRole);
      const artifact = publicAuthority?.artifactAuthority?.[execution.executionRole];
      const worker = execution.executionRole === 'original' ? publicAuthority?.workerReceipt : publicAuthority?.replayWorkerReceipt;
      if (runtimeExecution?.experimentRunReceiptHash !== execution.experimentRunReceiptHash
        || runtimeExecution?.experimentAttemptId !== execution.experimentAttemptId
        || runtimeExecution?.executionReceiptHash !== execution.executionReceiptHash
        || runtimeExecution?.runtimeIdentityHash !== execution.runtimeIdentityHash
        || runtimeExecution?.environmentBindingHash !== execution.environmentBindingHash
        || runtimeExecution?.sourceLineageHash !== experiment.sourceLineageHash
        || artifact?.contentHash !== execution.rawEventArtifactHash
        || Number(artifact?.bytes) !== Number(execution.rawEventArtifactBytes)
        || artifact?.artifactWriteReceiptHash !== execution.rawArtifactWriteReceiptHash
        || artifact?.ledgerReceiptId !== execution.rawArtifactLedgerReceiptId
        || artifact?.ledgerEvidenceAssurance !== 'trusted-runtime-row-summary-structural-only-v1'
        || artifact?.ledgerReceiptSummary?.receiptId !== execution.rawArtifactLedgerReceiptId
        || artifact?.ledgerReceiptSummary?.receiptHash !== execution.rawArtifactWriteReceiptHash
        || artifact?.ledgerReceiptSummary?.writerTrusted !== true
        || worker?.experimentRunReceiptHash !== execution.experimentRunReceiptHash
        || worker?.rawArtifactWriteReceiptHash !== execution.rawArtifactWriteReceiptHash
        || worker?.rawArtifactLedgerReceiptId !== execution.rawArtifactLedgerReceiptId
        || worker?.sourceLineageHash !== experiment.sourceLineageHash) return false;
    }
    if (publicAuthority?.reproducibilityLedgerReceipt?.experimentReplayReceiptHash !== experiment.experimentReplayReceiptHash
      || publicAuthority?.reproducibilityLedgerReceipt?.sourceLineageHash !== experiment.sourceLineageHash) return false;
  }
  return registryExperiments.size >= Number(manifest?.experimentCount)
    && environmentExperiments.size === Number(manifest?.experimentCount)
    && authorityExperiments.size === Number(manifest?.experimentCount);
}
