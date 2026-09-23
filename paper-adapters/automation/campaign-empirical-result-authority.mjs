import { evaluateEmpiricalResultContract } from './empirical-contract-reader.mjs';
import { persistCampaignExperimentRawArtifact } from './campaign-experiment-artifact-authority.mjs';

export async function buildCampaignEmpiricalResultContract({
  artifactRepositoryFactory,
  runtimeRoot,
  outputDirectory,
  campaign,
  node,
  reproductionEmpirical,
  benchmarkSelector,
  datasetMounts,
  datasetConsumptionContract,
  baselineNode,
  executionReceipt,
} = {}) {
  const rawArtifactWriteReceipt = benchmarkSelector
    ? await persistCampaignExperimentRawArtifact({
      artifactRepositoryFactory,
      runtimeRoot,
      outputDirectory,
      paperId: campaign.paperId,
      campaignId: campaign.campaignId,
      nodeId: node.nodeId,
      attemptId: node.attemptId || 'direct',
      executionRole: reproductionEmpirical ? 'independent-replay' : 'original',
      expectedHash: executionReceipt?.harnessExecutionReceipt?.rawEventArtifactHash,
      expectedBytes: executionReceipt?.harnessExecutionReceipt?.rawEventArtifactBytes,
    })
    : null;
  return evaluateEmpiricalResultContract({
    outputDirectory,
    metricSchema: campaign.spec.metricSchema || {},
    baselineMetrics: baselineNode?.result?.metricSnapshot || null,
    baselineRunReceipt: baselineNode?.result?.experimentRunReceipt || null,
    benchmarkSelector,
    datasetMounts,
    executionReceipt,
    datasetConsumptionContractReceiptHash: datasetConsumptionContract?.datasetConsumptionContractReceiptHash || null,
    rawArtifactWriteReceipt,
  });
}
