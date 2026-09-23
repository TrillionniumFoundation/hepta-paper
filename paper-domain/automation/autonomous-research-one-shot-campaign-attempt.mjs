import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { AUTONOMOUS_RESEARCH_ONE_SHOT_EVENT_KEYS as EVENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_RECEIPT_KEYS as RECEIPT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_RESERVATION_KEYS as RESERVATION_KEYS }
  from './autonomous-research-one-shot-campaign-attempt-keys.data.mjs';
import {
  assertAutonomousResearchOneShotJsonShape,
  canonicalAutonomousResearchOneShotSnapshot,
} from './autonomous-research-one-shot-canonical-json.mjs';
import {
  verifyAutonomousResearchOneShotCampaignExecutionBinding,
  verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit,
} from './autonomous-research-one-shot-campaign-execution-binding.mjs';
import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_HISTORICAL_ATTEMPT_ANCHORS,
} from './autonomous-research-one-shot-historical-attempt-anchors.data.mjs';

export { autonomousResearchOneShotProviderRuntimeBindingHash }
  from './autonomous-research-one-shot-provider-runtime-binding.mjs';
export * from './autonomous-research-one-shot-campaign-execution-binding.mjs';
export {
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
} from './autonomous-research-one-shot-target-campaign.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MAXIMUM_BINDING_BYTES = 64 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 128 * 1024;
const MAXIMUM_OUTCOME_BYTES = 128 * 1024;

export const AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES = Object.freeze([
  'attempt_reserved', 'preconditions_verified', 'prepare_verified', 'provider_started',
  'provider_completed', 'launch_started', 'terminal',
]);

export const AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_TERMINAL_STATUSES = Object.freeze([
    'blocked_pre_provider',
    'blocked_post_provider',
    'completed',
    'failed_terminal',
    'recovered_incomplete',
]);

const PHASE_INDEX = new Map(AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES
  .map((phase, index) => [phase, index]));
const TERMINAL_STATUSES = new Set(
  AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_TERMINAL_STATUSES,
);

function invalid(code) {
  throw new Error(code);
}

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function snapshotHash(kind, value) {
  return value === null ? null : hashRecord(kind, value);
}

function reservationPayload(value) {
  const {
    autonomousResearchOneShotCampaignAttemptReservationHash: claimedHash,
    ...payload
  } = value;
  return { claimedHash, payload };
}

function eventPayload(value) {
  const {
    autonomousResearchOneShotCampaignAttemptEventHash: claimedHash,
    ...payload
  } = value;
  return { claimedHash, payload };
}

function terminalReceiptPayload(value) {
  const {
    autonomousResearchOneShotCampaignAttemptTerminalReceiptHash: claimedHash,
    ...payload
  } = value;
  return { claimedHash, payload };
}

export function canonicalAutonomousResearchOneShotCampaignAttemptJson(value) {
  assertAutonomousResearchOneShotJsonShape(
    value,
    'autonomous_research_one_shot_campaign_attempt_json_invalid',
  );
  return stableStringify(value);
}

export function buildAutonomousResearchOneShotCampaignAttemptReservation({
  attemptId,
  idempotencyKey,
  campaignId,
  protectedCampaignId,
  executionBinding,
  reservedAt,
} = {}) {
  const binding = canonicalAutonomousResearchOneShotSnapshot(executionBinding, {
    code: 'autonomous_research_one_shot_campaign_attempt_binding_invalid',
    maximumBytes: MAXIMUM_BINDING_BYTES,
  });
  if (!SAFE_ID.test(String(attemptId || ''))
    || !SHA256.test(String(idempotencyKey || ''))
    || !SAFE_ID.test(String(campaignId || ''))
    || !SAFE_ID.test(String(protectedCampaignId || ''))
    || campaignId === protectedCampaignId
    || !canonicalInstant(reservedAt)
    || !verifyAutonomousResearchOneShotCampaignExecutionBinding(binding)
    || binding.targetCampaignDefinition.campaignId !== campaignId
    || binding.protectedCampaignDefinition.campaignId !== protectedCampaignId) {
    invalid('autonomous_research_one_shot_campaign_attempt_reservation_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptReservation',
    status: 'attempt_reserved',
    attemptId,
    idempotencyKey,
    campaignId,
    protectedCampaignId,
    executionBinding: binding,
    executionBindingHash: hashRecord(
      'AutonomousResearchOneShotCampaignExecutionBinding',
      binding,
    ),
    reservedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchOneShotCampaignAttemptReservationHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptReservation',
      payload,
    ),
  });
}

