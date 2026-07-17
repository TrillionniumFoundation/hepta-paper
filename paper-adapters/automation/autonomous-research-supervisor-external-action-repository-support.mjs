import crypto from 'node:crypto';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
  buildAutonomousResearchSupervisorExternalActionAttemptMarker,
  buildAutonomousResearchSupervisorExternalActionAttemptReceipt,
  buildAutonomousResearchSupervisorExternalActionProgressReceipt,
  verifyAutonomousResearchSupervisorExternalActionAttemptMarker,
  verifyAutonomousResearchSupervisorExternalActionAttemptReceipt,
  verifyAutonomousResearchSupervisorExternalActionProgressReceipt,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import {
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {
  verifyAutomationReadinessSideEffectInspection,
} from '../../paper-domain/automation/automation-readiness-side-effect-inspection.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function parseJournalJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); }
  catch { throw new Error('autonomous_research_supervisor_external_action_journal_invalid'); }
}

function mapExternalActionRow(row) {
  if (!row) return null;
  const marker = parseJournalJson(row.marker_json);
  const progress = parseJournalJson(row.progress_json);
  const receipt = parseJournalJson(row.receipt_json);
  if (!verifyAutonomousResearchSupervisorExternalActionAttemptMarker(marker)
    || marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash !== row.marker_hash
    || marker.attemptId !== row.attempt_id || marker.campaignId !== row.campaign_id
    || marker.actionKind !== row.action_kind || marker.reservationHash !== row.reservation_hash
    || marker.leaseGeneration !== Number(row.lease_generation)
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
    leaseGeneration: Number(row.lease_generation),
    dispatchCount: Number(row.dispatch_count),
    providerCanaryCount: Number(row.provider_canary_count),
    status: row.status,
    marker: Object.freeze(marker),
    progress: progress ? Object.freeze(progress) : null,
    receipt: receipt ? Object.freeze(receipt) : null,
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
  });
}

function reservationValid(actionKind, reservation, current) {
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
    && ((actionKind
      === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS
      && reservation.launchMode === 'production-run')
      || (actionKind
        === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.GOLDEN_RELEASE_ATTESTOR
        && reservation.launchMode === 'golden-bootstrap'));
}

