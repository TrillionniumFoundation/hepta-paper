import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const AUTONOMOUS_RESEARCH_LAUNCH_MODES = Object.freeze({
  GOLDEN_BOOTSTRAP: 'golden-bootstrap',
  PRODUCTION_RUN: 'production-run',
});
export const AUTONOMOUS_RESEARCH_LAUNCH_VALIDITY_SAFETY_MARGIN_MS = 15 * 60 * 1000;

export function resolvePersistedAutonomousResearchLaunchMode({
  campaign,
  requestedLaunchMode = null,
} = {}) {
  const preparation = campaign?.spec?.autonomousResearchPreparation || null;
  if (!preparation || preparation.version !== 1
    || preparation.kind !== 'AutonomousResearchLoopPreparationReport') {
    throw new Error('autonomous_research_persisted_preparation_required');
  }
  const { autonomousResearchLoopPreparationReportHash: claimedHash, ...payload } = preparation;
  if (hashRecord('AutonomousResearchLoopPreparationReport', payload) !== claimedHash) {
    throw new Error('autonomous_research_persisted_preparation_hash_invalid');
  }
  const persistedMode = preparation.launchMode;
  const launchMode = persistedMode === undefined
    ? AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN : persistedMode;
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(launchMode)) {
    throw new Error(`autonomous_research_persisted_launch_mode_invalid:${launchMode}`);
  }
  if (requestedLaunchMode !== null && requestedLaunchMode !== launchMode) {
    throw new Error(
      `autonomous_research_launch_mode_mismatch:${launchMode}:${requestedLaunchMode}`,
    );
  }
  return Object.freeze({
    launchMode,
    legacyLaunchModeMissing: persistedMode === undefined,
    budgets: Object.freeze({ ...(campaign?.spec?.budgets || {}) }),
  });
}

const MUTATING_OR_PROVIDER_ACTIONS = new Set(['launch', 'resume', 'converge']);
const BUDGET_KEYS = Object.freeze([
  'maxWallTimeMs',
  'maxAgentCalls',
  'maxCpuJobs',
  'maxGpuJobs',
  'maxTokenCount',
  'maxCostUsd',
  'maxMemoryMiB',
]);

const GOLDEN_BOOTSTRAP_HARD_BUDGETS = Object.freeze({
  maxWallTimeMs: 2 * 60 * 60 * 1000,
  maxAgentCalls: 48,
  maxCpuJobs: 128,
  maxGpuJobs: 16,
  maxTokenCount: 300_000,
  maxCostUsd: 100,
  maxMemoryMiB: 8192,
});

const PRODUCTION_DEFAULT_HARD_BUDGETS = Object.freeze({
  maxWallTimeMs: 6 * 60 * 60 * 1000,
  maxAgentCalls: 64,
  maxCpuJobs: 256,
  maxGpuJobs: 32,
  maxTokenCount: 500_000,
  maxCostUsd: 100,
  maxMemoryMiB: 8192,
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedMode(value) {
  const mode = String(value || '').trim();
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(mode)) {
    throw new Error(`autonomous_research_launch_mode_invalid:${mode || '<empty>'}`);
  }
  return mode;
}

function normalizedBudgets(mode, budgets) {
  const defaults = mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
    ? GOLDEN_BOOTSTRAP_HARD_BUDGETS : PRODUCTION_DEFAULT_HARD_BUDGETS;
  const source = budgets && typeof budgets === 'object' && !Array.isArray(budgets) ? budgets : {};
  const normalized = Object.fromEntries(BUDGET_KEYS.map((key) => {
    const value = source[key] === undefined ? defaults[key] : finiteNonNegative(source[key]);
    if (value === null) throw new Error(`autonomous_research_launch_budget_invalid:${key}`);
    return [key, mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
      ? Math.min(value, defaults[key]) : value];
  }));
  return normalized;
}

export function resolveAutonomousResearchProviderPricing({
  researchAuthorProvider = null,
  researchAuthorModel = null,
  formalReviewerProvider = null,
  formalReviewerModel = null,
  researchAuthorMaximumCostPerCallUsd = null,
  formalReviewerMaximumCostPerCallUsd = null,
} = {}) {
  const authorMaximum = finitePositive(researchAuthorMaximumCostPerCallUsd);
  const reviewerMaximum = finitePositive(formalReviewerMaximumCostPerCallUsd);
  const blockers = [];
  if (!authorMaximum) blockers.push('autonomous_research_research_author_provider_pricing_unknown');
  if (!reviewerMaximum) blockers.push('autonomous_research_formal_reviewer_provider_pricing_unknown');
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchProviderPricingInspection',
    status: blockers.length
      ? 'autonomous_research_provider_pricing_unknown'
      : 'autonomous_research_provider_pricing_bounded',
    pricingAuthority: 'operator-configured-maximum-cost-per-provider-call-v1',
    researchAuthor: Object.freeze({
      provider: researchAuthorProvider || null,
      model: researchAuthorModel || null,
      maximumCostPerCallUsd: authorMaximum,
    }),
    formalReviewer: Object.freeze({
      provider: formalReviewerProvider || null,
      model: formalReviewerModel || null,
      maximumCostPerCallUsd: reviewerMaximum,
    }),
    maximumCostPerCallUsd: authorMaximum && reviewerMaximum
      ? Math.max(authorMaximum, reviewerMaximum) : null,
    providerCanaryPairMaximumCostUsd: authorMaximum && reviewerMaximum
      ? authorMaximum + reviewerMaximum : null,
    pricingKnown: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchProviderPricingInspectionHash:
      hashRecord('AutonomousResearchProviderPricingInspection', payload),
  });
}