export function verifyAutonomousResearchOneShotCampaignAttemptReservation(value) {
  return verifyAutonomousResearchOneShotCampaignAttemptReservationWithBindingPolicy(
    value,
    verifyAutonomousResearchOneShotCampaignExecutionBinding,
  );
}

function verifyAutonomousResearchOneShotCampaignAttemptReservationWithBindingPolicy(
  value,
  verifyExecutionBinding,
) {
  if (!exactKeys(value, RESERVATION_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousResearchOneShotCampaignAttemptReservation'
    || value.status !== 'attempt_reserved'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SHA256.test(String(value.idempotencyKey || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !SAFE_ID.test(String(value.protectedCampaignId || ''))
    || value.campaignId === value.protectedCampaignId
    || !canonicalInstant(value.reservedAt)
    || !SHA256.test(String(value.executionBindingHash || ''))) return false;
  let binding;
  try {
    binding = canonicalAutonomousResearchOneShotSnapshot(value.executionBinding, {
      code: 'autonomous_research_one_shot_campaign_attempt_binding_invalid',
      maximumBytes: MAXIMUM_BINDING_BYTES,
    });
  } catch { return false; }
  if (stableStringify(binding) !== stableStringify(value.executionBinding)
    || !verifyExecutionBinding(binding)
    || binding.targetCampaignDefinition.campaignId !== value.campaignId
    || binding.protectedCampaignDefinition.campaignId !== value.protectedCampaignId
    || hashRecord('AutonomousResearchOneShotCampaignExecutionBinding', binding)
      !== value.executionBindingHash) return false;
  const { claimedHash, payload } = reservationPayload(value);
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchOneShotCampaignAttemptReservation', payload)
      === claimedHash;
}

export function verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit(
  value,
) {
  return verifyAutonomousResearchOneShotCampaignAttemptReservationWithBindingPolicy(
    value,
    verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit,
  );
}

export function buildAutonomousResearchOneShotCampaignAttemptEvent({
  reservation,
  previousEvent = null,
  phase,
  evidence = null,
  eventId = null,
  recordedAt,
} = {}) {
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_reservation_invalid');
  }
  if (!PHASE_INDEX.has(phase)) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_phase_invalid');
  }
  const sequence = previousEvent === null ? 1 : previousEvent.sequence + 1;
  const previousEventHash = previousEvent === null ? null
    : previousEvent.autonomousResearchOneShotCampaignAttemptEventHash;
  if (previousEvent === null) {
    if (phase !== 'attempt_reserved') {
      invalid('autonomous_research_one_shot_campaign_attempt_event_transition_invalid');
    }
  } else if (!verifyAutonomousResearchOneShotCampaignAttemptEvent(previousEvent, {
    reservation,
  }) || previousEvent.phase === 'terminal'
    || (phase !== 'terminal'
      && PHASE_INDEX.get(phase) !== PHASE_INDEX.get(previousEvent.phase) + 1)) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_transition_invalid');
  }
  const canonicalEvidence = canonicalAutonomousResearchOneShotSnapshot(evidence, {
    code: 'autonomous_research_one_shot_campaign_attempt_event_evidence_invalid',
    maximumBytes: MAXIMUM_EVIDENCE_BYTES,
    allowNull: phase !== 'attempt_reserved',
  });
  if (phase === 'attempt_reserved'
    && (stableStringify(canonicalEvidence) !== stableStringify({
      reservationHash:
        reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    }))) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_evidence_invalid');
  }
  const effectiveEventId = eventId || hashRecord(
    'AutonomousResearchOneShotCampaignAttemptEventId',
    {
      attemptId: reservation.attemptId,
      phase,
      reservationHash:
        reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
      sequence,
    },
  );
  if (!SHA256.test(String(effectiveEventId || '')) || !canonicalInstant(recordedAt)
    || (previousEvent && Date.parse(recordedAt) < Date.parse(previousEvent.recordedAt))) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptEvent',
    attemptId: reservation.attemptId,
    idempotencyKey: reservation.idempotencyKey,
    campaignId: reservation.campaignId,
    reservationHash:
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    sequence,
    eventId: effectiveEventId,
    phase,
    previousEventHash,
    evidence: canonicalEvidence,
    evidenceHash: snapshotHash(
      'AutonomousResearchOneShotCampaignAttemptEventEvidence',
      canonicalEvidence,
    ),
    recordedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchOneShotCampaignAttemptEventHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptEvent',
      payload,
    ),
  });
}