export function installAutonomousResearchSupervisorExternalActionJournalSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_supervisor_external_action_journal (
    attempt_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK(action_kind IN (
      'provider-canary','production-readiness','golden-release-attestor'
    )),
    reservation_hash TEXT NOT NULL,
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
    UNIQUE(campaign_id,action_kind,reservation_hash)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS
    idx_autonomous_research_supervisor_external_action_one_active
    ON autonomous_research_supervisor_external_action_journal(campaign_id)
    WHERE status='in_progress';
  CREATE INDEX IF NOT EXISTS idx_autonomous_research_supervisor_external_action_history
    ON autonomous_research_supervisor_external_action_journal(campaign_id,started_at,attempt_id);`);
}

export function createAutonomousResearchSupervisorExternalActionRepositorySupport({
  database,
  requireOpen,
  beginTransaction,
  rollback,
  fencedRow,
  leaseIdentity,
  timestamp,
  providerCanarySuccessEvidenceValid,
  providerCanaryProgressEvidenceValid,
} = {}) {
  function externalActionRow(attemptId) {
    requireOpen();
    return mapExternalActionRow(database.prepare(
      'SELECT * FROM autonomous_research_supervisor_external_action_journal WHERE attempt_id=?',
    ).get(attemptId));
  }

  function activeAttemptForCampaign(campaignId) {
    return mapExternalActionRow(database.prepare(`SELECT * FROM
      autonomous_research_supervisor_external_action_journal
      WHERE campaign_id=? AND status='in_progress'`).get(campaignId));
  }

  function insertInTransaction({ identity, current, actionKind, reservation, observedAt }) {
    if (!reservationValid(actionKind, reservation, current)) {
      throw new Error('autonomous_research_supervisor_external_action_reservation_invalid');
    }
    const attemptId = `external-action:${crypto.randomUUID()}`;
    const marker = buildAutonomousResearchSupervisorExternalActionAttemptMarker({
      attemptId,
      campaignId: current.campaignId,
      actionKind,
      reservation,
      dispatchCount: current.dispatchCount,
      providerCanaryCount: current.providerCanaryCount,
      leaseGeneration: identity.leaseGeneration,
      startedAt: observedAt.toISOString(),
    });
    database.prepare(`INSERT INTO autonomous_research_supervisor_external_action_journal(
      attempt_id,campaign_id,action_kind,reservation_hash,lease_generation,dispatch_count,
      provider_canary_count,status,marker_json,marker_hash,started_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      marker.attemptId, marker.campaignId, marker.actionKind, marker.reservationHash,
      marker.leaseGeneration, marker.dispatchCount, marker.providerCanaryCount,
      'in_progress', JSON.stringify(marker),
      marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash, marker.startedAt,
    );
    return externalActionRow(attemptId);
  }

  function requireFencedAttempt(identity, attempt, observedAt) {
    fencedRow(identity, observedAt);
    const value = externalActionRow(attempt?.attemptId || attempt);
    if (!value || value.status !== 'in_progress'
      || value.campaignId !== identity.campaignId
      || value.leaseGeneration !== identity.leaseGeneration
      || (attempt?.reservationHash && attempt.reservationHash !== value.reservationHash)) {
      throw new Error('autonomous_research_supervisor_external_action_fence_conflict');
    }
    return value;
  }

  function finishInTransaction({
    identity,
    attempt,
    observedAt,
    successful,
    evidence,
    actionAccountingComplete,
    externalActionPerformed,
    blocker,
  }) {
    const current = requireFencedAttempt(identity, attempt, observedAt);
    if (current.actionKind
      === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
      const reservation = current.marker.reservation;
      const validSuccess = successful === true
        && providerCanarySuccessEvidenceValid(evidence, current.marker)
        && actionAccountingComplete === true && externalActionPerformed === true;
      const validFailure = successful === false && (evidence === null
        || verifyAutonomousResearchProviderCanarySideEffectInspection(evidence, {
          providerConfigurationHash: reservation.providerConfigurationHash,
          reservation: reservation.providerCanaryReservation,
        })) && (evidence === null
        ? actionAccountingComplete === false
        : actionAccountingComplete === evidence.actionAccountingComplete
          && externalActionPerformed === evidence.externalActionPerformed);
      if (!validSuccess && !validFailure) {
        throw new Error('autonomous_research_supervisor_provider_canary_receipt_invalid');
      }
    } else {
      const validInspection = verifyAutomationReadinessSideEffectInspection(evidence);
      if ((successful === true && !validInspection)
        || (evidence !== null && !validInspection)
        || (successful === false && evidence === null && actionAccountingComplete !== false)
        || (validInspection && externalActionPerformed !== evidence.externalActionPerformed)) {
        throw new Error('autonomous_research_supervisor_readiness_receipt_invalid');
      }
    }
    const status = successful === true ? 'completed' : 'failed';
    const receipt = buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
      marker: current.marker,
      status,
      evidence,
      lastProgress: current.progress,
      completedAt: observedAt.toISOString(),
      actionAccountingComplete,
      externalActionPerformed,
      blocker,
    });
    const result = database.prepare(`UPDATE
      autonomous_research_supervisor_external_action_journal SET
      status=?,receipt_json=?,receipt_hash=?,completed_at=?
      WHERE attempt_id=? AND status='in_progress'`).run(
      status, JSON.stringify(receipt),
      receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash,
      receipt.completedAt, current.attemptId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error('autonomous_research_supervisor_external_action_fence_conflict');
    }
    return externalActionRow(current.attemptId);
  }

  function recoverAttemptInTransaction({ attempt, observedAt, blocker }) {
    const receipt = buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
      marker: attempt.marker,
      status: 'recovered_incomplete',
      evidence: null,
      lastProgress: attempt.progress,
      completedAt: observedAt.toISOString(),
      actionAccountingComplete: false,
      externalActionPerformed: Boolean(attempt.progress),
      blocker,
    });
    const updated = database.prepare(`UPDATE
      autonomous_research_supervisor_external_action_journal SET
      status='recovered_incomplete',receipt_json=?,receipt_hash=?,completed_at=?
      WHERE attempt_id=? AND status='in_progress'`).run(
      JSON.stringify(receipt),
      receipt.autonomousResearchSupervisorExternalActionAttemptReceiptHash,
      receipt.completedAt,
      attempt.attemptId,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error('autonomous_research_supervisor_external_action_recovery_conflict');
    }
    return receipt;
  }

  function markProviderAttemptInterrupted(attempt) {
    if (attempt.actionKind
      !== AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) return;
    database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
      last_provider_canary_status='failed_unattributed',
      last_provider_canary_receipt_hash=NULL,last_error=?
      WHERE campaign_id=? AND last_provider_canary_status='in_progress'`).run(
      'autonomous_research_supervisor_provider_canary_interrupted',
      attempt.campaignId,
    );
  }

  return Object.freeze({
    activeAttemptForCampaign,
    insertInTransaction,
    requireFencedAttempt,
    finishInTransaction,
    beginExternalActionAttempt({ lease, actionKind, reservation, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      try {
        beginTransaction();
        const current = fencedRow(identity, observedAt);
        const attempt = insertInTransaction({
          identity, current, actionKind, reservation, observedAt,
        });
        database.exec('COMMIT;');
        return attempt;
      } catch (error) {
        rollback();
        throw error;
      }
    },
    recordExternalActionProgress({ lease, attempt, evidence, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      try {
        beginTransaction();
        const current = requireFencedAttempt(identity, attempt, observedAt);
        if (current.actionKind
          === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY
          && !providerCanaryProgressEvidenceValid(
            evidence, current.marker.reservation,
          )) {
          throw new Error('autonomous_research_supervisor_external_action_progress_invalid');
        }
        const progress = buildAutonomousResearchSupervisorExternalActionProgressReceipt({
          marker: current.marker,
          evidence,
          sequence: (current.progress?.sequence || 0) + 1,
          recordedAt: observedAt.toISOString(),
        });
        const result = database.prepare(`UPDATE
          autonomous_research_supervisor_external_action_journal SET
          progress_json=?,progress_hash=? WHERE attempt_id=? AND status='in_progress'`).run(
          JSON.stringify(progress),
          progress.autonomousResearchSupervisorExternalActionProgressReceiptHash,
          current.attemptId,
        );
        if (Number(result.changes) !== 1) {
          throw new Error('autonomous_research_supervisor_external_action_fence_conflict');
        }
        database.exec('COMMIT;');
        return externalActionRow(current.attemptId);
      } catch (error) {
        rollback();
        throw error;
      }
    },
    finishExternalActionAttempt({
      lease,
      attempt,
      successful,
      evidence = null,
      actionAccountingComplete = true,
      externalActionPerformed = false,
      blocker = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      try {
        beginTransaction();
        const result = finishInTransaction({
          identity, attempt, observedAt, successful, evidence,
          actionAccountingComplete, externalActionPerformed, blocker,
        });
        database.exec('COMMIT;');
        return result;
      } catch (error) {
        rollback();
        throw error;
      }
    },
    getExternalActionAttempt(attemptId) {
      return externalActionRow(attemptId);
    },
    listExternalActionAttempts({ campaignId, limit = 1000 } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(campaignId || ''))) {
        throw new Error('autonomous_research_supervisor_campaign_scope_invalid');
      }
      const bounded = Math.max(1, Math.min(10_000, Number(limit || 1000)));
      return Object.freeze(database.prepare(`SELECT * FROM
        autonomous_research_supervisor_external_action_journal WHERE campaign_id=?
        ORDER BY started_at,attempt_id LIMIT ?`).all(campaignId, bounded)
        .map(mapExternalActionRow));
    },
    recoverStaleAttemptsInTransaction({ observedAt }) {
      const unfinished = database.prepare(`SELECT journal.*
        FROM autonomous_research_supervisor_external_action_journal AS journal
        JOIN autonomous_research_supervisor_campaign AS campaign
          ON campaign.campaign_id=journal.campaign_id
        WHERE journal.status='in_progress' AND (
          campaign.lease_expires_at IS NULL
          OR campaign.lease_generation<>journal.lease_generation
          OR julianday(campaign.lease_expires_at)<=julianday(?)
        ) ORDER BY journal.started_at,journal.attempt_id`).all(observedAt.toISOString())
        .map(mapExternalActionRow);
      const receipts = unfinished.map((attempt) => {
        const receipt = recoverAttemptInTransaction({
          attempt,
          observedAt,
          blocker: 'autonomous_research_supervisor_external_action_interrupted',
        });
        markProviderAttemptInterrupted(attempt);
        return receipt;
      });
      return Object.freeze(receipts);
    },
    recoverActiveAttemptInTransaction({ current, observedAt, blocker }) {
      const attempt = current.activeExternalActionAttempt;
      if (!attempt) return null;
      const receipt = recoverAttemptInTransaction({ attempt, observedAt, blocker });
      markProviderAttemptInterrupted(attempt);
      return receipt;
    },
  });
}
