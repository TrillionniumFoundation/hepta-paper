import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  buildCampaignBenchmarkSelector,
  verifyCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { datasetEnvironmentName } from '../../paper-domain/automation/empirical-contract.mjs';
import {
  buildDatasetConsumptionRepairRequest,
  buildEmpiricalArtifactRepairRequest,
  buildEmpiricalCodeRepairRequest,
  buildLatexRepairRequest,
} from './campaign-agent-policy.mjs';
import {
  advanceEmpiricalTechnicalRepairSpec,
  buildEmpiricalFailedAttemptRecord,
  empiricalResultContractTechnicalRepairEligible,
  empiricalTechnicalRepairEligible,
} from './campaign-empirical-repair-policy.mjs';
import { campaignEmpiricalNodeClassification } from './campaign-node-kind-policy.mjs';
import {
  assertOutcomeBoundBenchmarkSourceUnchanged,
  empiricalPreDataFreezeFromResult,
} from './campaign-confirmatory-lineage-policy.mjs';

export { empiricalResultContractTechnicalRepairEligible, empiricalTechnicalRepairEligible };

function skipped(node, changedPaths) {
  return { status: 'impact_revalidation_not_required', nodeKind: node.kind, changedPaths };
}

function requireRevalidation(campaign, node, context) {
  if (!node.kind.startsWith('revalidate-')) return true;
  const changedPaths = context.revisionNode?.result?.changedPaths || [];
  const impact = requiredRevalidationForChanges(changedPaths);
  const required = context.empirical.revalidateCode ? impact.code
    : (context.empirical.revalidate || context.empirical.revalidateReplay)
      ? Boolean(campaign.spec.benchmarkSelector) || impact.empirical
      : node.kind === 'revalidate-compile' ? impact.compile : true;
  return required ? true : skipped(node, changedPaths);
}

