import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  verifyAutonomousResearchOneShotCampaignAttemptReservation,
  verifyAutonomousResearchOneShotCampaignExecutionBinding,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';

export function autonomousResearchOneShotCampaignAttemptIdempotencyKey(
  executionBinding,
) {
  if (!verifyAutonomousResearchOneShotCampaignExecutionBinding(executionBinding)) {
    throw new Error('autonomous_research_one_shot_execution_binding_invalid');
  }
  return hashRecord(
    'AutonomousResearchOneShotCampaignAttemptIdempotencyKey',
    {
      campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
      executionBindingHash: hashRecord(
        'AutonomousResearchOneShotCampaignExecutionBinding',
        executionBinding,
      ),
    },
  );
}

function replayReservationProjection(reservation) {
  return {
    version: reservation.version,
    kind: reservation.kind,
    status: reservation.status,
    attemptId: reservation.attemptId,
    idempotencyKey: reservation.idempotencyKey,
    campaignId: reservation.campaignId,
    protectedCampaignId: reservation.protectedCampaignId,
    executionBinding: reservation.executionBinding,
    executionBindingHash: reservation.executionBindingHash,
  };
}

export function selectAutonomousResearchOneShotCampaignAttemptReservation({
  existing,
  candidateReservation,
} = {}) {
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(candidateReservation)) {
    throw new Error('autonomous_research_one_shot_candidate_reservation_invalid');
  }
  if (!existing) return candidateReservation;
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(existing.reservation)
    || typeof existing.headPhase !== 'string'
    || stableStringify(replayReservationProjection(existing.reservation))
      !== stableStringify(replayReservationProjection(candidateReservation))) {
    throw new Error('autonomous_research_one_shot_existing_reservation_binding_mismatch');
  }
  // A durable provider_completed marker is not authenticated strongly enough
  // to authorize a later launch after process restart. Refuse the recovery
  // side effect instead of letting a pre-seeded journal skip the live canary.
  if (existing.headPhase === 'provider_completed') {
    throw new Error(
      'autonomous_research_one_shot_existing_provider_completion_not_launch_authority',
    );
  }
  return existing.reservation;
}
