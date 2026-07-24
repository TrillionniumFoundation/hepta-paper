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
  const completedBudgets = completeAutonomousResearchResourceBudgets({
    requestedBudgets,
    effectiveBudgets: launchModeGate?.effectiveBudgets,
    requiredBudgets: preview.requiredBudgets,
  });
  const closedGate = evaluateAutonomousResearchLaunchModeGate({
    launchMode,
    action,
    budgets: completedBudgets,
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
