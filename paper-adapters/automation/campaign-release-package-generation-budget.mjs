function executionBudgetError(code, { deferred = false } = {}) {
  const error = new Error(code);
  error.code = code;
  if (deferred) {
    error.retryable = true;
    error.stateRecoverabilityDeferred = true;
  }
  return error;
}

export function campaignReleaseGenerationLeaseWaitBudgetMs(
  executionBudget,
  clock,
  maximumWaitMs,
) {
  if (executionBudget === null || executionBudget === undefined) {
    return maximumWaitMs;
  }
  if (!executionBudget || typeof executionBudget !== 'object') {
    throw executionBudgetError('campaign_release_execution_budget_invalid');
  }
  const candidates = [];
  if (executionBudget.remainingWallTimeMs !== undefined) {
    const remaining = Number(executionBudget.remainingWallTimeMs);
    if (!Number.isFinite(remaining)) {
      throw executionBudgetError('campaign_release_execution_budget_invalid');
    }
    if (remaining <= 0) {
      throw executionBudgetError(
        'campaign_release_execution_budget_exhausted',
        { deferred: true },
      );
    }
    candidates.push(remaining);
  }
  if (executionBudget.absoluteDeadlineEpochMs !== undefined) {
    const deadline = Number(executionBudget.absoluteDeadlineEpochMs);
    const observedAt = clock?.now?.() || new Date();
    const observedAtMs = observedAt instanceof Date ? observedAt.getTime() : Number.NaN;
    if (!Number.isFinite(deadline) || !Number.isFinite(observedAtMs)) {
      throw executionBudgetError('campaign_release_execution_budget_invalid');
    }
    const remaining = deadline - observedAtMs;
    if (remaining <= 0) {
      throw executionBudgetError(
        'campaign_release_execution_budget_exhausted',
        { deferred: true },
      );
    }
    candidates.push(remaining);
  }
  if (!candidates.length) return maximumWaitMs;
  const budgetWaitMs = Math.max(1, Math.floor(Math.min(...candidates)));
  return maximumWaitMs === undefined
    ? budgetWaitMs
    : Math.min(Number(maximumWaitMs), budgetWaitMs);
}
