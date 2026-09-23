import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  autonomousResearchSupervisorExternalActionStableKey,
} from './autonomous-research-supervisor-external-action-recovery-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const ACTION_KINDS = new Set([
  'provider-canary',
  'production-readiness',
  'golden-release-attestor',
]);
const FINAL_STATUSES = new Set(['completed', 'failed', 'recovered_incomplete']);
const MARKER_KEYS = Object.freeze([
  'actionAccountingComplete', 'actionKind', 'attemptId', 'campaignId', 'dispatchCount',
  'externalActionMayHaveOccurred', 'idempotencyKey', 'kind', 'leaseGeneration', 'providerCanaryCount',
  'reservation', 'reservationHash', 'startedAt', 'status',
  'autonomousResearchSupervisorExternalActionAttemptMarkerHash', 'version',
].sort());
const PROGRESS_KEYS = Object.freeze([
  'actionAccountingComplete', 'actionKind', 'attemptId', 'campaignId', 'evidence',
  'evidenceHash', 'externalActionMayHaveOccurred', 'kind', 'markerHash', 'recordedAt',
  'sequence', 'status',
  'autonomousResearchSupervisorExternalActionProgressReceiptHash', 'version',
].sort());
const RECEIPT_KEYS = Object.freeze([
  'actionAccountingComplete', 'actionKind', 'attemptId', 'blocker', 'campaignId',
  'completedAt', 'evidence', 'evidenceHash', 'externalActionMayHaveOccurred',
  'externalActionPerformed', 'kind', 'lastProgress', 'markerHash', 'status',
  'marker',
  'autonomousResearchSupervisorExternalActionAttemptReceiptHash', 'version',
].sort());

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function plainSnapshot(value, maximumBytes = 48 * 1024) {
  if (value === null || value === undefined) return null;
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error('autonomous_research_supervisor_external_action_evidence_invalid'); }
  if (Buffer.byteLength(serialized) > maximumBytes) {
    throw new Error('autonomous_research_supervisor_external_action_evidence_invalid');
  }
  const parsed = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('autonomous_research_supervisor_external_action_evidence_invalid');
  }
  return Object.freeze(parsed);
}

function evidenceHash(actionKind, evidence) {
  return evidence === null ? null : hashRecord(
    'AutonomousResearchSupervisorExternalActionEvidence',
    { actionKind, evidence },
  );
}

function reservationHash({ campaignId, actionKind, reservation }) {
  return hashRecord('AutonomousResearchSupervisorExternalActionReservation', {
    campaignId,
    actionKind,
    reservation,
  });
}

export function buildAutonomousResearchSupervisorExternalActionAttemptMarker({
  attemptId,
  campaignId,
  actionKind,
  reservation,
  dispatchCount,
  providerCanaryCount,
  leaseGeneration,
  idempotencyKey,
  startedAt,
} = {}) {
  const canonicalReservation = plainSnapshot(reservation, 16 * 1024);
  let effectiveIdempotencyKey = idempotencyKey;
  if (!effectiveIdempotencyKey && canonicalReservation) {
    effectiveIdempotencyKey = autonomousResearchSupervisorExternalActionStableKey({
      campaignId,
      actionKind,
      dispatchCount,
      providerCanaryCount,
      providerConfigurationHash: canonicalReservation.providerConfigurationHash,
      actionConfigurationIdentityHash:
        canonicalReservation.externalActionConfigurationIdentityHash
          || canonicalReservation.providerConfigurationHash,
      attemptScopeHash:
        canonicalReservation.providerCanaryReservation?.plannedGenerationHash
          || canonicalReservation.dispatchAuthorizationHash,
      action: canonicalReservation.action || null,
      launchMode: canonicalReservation.launchMode || null,
    });
  }
  if (!SAFE_ID.test(String(attemptId || '')) || !SAFE_ID.test(String(campaignId || ''))
    || !ACTION_KINDS.has(actionKind)
    || !Number.isSafeInteger(dispatchCount) || dispatchCount < 1
    || !Number.isSafeInteger(providerCanaryCount) || providerCanaryCount < 0
    || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1
    || !SHA256.test(String(effectiveIdempotencyKey || ''))
    || !canonicalInstant(startedAt)) {
    throw new Error('autonomous_research_supervisor_external_action_marker_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorExternalActionAttemptMarker',
    status: 'autonomous_research_supervisor_external_action_in_progress',
    attemptId,
    campaignId,
    actionKind,
    reservation: canonicalReservation,
    reservationHash: reservationHash({ campaignId, actionKind, reservation: canonicalReservation }),
    dispatchCount,
    providerCanaryCount,
    leaseGeneration,
    idempotencyKey: effectiveIdempotencyKey,
    startedAt,
    actionAccountingComplete: false,
    externalActionMayHaveOccurred: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorExternalActionAttemptMarkerHash: hashRecord(
      'AutonomousResearchSupervisorExternalActionAttemptMarker', payload,
    ),
  });
}

