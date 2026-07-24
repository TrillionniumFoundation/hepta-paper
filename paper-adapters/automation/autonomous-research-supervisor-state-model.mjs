import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchScientificDispositionReceipt,
} from '../../paper-domain/automation/autonomous-research-scientific-disposition-contract.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function boundedAutonomousResearchSupervisorInteger(
  value,
  fallback,
  minimum,
  maximum,
) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate)) return fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function number(value, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback : Number(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

export function autonomousResearchSupervisorTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_supervisor_clock_invalid');
  }
  return date;
}

export function normalizeAutonomousResearchSupervisorLifecyclePolicy(value = {}) {
  const leaseMs = boundedAutonomousResearchSupervisorInteger(
    value.leaseMs, 15 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000,
  );
  const baseCooldownMs = boundedAutonomousResearchSupervisorInteger(
    value.baseCooldownMs, 1000, 100, 60 * 60 * 1000,
  );
  const maximumCooldownMs = Math.max(baseCooldownMs, boundedAutonomousResearchSupervisorInteger(
    value.maximumCooldownMs,
    5 * 60 * 1000,
    baseCooldownMs,
    24 * 60 * 60 * 1000,
  ));
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorLifecyclePolicy',
    maximumDispatches: boundedAutonomousResearchSupervisorInteger(
      value.maximumDispatches, 256, 1, 10_000),
    maximumProviderCanaries: boundedAutonomousResearchSupervisorInteger(
      value.maximumProviderCanaries, 64, 1, 1000),
    maximumConsecutiveFailures: boundedAutonomousResearchSupervisorInteger(
      value.maximumConsecutiveFailures, 32, 1, 1000),
    maximumLifecycleCostUsd: number(value.maximumLifecycleCostUsd, 150, 0.01, 100_000),
    maximumLifetimeMs: boundedAutonomousResearchSupervisorInteger(value.maximumLifetimeMs,
      7 * 24 * 60 * 60 * 1000, 60 * 1000, 30 * 24 * 60 * 60 * 1000),
    leaseMs,
    baseCooldownMs,
    maximumCooldownMs,
    providerCanaryIntervalMs: boundedAutonomousResearchSupervisorInteger(
      value.providerCanaryIntervalMs,
      15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    providerCanaryReservationCostUsd: number(
      value.providerCanaryReservationCostUsd, 0, 0, 1000),
    qualificationMaximumTotalAttempts: boundedAutonomousResearchSupervisorInteger(
      value.qualificationMaximumTotalAttempts, 48, 1, 1000),
    qualificationMaximumTotalCostUsd: number(
      value.qualificationMaximumTotalCostUsd, 25, 0.01, 10_000),
    qualificationAttemptReservationCostUsd: number(
      value.qualificationAttemptReservationCostUsd, 0.05, 0.000001, 1000),
    qualificationRenewalLeadMs: boundedAutonomousResearchSupervisorInteger(
      value.qualificationRenewalLeadMs,
      15 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    qualificationActionSafetyMarginMs: boundedAutonomousResearchSupervisorInteger(
      value.qualificationActionSafetyMarginMs,
      15 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000),
  });
  if (payload.providerCanaryReservationCostUsd * payload.maximumProviderCanaries
      + payload.qualificationMaximumTotalCostUsd > payload.maximumLifecycleCostUsd) {
    throw new Error('autonomous_research_supervisor_lifecycle_cost_envelope_invalid');
  }
  return Object.freeze({
    ...payload,
    lifecyclePolicyHash: hashRecord('AutonomousResearchSupervisorLifecyclePolicy', payload),
  });
}

function parsePolicy(row) {
  let policy;
  try { policy = JSON.parse(String(row.policy_json || '')); }
  catch { throw new Error('autonomous_research_supervisor_policy_state_invalid'); }
  const { lifecyclePolicyHash, ...input } = policy;
  const normalized = normalizeAutonomousResearchSupervisorLifecyclePolicy(input);
  if (!SHA256.test(String(lifecyclePolicyHash || ''))
    || lifecyclePolicyHash !== row.policy_hash
    || lifecyclePolicyHash !== normalized.lifecyclePolicyHash) {
    throw new Error('autonomous_research_supervisor_policy_state_invalid');
  }
  return normalized;
}

