import {
  buildExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';

export function attachCampaignEmpiricalAuthority({
  primitives,
  campaign,
  node,
  context,
  workspace,
  outputDirectory,
  benchmarkSelector,
  datasetConsumptionContract,
  result,
  contract,
  runtimeKernelExecutionBinding = null,
} = {}) {
  const preparation = campaign?.spec?.autonomousResearchPreparation || null;
  const experimentIrExecutionAuthorityReceipt = context.empirical.reproduction
    && preparation?.researchAgendaIr
    && preparation?.researchAgendaProducerReceipt
    && contract?.experimentReplayReceipt
    ? buildExperimentIrExecutionAuthorityReceipt({
      campaignId: campaign.campaignId,
      paperId: campaign.paperId,
      campaignPlanHash: campaign.spec.campaignPlanHash,
      nodeId: node.nodeId,
      nodeKind: node.kind,
      researchAgendaIr: preparation.researchAgendaIr,
      researchAgendaProducerReceipt: preparation.researchAgendaProducerReceipt,
      proposal: preparation.proposal,
      researchAgendaClaimBindingReceipt: preparation.agendaClaimBindingReceipt,
      experimentReplayReceipt: contract.experimentReplayReceipt,
    })
    : null;
  const evidenceArtifact = context.empirical.reproduction && contract?.experimentReplayReceipt
    ? primitives.empirical.writeEvidenceBundle({
      outputDirectory,
      experimentRunReceipt: contract.experimentRunReceipt
        && contract.experimentReplayReceipt.originalExperimentRunReceiptHash
          === context.empiricalBaselineNode?.result?.experimentRunReceipt
            ?.experimentRunReceiptHash
        ? context.empiricalBaselineNode.result.experimentRunReceipt
        : null,
      experimentReplayReceipt: contract.experimentReplayReceipt,
    })
    : null;
  const materializationResult = evidenceArtifact
    ? {
      ...result,
      artifacts: context.empirical.reproduction
        ? [evidenceArtifact] : [...(result.artifacts || []), evidenceArtifact],
    }
    : result;
  const materialization = context.empirical.reproduction && !evidenceArtifact
    ? { materializedPaths: [], automationArtifactMaterializationReceiptHash: null }
    : primitives.workspace.materializeArtifacts({
      result: materializationResult,
      outputDirectory,
      workspace,
      nodeId: node.nodeId,
    });
  return {
    evidenceArtifact,
    materialization,
    result: Object.freeze({
      ...result,
      metricSnapshot: contract?.metrics || [],
      empiricalResultContractReceiptHash: contract?.empiricalResultContractReceiptHash || null,
      empiricalResultContractStatus: contract?.status || null,
      experimentRunReceipt: contract?.experimentRunReceipt || null,
      experimentReplayReceipt: contract?.experimentReplayReceipt || null,
      experimentEvidenceBundleHash: evidenceArtifact?.sha256 || null,
      experimentIrExecutionAuthorityReceipt,
      experimentIrExecutionAuthorityReceiptHash:
        experimentIrExecutionAuthorityReceipt
          ?.experimentIrExecutionAuthorityReceiptHash || null,
      datasetConsumptionContractReceiptHash:
        datasetConsumptionContract?.datasetConsumptionContractReceiptHash || null,
      datasetConsumptionStatus: datasetConsumptionContract?.status || null,
      benchmarkSelector,
      campaignBenchmarkSelectorHash: benchmarkSelector?.campaignBenchmarkSelectorHash || null,
      autonomousEmpiricalRuntimeKernelExecutionBinding: runtimeKernelExecutionBinding,
      autonomousEmpiricalRuntimeKernelExecutionBindingHash:
        runtimeKernelExecutionBinding
          ?.autonomousEmpiricalRuntimeKernelExecutionBindingHash || null,
    }),
  };
}