export function verifyAutonomousResearchSupervisorExternalActionAttemptMarker(value) {
  if (!exactKeys(value, MARKER_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchSupervisorExternalActionAttemptMarker'
    || value.status !== 'autonomous_research_supervisor_external_action_in_progress'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !ACTION_KINDS.has(value.actionKind)
    || !value.reservation || typeof value.reservation !== 'object' || Array.isArray(value.reservation)
    || !SHA256.test(String(value.reservationHash || ''))
    || value.reservationHash !== reservationHash(value)
    || !Number.isSafeInteger(value.dispatchCount) || value.dispatchCount < 1
    || !Number.isSafeInteger(value.providerCanaryCount) || value.providerCanaryCount < 0
    || !Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 1
    || !SHA256.test(String(value.idempotencyKey || ''))
    || !canonicalInstant(value.startedAt)
    || value.actionAccountingComplete !== false
    || value.externalActionMayHaveOccurred !== false) return false;
  const {
    autonomousResearchSupervisorExternalActionAttemptMarkerHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchSupervisorExternalActionAttemptMarker', payload)
      === claimedHash;
}

export function buildAutonomousResearchSupervisorExternalActionProgressReceipt({
  marker,
  evidence,
  sequence = 1,
  recordedAt,
} = {}) {
  if (!verifyAutonomousResearchSupervisorExternalActionAttemptMarker(marker)
    || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 16
    || !canonicalInstant(recordedAt)) {
    throw new Error('autonomous_research_supervisor_external_action_progress_invalid');
  }
  const canonicalEvidence = plainSnapshot(evidence);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorExternalActionProgressReceipt',
    status: 'autonomous_research_supervisor_external_action_progress_recorded',
    attemptId: marker.attemptId,
    campaignId: marker.campaignId,
    actionKind: marker.actionKind,
    markerHash: marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash,
    sequence,
    evidence: canonicalEvidence,
    evidenceHash: evidenceHash(marker.actionKind, canonicalEvidence),
    recordedAt,
    actionAccountingComplete: false,
    externalActionMayHaveOccurred: true,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorExternalActionProgressReceiptHash: hashRecord(
      'AutonomousResearchSupervisorExternalActionProgressReceipt', payload,
    ),
  });
}