export function mapAutonomousResearchSupervisorStateRow(row) {
  if (!row) return null;
  const policy = parsePolicy(row);
  let lastOutcome = null;
  if (row.last_outcome_json) {
    try { lastOutcome = JSON.parse(row.last_outcome_json); }
    catch { throw new Error('autonomous_research_supervisor_outcome_state_invalid'); }
    const receipt = lastOutcome?.scientificDispositionReceipt || null;
    const receiptHash = lastOutcome?.scientificDispositionReceiptHash || null;
    if ((receipt === null) !== (receiptHash === null)
      || (receipt && (!verifyAutonomousResearchScientificDispositionReceipt(receipt)
        || receiptHash
          !== receipt.autonomousResearchScientificDispositionReceiptHash))) {
      throw new Error('autonomous_research_supervisor_outcome_state_invalid');
    }
  }
  const activeDispatchPhase = row.active_dispatch_phase || null;
  const activeDispatchCount = row.active_dispatch_count === null
    || row.active_dispatch_count === undefined ? null : Number(row.active_dispatch_count);
  const activeDispatchLeaseGeneration = row.active_dispatch_lease_generation === null
    || row.active_dispatch_lease_generation === undefined
    ? null : Number(row.active_dispatch_lease_generation);
  const activeDispatchReservationHash = row.active_dispatch_reservation_hash || null;
  if ((activeDispatchPhase === null) !== (activeDispatchCount === null)
    || (activeDispatchPhase === null) !== (activeDispatchLeaseGeneration === null)
    || (activeDispatchPhase === null) !== (activeDispatchReservationHash === null)
    || (activeDispatchPhase !== null
      && (!['reserved', 'started', 'recovery_pending', 'resumable']
        .includes(activeDispatchPhase)
        || !Number.isSafeInteger(activeDispatchCount) || activeDispatchCount < 1
        || !Number.isSafeInteger(activeDispatchLeaseGeneration)
        || activeDispatchLeaseGeneration < 1
        || !SHA256.test(activeDispatchReservationHash)))) {
    throw new Error('autonomous_research_supervisor_active_dispatch_state_invalid');
  }
  return Object.freeze({
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    disposition: row.disposition,
    policy,
    lifecycleStartedAt: row.lifecycle_started_at,
    absoluteDeadlineAt: row.absolute_deadline_at,
    dispatchCount: Number(row.dispatch_count),
    activeDispatchPhase,
    activeDispatchCount,
    activeDispatchLeaseGeneration,
    activeDispatchReservationHash,
    providerCanaryCount: Number(row.provider_canary_count),
    providerCanaryReservedCostUsd: Number(row.provider_canary_reserved_cost_usd),
    observedCampaignCostUsd: Number(row.observed_campaign_cost_usd),
    observedQualificationReservedCostUsd:
      Number(row.observed_qualification_reserved_cost_usd),
    costKnown: Boolean(row.cost_known),
    consecutiveFailures: Number(row.consecutive_failures),
    nextDispatchAt: row.next_dispatch_at,
    lastProviderCanaryAt: row.last_provider_canary_at || null,
    lastProviderCanaryStatus: row.last_provider_canary_status || null,
    lastProviderCanaryReceiptHash: row.last_provider_canary_receipt_hash || null,
    lastOutcome,
    lastError: row.last_error || null,
    terminalReason: row.terminal_reason || null,
    recoveredLeaseCount: Number(row.recovered_lease_count),
    leaseOwner: row.lease_owner || null,
    leaseToken: row.lease_token || null,
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function autonomousResearchSupervisorLeaseIdentity(value = {}) {
  if (!SAFE_ID.test(String(value.campaignId || ''))
    || !SAFE_ID.test(String(value.ownerId || ''))
    || !SAFE_ID.test(String(value.leaseToken || ''))
    || !Number.isSafeInteger(Number(value.leaseGeneration))
    || Number(value.leaseGeneration) < 1) {
    throw new Error('autonomous_research_supervisor_lease_identity_invalid');
  }
  return Object.freeze({
    campaignId: String(value.campaignId),
    ownerId: String(value.ownerId),
    leaseToken: String(value.leaseToken),
    leaseGeneration: Number(value.leaseGeneration),
  });
}

export function boundedAutonomousResearchSupervisorOutcome(value) {
  if (value === null || value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 64 * 1024) {
    throw new Error('autonomous_research_supervisor_outcome_too_large');
  }
  return serialized;
}
