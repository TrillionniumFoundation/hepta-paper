import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import {
  buildDatasetConsumptionRepairRequest,
  buildEmpiricalArtifactRepairRequest,
  buildEmpiricalCodeRepairRequest,
  buildLatexRepairRequest,
} from './campaign-agent-policy.mjs';
import {
  advanceEmpiricalTechnicalRepairSpec,
  assertLatexTechnicalRepairPreservesScientificContent,
  assertConfirmatoryWritableRepairAllowed,
  buildEmpiricalFailedAttemptRecord,
  buildEmpiricalOutcomeBlindExecutionDiagnostic,
  buildEmpiricalOutcomeBlindResultContractDiagnostic,
  empiricalResultContractTechnicalRepairEligible,
  empiricalTechnicalRepairEligible,
} from './campaign-empirical-repair-policy.mjs';
import {
  assertAutonomousEmpiricalRuntimeKernelExecutionBinding,
} from '../../paper-domain/automation/autonomous-empirical-runtime-kernel-execution-binding.mjs';
import {
  attachCampaignEmpiricalAuthority,
} from './campaign-empirical-authority-materialization.mjs';
import { buildCampaignEmpiricalSpec } from './campaign-empirical-spec-builder.mjs';

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

async function runRepair({ primitives, executionResources, requestBuilder, executionSignal }) {
  const repair = ({ remainingTokenCount = 4096, signal = executionSignal } = {}) => primitives.agent.execute({
    principal: 'default',
    request: requestBuilder({ remainingTokenCount, signal }),
  });
  return executionResources?.runNestedAgent ? executionResources.runNestedAgent(repair) : repair();
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
  let latexRepairContentPreservationReceipt = null;
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
      const diagnostic = buildEmpiricalOutcomeBlindExecutionDiagnostic(result, { language });
      const manuscriptBeforeRepair = primitives.workspace.readTextIfPresent({
        workspace,
        relative: manuscript,
      });
      repairReceipt = await runRepair({
        primitives,
        executionResources,
        executionSignal,
        requestBuilder: ({ remainingTokenCount, signal }) => buildLatexRepairRequest({
          campaign, workspace, manuscript, nodeKind: node.kind, diagnostic, remainingTokenCount, signal,
        }),
      });
      latexRepairContentPreservationReceipt =
        assertLatexTechnicalRepairPreservesScientificContent({
          before: manuscriptBeforeRepair,
          after: primitives.workspace.readTextIfPresent({ workspace, relative: manuscript }),
          repairReceipt,
        });
      const failed = buildEmpiricalFailedAttemptRecord({ spec: executionSpec, result });
      failedAttemptLineage.push(failed);
      executionSpec = advanceEmpiricalTechnicalRepairSpec(executionSpec, failed);
      result = await primitives.empirical.execute(executionSpec);
    }
  }
  if (result.status !== 'empirical_execution_completed'
    && empiricalTechnicalRepairEligible(result, { language }) && language !== 'latex' && allowSourceRepair) {
    assertConfirmatoryWritableRepairAllowed({ spec: executionSpec, language, nodeKind: node.kind, stage: 'empirical-code', receipt: result });
    const diagnostic = buildEmpiricalOutcomeBlindExecutionDiagnostic(result, { language });
    repairReceipt = await runRepair({
      primitives,
      executionResources,
      executionSignal,
      requestBuilder: ({ remainingTokenCount, signal }) => buildEmpiricalCodeRepairRequest({
        campaign, workspace, entrypoint, language, nodeKind: node.kind,
        diagnostic, remainingTokenCount, signal,
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
  return {
    result,
    repairReceipt,
    sanitizerReceipt,
    latexRepairContentPreservationReceipt,
    executionSpec,
    failedAttemptLineage,
  };
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
    assertConfirmatoryWritableRepairAllowed({ spec: repairedSpec, language, nodeKind: node.kind, stage: 'empirical-artifact-contract', receipt: contract });
    const diagnostic = buildEmpiricalOutcomeBlindResultContractDiagnostic(contract);
    repairedReceipt = await runRepair({
      primitives,
      executionResources,
      executionSignal,
      requestBuilder: ({ remainingTokenCount, signal }) => buildEmpiricalArtifactRepairRequest({
        campaign, workspace, entrypoint, language, nodeKind: node.kind,
        diagnostic, remainingTokenCount, signal,
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

export async function executeCampaignEmpiricalNode({ primitives, campaign, node, context, workspace, manuscript, executionBudget = {}, executionSignal = null, executionResources = null } = {}) {
  if (!context.empirical.empirical) throw new Error(`campaign_empirical_node_kind_invalid:${node.kind}`);
  const required = requireRevalidation(campaign, node, context);
  if (required !== true) return required;
  const allowSourceRepair = sourceMutationRepairAllowed(node);
  const built = buildCampaignEmpiricalSpec({ primitives, campaign, node, context, workspace, manuscript, executionBudget, executionSignal, executionResources });
  const preparation = campaign?.spec?.autonomousResearchPreparation || null;
  const runtimeKernelExecutionBinding = built.language !== 'latex'
    ? assertAutonomousEmpiricalRuntimeKernelExecutionBinding({
      launchMode: preparation?.launchMode || 'golden-bootstrap',
      protocolFamily: preparation?.proposal?.protocolFamily
        || built.benchmarkSelector?.experimentDesign?.benchmarkFamily || null,
      language: built.language,
      datasetMounts: built.datasetMounts,
      benchmarkSelector: built.benchmarkSelector,
      empiricalExecutionProfileSelection:
        preparation?.empiricalExecutionProfileSelection || null,
      empiricalRuntimeCapabilityInspection:
        preparation?.empiricalRuntimeCapabilityInspection || null,
      runtimeImageReproducibilityInspection:
        preparation?.runtimeImageReproducibilityInspection || null,
      observedAt: new Date(),
      minimumRemainingValidityMs: Number(executionBudget.remainingWallTimeMs || 0),
    }) : null;
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
  const authority = attachCampaignEmpiricalAuthority({
    primitives, campaign, node, context, workspace, outputDirectory: built.outputDirectory,
    benchmarkSelector: built.benchmarkSelector, datasetConsumptionContract: consumption.contract,
    result: contracted.result, contract: contracted.contract,
    runtimeKernelExecutionBinding,
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
    latexTechnicalRepairContentPreservationReceiptHash:
      execution.latexRepairContentPreservationReceipt
        ?.latexTechnicalRepairContentPreservationReceiptHash || null,
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
    experimentIrExecutionAuthorityReceipt:
      authority.result.experimentIrExecutionAuthorityReceipt || null,
    experimentIrExecutionAuthorityReceiptHash:
      authority.result.experimentIrExecutionAuthorityReceiptHash || null,
    datasetConsumptionContractReceiptHash: authority.result.datasetConsumptionContractReceiptHash,
    datasetConsumptionStatus: authority.result.datasetConsumptionStatus,
    autonomousEmpiricalRuntimeKernelExecutionBindingHash:
      authority.result.autonomousEmpiricalRuntimeKernelExecutionBindingHash || null,
    materializedPaths: authority.materialization.materializedPaths,
    automationArtifactMaterializationReceiptHash: authority.materialization.automationArtifactMaterializationReceiptHash,
    status: 'automation_repair_execution_completed',
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, automationRepairExecutionReceiptHash: hashRecord('AutomationRepairExecutionReceipt', payload) });
}
