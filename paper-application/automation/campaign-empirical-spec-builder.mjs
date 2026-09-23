import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  buildCampaignEmpiricalAttemptRootId,
} from '../../paper-domain/automation/campaign-empirical-attempt-identity.mjs';
import {
  buildCampaignBenchmarkSelector,
  verifyCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { datasetEnvironmentName } from '../../paper-domain/automation/empirical-contract.mjs';
import { campaignEmpiricalNodeClassification } from './campaign-node-kind-policy.mjs';
import {
  assertOutcomeBoundBenchmarkSourceUnchanged,
  empiricalPreDataFreezeFromResult,
} from './campaign-confirmatory-lineage-policy.mjs';

function confirmatoryAnchor({ node, context, language }) {
  if (context.empirical.reproduction) {
    const result = context.empiricalBaselineNode?.result;
    return Object.freeze({
      freeze: empiricalPreDataFreezeFromResult(result),
      armAdapterSet: result?.harnessExecutionReceipt?.armAdapterSet
        || result?.experimentRunReceipt?.harnessExecutionReceipt?.armAdapterSet || null,
    });
  }
  if (!(context.empirical.revalidate || context.empirical.revalidateCode)) return null;
  const anchor = [...(context.campaignNodes || [])]
    .filter((candidate) => candidate?.nodeId !== node?.nodeId && candidate?.status === 'completed'
      && (candidate?.spec?.language || candidate?.language || 'python') === language
      && (() => {
        const classification = campaignEmpiricalNodeClassification(candidate?.kind);
        return classification.primary || classification.revalidate;
      })()
      && empiricalPreDataFreezeFromResult(candidate?.result))
    .sort((left, right) => Number(right.roundIndex || 0) - Number(left.roundIndex || 0)
      || String(right.nodeId || '').localeCompare(String(left.nodeId || '')))[0];
  return Object.freeze({
    freeze: empiricalPreDataFreezeFromResult(anchor?.result),
    armAdapterSet: anchor?.result?.harnessExecutionReceipt?.armAdapterSet
      || anchor?.result?.experimentRunReceipt?.harnessExecutionReceipt?.armAdapterSet || null,
  });
}

export { buildCampaignEmpiricalAttemptRootId };

export function buildCampaignEmpiricalSpec({
  primitives,
  campaign,
  node,
  context,
  workspace,
  manuscript,
  executionBudget,
  executionSignal,
  executionResources,
}) {
  const language = context.empirical.compile ? 'latex' : (node.spec?.language || node.language || 'python');
  const entrypoint = primitives.workspace.findEmpiricalEntrypoint({ workspace, language });
  const outputDirectory = primitives.workspace.outputDirectory({
    campaignId: campaign.campaignId,
    nodeId: node.nodeId,
    attemptId: node.attemptId || 'direct',
  });
  // Compilation is a document build, not a benchmark execution. Carrying the
  // campaign benchmark selector into a LaTeX node routes the manuscript through
  // the system benchmark harness and makes it look for treatment/baseline/
  // ablation adapters next to main.tex. It also grants an unnecessary dataset
  // surface to the compiler.
  const datasetMounts = language === 'latex' ? [] : (campaign.spec.datasetMounts || []);
  const datasetAuthorizationSet = buildDatasetAuthorizationSet(datasetMounts);
  const benchmarkSelectorTemplate = language === 'latex'
    ? null
    : (campaign.spec.benchmarkSelector || null);
  let benchmarkSelector = benchmarkSelectorTemplate;
  if (language !== 'latex' && (campaign.spec.benchmarkId || benchmarkSelectorTemplate)) {
    const templateVerification = verifyCampaignBenchmarkSelector(benchmarkSelectorTemplate, {
      benchmarkId: campaign.spec.benchmarkId,
      datasetMounts,
    });
    if (!templateVerification.valid) {
      const error = new Error(`campaign_empirical_benchmark_selector_invalid:${templateVerification.blockers.join(',')}`);
      error.retryable = false;
      throw error;
    }
    const empiricalClaimUniverse = primitives.empirical.readEmpiricalClaimUniverse({
      sourceRoot: workspace,
      manuscriptPath: manuscript,
    });
    if (empiricalClaimUniverse.status !== 'empirical_claim_universe_verified') {
      const error = new Error(`campaign_empirical_claim_authority_invalid:${(empiricalClaimUniverse.blockers || []).join(',')}`);
      error.retryable = false;
      throw error;
    }
    try {
      benchmarkSelector = buildCampaignBenchmarkSelector({
        benchmarkId: campaign.spec.benchmarkId,
        datasetMounts,
        empiricalClaimUniverse,
      });
    } catch (cause) {
      const error = new Error(`campaign_empirical_claim_bound_selector_invalid:${cause?.message || 'unknown'}`);
      error.retryable = false;
      throw error;
    }
    const intentHash = node.spec?.executionIntent?.benchmarkSelectorHash;
    const templateAuthorityHash = benchmarkSelectorTemplate?.benchmarkSelectorTemplateHash
      || benchmarkSelectorTemplate?.campaignBenchmarkSelectorHash;
    if (intentHash !== benchmarkSelectorTemplate?.campaignBenchmarkSelectorHash
      || benchmarkSelector.benchmarkSelectorTemplateHash !== templateAuthorityHash) {
      const error = new Error('campaign_empirical_benchmark_selector_template_binding_mismatch');
      error.retryable = false;
      throw error;
    }
    const anchor = confirmatoryAnchor({ node, context, language });
    if (anchor?.freeze) {
      const resolvedAdapters = primitives.empirical.resolveBenchmarkArmAdapterSet?.({
        sourceRoot: workspace,
        entrypoint,
        protocolSet: benchmarkSelector.experimentDesign.benchmarkHarness.armProtocolSet,
      });
      assertOutcomeBoundBenchmarkSourceUnchanged({
        anchorFreeze: anchor.freeze,
        anchorArmAdapterSet: anchor.armAdapterSet,
        currentArmAdapterSet: resolvedAdapters?.adapterSet || null,
        analysisProtocolHash: benchmarkSelector.experimentDesign.analysisProtocolHash,
        systemBenchmarkArmProtocolSetHash:
          benchmarkSelector.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
        systemBenchmarkArmAdapterSetHash: resolvedAdapters?.status === 'system_benchmark_arm_adapters_verified'
          ? resolvedAdapters.adapterSet.systemBenchmarkArmAdapterSetHash : null,
      });
    }
  }
  const datasetEnvironment = Object.fromEntries(datasetMounts.map((mount) => [
    datasetEnvironmentName(mount.name),
    `/datasets/${mount.name}`,
  ]));
  const empiricalAttemptRootId = buildCampaignEmpiricalAttemptRootId({
    campaignId: campaign.campaignId || campaign.campaign_id,
    nodeId: node.nodeId || node.node_id,
    attemptId: node.attemptId || node.attempt_id || 'direct',
  });
  const preparation = campaign.spec.autonomousResearchPreparation || null;
  const researchFeasibility = preparation?.researchAgendaIr?.resourceFeasibility || null;
  const maximumWallTimeMs = Math.min(
    20 * 60 * 1000,
    Number(executionBudget.remainingWallTimeMs || 20 * 60 * 1000),
    Number(researchFeasibility?.maximumWallTimeMs || Number.MAX_SAFE_INTEGER),
  );
  const workerCpuCount = 1;
  const workerMemoryBytes = Math.min(
    Number(campaign.spec.workerMemoryBytes || 4 * 1024 * 1024 * 1024),
    Number(researchFeasibility?.maximumMemoryBytes || Number.MAX_SAFE_INTEGER),
  );
  const workerCpuSeconds = Math.min(
    Number(campaign.spec.workerCpuSeconds || 3600),
    Math.max(1, Math.floor(maximumWallTimeMs / 1000) * workerCpuCount),
  );
  const experimentResearchContext = preparation?.researchAgendaIr
    && preparation?.proposal && preparation?.agendaClaimBindingReceipt
    ? Object.freeze({
      researchAgendaIr: preparation.researchAgendaIr,
      proposal: preparation.proposal,
      researchAgendaClaimBindingReceipt: preparation.agendaClaimBindingReceipt,
    }) : null;
  const spec = {
    language,
    entrypoint,
    cwd: workspace,
    sourceRoot: workspace,
    outputDirectory,
    outputPaths: (context.empirical.primary || context.empirical.reproduction || context.empirical.revalidate)
      ? ['results.json', 'results.csv']
      : (language === 'latex' ? [manuscript.replace(/\.tex$/i, '.pdf')] : []),
    timeoutMs: maximumWallTimeMs,
    absoluteDeadlineEpochMs: Math.min(
      Number(executionBudget.absoluteDeadlineEpochMs || Number.MAX_SAFE_INTEGER),
      Date.now() + maximumWallTimeMs,
    ),
    requiresGpu: Boolean((node.spec?.requiresGpu || node.requiresGpu || campaign.spec.requiresGpu) && language !== 'latex'),
    datasetMounts,
    benchmarkSelector,
    env: {
      HEPTA_SEED: String(campaign.spec.seed || benchmarkSelector?.experimentDesign?.seedSchedule?.[0] || 42),
      HEPTA_OUTPUT_DIR: '/output',
      PYTHONHASHSEED: String(campaign.spec.seed || 42),
      OMP_NUM_THREADS: String(campaign.spec.ompThreads || 1),
      OPENBLAS_NUM_THREADS: String(campaign.spec.ompThreads || 1),
      MKL_NUM_THREADS: String(campaign.spec.ompThreads || 1),
      NUMEXPR_NUM_THREADS: String(campaign.spec.ompThreads || 1),
      BLIS_NUM_THREADS: String(campaign.spec.ompThreads || 1),
      VECLIB_MAXIMUM_THREADS: String(campaign.spec.ompThreads || 1),
      OMP_DYNAMIC: 'FALSE',
      MKL_DYNAMIC: 'FALSE',
      ...(benchmarkSelector ? {
        HEPTA_BENCHMARK_ID: benchmarkSelector.benchmarkId,
        HEPTA_BENCHMARK_SELECTOR_HASH: benchmarkSelector.campaignBenchmarkSelectorHash,
        HEPTA_EXPERIMENT_DESIGN_HASH: benchmarkSelector.experimentDesignHash,
        HEPTA_EXPERIMENT_DESIGN_JSON: JSON.stringify(benchmarkSelector.experimentDesign),
        HEPTA_BENCHMARK_HARNESS_HASH: benchmarkSelector.experimentDesign.benchmarkHarnessHash,
        HEPTA_DATASET_AUTHORIZATION_SET_HASH: datasetAuthorizationSet.datasetAuthorizationSetHash,
        HEPTA_EXPERIMENT_ATTEMPT_ID: empiricalAttemptRootId,
      } : {}),
      ...datasetEnvironment,
    },
    memoryBytes: workerMemoryBytes,
    cpuSeconds: workerCpuSeconds,
    cpuCount: workerCpuCount,
    maximumProcesses: Number(campaign.spec.workerMaximumProcesses || 128),
    requireSeparateOutputRoot: Boolean(
      language === 'latex'
      || context.empirical.primary
      || context.empirical.reproduction
      || context.empirical.revalidate
    ),
    cachePolicy: context.empirical.reproduction ? 'bypass' : 'default',
    sourceLineageHash: primitives.workspace.hashFile({ workspace, relative: manuscript }),
    empiricalAttemptRootId,
    empiricalAttemptVersion: 1,
    failedAttemptLineageHashes: Object.freeze([]),
    experimentResearchContext,
    localOnly: campaign.spec.localOnly === true,
    signal: executionSignal || null,
    runEmpiricalCell: executionResources?.runEmpiricalCell || null,
  };
  return { language, entrypoint, outputDirectory, datasetMounts, benchmarkSelector, spec };
}