export function verifyAutonomousResearchOneShotCampaignAttemptEvent(value, {
  reservation = null,
  previousEvent = undefined,
} = {}) {
  return verifyAutonomousResearchOneShotCampaignAttemptEventWithReservationPolicy(
    value,
    { reservation, previousEvent },
    verifyAutonomousResearchOneShotCampaignAttemptReservation,
  );
}

function verifyAutonomousResearchOneShotCampaignAttemptEventWithReservationPolicy(value, {
  reservation = null,
  previousEvent = undefined,
} = {}, verifyReservation) {
  if (!exactKeys(value, EVENT_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousResearchOneShotCampaignAttemptEvent'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SHA256.test(String(value.idempotencyKey || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !SHA256.test(String(value.reservationHash || ''))
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !SHA256.test(String(value.eventId || ''))
    || !PHASE_INDEX.has(value.phase)
    || (value.previousEventHash !== null
      && !SHA256.test(String(value.previousEventHash || '')))
    || (value.evidenceHash !== null && !SHA256.test(String(value.evidenceHash || '')))
    || !canonicalInstant(value.recordedAt)) return false;
  let evidence;
  try {
    evidence = canonicalAutonomousResearchOneShotSnapshot(value.evidence, {
      code: 'autonomous_research_one_shot_campaign_attempt_event_evidence_invalid',
      maximumBytes: MAXIMUM_EVIDENCE_BYTES,
      allowNull: value.phase !== 'attempt_reserved',
    });
  } catch { return false; }
  if (stableStringify(evidence) !== stableStringify(value.evidence)
    || snapshotHash('AutonomousResearchOneShotCampaignAttemptEventEvidence', evidence)
      !== value.evidenceHash) return false;
  if (reservation && (!verifyReservation(reservation)
    || value.attemptId !== reservation.attemptId
    || value.idempotencyKey !== reservation.idempotencyKey
    || value.campaignId !== reservation.campaignId
    || value.reservationHash
      !== reservation.autonomousResearchOneShotCampaignAttemptReservationHash)) return false;
  if (previousEvent !== undefined) {
    if (previousEvent === null) {
      if (value.sequence !== 1 || value.phase !== 'attempt_reserved'
        || value.previousEventHash !== null
        || !reservation
        || stableStringify(value.evidence) !== stableStringify({
          reservationHash:
            reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
        })) return false;
    } else if (!verifyAutonomousResearchOneShotCampaignAttemptEventWithReservationPolicy(
      previousEvent,
      { reservation },
      verifyReservation,
    ) || value.sequence !== previousEvent.sequence + 1
      || value.previousEventHash
        !== previousEvent.autonomousResearchOneShotCampaignAttemptEventHash
      || Date.parse(value.recordedAt) < Date.parse(previousEvent.recordedAt)
      || previousEvent.phase === 'terminal'
      || (value.phase !== 'terminal'
        && PHASE_INDEX.get(value.phase) !== PHASE_INDEX.get(previousEvent.phase) + 1)) {
      return false;
    }
  }
  const { claimedHash, payload } = eventPayload(value);
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchOneShotCampaignAttemptEvent', payload) === claimedHash;
}

export function verifyAutonomousResearchOneShotCampaignAttemptEventForHistoricalAudit(
  value,
  {
    reservation = null,
    previousEvent = undefined,
  } = {},
) {
  return verifyAutonomousResearchOneShotCampaignAttemptEventWithReservationPolicy(
    value,
    { reservation, previousEvent },
    verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit,
  );
}

export function verifyAutonomousResearchOneShotCampaignAttemptEventSequence({
  reservation,
  events,
} = {}) {
  return verifyAutonomousResearchOneShotCampaignAttemptEventSequenceWithReservationPolicy(
    { reservation, events },
    verifyAutonomousResearchOneShotCampaignAttemptReservation,
    verifyAutonomousResearchOneShotCampaignAttemptEvent,
  );
}

function verifyAutonomousResearchOneShotCampaignAttemptEventSequenceWithReservationPolicy({
  reservation,
  events,
} = {}, verifyReservation, verifyEvent) {
  if (!verifyReservation(reservation)
    || !Array.isArray(events) || events.length < 1
    || events.length > AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES.length) {
    return false;
  }
  let previous = null;
  for (const event of events) {
    if (!verifyEvent(
      event,
      { reservation, previousEvent: previous },
    )) return false;
    previous = event;
  }
  return true;
}

export function verifyAutonomousResearchOneShotCampaignAttemptEventSequenceForHistoricalAudit({
  reservation,
  events,
} = {}) {
  return verifyAutonomousResearchOneShotCampaignAttemptEventSequenceWithReservationPolicy(
    { reservation, events },
    verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit,
    verifyAutonomousResearchOneShotCampaignAttemptEventForHistoricalAudit,
  );
}

export function buildAutonomousResearchOneShotCampaignAttemptTerminalReceipt({
  reservation,
  lastEvent,
  terminalStatus,
  outcome = null,
  completedAt,
} = {}) {
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)
    || !verifyAutonomousResearchOneShotCampaignAttemptEvent(lastEvent, { reservation })
    || lastEvent.phase === 'terminal'
    || !TERMINAL_STATUSES.has(terminalStatus)
    || !canonicalInstant(completedAt)
    || Date.parse(completedAt) < Date.parse(lastEvent.recordedAt)) {
    invalid('autonomous_research_one_shot_campaign_attempt_terminal_receipt_invalid');
  }
  const lastPhaseIndex = PHASE_INDEX.get(lastEvent.phase);
  if ((lastEvent.phase === 'provider_started' && terminalStatus !== 'recovered_incomplete')
    || (terminalStatus === 'recovered_incomplete'
      && !['provider_started', 'launch_started'].includes(lastEvent.phase))
    || (terminalStatus === 'blocked_pre_provider'
      && lastPhaseIndex >= PHASE_INDEX.get('provider_started'))
    || (terminalStatus === 'blocked_post_provider'
      && lastEvent.phase !== 'provider_completed')
    || (['completed', 'failed_terminal'].includes(terminalStatus)
      && lastEvent.phase !== 'launch_started')) {
    invalid('autonomous_research_one_shot_campaign_attempt_terminal_status_invalid');
  }
  const canonicalOutcome = canonicalAutonomousResearchOneShotSnapshot(outcome, {
    code: 'autonomous_research_one_shot_campaign_attempt_terminal_outcome_invalid',
    maximumBytes: MAXIMUM_OUTCOME_BYTES,
    allowNull: true,
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptTerminalReceipt',
    status: 'autonomous_research_one_shot_campaign_attempt_terminal',
    attemptId: reservation.attemptId,
    idempotencyKey: reservation.idempotencyKey,
    campaignId: reservation.campaignId,
    reservationHash:
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    terminalStatus,
    lastPhase: lastEvent.phase,
    lastEventHash:
      lastEvent.autonomousResearchOneShotCampaignAttemptEventHash,
    outcome: canonicalOutcome,
    outcomeHash: snapshotHash(
      'AutonomousResearchOneShotCampaignAttemptTerminalOutcome',
      canonicalOutcome,
    ),
    providerMayHaveStarted: lastPhaseIndex >= PHASE_INDEX.get('provider_started'),
    providerCompleted: lastPhaseIndex >= PHASE_INDEX.get('provider_completed'),
    launchMayHaveStarted: lastPhaseIndex >= PHASE_INDEX.get('launch_started'),
    completedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchOneShotCampaignAttemptTerminalReceiptHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptTerminalReceipt',
      payload,
    ),
  });
}

