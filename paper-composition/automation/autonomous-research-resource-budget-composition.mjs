import {
  assertAutonomousResearchResourceBudgetClosure,
  completeAutonomousResearchResourceBudgets,
  inspectAutonomousResearchResourceBudgetClosure,
} from '../../paper-domain/automation/autonomous-research-resource-budget-policy.mjs';
import {
  evaluateAutonomousResearchLaunchModeGate,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';

export function closeAutonomousResearchResourceBudgets({
  campaignId,
  loopPreparation,
  datasetMounts,
  requestedBudgets,
  launchMode,
  action,
  localOnly = false,
  directLocalRunBudgetWaiver = null,
  directLocalRunCliProvenance = null,
  autonomousResearchPreparation = null,
  launchModeGate,
  providerPricingInspection,
  fullResearchReadiness,
  admissionOnly = false,
} = {}) {
  const preview = inspectAutonomousResearchResourceBudgetClosure({
    campaignId,
    loopPreparation,
    datasetMounts,
    budgets: launchModeGate?.effectiveBudgets,
  });
  const completedBudgetBase = completeAutonomousResearchResourceBudgets({
    requestedBudgets,
    effectiveBudgets: launchModeGate?.effectiveBudgets,
    requiredBudgets: preview.requiredBudgets,
  });
  const completedBudgets = Object.freeze({
    ...completedBudgetBase,
    ...(directLocalRunBudgetWaiver?.unlimitedTokenCount === true
      ? { maxTokenCount: requestedBudgets?.maxTokenCount } : {}),
    ...(directLocalRunBudgetWaiver?.unlimitedCostUsd === true
      ? { maxCostUsd: requestedBudgets?.maxCostUsd } : {}),
  });
  const closedGate = evaluateAutonomousResearchLaunchModeGate({
    launchMode,
    action,
    budgets: completedBudgets,
    localOnly,
    directLocalRunBudgetWaiver,
    directLocalRunCliProvenance,
    autonomousResearchPreparation,
    campaignId,
    paperId: loopPreparation?.proposal?.paperId || null,
    providerPricingInspection,
    fullResearchReadiness,
    admissionOnly,
  });
  if (closedGate.status !== 'autonomous_research_launch_mode_ready') {
    throw new Error(
      `autonomous_research_resource_budget_launch_mode_blocked:${closedGate.blockers.join(',')}`,
    );
  }
  const inspection = assertAutonomousResearchResourceBudgetClosure({
    campaignId,
    loopPreparation,
    datasetMounts,
    budgets: closedGate.effectiveBudgets,
  });
  return Object.freeze({
    launchModeGate: closedGate,
    effectiveBudgets: closedGate.effectiveBudgets,
    resourceBudgetClosure: inspection,
  });
}
