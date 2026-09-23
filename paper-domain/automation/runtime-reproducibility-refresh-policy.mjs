import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const OPERATOR_COST_AUTHORITY = 'operator_declared_worst_case_usd';
const ZERO_COST_AUTHORITY = 'externally_operated_zero_cost';
const FIXED_BUDGET_EPOCH_MS = 24 * 60 * 60 * 1000;

function integer(value, fallback, minimum, maximum, blocker) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(blocker);
  }
  return candidate;
}

function finiteNumber(value, minimum, maximum, blocker) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(blocker);
  }
  return candidate;
}

export function normalizeRuntimeReproducibilityRefreshPolicy(value = {}) {
  if (value.budgetEpochMs !== undefined
    && Number(value.budgetEpochMs) !== FIXED_BUDGET_EPOCH_MS) {
    throw new Error('runtime_reproducibility_refresh_budget_epoch_fixed');
  }
  const baseBackoffMs = integer(
    value.baseBackoffMs,
    30_000,
    100,
    60 * 60 * 1000,
    'runtime_reproducibility_refresh_base_backoff_invalid',
  );
  const maximumBackoffMs = integer(
    value.maximumBackoffMs,
    5 * 60 * 1000,
    baseBackoffMs,
    24 * 60 * 60 * 1000,
    'runtime_reproducibility_refresh_maximum_backoff_invalid',
  );
  const payload = Object.freeze({
    version: 1,
    kind: 'RuntimeReproducibilityRefreshPolicy',
    budgetEpochMs: FIXED_BUDGET_EPOCH_MS,
    maximumAttemptsPerEpoch: integer(
      value.maximumAttemptsPerEpoch,
      null,
      1,
      10_000,
      'runtime_reproducibility_refresh_maximum_attempts_required',
    ),
    maximumCostUsdPerEpoch: finiteNumber(
      value.maximumCostUsdPerEpoch,
      0,
      100_000_000,
      'runtime_reproducibility_refresh_maximum_cost_required',
    ),
    leaseMs: integer(
      value.leaseMs,
      10 * 60 * 1000,
      1000,
      4 * 60 * 60 * 1000,
      'runtime_reproducibility_refresh_lease_invalid',
    ),
    baseBackoffMs,
    maximumBackoffMs,
    renewalLeadMs: integer(
      value.renewalLeadMs,
      60 * 60 * 1000,
      1000,
      24 * 60 * 60 * 1000,
      'runtime_reproducibility_refresh_renewal_lead_invalid',
    ),
    actionSafetyMarginMs: integer(
      value.actionSafetyMarginMs,
      15 * 60 * 1000,
      15 * 60 * 1000,
      60 * 60 * 1000,
      'runtime_reproducibility_refresh_action_safety_margin_invalid',
    ),
  });
  return Object.freeze({
    ...payload,
    runtimeReproducibilityRefreshPolicyHash: hashRecord(
      'RuntimeReproducibilityRefreshPolicy',
      payload,
    ),
  });
}

export function runtimeReproducibilityBudgetEpoch(policy, nowEpochMs) {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
    throw new Error('runtime_reproducibility_refresh_clock_invalid');
  }
  const epochStartEpochMs = Math.floor(nowEpochMs / policy.budgetEpochMs)
    * policy.budgetEpochMs;
  return Object.freeze({
    epochStartEpochMs,
    epochEndEpochMs: epochStartEpochMs + policy.budgetEpochMs,
  });
}

export function runtimeReproducibilityReservation(configuration = {}) {
  const maximumVerificationCostUsd = finiteNumber(
    configuration.maximumVerificationCostUsd,
    0,
    1_000_000,
    'runtime_reproducibility_refresh_verification_cost_unknown',
  );
  const verificationCostAuthority = String(configuration.verificationCostAuthority || '');
  const validAuthority = maximumVerificationCostUsd === 0
    ? verificationCostAuthority === ZERO_COST_AUTHORITY
    : verificationCostAuthority === OPERATOR_COST_AUTHORITY;
  if (!validAuthority) {
    throw new Error('runtime_reproducibility_refresh_verification_cost_unknown');
  }
  const configurationIdentityHash = String(configuration.configurationIdentityHash || '');
  if (!/^sha256:[0-9a-f]{64}$/i.test(configurationIdentityHash)) {
    throw new Error('runtime_reproducibility_refresh_configuration_identity_invalid');
  }
  return Object.freeze({
    configurationIdentityHash,
    maximumVerificationCostUsd,
    verificationCostAuthority,
  });
}

export function assertRuntimeReproducibilityRefreshLead({ policy, configuration } = {}) {
  const minimumRefreshLeadMs = Number(configuration?.minimumRefreshLeadMs);
  const maximumReceiptAgeMs = Number(configuration?.maximumReceiptAgeMs);
  if (!Number.isSafeInteger(minimumRefreshLeadMs) || minimumRefreshLeadMs < 1
    || !Number.isSafeInteger(maximumReceiptAgeMs) || maximumReceiptAgeMs < 1
    || policy.renewalLeadMs < minimumRefreshLeadMs + policy.maximumBackoffMs
    || policy.renewalLeadMs >= maximumReceiptAgeMs) {
    throw new Error('runtime_reproducibility_refresh_lead_insufficient');
  }
  return true;
}

export function runtimeReproducibilityRefreshRequired({
  receiptReady,
  receiptExpiresAtEpochMs,
  policy,
  nowEpochMs,
  requiredValidityMs = null,
} = {}) {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
    throw new Error('runtime_reproducibility_refresh_clock_invalid');
  }
  if (receiptReady !== true || !Number.isSafeInteger(receiptExpiresAtEpochMs)) return true;
  const coverageMs = Number.isSafeInteger(requiredValidityMs) && requiredValidityMs >= 0
    ? Math.max(policy.renewalLeadMs, requiredValidityMs)
    : policy.renewalLeadMs;
  return receiptExpiresAtEpochMs - nowEpochMs <= coverageMs;
}
