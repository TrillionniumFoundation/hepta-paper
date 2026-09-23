import {
  FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  inspectAutonomousResearchCampaignExecutionAdmission,
} from '../../paper-domain/automation/autonomous-research-campaign-execution-admission.mjs';
import { elapsedRunMs } from './campaign-execution-budget-policy.mjs';
import {
  verifyAutonomousResearchScientificDispositionReceipt,
} from '../../paper-domain/automation/autonomous-research-scientific-disposition-contract.mjs';

const CAMPAIGN_TERMINAL = new Set(['failed', 'cancelled']);
const AUTOMATIC_SUPERVISOR_RECOVERY_REASONS = new Set([
  'supervisor_process_shutdown',
  'supervisor_transient_failure',
  'supervisor_lease_lost',
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function autonomousResearchCampaignRequiresExternalSubmission(campaign) {
  return campaign?.spec?.autonomousResearchPreparation?.venueProfileSelection
    ?.requireExternalSubmission === true;
}

function submissionRecoveryDisposition({ campaign, submissionRecovery }) {
  if (!autonomousResearchCampaignRequiresExternalSubmission(campaign)) {
    return Object.freeze({ required: false, ready: true, terminalFailure: false });
  }
  const delivery = submissionRecovery?.delivery || null;
  return Object.freeze({
    required: true,
    ready: delivery?.status === 'autonomous_submission_delivery_completed'
      && delivery?.terminal === true,
    terminalFailure:
      delivery?.status === 'autonomous_submission_delivery_explicit_failure'
      && delivery?.terminal === true,
  });
}

export function remainingAutonomousCampaignWallTimeMs(campaign, nowEpochMs) {
  if (campaign?.status === 'completed') return 0;
  const maximumWallTimeMs = Number(
    campaign?.spec?.budgets?.maxWallTimeMs ?? 6 * 60 * 60 * 1000,
  );
  if (!Number.isSafeInteger(maximumWallTimeMs) || maximumWallTimeMs < 1) {
    throw new Error('autonomous_research_campaign_wall_budget_invalid');
  }
  return Math.max(0, maximumWallTimeMs - elapsedRunMs(campaign, nowEpochMs));
}

export function qualificationMetrics(qualificationState) {
  return Object.freeze({
    totalAttemptCount: Number(qualificationState?.recovery?.totalAttemptCount || 0),
    reservedCostUsd: Object.hasOwn(qualificationState?.recovery || {}, 'reservedCostUsd')
      ? Number(qualificationState.recovery.reservedCostUsd || 0) : 0,
  });
}

export function requiredQualificationValidityMs({ campaign, lifecycle, now } = {}) {
  const remainingWallTimeMs = remainingAutonomousCampaignWallTimeMs(
    campaign,
    now.getTime(),
  );
  return Math.max(
    lifecycle.policy.qualificationRenewalLeadMs,
    campaign?.status === 'completed'
      ? 0 : remainingWallTimeMs + lifecycle.policy.qualificationActionSafetyMarginMs,
  );
}

export function qualificationBindsCurrentRuntime({
  qualificationState,
  runtimeReadiness,
  requiredValidityMs,
  now,
} = {}) {
  const expiresAt = Date.parse(qualificationState?.receipt?.expiresAt || '');
  return qualificationState?.recovery?.status === 'qualification_verified'
    && SHA256.test(String(runtimeReadiness?.receiptHash || ''))
    && qualificationState?.receipt?.runtimeImageReproducibilityReceiptHash
      === runtimeReadiness.receiptHash
    && Number.isFinite(expiresAt)
    && expiresAt - now.getTime() > requiredValidityMs;
}

function qualificationWindow({ campaign, lifecycle, qualificationState, runtimeReadiness, now }) {
  const requiredValidity = requiredQualificationValidityMs({ campaign, lifecycle, now });
  return Object.freeze({
    requiredValidity,
    coverable: requiredValidity < FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS,
    verified: qualificationBindsCurrentRuntime({
      qualificationState,
      runtimeReadiness,
      requiredValidityMs: requiredValidity,
      now,
    }),
  });
}

function runtimeRenewalAt(runtimeReadiness) {
  const renewAt = Date.parse(runtimeReadiness?.renewAt || '');
  return Number.isFinite(renewAt) ? renewAt : 0;
}

function initiallyExecutionAdmitted(campaign) {
  const inspection = inspectAutonomousResearchCampaignExecutionAdmission(campaign?.spec);
  return campaign?.currentPhase === 'admitted-not-authorized'
    && campaign?.stopReason === null
    && inspection.present === true && inspection.valid === true
    && inspection.binding?.campaignId === campaign?.campaignId
    && campaign?.spec?.paperId === campaign?.paperId;
}

export function autonomousResearchSupervisorPausedRecoveryDecision(campaign) {
  if (campaign?.status !== 'paused') return null;
  if (AUTOMATIC_SUPERVISOR_RECOVERY_REASONS.has(campaign.stopReason)
    || initiallyExecutionAdmitted(campaign)) return null;
  return Object.freeze({
    block: true,
    reason: `supervisor_nonrecoverable_paused_campaign:${campaign.stopReason || 'unknown'}`,
  });
}

export function autonomousResearchSupervisorDispatchDecision({
  campaign,
  lifecycle,
  qualificationState,
  runtimeReadiness,
  submissionRecovery = null,
  scientificDispositionReceipt = null,
  now,
} = {}) {
  if (scientificDispositionReceipt) {
    if (!verifyAutonomousResearchScientificDispositionReceipt(scientificDispositionReceipt)
      || scientificDispositionReceipt.source.campaignId !== campaign?.campaignId
      || scientificDispositionReceipt.source.paperId !== campaign?.paperId) {
      return Object.freeze({
        block: true,
        reason: 'autonomous_research_scientific_disposition_receipt_invalid',
      });
    }
    return Object.freeze({
      settle: true,
      reason: scientificDispositionReceipt.settlementReason,
      scientificDispositionReceipt,
    });
  }
  if (CAMPAIGN_TERMINAL.has(campaign.status)) {
    return Object.freeze({ settle: true, reason: `campaign_${campaign.status}` });
  }
  const pausedRecovery = autonomousResearchSupervisorPausedRecoveryDecision(campaign);
  if (pausedRecovery) return pausedRecovery;
  if (campaign.status === 'stopped'
    && !AUTOMATIC_SUPERVISOR_RECOVERY_REASONS.has(campaign.stopReason)) {
    return Object.freeze({
      block: true,
      reason: `supervisor_nonrecoverable_stopped_campaign:${campaign.stopReason || 'unknown'}`,
    });
  }
  if (!['running', 'paused', 'stopped', 'completed'].includes(campaign.status)) {
    return Object.freeze({
      block: true,
      reason: `supervisor_campaign_state_invalid:${campaign.status || 'unknown'}`,
    });
  }
  const window = qualificationWindow({
    campaign, lifecycle, qualificationState, runtimeReadiness, now,
  });
  if (!window.coverable) {
    return Object.freeze({
      block: true,
      reason: 'supervisor_qualification_campaign_window_uncoverable',
    });
  }
  const submission = submissionRecoveryDisposition({ campaign, submissionRecovery });
  if (submission.terminalFailure) {
    return Object.freeze({
      block: true,
      reason: 'autonomous_submission_delivery_explicit_failure',
    });
  }
  if (campaign.status === 'completed' && window.verified && submission.ready) {
    const expiresAt = Date.parse(qualificationState.receipt.expiresAt);
    const renewAt = Math.min(
      expiresAt - window.requiredValidity,
      runtimeRenewalAt(runtimeReadiness),
    );
    const deadline = Date.parse(lifecycle.absoluteDeadlineAt);
    return renewAt >= deadline
      ? Object.freeze({ settle: true, reason: 'qualified_beyond_lifecycle' })
      : Object.freeze({
        deferUntil: new Date(renewAt),
        reason: 'qualification_renewal_scheduled',
      });
  }
  if (campaign.status === 'completed' && window.verified && submission.required) {
    return Object.freeze({
      action: 'resume',
      qualificationRenewalRequired: false,
      requiredQualificationValidityMs: window.requiredValidity,
      qualificationRetry: Object.freeze({
        maximumTotalAttempts: lifecycle.policy.qualificationMaximumTotalAttempts,
        maximumTotalCostUsd: lifecycle.policy.qualificationMaximumTotalCostUsd,
        attemptReservationCostUsd: lifecycle.policy.qualificationAttemptReservationCostUsd,
        renewalLeadMs: window.requiredValidity,
        globalDeadlineMs: Math.max(
          1000,
          Date.parse(lifecycle.absoluteDeadlineAt) - now.getTime(),
        ),
      }),
      reason: 'autonomous_submission_delivery_required',
    });
  }
  const remainingMs = Date.parse(lifecycle.absoluteDeadlineAt) - now.getTime();
  const qualification = qualificationMetrics(qualificationState);
  if (qualification.totalAttemptCount >= lifecycle.policy.qualificationMaximumTotalAttempts) {
    return Object.freeze({ block: true, reason: 'supervisor_qualification_attempt_budget_exhausted' });
  }
  if (qualification.reservedCostUsd >= lifecycle.policy.qualificationMaximumTotalCostUsd) {
    return Object.freeze({ block: true, reason: 'supervisor_qualification_cost_budget_exhausted' });
  }
  return Object.freeze({
    action: 'resume',
    qualificationRenewalRequired: !window.verified,
    requiredQualificationValidityMs: window.requiredValidity,
    qualificationRetry: Object.freeze({
      maximumTotalAttempts: lifecycle.policy.qualificationMaximumTotalAttempts,
      maximumTotalCostUsd: lifecycle.policy.qualificationMaximumTotalCostUsd,
      attemptReservationCostUsd: lifecycle.policy.qualificationAttemptReservationCostUsd,
      renewalLeadMs: window.requiredValidity,
      globalDeadlineMs: Math.max(1000, remainingMs),
    }),
  });
}

export function autonomousResearchSupervisorNextSchedule({
  report,
  campaign,
  qualificationState,
  runtimeReadiness,
  lifecycle,
  now,
  pollMs,
  scientificDispositionReceipt = null,
} = {}) {
  if (scientificDispositionReceipt) {
    if (!verifyAutonomousResearchScientificDispositionReceipt(scientificDispositionReceipt)
      || scientificDispositionReceipt.source.campaignId !== campaign?.campaignId
      || scientificDispositionReceipt.source.paperId !== campaign?.paperId) {
      return Object.freeze({
        settled: false,
        nextAt: now,
        reason: 'autonomous_research_scientific_disposition_receipt_invalid',
        terminalReason: 'autonomous_research_scientific_disposition_receipt_invalid',
      });
    }
    return Object.freeze({
      settled: true,
      nextAt: now,
      reason: scientificDispositionReceipt.settlementReason,
      scientificDispositionReceipt,
    });
  }
  const window = qualificationWindow({
    campaign, lifecycle, qualificationState, runtimeReadiness, now,
  });
  if (!window.coverable) {
    return Object.freeze({
      settled: false,
      nextAt: now,
      reason: 'supervisor_qualification_campaign_window_uncoverable',
      terminalReason: 'supervisor_qualification_campaign_window_uncoverable',
    });
  }
  const deadlineMs = Date.parse(lifecycle.absoluteDeadlineAt);
  const submission = submissionRecoveryDisposition({
    campaign,
    submissionRecovery: { delivery: report?.autonomousSubmission?.delivery || null },
  });
  if (submission.terminalFailure) {
    return Object.freeze({
      settled: false,
      nextAt: now,
      reason: 'autonomous_submission_delivery_explicit_failure',
      terminalReason: 'autonomous_submission_delivery_explicit_failure',
    });
  }
  if (submission.required && !submission.ready) {
    return Object.freeze({
      settled: false,
      nextAt: new Date(Math.min(deadlineMs, now.getTime() + pollMs)),
      reason: 'autonomous_submission_recovery_scheduled',
    });
  }
  const boundedGoldenQualificationPublished = campaign?.status === 'completed'
    && report?.boundedGoldenQualificationPublished === true;
  const completedQualificationOutcome = report?.fullAutomaticResearchWritingReady === true
    ? 'qualified_beyond_lifecycle'
    : boundedGoldenQualificationPublished
      ? 'bounded_golden_qualification_published_beyond_lifecycle'
      : null;
  if (completedQualificationOutcome && window.verified) {
    const expiresAt = Date.parse(qualificationState.receipt.expiresAt);
    const renewAt = Math.min(
      expiresAt - window.requiredValidity,
      runtimeRenewalAt(runtimeReadiness),
    );
    if (renewAt >= deadlineMs) {
      return Object.freeze({
        settled: true,
        nextAt: now,
        reason: completedQualificationOutcome,
      });
    }
    return Object.freeze({
      settled: false,
      nextAt: new Date(Math.min(
        deadlineMs,
        Math.max(now.getTime() + pollMs, renewAt),
      )),
      reason: 'qualification_renewal_scheduled',
    });
  }
  const persistedNext = Date.parse(qualificationState?.recovery?.nextAttemptAt || '');
  return Object.freeze({
    settled: false,
    nextAt: new Date(Math.min(
      deadlineMs,
      Math.max(now.getTime() + pollMs,
        Number.isFinite(persistedNext) ? persistedNext : now.getTime() + pollMs),
    )),
    reason: window.verified
      ? 'supervisor_retry_scheduled'
      : 'qualification_runtime_binding_renewal_required',
  });
}