function confirmatoryAnchorFreeze({ node, context, language }) {
  if (context.empirical.reproduction) {
    return empiricalPreDataFreezeFromResult(context.empiricalBaselineNode?.result);
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
  return empiricalPreDataFreezeFromResult(anchor?.result);
}

async function runRepair({ primitives, executionResources, requestBuilder, executionSignal }) {
  const repair = ({ remainingTokenCount = 4096, signal = executionSignal } = {}) => primitives.agent.execute({
    principal: 'default',
    request: requestBuilder({ remainingTokenCount, signal }),
  });
  return executionResources?.runNestedAgent ? executionResources.runNestedAgent(repair) : repair();
}

function buildEmpiricalSpec({ primitives, campaign, node, context, workspace, manuscript, executionBudget, executionSignal, executionResources }) {
  const language = context.empirical.compile ? 'latex' : (node.spec?.language || node.language || 'python');
  const entrypoint = primitives.workspace.findEmpiricalEntrypoint({ workspace, language });
  const outputDirectory = primitives.workspace.outputDirectory({
    campaignId: campaign.campaignId,
    nodeId: node.nodeId,
    attemptId: node.attemptId || 'direct',
  });
  const datasetMounts = campaign.spec.datasetMounts || [];
  const datasetAuthorizationSet = buildDatasetAuthorizationSet(datasetMounts);
  const benchmarkSelectorTemplate = campaign.spec.benchmarkSelector || null;
  let benchmarkSelector = benchmarkSelectorTemplate;
  if (campaign.spec.benchmarkId || benchmarkSelectorTemplate) {
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
    const anchorFreeze = confirmatoryAnchorFreeze({ node, context, language });
    if (anchorFreeze) {
      const resolvedAdapters = primitives.empirical.resolveBenchmarkArmAdapterSet?.({
        sourceRoot: workspace,
        entrypoint,
        protocolSet: benchmarkSelector.experimentDesign.benchmarkHarness.armProtocolSet,
      });
      assertOutcomeBoundBenchmarkSourceUnchanged({
        anchorFreeze,
        analysisProtocolHash: benchmarkSelector.experimentDesign.analysisProtocolHash,
        systemBenchmarkArmProtocolSetHash:
          benchmarkSelector.experimentDesign.benchmarkHarness.systemBenchmarkArmProtocolSetHash,
        systemBenchmarkArmAdapterSetHash: resolvedAdapters?.status === 'system_benchmark_arm_adapters_verified'
          ? resolvedAdapters.adapterSet.systemBenchmarkArmAdapterSetHash : null,
      });
    }
  }
  const datasetEnvironment = Object.fromEntries(datasetMounts.map((mount) => [datasetEnvironmentName(mount.name), `/datasets/${mount.name}`]));
  const empiricalAttemptRootId = `${campaign.campaignId || campaign.campaign_id}:${node.nodeId || node.node_id}:${node.attemptId || node.attempt_id || 'direct'}`;
  const spec = {
    language,
    entrypoint,
    cwd: workspace,
    sourceRoot: workspace,
    outputDirectory,
    outputPaths: (context.empirical.primary || context.empirical.reproduction || context.empirical.revalidate)
      ? ['results.json', 'results.csv']
      : (language === 'latex' ? [manuscript.replace(/\.tex$/i, '.pdf')] : []),
    timeoutMs: Math.min(20 * 60 * 1000, Number(executionBudget.remainingWallTimeMs || 20 * 60 * 1000)),
    absoluteDeadlineEpochMs: Number(executionBudget.absoluteDeadlineEpochMs || (Date.now() + Math.min(20 * 60 * 1000, Number(executionBudget.remainingWallTimeMs || 20 * 60 * 1000)))),
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
    memoryBytes: Number(campaign.spec.workerMemoryBytes || 4 * 1024 * 1024 * 1024),
    cpuSeconds: Number(campaign.spec.workerCpuSeconds || 3600),
    maximumProcesses: Number(campaign.spec.workerMaximumProcesses || 128),
    requireSeparateOutputRoot: Boolean(context.empirical.primary || context.empirical.reproduction || context.empirical.revalidate),
    cachePolicy: context.empirical.reproduction ? 'bypass' : 'default',
    sourceLineageHash: primitives.workspace.hashFile({ workspace, relative: manuscript }),
    empiricalAttemptRootId,
    empiricalAttemptVersion: 1,
    failedAttemptLineageHashes: Object.freeze([]),
    signal: executionSignal || null,
    runEmpiricalCell: executionResources?.runEmpiricalCell || null,
  };
  return { language, entrypoint, outputDirectory, datasetMounts, benchmarkSelector, spec };
}

function sourceMutationRepairAllowed(node) {
  return (node?.sourceMutationPolicy || node?.spec?.sourceMutationPolicy || null) !== 'forbid';
}

function sourceSealRepairError(node, stage, receipt = null) {
  const error = new Error(`campaign_source_seal_repair_forbidden:${node?.kind || 'unknown'}:${stage}`);
  error.retryable = false;
  error.receipt = receipt;
  return error;
}

async function enforceDatasetConsumption({ primitives, campaign, node, context, workspace, executionResources, executionSignal, language, entrypoint, datasetMounts, allowSourceRepair }) {
  if (language === 'latex' || !datasetMounts.length) return { contract: null, repairReceipt: null };
  let contract = primitives.empirical.evaluateDatasetConsumption({
    sourceText: primitives.workspace.readTextIfPresent({ workspace, relative: entrypoint }),
    datasetMounts,
  });
  let repairReceipt = null;
  if (contract.blockers.length && !context.empirical.reproduction && allowSourceRepair) {
    repairReceipt = await runRepair({
      primitives,
      executionResources,
      executionSignal,
      requestBuilder: ({ remainingTokenCount, signal }) => buildDatasetConsumptionRepairRequest({
        campaign, workspace, entrypoint, language, nodeKind: node.kind, contract, remainingTokenCount, signal,
      }),
    });
    contract = primitives.empirical.evaluateDatasetConsumption({
      sourceText: primitives.workspace.readTextIfPresent({ workspace, relative: entrypoint }),
      datasetMounts,
    });
  }
  if (contract.blockers.length) {
    if (!allowSourceRepair && !context.empirical.reproduction) {
      throw sourceSealRepairError(node, 'dataset-consumption', contract);
    }
    const error = new Error(contract.blockers.join(',') || 'dataset_consumption_contract_blocked');
    error.retryable = !context.empirical.reproduction;
    error.receipt = contract;
    throw error;
  }
  return { contract, repairReceipt };
}

async function executeWithRepair({ primitives, campaign, node, workspace, manuscript, executionResources, executionSignal, language, entrypoint, spec, initialRepairReceipt, allowSourceRepair }) {
  let repairReceipt = initialRepairReceipt;
  let sanitizerReceipt = null;
  let executionSpec = spec;
  const failedAttemptLineage = [];
  let result = await primitives.empirical.execute(executionSpec);
  if (result.status !== 'empirical_execution_completed'
    && empiricalTechnicalRepairEligible(result, { language }) && language === 'latex' && allowSourceRepair) {
    sanitizerReceipt = primitives.empirical.sanitizeLatex({ workspacePath: workspace, manuscriptPath: manuscript });
    if (sanitizerReceipt.changed) {
      const failed = buildEmpiricalFailedAttemptRecord({ spec: executionSpec, result });
      failedAttemptLineage.push(failed);
      executionSpec = advanceEmpiricalTechnicalRepairSpec(executionSpec, failed);
      result = await primitives.empirical.execute(executionSpec);
    }
    if (result.status !== 'empirical_execution_completed'
      && empiricalTechnicalRepairEligible(result, { language })) {
      repairReceipt = await runRepair({
        primitives,
        executionResources,
        executionSignal,
        requestBuilder: ({ remainingTokenCount, signal }) => buildLatexRepairRequest({
          campaign, workspace, manuscript, nodeKind: node.kind, diagnostics: result.stderrTail || '', remainingTokenCount, signal,
        }),
      });
      const failed = buildEmpiricalFailedAttemptRecord({ spec: executionSpec, result });
      failedAttemptLineage.push(failed);
      executionSpec = advanceEmpiricalTechnicalRepairSpec(executionSpec, failed);
      result = await primitives.empirical.execute(executionSpec);
    }
  }
  if (result.status !== 'empirical_execution_completed'
    && empiricalTechnicalRepairEligible(result, { language }) && language !== 'latex' && allowSourceRepair) {
    repairReceipt = await runRepair({
      primitives,
      executionResources,
      executionSignal,
      requestBuilder: ({ remainingTokenCount, signal }) => buildEmpiricalCodeRepairRequest({
        campaign, workspace, entrypoint, language, nodeKind: node.kind,
        diagnostics: result.stderrTail || result.stdoutTail || '', remainingTokenCount, signal,
      }),
    });
    const failed = buildEmpiricalFailedAttemptRecord({ spec: executionSpec, result });
    failedAttemptLineage.push(failed);
    executionSpec = advanceEmpiricalTechnicalRepairSpec(executionSpec, failed);
    result = await primitives.empirical.execute(executionSpec);
  }
  if (result.status !== 'empirical_execution_completed') {
    const technicalFailure = empiricalTechnicalRepairEligible(result, { language });
    if (!allowSourceRepair && technicalFailure) {
      throw sourceSealRepairError(node, language === 'latex' ? 'latex' : 'empirical-code', result);
    }
    const error = new Error(result.blockers?.join(',') || result.status);
    error.retryable = technicalFailure
      && !['empirical_runtime_unavailable', 'empirical_execution_cancelled'].includes(result.status);
    error.receipt = result;
    throw error;
  }
  return { result, repairReceipt, sanitizerReceipt, executionSpec, failedAttemptLineage };
}

async function enforceResultContract({ primitives, campaign, node, context, workspace, executionResources, executionSignal, language, entrypoint, outputDirectory, datasetMounts, benchmarkSelector, datasetConsumptionContract, spec, result, repairReceipt, failedAttemptLineage = [], allowSourceRepair }) {
  if (!(context.empirical.primary || context.empirical.reproduction || context.empirical.revalidate)) {
    return { result, contract: null, repairReceipt, executionSpec: spec, failedAttemptLineage: Object.freeze([...failedAttemptLineage]) };
  }
  if (context.empirical.reproduction && !context.empiricalBaselineNode) {
    throw new Error('campaign_empirical_reproduction_baseline_dependency_required');
  }
  const build = (executionReceipt) => primitives.empirical.buildResultContract({
    outputDirectory,
    campaign,
    node,
    reproductionEmpirical: context.empirical.reproduction,
    benchmarkSelector,
    datasetMounts,
    datasetConsumptionContract,
    baselineNode: context.empiricalBaselineNode,
    executionReceipt,
  });
  let contract = await build(result);
  let repairedResult = result;
  let repairedReceipt = repairReceipt;
  let repairedSpec = spec;
  const repairLineage = [...failedAttemptLineage];
  if (contract.blockers.length && !context.empirical.reproduction && allowSourceRepair
    && empiricalResultContractTechnicalRepairEligible(contract)) {
    repairedReceipt = await runRepair({
      primitives,
      executionResources,
      executionSignal,
      requestBuilder: ({ remainingTokenCount, signal }) => buildEmpiricalArtifactRepairRequest({
        campaign, workspace, entrypoint, language, nodeKind: node.kind,
        blockers: contract.blockers, remainingTokenCount, signal,
      }),
    });
    const failed = buildEmpiricalFailedAttemptRecord({ spec: repairedSpec, result: repairedResult, contract });
    repairLineage.push(failed);
    repairedSpec = advanceEmpiricalTechnicalRepairSpec(repairedSpec, failed);
    repairedResult = await primitives.empirical.execute(repairedSpec);
    if (repairedResult.status === 'empirical_execution_completed') contract = await build(repairedResult);
  }
  if (contract.blockers.length) {
    const technicalFailure = empiricalResultContractTechnicalRepairEligible(contract);
    if (!allowSourceRepair && !context.empirical.reproduction && technicalFailure) {
      throw sourceSealRepairError(node, 'empirical-artifact-contract', contract);
    }
    const error = new Error(contract.blockers.join(',') || 'empirical_result_contract_blocked');
    error.retryable = technicalFailure;
    error.receipt = contract;
    throw error;
  }
  return {
    result: repairedResult,
    contract,
    repairReceipt: repairedReceipt,
    executionSpec: repairedSpec,
    failedAttemptLineage: Object.freeze(repairLineage),
  };
}

function attachAuthority({ primitives, node, context, workspace, outputDirectory, benchmarkSelector, datasetConsumptionContract, result, contract }) {
  const evidenceArtifact = context.empirical.reproduction && contract?.experimentReplayReceipt
    ? primitives.empirical.writeEvidenceBundle({
      outputDirectory,
      experimentRunReceipt: contract.experimentRunReceipt
        && contract.experimentReplayReceipt.originalExperimentRunReceiptHash === context.empiricalBaselineNode?.result?.experimentRunReceipt?.experimentRunReceiptHash
        ? context.empiricalBaselineNode.result.experimentRunReceipt
        : null,
      experimentReplayReceipt: contract.experimentReplayReceipt,
    })
    : null;
  const materializationResult = evidenceArtifact
    ? { ...result, artifacts: context.empirical.reproduction ? [evidenceArtifact] : [...(result.artifacts || []), evidenceArtifact] }
    : result;
  const materialization = context.empirical.reproduction && !evidenceArtifact
    ? { materializedPaths: [], automationArtifactMaterializationReceiptHash: null }
    : primitives.workspace.materializeArtifacts({ result: materializationResult, outputDirectory, workspace, nodeId: node.nodeId });
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
      datasetConsumptionContractReceiptHash: datasetConsumptionContract?.datasetConsumptionContractReceiptHash || null,
      datasetConsumptionStatus: datasetConsumptionContract?.status || null,
      benchmarkSelector,
      campaignBenchmarkSelectorHash: benchmarkSelector?.campaignBenchmarkSelectorHash || null,
    }),
  };
}

