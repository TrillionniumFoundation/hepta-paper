import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

export const H = (label) => hashRecord('AutonomousSupervisorTestHash', { label });

export function campaign(campaignId, status, stopReason = null) {
  return {
    campaignId,
    paperId: campaignId.split(':').at(-1),
    status,
    stopReason,
    costKnown: true,
    costUsd: 2,
    spec: {
      budgets: { maxCostUsd: 100 },
      autonomousResearchPreparation: {
        proposal: { paperId: campaignId.split(':').at(-1) },
        autonomousResearchProviderConfigurationHash: H('supervisor-provider-configuration'),
      },
    },
  };
}

export function readinessLifecycle(now, overrides = {}) {
  return {
    absoluteDeadlineAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    policy: {
      qualificationRenewalLeadMs: 15 * 60 * 1000,
      qualificationActionSafetyMarginMs: 15 * 60 * 1000,
      qualificationMaximumTotalAttempts: 48,
      qualificationMaximumTotalCostUsd: 25,
      qualificationAttemptReservationCostUsd: 0.05,
      ...overrides,
    },
  };
}
