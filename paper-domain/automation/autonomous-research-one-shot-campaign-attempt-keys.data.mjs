export const AUTONOMOUS_RESEARCH_ONE_SHOT_RESERVATION_KEYS = Object.freeze([
  'attemptId', 'autonomousResearchOneShotCampaignAttemptReservationHash',
  'campaignId', 'executionBinding', 'executionBindingHash', 'idempotencyKey',
  'kind', 'protectedCampaignId', 'reservedAt', 'status', 'version',
].sort());

export const AUTONOMOUS_RESEARCH_ONE_SHOT_EVENT_KEYS = Object.freeze([
  'attemptId', 'autonomousResearchOneShotCampaignAttemptEventHash', 'campaignId',
  'eventId', 'evidence', 'evidenceHash', 'idempotencyKey', 'kind', 'phase',
  'previousEventHash', 'recordedAt', 'reservationHash', 'sequence', 'version',
].sort());

export const AUTONOMOUS_RESEARCH_ONE_SHOT_RECEIPT_KEYS = Object.freeze([
  'attemptId', 'autonomousResearchOneShotCampaignAttemptTerminalReceiptHash',
  'campaignId', 'completedAt', 'idempotencyKey', 'kind', 'lastEventHash',
  'lastPhase', 'launchMayHaveStarted', 'outcome', 'outcomeHash',
  'providerCompleted', 'providerMayHaveStarted', 'reservationHash', 'status',
  'terminalStatus', 'version',
].sort());
