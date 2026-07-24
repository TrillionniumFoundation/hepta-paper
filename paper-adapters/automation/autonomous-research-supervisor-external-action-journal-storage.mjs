import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
  verifyAutonomousResearchSupervisorExternalActionAttemptMarker,
  verifyAutonomousResearchSupervisorExternalActionAttemptReceipt,
  verifyAutonomousResearchSupervisorExternalActionProgressReceipt,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function parseJournalJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); }
  catch { throw new Error('autonomous_research_supervisor_external_action_journal_invalid'); }
}

export function mapAutonomousResearchSupervisorExternalActionRow(row) {
  if (!row) return null;
  const marker = parseJournalJson(row.marker_json);
  const progress = parseJournalJson(row.progress_json);
  const receipt = parseJournalJson(row.receipt_json);
  const recoveryResult = parseJournalJson(row.recovery_result_json);
  const recoveryResultHash = recoveryResult === null ? null : hashRecord(
    'AutonomousResearchSupervisorExternalActionRecoveryResult',
    {
      actionKind: row.action_kind,
      idempotencyKey: row.idempotency_key,
      result: recoveryResult,
    },
  );
  if (!verifyAutonomousResearchSupervisorExternalActionAttemptMarker(marker)
    || marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash !== row.marker_hash
    || marker.attemptId !== row.attempt_id || marker.campaignId !== row.campaign_id
    || marker.actionKind !== row.action_kind || marker.reservationHash !== row.reservation_hash
    || marker.leaseGeneration !== Number(row.lease_generation)
    || marker.idempotencyKey !== row.idempotency_key
    || marker.dispatchCount !== Number(row.dispatch_count)
    || marker.providerCanaryCount !== Number(row.provider_canary_count)
    || marker.startedAt !== row.started_at
    || !['in_progress', 'completed', 'failed', 'recovered_incomplete'].includes(row.status)
    || Boolean(progress) !== Boolean(row.progress_hash)
    || (progress && (!verifyAutonomousResearchSupervisorExternalActionProgressReceipt(
      progress, { marker },
    ) || progress.autonomousResearchSupervisorExternalActionProgressReceiptHash
      !== row.progress_hash))
    || Boolean(receipt) !== Boolean(row.receipt_hash)
    || Boolean(recoveryResult) !== Boolean(row.recovery_result_hash)
    || recoveryResultHash !== (row.recovery_result_hash || null)
    || (receipt && (!verifyAutonomousResearchSupervisorExternalActionAttemptReceipt(
      receipt, { marker },
    ) || receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash
      !== row.receipt_hash))
    || (row.status === 'in_progress' && (receipt || row.completed_at))
    || (row.status !== 'in_progress' && (!receipt || receipt.status !== row.status
      || receipt.completedAt !== row.completed_at))) {
    throw new Error('autonomous_research_supervisor_external_action_journal_invalid');
  }
  return Object.freeze({
    attemptId: row.attempt_id,
    campaignId: row.campaign_id,
    actionKind: row.action_kind,
    reservationHash: row.reservation_hash,
    idempotencyKey: row.idempotency_key,
    leaseGeneration: Number(row.lease_generation),
    dispatchCount: Number(row.dispatch_count),
    providerCanaryCount: Number(row.provider_canary_count),
    status: row.status,
    marker: Object.freeze(marker),
    progress: progress ? Object.freeze(progress) : null,
    receipt: receipt ? Object.freeze(receipt) : null,
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    recoveryResult: recoveryResult ? Object.freeze(recoveryResult) : null,
    recoveryResultHash: row.recovery_result_hash || null,
  });
}