export function evaluateAutonomousResearchLaunchModeGate({
  launchMode,
  action,
  budgets = {},
  providerPricingInspection = null,
  fullResearchReadiness = null,
  admissionOnly = false,
} = {}) {
  const mode = normalizedMode(launchMode);
  const normalizedAction = String(action || '').trim();
  if (!['prepare', 'launch', 'status', 'resume', 'converge'].includes(normalizedAction)) {
    throw new Error(`autonomous_research_campaign_action_invalid:${normalizedAction || '<empty>'}`);
  }
  const effectiveBudgets = normalizedBudgets(mode, budgets);
  const blockers = [];
  const providerOrMutationRequested = MUTATING_OR_PROVIDER_ACTIONS.has(normalizedAction);
  const production = mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN;
  const requiredValidityMs = effectiveBudgets.maxWallTimeMs
    + AUTONOMOUS_RESEARCH_LAUNCH_VALIDITY_SAFETY_MARGIN_MS;
  const runtimeRemainingValidityMs = finitePositive(
    fullResearchReadiness?.runtimeImageReproducibility?.remainingValidityMs,
  );
  const qualificationRemainingValidityMs = finitePositive(
    fullResearchReadiness?.fullResearchQualification?.remainingValidityMs,
  );
  const runtimeValidityWindowReady = !production || !providerOrMutationRequested
    || (runtimeRemainingValidityMs !== null
      && runtimeRemainingValidityMs > requiredValidityMs);
  const qualificationValidityWindowReady = !production || !providerOrMutationRequested
    || (qualificationRemainingValidityMs !== null
      && qualificationRemainingValidityMs > requiredValidityMs);
  const fullReadinessVerified = !production || !providerOrMutationRequested
    || ((admissionOnly === true
      ? fullResearchReadiness?.productionEnqueueAdmissionReady === true
      : fullResearchReadiness?.fullResearchQualificationReady === true
        && fullResearchReadiness?.campaignFullyQualified === true
        && fullResearchReadiness?.fullAutomaticResearchWritingReady === true
        && fullResearchReadiness?.researchExecutionReleaseAttestorProductionReady === true)
      && fullResearchReadiness?.runtimeImageReproducibilityReady === true
      && runtimeValidityWindowReady && qualificationValidityWindowReady);
  if (!fullReadinessVerified) {
    blockers.push('autonomous_research_production_full_readiness_required');
  }
  if (production && providerOrMutationRequested && !runtimeValidityWindowReady) {
    blockers.push('autonomous_research_runtime_receipt_validity_window_insufficient');
  }
  if (production && providerOrMutationRequested && !qualificationValidityWindowReady) {
    blockers.push('autonomous_research_qualification_receipt_validity_window_insufficient');
  }

  let maximumAffordableAgentCalls = null;
  if (providerOrMutationRequested) {
    if (providerPricingInspection?.pricingKnown !== true
      || !finitePositive(providerPricingInspection?.maximumCostPerCallUsd)) {
      blockers.push('autonomous_research_provider_pricing_required');
      blockers.push(...(providerPricingInspection?.blockers || []));
    }
    const costCeiling = finitePositive(production
      ? budgets?.maxCostUsd : effectiveBudgets.maxCostUsd);
    if (production && !costCeiling) {
      blockers.push('autonomous_research_production_cost_ceiling_required');
    }
    if (costCeiling && finitePositive(providerPricingInspection?.maximumCostPerCallUsd)) {
      maximumAffordableAgentCalls = Math.floor(
        costCeiling / providerPricingInspection.maximumCostPerCallUsd,
      );
      if (maximumAffordableAgentCalls < 1) {
        blockers.push('autonomous_research_production_cost_ceiling_cannot_fund_one_call');
      } else {
        effectiveBudgets.maxAgentCalls = Math.min(
          effectiveBudgets.maxAgentCalls,
          maximumAffordableAgentCalls,
        );
      }
    }
  }

  const hardBudgetReady = ['maxWallTimeMs', 'maxAgentCalls', 'maxCostUsd']
    .every((key) => finitePositive(effectiveBudgets[key]));
  if (providerOrMutationRequested && !hardBudgetReady) {
    blockers.push('autonomous_research_independent_hard_budget_required');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchLaunchModeGate',
    status: uniqueBlockers.length
      ? 'autonomous_research_launch_mode_blocked'
      : 'autonomous_research_launch_mode_ready',
    launchMode: mode,
    action: normalizedAction,
    admissionOnly: admissionOnly === true,
    providerOrMutationRequested,
    goldenBootstrap: mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP,
    productionRun: production,
    fullReadinessVerified,
    releaseSignerProductionReady:
      fullResearchReadiness?.researchExecutionReleaseAttestorProductionReady === true,
    productionEnqueueAdmissionReady:
      fullResearchReadiness?.productionEnqueueAdmissionReady === true,
    runtimeImageReproducibilityReady:
      fullResearchReadiness?.runtimeImageReproducibilityReady === true,
    requiredReceiptValidityMs: requiredValidityMs,
    runtimeRemainingValidityMs,
    qualificationRemainingValidityMs,
    runtimeValidityWindowReady,
    qualificationValidityWindowReady,
    providerPricingKnown: providerPricingInspection?.pricingKnown === true,
    providerPricingInspectionHash:
      providerPricingInspection?.autonomousResearchProviderPricingInspectionHash || null,
    maximumCostPerCallUsd: providerPricingInspection?.maximumCostPerCallUsd || null,
    providerCanaryPairMaximumCostUsd:
      providerPricingInspection?.providerCanaryPairMaximumCostUsd || null,
    maximumAffordableAgentCalls,
    providerTokenUsageMetered: false,
    tokenBudgetAssurance: 'prompt_only_not_a_hard_provider_limit',
    costBoundViaConfiguredProviderMaximumPerCall:
      providerOrMutationRequested && maximumAffordableAgentCalls !== null,
    effectiveBudgets: Object.freeze({ ...effectiveBudgets }),
    budgetPolicy: production
      ? 'production-priced-cost-ceiling-plus-independent-hard-limits-v1'
      : 'golden-bootstrap-priced-call-cost-and-wall-limits-v2',
    unknownProviderCostTreatedAsUnlimited: false,
    workspaceMutationPermitted: uniqueBlockers.length === 0 && providerOrMutationRequested,
    storeMutationPermitted: uniqueBlockers.length === 0 && providerOrMutationRequested,
    providerExecutionPermitted: admissionOnly !== true
      && uniqueBlockers.length === 0 && providerOrMutationRequested,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchLaunchModeGateHash:
      hashRecord('AutonomousResearchLaunchModeGate', payload),
  });
}