export function verifyAutonomousResearchSupervisorExternalActionProgressReceipt(value, {
  marker = null,
} = {}) {
  if (!exactKeys(value, PROGRESS_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchSupervisorExternalActionProgressReceipt'
    || value.status !== 'autonomous_research_supervisor_external_action_progress_recorded'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !ACTION_KINDS.has(value.actionKind)
    || !SHA256.test(String(value.markerHash || ''))
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 16
    || !value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)
    || value.evidenceHash !== evidenceHash(value.actionKind, value.evidence)
    || !canonicalInstant(value.recordedAt)
    || value.actionAccountingComplete !== false
    || value.externalActionMayHaveOccurred !== true) return false;
  if (marker && (!verifyAutonomousResearchSupervisorExternalActionAttemptMarker(marker)
    || value.attemptId !== marker.attemptId || value.campaignId !== marker.campaignId
    || value.actionKind !== marker.actionKind
    || value.markerHash !== marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash)) {
    return false;
  }
  const {
    autonomousResearchSupervisorExternalActionProgressReceiptHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchSupervisorExternalActionProgressReceipt', payload)
      === claimedHash;
}

export function buildAutonomousResearchSupervisorExternalActionAttemptReceipt({
  marker,
  status,
  evidence = null,
  lastProgress = null,
  completedAt,
  actionAccountingComplete,
  externalActionPerformed,
  blocker = null,
} = {}) {
  if (!verifyAutonomousResearchSupervisorExternalActionAttemptMarker(marker)
    || !FINAL_STATUSES.has(status) || !canonicalInstant(completedAt)
    || typeof actionAccountingComplete !== 'boolean'
    || typeof externalActionPerformed !== 'boolean'
    || (lastProgress && !verifyAutonomousResearchSupervisorExternalActionProgressReceipt(
      lastProgress, { marker },
    ))
    || (status === 'recovered_incomplete' && actionAccountingComplete !== false)) {
    throw new Error('autonomous_research_supervisor_external_action_receipt_invalid');
  }
  const canonicalEvidence = plainSnapshot(evidence);
  const normalizedBlocker = blocker === null ? null : String(blocker).slice(0, 512);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorExternalActionAttemptReceipt',
    status,
    attemptId: marker.attemptId,
    campaignId: marker.campaignId,
    actionKind: marker.actionKind,
    marker: Object.freeze({ ...marker }),
    markerHash: marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash,
    lastProgress: lastProgress ? Object.freeze({ ...lastProgress }) : null,
    evidence: canonicalEvidence,
    evidenceHash: evidenceHash(marker.actionKind, canonicalEvidence),
    completedAt,
    actionAccountingComplete,
    externalActionPerformed,
    externalActionMayHaveOccurred: externalActionPerformed || !actionAccountingComplete,
    blocker: normalizedBlocker,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorExternalActionAttemptReceiptHash: hashRecord(
      'AutonomousResearchSupervisorExternalActionAttemptReceipt', payload,
    ),
  });
}

export function verifyAutonomousResearchSupervisorExternalActionAttemptReceipt(value, {
  marker = null,
} = {}) {
  if (!exactKeys(value, RECEIPT_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchSupervisorExternalActionAttemptReceipt'
    || !FINAL_STATUSES.has(value.status)
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !ACTION_KINDS.has(value.actionKind)
    || !verifyAutonomousResearchSupervisorExternalActionAttemptMarker(value.marker)
    || !SHA256.test(String(value.markerHash || ''))
    || (value.lastProgress && !verifyAutonomousResearchSupervisorExternalActionProgressReceipt(
      value.lastProgress, { marker: marker || value.marker },
    ))
    || (value.evidence !== null && (!value.evidence || typeof value.evidence !== 'object'
      || Array.isArray(value.evidence)))
    || value.evidenceHash !== evidenceHash(value.actionKind, value.evidence)
    || !canonicalInstant(value.completedAt)
    || typeof value.actionAccountingComplete !== 'boolean'
    || typeof value.externalActionPerformed !== 'boolean'
    || value.externalActionMayHaveOccurred
      !== (value.externalActionPerformed || !value.actionAccountingComplete)
    || (value.blocker !== null && typeof value.blocker !== 'string')
    || (value.status === 'recovered_incomplete' && value.actionAccountingComplete !== false)) {
    return false;
  }
  if (value.attemptId !== value.marker.attemptId
    || value.campaignId !== value.marker.campaignId
    || value.actionKind !== value.marker.actionKind
    || value.markerHash
      !== value.marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash) return false;
  if (marker && (!verifyAutonomousResearchSupervisorExternalActionAttemptMarker(marker)
    || value.attemptId !== marker.attemptId || value.campaignId !== marker.campaignId
    || value.actionKind !== marker.actionKind
    || value.markerHash !== marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash)) {
    return false;
  }
  const {
    autonomousResearchSupervisorExternalActionAttemptReceiptHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchSupervisorExternalActionAttemptReceipt', payload)
      === claimedHash;
}

export const AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS = Object.freeze({
  PROVIDER_CANARY: 'provider-canary',
  PRODUCTION_READINESS: 'production-readiness',
  GOLDEN_RELEASE_ATTESTOR: 'golden-release-attestor',
});