export function autonomousResearchSupervisorExternalActionReservationValid(
  actionKind,
  reservation,
  current,
) {
  if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)
    || reservation.campaignId !== current.campaignId
    || reservation.dispatchCount !== current.dispatchCount) return false;
  if (actionKind === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
    const canary = reservation.providerCanaryReservation;
    return reservation.kind === 'AutonomousResearchSupervisorProviderCanaryReservation'
      && SHA256.test(String(reservation.providerConfigurationHash || ''))
      && canary?.generationSequence === current.providerCanaryCount
      && canary?.providerCanaryReservedAttemptCount === 1
      && Number(canary?.providerCanaryReservedCostUsd)
        === current.policy.providerCanaryReservationCostUsd
      && SHA256.test(String(canary?.plannedGenerationHash || ''));
  }
  return reservation.kind === 'AutonomousResearchSupervisorReadinessActionReservation'
    && ['launch', 'resume', 'converge'].includes(reservation.action)
    && SHA256.test(String(reservation.dispatchAuthorizationHash || ''))
    && SHA256.test(String(reservation.providerConfigurationHash || ''))
    && SHA256.test(String(reservation.externalActionConfigurationIdentityHash || ''))
    && ((actionKind
      === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS
      && reservation.launchMode === 'production-run')
      || (actionKind
        === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.GOLDEN_RELEASE_ATTESTOR
        && reservation.launchMode === 'golden-bootstrap'));
}

export function autonomousResearchSupervisorSideEffectReservationHash({
  campaignId,
  actionKind,
  reservation,
} = {}) {
  return hashRecord('AutonomousResearchSupervisorExternalActionReservation', {
    campaignId,
    actionKind,
    reservation,
  });
}

export function assertAutonomousResearchSupervisorFinalizedSideEffectPermit({
  receipt,
  required,
  reservationHash,
} = {}) {
  if (!required) return;
  if (receipt?.status === 'externally_fenced_sqlite_mutation_finalized'
    && SHA256.test(String(receipt.sideEffectPermitHash || ''))) return;
  const error = new Error(
    'autonomous_research_supervisor_external_action_side_effect_permit_required',
  );
  error.committed = true;
  error.reservationId = receipt?.reservationId || null;
  error.sideEffectPermitHash = receipt?.sideEffectPermitHash || null;
  error.sideEffectReservationHash = reservationHash;
  throw error;
}

export function installAutonomousResearchSupervisorExternalActionJournalSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_supervisor_external_action_journal (
    attempt_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK(action_kind IN (
      'provider-canary','production-readiness','golden-release-attestor'
    )),
    reservation_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
    dispatch_count INTEGER NOT NULL CHECK(dispatch_count>=1),
    provider_canary_count INTEGER NOT NULL CHECK(provider_canary_count>=0),
    status TEXT NOT NULL CHECK(status IN (
      'in_progress','completed','failed','recovered_incomplete'
    )),
    marker_json TEXT NOT NULL,
    marker_hash TEXT NOT NULL,
    progress_json TEXT,
    progress_hash TEXT,
    receipt_json TEXT,
    receipt_hash TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    recovery_result_json TEXT,
    recovery_result_hash TEXT,
    UNIQUE(campaign_id,action_kind,reservation_hash)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS
    idx_autonomous_research_supervisor_external_action_one_active
    ON autonomous_research_supervisor_external_action_journal(campaign_id)
    WHERE status='in_progress';
  CREATE INDEX IF NOT EXISTS idx_autonomous_research_supervisor_external_action_history
    ON autonomous_research_supervisor_external_action_journal(campaign_id,started_at,attempt_id);`);
  const columns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_supervisor_external_action_journal)',
  ).all().map((column) => column.name));
  if (!columns.has('idempotency_key')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_external_action_journal
      ADD COLUMN idempotency_key TEXT;`);
  }
  if (!columns.has('recovery_result_json')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_external_action_journal
      ADD COLUMN recovery_result_json TEXT;`);
  }
  if (!columns.has('recovery_result_hash')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_external_action_journal
      ADD COLUMN recovery_result_hash TEXT;`);
  }
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS
    idx_autonomous_research_supervisor_external_action_idempotency
    ON autonomous_research_supervisor_external_action_journal(idempotency_key)
    WHERE idempotency_key IS NOT NULL;`);
}
