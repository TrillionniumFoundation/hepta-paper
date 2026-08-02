import {
  AUTONOMOUS_RESEARCH_UNLIMITED_BUDGET_SENTINEL,
  buildAutonomousResearchDirectLocalRunBudgetWaiver,
  buildAutonomousResearchDirectLocalRunCliProvenance,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';

export const LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE = 'local-run';

export function isLocalAutonomousResearchCliLaunchMode(value = null) {
  return String(value || LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE).trim()
    === LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE;
}

export function normalizeAutonomousResearchCliLaunchMode(value = null) {
  const selected = String(value || LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE).trim();
  return selected === LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE
    ? 'golden-bootstrap'
    : selected;
}

export function resolveAutonomousResearchDirectLocalRunBudgetWaiver({
  launchMode = null,
  campaignId = null,
  paperId = null,
  unlimitedTokens = false,
  unlimitedCost = false,
  maxTokensSpecified = false,
  maxCostUsdSpecified = false,
} = {}) {
  if (unlimitedTokens !== true && unlimitedCost !== true) {
    return Object.freeze({
      budgets: Object.freeze({}),
      waiver: null,
      provenance: null,
    });
  }
  if (!isLocalAutonomousResearchCliLaunchMode(launchMode)) {
    throw new Error('autonomous_research_unlimited_budget_requires_direct_local_run');
  }
  if (unlimitedTokens === true && maxTokensSpecified === true) {
    throw new Error('autonomous_research_unlimited_tokens_conflicts_with_max_tokens');
  }
  if (unlimitedCost === true && maxCostUsdSpecified === true) {
    throw new Error('autonomous_research_unlimited_cost_conflicts_with_max_cost_usd');
  }
  const provenance = buildAutonomousResearchDirectLocalRunCliProvenance({
    campaignId,
    paperId,
  });
  return Object.freeze({
    budgets: Object.freeze({
      ...(unlimitedTokens === true
        ? { maxTokenCount: AUTONOMOUS_RESEARCH_UNLIMITED_BUDGET_SENTINEL } : {}),
      ...(unlimitedCost === true
        ? { maxCostUsd: AUTONOMOUS_RESEARCH_UNLIMITED_BUDGET_SENTINEL } : {}),
    }),
    waiver: buildAutonomousResearchDirectLocalRunBudgetWaiver({
      unlimitedTokenCount: unlimitedTokens,
      unlimitedCostUsd: unlimitedCost,
      provenance,
    }),
    provenance,
  });
}

export function autonomousResearchCommandExitCode({
  action,
  launchMode = 'production-run',
  report,
  requireFullReady = false,
  requireLaunchReady = false,
  requireBoundedGoldenReady = false,
} = {}) {
  const localReady = launchMode === LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE
    && report?.localResearchWritingReady === true;
  const boundedGoldenReady = action === 'converge'
    && launchMode === 'golden-bootstrap'
    && report?.boundedGoldenQualificationPublished === true;
  if (action === 'converge' && !localReady && !boundedGoldenReady
    && report?.status !== 'autonomous_research_campaign_completed_and_qualified') return 2;
  if (requireBoundedGoldenReady && !boundedGoldenReady) return 2;
  if (requireFullReady) {
    const fullReady = action === 'prepare'
      ? report?.unattendedCampaignLaunchReady === true
        && report?.externalQualificationServiceReady === true
      : report?.campaignFullyQualified === true;
    if (!fullReady) return 2;
  }
  if (requireLaunchReady) {
    const launchReady = action === 'prepare'
      ? report?.unattendedCampaignLaunchReady === true
      : report?.autonomousExecutionLaunchReady === true
        || report?.qualificationEligibility?.autonomousExecutionLaunchReady === true;
    if (!launchReady) return 2;
  }
  return 0;
}