export async function executeCampaignEmpiricalNode({ primitives, campaign, node, context, workspace, manuscript, executionBudget = {}, executionSignal = null, executionResources = null } = {}) {
  if (!context.empirical.empirical) throw new Error(`campaign_empirical_node_kind_invalid:${node.kind}`);
  const required = requireRevalidation(campaign, node, context);
  if (required !== true) return required;
  const allowSourceRepair = sourceMutationRepairAllowed(node);
  const built = buildEmpiricalSpec({ primitives, campaign, node, context, workspace, manuscript, executionBudget, executionSignal, executionResources });
  const consumption = await enforceDatasetConsumption({
    primitives, campaign, node, context, workspace, executionResources, executionSignal,
    language: built.language, entrypoint: built.entrypoint, datasetMounts: built.datasetMounts,
    allowSourceRepair,
  });
  const execution = await executeWithRepair({
    primitives, campaign, node, workspace, manuscript, executionResources, executionSignal,
    language: built.language, entrypoint: built.entrypoint, spec: built.spec,
    initialRepairReceipt: consumption.repairReceipt,
    allowSourceRepair,
  });
  const contracted = await enforceResultContract({
    primitives, campaign, node, context, workspace, executionResources, executionSignal,
    language: built.language, entrypoint: built.entrypoint, outputDirectory: built.outputDirectory,
    datasetMounts: built.datasetMounts, benchmarkSelector: built.benchmarkSelector,
    datasetConsumptionContract: consumption.contract, spec: execution.executionSpec,
    result: execution.result, repairReceipt: execution.repairReceipt,
    failedAttemptLineage: execution.failedAttemptLineage,
    allowSourceRepair,
  });
  if (built.benchmarkSelector) {
    const lineageHashes = contracted.failedAttemptLineage
      .map((item) => item.empiricalFailedAttemptLineageHash);
    const freeze = contracted.result.preDataAccessFreeze
      || contracted.result.harnessExecutionReceipt?.preDataAccessFreeze;
    if (!freeze
      || freeze.attemptVersion !== Number(contracted.executionSpec.empiricalAttemptVersion || 1)
      || JSON.stringify(freeze.failedAttemptLineageHashes) !== JSON.stringify(lineageHashes)
      || freeze.analysisProtocolHash !== built.benchmarkSelector.experimentDesign.analysisProtocolHash) {
      const error = new Error('campaign_empirical_pre_data_access_freeze_lineage_mismatch');
      error.retryable = false;
      error.receipt = freeze || contracted.result;
      throw error;
    }
  }
  const authority = attachAuthority({
    primitives, node, context, workspace, outputDirectory: built.outputDirectory,
    benchmarkSelector: built.benchmarkSelector, datasetConsumptionContract: consumption.contract,
    result: contracted.result, contract: contracted.contract,
  });
  if (!contracted.repairReceipt && !execution.sanitizerReceipt?.changed) {
    return Object.freeze({
      ...authority.result,
      materializedPaths: authority.materialization.materializedPaths,
      automationArtifactMaterializationReceiptHash: authority.materialization.automationArtifactMaterializationReceiptHash,
    });
  }
  const payload = {
    version: 1,
    kind: 'AutomationRepairExecutionReceipt',
    nodeKind: node.kind,
    repairAgentReceiptHash: contracted.repairReceipt?.agentExecutionReceiptHash || null,
    generatedLatexSanitizerReceiptHash: execution.sanitizerReceipt?.generatedLatexSanitizerReceiptHash || null,
    repairedExecutionReceiptHash: authority.result.multiLanguageEmpiricalReceiptHash,
    empiricalAttemptVersion: Number(contracted.executionSpec?.empiricalAttemptVersion || 1),
    experimentAttemptId: contracted.executionSpec?.env?.HEPTA_EXPERIMENT_ATTEMPT_ID || null,
    failedAttemptLineageHashes: Object.freeze(contracted.failedAttemptLineage
      .map((item) => item.empiricalFailedAttemptLineageHash)),
    failedAttemptLineage: contracted.failedAttemptLineage,
    preDataAccessFreeze: authority.result.preDataAccessFreeze || null,
    empiricalPreDataAccessFreezeHash: authority.result.empiricalPreDataAccessFreezeHash || null,
    language: authority.result.language || built.language,
    runnerReceiptHash: authority.result.runnerReceiptHash || null,
    artifacts: authority.result.artifacts || [],
    isolation: authority.result.isolation || {},
    containerImage: authority.result.containerImage || null,
    containerImageDigest: authority.result.containerImageDigest || null,
    sourceMerkleHash: authority.result.sourceMerkleHash || null,
    sourceWorkspaceManifestHash: authority.result.sourceWorkspaceManifestHash || null,
    datasetMounts: authority.result.datasetMounts || [],
    cacheHit: Boolean(authority.result.cacheHit),
    executionCacheKey: authority.result.executionCacheKey || null,
    metricSnapshot: authority.result.metricSnapshot,
    empiricalResultContractReceiptHash: authority.result.empiricalResultContractReceiptHash,
    empiricalResultContractStatus: authority.result.empiricalResultContractStatus,
    experimentRunReceipt: authority.result.experimentRunReceipt,
    experimentReplayReceipt: authority.result.experimentReplayReceipt,
    experimentEvidenceBundleHash: authority.result.experimentEvidenceBundleHash,
    datasetConsumptionContractReceiptHash: authority.result.datasetConsumptionContractReceiptHash,
    datasetConsumptionStatus: authority.result.datasetConsumptionStatus,
    materializedPaths: authority.materialization.materializedPaths,
    automationArtifactMaterializationReceiptHash: authority.materialization.automationArtifactMaterializationReceiptHash,
    status: 'automation_repair_execution_completed',
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, automationRepairExecutionReceiptHash: hashRecord('AutomationRepairExecutionReceipt', payload) });
}