export function verifyAutonomousResearchOneShotCampaignAttemptTerminalReceipt(value, {
  reservation = null,
  lastEvent = null,
} = {}) {
  return verifyAutonomousResearchOneShotCampaignAttemptTerminalReceiptWithAuditPolicy(
    value,
    { reservation, lastEvent },
    verifyAutonomousResearchOneShotCampaignAttemptReservation,
    verifyAutonomousResearchOneShotCampaignAttemptEvent,
  );
}

function verifyAutonomousResearchOneShotCampaignAttemptTerminalReceiptWithAuditPolicy(
  value,
  {
    reservation = null,
    lastEvent = null,
  } = {},
  verifyReservation,
  verifyEvent,
) {
  if (!exactKeys(value, RECEIPT_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousResearchOneShotCampaignAttemptTerminalReceipt'
    || value.status !== 'autonomous_research_one_shot_campaign_attempt_terminal'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SHA256.test(String(value.idempotencyKey || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !SHA256.test(String(value.reservationHash || ''))
    || !TERMINAL_STATUSES.has(value.terminalStatus)
    || !PHASE_INDEX.has(value.lastPhase) || value.lastPhase === 'terminal'
    || !SHA256.test(String(value.lastEventHash || ''))
    || (value.outcomeHash !== null && !SHA256.test(String(value.outcomeHash || '')))
    || typeof value.providerMayHaveStarted !== 'boolean'
    || typeof value.providerCompleted !== 'boolean'
    || typeof value.launchMayHaveStarted !== 'boolean'
    || !canonicalInstant(value.completedAt)) return false;
  let outcome;
  try {
    outcome = canonicalAutonomousResearchOneShotSnapshot(value.outcome, {
      code: 'autonomous_research_one_shot_campaign_attempt_terminal_outcome_invalid',
      maximumBytes: MAXIMUM_OUTCOME_BYTES,
      allowNull: true,
    });
  } catch { return false; }
  if (stableStringify(outcome) !== stableStringify(value.outcome)
    || snapshotHash('AutonomousResearchOneShotCampaignAttemptTerminalOutcome', outcome)
      !== value.outcomeHash) return false;
  if (reservation && (!verifyReservation(reservation)
    || value.attemptId !== reservation.attemptId
    || value.idempotencyKey !== reservation.idempotencyKey
    || value.campaignId !== reservation.campaignId
    || value.reservationHash
      !== reservation.autonomousResearchOneShotCampaignAttemptReservationHash)) return false;
  if (lastEvent && (!verifyEvent(lastEvent, {
    reservation,
  }) || value.lastPhase !== lastEvent.phase
    || value.lastEventHash
      !== lastEvent.autonomousResearchOneShotCampaignAttemptEventHash
    || Date.parse(value.completedAt) < Date.parse(lastEvent.recordedAt))) return false;
  const phaseIndex = PHASE_INDEX.get(value.lastPhase);
  if (value.providerMayHaveStarted !== (phaseIndex >= PHASE_INDEX.get('provider_started'))
    || value.providerCompleted !== (phaseIndex >= PHASE_INDEX.get('provider_completed'))
    || value.launchMayHaveStarted !== (phaseIndex >= PHASE_INDEX.get('launch_started'))
    || (value.lastPhase === 'provider_started'
      && value.terminalStatus !== 'recovered_incomplete')
    || (value.terminalStatus === 'recovered_incomplete'
      && !['provider_started', 'launch_started'].includes(value.lastPhase))
    || (value.terminalStatus === 'blocked_pre_provider'
      && phaseIndex >= PHASE_INDEX.get('provider_started'))
    || (value.terminalStatus === 'blocked_post_provider'
      && value.lastPhase !== 'provider_completed')
    || (['completed', 'failed_terminal'].includes(value.terminalStatus)
      && value.lastPhase !== 'launch_started')) return false;
  const { claimedHash, payload } = terminalReceiptPayload(value);
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchOneShotCampaignAttemptTerminalReceipt', payload)
      === claimedHash;
}

export function verifyAutonomousResearchOneShotCampaignAttemptTerminalReceiptForHistoricalAudit(
  value,
  {
    reservation = null,
    lastEvent = null,
  } = {},
) {
  return verifyAutonomousResearchOneShotCampaignAttemptTerminalReceiptWithAuditPolicy(
    value,
    { reservation, lastEvent },
    verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit,
    verifyAutonomousResearchOneShotCampaignAttemptEventForHistoricalAudit,
  );
}

export function deriveAutonomousResearchOneShotCampaignAttemptRecoveryDisposition({
  reservation,
  events,
  terminalReceipt = null,
} = {}) {
  return deriveAutonomousResearchOneShotCampaignAttemptRecoveryDispositionWithAuditPolicy(
    { reservation, events, terminalReceipt },
    verifyAutonomousResearchOneShotCampaignAttemptEventSequence,
    verifyAutonomousResearchOneShotCampaignAttemptTerminalReceipt,
  );
}

function deriveAutonomousResearchOneShotCampaignAttemptRecoveryDispositionWithAuditPolicy({
  reservation,
  events,
  terminalReceipt = null,
} = {}, verifyEventSequence, verifyTerminalReceipt) {
  if (!verifyEventSequence({ reservation, events })) {
    invalid('autonomous_research_one_shot_campaign_attempt_sequence_invalid');
  }
  const head = events.at(-1);
  if (head.phase !== 'terminal' && terminalReceipt !== null) {
    invalid('autonomous_research_one_shot_campaign_attempt_terminal_chain_invalid');
  }
  if (head.phase === 'terminal') {
    const previous = events.at(-2);
    if (!previous || !verifyTerminalReceipt(
      terminalReceipt,
      { reservation, lastEvent: previous },
    ) || head.evidence?.terminalReceiptHash
      !== terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash) {
      invalid('autonomous_research_one_shot_campaign_attempt_terminal_chain_invalid');
    }
    return Object.freeze({
      status: 'terminal_replay',
      headPhase: head.phase,
      mayAppendProviderStarted: false,
      mayAppendLaunchStarted: false,
      monitorOnly: false,
      terminalReceipt,
    });
  }
  const dispositionByPhase = Object.freeze({
    attempt_reserved: ['resume_preconditions', false, false, false],
    preconditions_verified: ['resume_prepare', false, false, false],
    prepare_verified: ['provider_marker_append_permitted', true, false, false],
    provider_started: ['provider_outcome_unknown_no_replay', false, false, false],
    provider_completed: ['launch_marker_append_permitted', false, true, false],
    launch_started: ['launch_outcome_unknown_monitor_only', false, false, true],
  });
  const [status, mayAppendProviderStarted, mayAppendLaunchStarted, monitorOnly] =
    dispositionByPhase[head.phase];
  return Object.freeze({
    status,
    headPhase: head.phase,
    mayAppendProviderStarted,
    mayAppendLaunchStarted,
    monitorOnly,
    terminalReceipt: null,
  });
}

export function deriveAutonomousResearchOneShotCampaignAttemptRecoveryDispositionForHistoricalAudit({
  reservation,
  events,
  terminalReceipt = null,
} = {}) {
  const currentReservation =
    verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation);
  if (!currentReservation
    && !verifyAutonomousResearchOneShotHistoricalCampaignAttemptAnchor({
      reservation,
      events,
      terminalReceipt,
    })) {
    invalid('autonomous_research_one_shot_historical_attempt_anchor_invalid');
  }
  const disposition =
    deriveAutonomousResearchOneShotCampaignAttemptRecoveryDispositionWithAuditPolicy(
    { reservation, events, terminalReceipt },
    verifyAutonomousResearchOneShotCampaignAttemptEventSequenceForHistoricalAudit,
    verifyAutonomousResearchOneShotCampaignAttemptTerminalReceiptForHistoricalAudit,
  );
  if (currentReservation) return disposition;
  return Object.freeze({
    ...disposition,
    status: 'historical_audit_only',
    mayAppendProviderStarted: false,
    mayAppendLaunchStarted: false,
    monitorOnly: false,
  });
}

export function verifyAutonomousResearchOneShotHistoricalCampaignAttemptAnchor({
  reservation,
  events,
  terminalReceipt = null,
} = {}) {
  const anchor = AUTONOMOUS_RESEARCH_ONE_SHOT_HISTORICAL_ATTEMPT_ANCHORS[
    reservation?.campaignId
  ];
  if (!anchor || !Array.isArray(events) || events.length !== anchor.headSequence) {
    return false;
  }
  const head = events.at(-1);
  const eventChainHash = hashRecord(
    'AutonomousResearchOneShotHistoricalCampaignAttemptEventChain',
    {
      version: 1,
      campaignId: reservation.campaignId,
      eventHashes: events.map(
        (event) => event?.autonomousResearchOneShotCampaignAttemptEventHash,
      ),
    },
  );
  return reservation.attemptId === anchor.attemptId
    && reservation.idempotencyKey === anchor.idempotencyKey
    && reservation.autonomousResearchOneShotCampaignAttemptReservationHash
      === anchor.reservationHash
    && head?.sequence === anchor.headSequence
    && head?.autonomousResearchOneShotCampaignAttemptEventHash === anchor.headEventHash
    && eventChainHash === anchor.eventChainHash
    && terminalReceipt?.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash
      === anchor.terminalReceiptHash;
}
