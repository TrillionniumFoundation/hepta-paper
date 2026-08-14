import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildCampaignBenchmarkSelector } from './campaign-benchmark-selector.mjs';
import {
  buildCampaignModeNodes,
  plannedAgentCallUpperBound,
  plannedBenchmarkCellJobUpperBounds,
} from './campaign-mode-graph.mjs';

const RESOURCE_BUDGET_KEYS = Object.freeze([
  'maxAgentCalls',
  'maxCpuJobs',
  'maxGpuJobs',
]);

function canonicalBudget(value, key) {
  const number = Number(value);
  const minimum = key === 'maxGpuJobs' ? 0 : 1;
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function fullCampaignNodes({ campaignId, revisionRounds, refereeCount, executionProfile }) {
  if (!executionProfile || !Number.isSafeInteger(revisionRounds)
    || !Number.isSafeInteger(refereeCount)) {
    throw new Error('autonomous_research_resource_budget_topology_invalid');
  }
  return buildCampaignModeNodes({
    campaignId,
    mode: 'full-campaign',
    rounds: revisionRounds,
    reviewers: refereeCount,
    executionProfiles: [executionProfile],
    executionIntent: Object.freeze({
      version: 1,
      kind: 'AutonomousResearchResourceBudgetPreviewIntent',
    }),
    empiricalRequested: true,
    applyManuscript: true,
    formalRequested: true,
    researchVerificationRequired: true,
  });
}

export function inspectAutonomousResearchProfileResourceBudgetClosure({
  campaignId,
  revisionRounds,
  refereeCount,
  executionProfile,
  empiricalExecutionProfileSelectionHash = null,
  benchmarkSelector,
  budgets = {},
  gpuScientificExecutionRequired = false,
} = {}) {
  const id = String(campaignId || 'autonomous-research:budget-preview');
  if (!benchmarkSelector?.experimentDesign) {
    throw new Error('autonomous_research_resource_budget_selector_required');
  }
  const nodes = fullCampaignNodes({
    campaignId: id, revisionRounds, refereeCount, executionProfile,
  });
  const plannedCells = plannedBenchmarkCellJobUpperBounds(nodes, benchmarkSelector);
  const requiredBudgets = Object.freeze({
    maxAgentCalls: plannedAgentCallUpperBound(nodes),
    maxCpuJobs: plannedCells.cpu + (gpuScientificExecutionRequired ? 1 : 0),
    maxGpuJobs: plannedCells.gpu + (gpuScientificExecutionRequired ? 1 : 0),
  });
  const effectiveBudgets = Object.freeze(Object.fromEntries(
    RESOURCE_BUDGET_KEYS.map((key) => [key, canonicalBudget(budgets?.[key], key)]),
  ));
  const blockers = [];
  for (const key of RESOURCE_BUDGET_KEYS) {
    if (effectiveBudgets[key] === null) {
      blockers.push(`autonomous_research_resource_budget_invalid:${key}`);
    } else if (effectiveBudgets[key] < requiredBudgets[key]) {
      blockers.push(`autonomous_research_resource_budget_insufficient:${key}`);
    }
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResourceBudgetClosureInspection',
    status: blockers.length
      ? 'autonomous_research_resource_budget_blocked'
      : 'autonomous_research_resource_budget_ready',
    campaignId: id,
    campaignNodeCount: nodes.length,
    benchmarkSelectorHash: benchmarkSelector.benchmarkSelectorHash || null,
    empiricalExecutionProfileSelectionHash,
    requiredBudgets,
    effectiveBudgets,
    blockers: Object.freeze(blockers),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchResourceBudgetClosureInspectionHash: hashRecord(
      'AutonomousResearchResourceBudgetClosureInspection',
      payload,
    ),
  });
}

export function inspectAutonomousResearchResourceBudgetClosure({
  campaignId,
  loopPreparation,
  datasetMounts = [],
  budgets = {},
} = {}) {
  const id = String(campaignId || 'autonomous-research:budget-preview');
  if (!Array.isArray(datasetMounts) || datasetMounts.length !== 1) {
    throw new Error('autonomous_research_resource_budget_dataset_invalid');
  }
  const benchmarkSelector = buildCampaignBenchmarkSelector({
    benchmarkId: datasetMounts[0]?.name,
    venueTarget: loopPreparation?.venueProfileSelection?.venueId || null,
    datasetMounts,
  });
  if (!benchmarkSelector) {
    throw new Error('autonomous_research_resource_budget_selector_required');
  }
  return inspectAutonomousResearchProfileResourceBudgetClosure({
    campaignId: id,
    revisionRounds: loopPreparation?.topologyTemplate?.revisionRounds,
    refereeCount: loopPreparation?.topologyTemplate?.refereeCount,
    executionProfile: loopPreparation?.empiricalExecutionProfileSelection?.executionProfile,
    empiricalExecutionProfileSelectionHash: loopPreparation
      ?.empiricalExecutionProfileSelection
      ?.autonomousEmpiricalExecutionProfileSelectionHash || null,
    benchmarkSelector,
    budgets,
    gpuScientificExecutionRequired:
      loopPreparation?.launchMode === 'production-run',
  });
}

export function completeAutonomousResearchResourceBudgets({
  requestedBudgets = {},
  effectiveBudgets = {},
  requiredBudgets = {},
} = {}) {
  return Object.freeze({
    ...effectiveBudgets,
    ...Object.fromEntries(RESOURCE_BUDGET_KEYS.map((key) => [
      key,
      requestedBudgets?.[key] === undefined
        ? Math.max(Number(effectiveBudgets?.[key] || 0), Number(requiredBudgets?.[key] || 0))
        : effectiveBudgets?.[key],
    ])),
  });
}

function assertInspection(inspection) {
  if (inspection.status !== 'autonomous_research_resource_budget_ready') {
    const detail = inspection.blockers.map((blocker) => {
      const key = blocker.split(':').at(-1);
      return `${blocker}:required=${inspection.requiredBudgets[key]}`
        + `:effective=${inspection.effectiveBudgets[key]}`;
    }).join(',');
    throw new Error(`autonomous_research_resource_budget_blocked:${detail}`);
  }
  return inspection;
}

export function assertAutonomousResearchProfileResourceBudgetClosure(input = {}) {
  return assertInspection(inspectAutonomousResearchProfileResourceBudgetClosure(input));
}

export function assertAutonomousResearchResourceBudgetClosure(input = {}) {
  return assertInspection(inspectAutonomousResearchResourceBudgetClosure(input));
}
