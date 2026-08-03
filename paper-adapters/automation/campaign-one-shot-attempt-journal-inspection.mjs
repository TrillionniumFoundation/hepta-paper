import {
  deriveAutonomousResearchOneShotCampaignAttemptRecoveryDisposition,
  verifyAutonomousResearchOneShotCampaignAttemptEvent,
  verifyAutonomousResearchOneShotCampaignAttemptEventSequence,
  verifyAutonomousResearchOneShotCampaignAttemptReservation,
  verifyAutonomousResearchOneShotCampaignAttemptTerminalReceipt,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import { stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { canonicalRowJson } from './campaign-one-shot-attempt-journal-support.mjs';

function invalid(code) {
  return new Error(code);
}

function eventFromRow(row, reservation, previousEvent) {
  const event = canonicalRowJson(
    row.event_json,
    'campaign_one_shot_attempt_journal_event_json_invalid',
  );
  if (!verifyAutonomousResearchOneShotCampaignAttemptEvent(event, {
    reservation,
    previousEvent,
  }) || row.event_id !== event.eventId
    || row.attempt_id !== event.attemptId
    || Number(row.sequence) !== event.sequence
    || row.phase !== event.phase
    || (row.previous_event_hash ?? null) !== event.previousEventHash
    || row.event_hash !== event.autonomousResearchOneShotCampaignAttemptEventHash
    || row.recorded_at !== event.recordedAt) {
    throw invalid('campaign_one_shot_attempt_journal_event_invalid');
  }
  return Object.freeze(event);
}

export function inspectCampaignOneShotAttemptFromPort(port, {
  attemptId = null,
  idempotencyKey = null,
} = {}) {
  if (!attemptId && !idempotencyKey) {
    throw invalid('campaign_one_shot_attempt_journal_lookup_invalid');
  }
  const where = attemptId ? 'attempt_id=?' : 'idempotency_key=?';
  const lookup = attemptId || idempotencyKey;
  const rows = port.query(`SELECT attempt_id,idempotency_key,campaign_id,
    protected_campaign_id,execution_binding_hash,reservation_hash,
    reservation_json,reserved_at FROM campaign_one_shot_attempts
    WHERE ${where} LIMIT 2;`, [lookup]).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw invalid('campaign_one_shot_attempt_journal_attempt_invalid');
  const row = rows[0];
  const reservation = canonicalRowJson(
    row.reservation_json,
    'campaign_one_shot_attempt_journal_reservation_json_invalid',
  );
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)
    || row.attempt_id !== reservation.attemptId
    || row.idempotency_key !== reservation.idempotencyKey
    || row.campaign_id !== reservation.campaignId
    || row.protected_campaign_id !== reservation.protectedCampaignId
    || row.execution_binding_hash !== reservation.executionBindingHash
    || row.reservation_hash
      !== reservation.autonomousResearchOneShotCampaignAttemptReservationHash
    || row.reserved_at !== reservation.reservedAt) {
    throw invalid('campaign_one_shot_attempt_journal_reservation_invalid');
  }
  const eventRows = port.query(`SELECT event_id,attempt_id,sequence,phase,
    previous_event_hash,event_hash,event_json,recorded_at
    FROM campaign_one_shot_attempt_events WHERE attempt_id=? ORDER BY sequence;`,
  [reservation.attemptId]).rows;
  const events = [];
  let previousEvent = null;
  for (const eventRow of eventRows) {
    const event = eventFromRow(eventRow, reservation, previousEvent);
    events.push(event);
    previousEvent = event;
  }
  if (!verifyAutonomousResearchOneShotCampaignAttemptEventSequence({
    reservation,
    events,
  })) throw invalid('campaign_one_shot_attempt_journal_event_sequence_invalid');

  const receiptRows = port.query(`SELECT attempt_id,receipt_hash,receipt_json,
    terminal_event_hash,completed_at
    FROM campaign_one_shot_attempt_terminal_receipts WHERE attempt_id=?;`,
  [reservation.attemptId]).rows;
  if (receiptRows.length > 1) {
    throw invalid('campaign_one_shot_attempt_journal_terminal_receipt_invalid');
  }
  let terminalReceipt = null;
  const head = events.at(-1);
  if (receiptRows.length === 1) {
    const receiptRow = receiptRows[0];
    terminalReceipt = canonicalRowJson(
      receiptRow.receipt_json,
      'campaign_one_shot_attempt_journal_terminal_receipt_json_invalid',
    );
    const preterminal = events.at(-2);
    if (head?.phase !== 'terminal' || !preterminal
      || !verifyAutonomousResearchOneShotCampaignAttemptTerminalReceipt(
        terminalReceipt,
        { reservation, lastEvent: preterminal },
      )
      || receiptRow.attempt_id !== reservation.attemptId
      || receiptRow.receipt_hash
        !== terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash
      || receiptRow.terminal_event_hash
        !== head.autonomousResearchOneShotCampaignAttemptEventHash
      || receiptRow.completed_at !== terminalReceipt.completedAt
      || stableStringify(head.evidence) !== stableStringify({
        terminalReceiptHash:
          terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash,
      })) {
      throw invalid('campaign_one_shot_attempt_journal_terminal_receipt_invalid');
    }
    terminalReceipt = Object.freeze(terminalReceipt);
  } else if (head?.phase === 'terminal') {
    throw invalid('campaign_one_shot_attempt_journal_terminal_receipt_missing');
  }
  const frozenEvents = Object.freeze(events);
  const recoveryDisposition =
    deriveAutonomousResearchOneShotCampaignAttemptRecoveryDisposition({
      reservation,
      events: frozenEvents,
      terminalReceipt,
    });
  return Object.freeze({
    version: 1,
    kind: 'CampaignOneShotAttemptJournalInspection',
    status: 'campaign_one_shot_attempt_journal_verified',
    reservation: Object.freeze(reservation),
    events: frozenEvents,
    headPhase: head.phase,
    headEventHash: head.autonomousResearchOneShotCampaignAttemptEventHash,
    terminalReceipt,
    recoveryDisposition,
  });
}
