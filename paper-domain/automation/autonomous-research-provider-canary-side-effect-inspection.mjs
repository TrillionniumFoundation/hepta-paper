import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,159}$/;
const SAFE_RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const ROLES = new Set(['research_author', 'formal_reviewer']);
const STATUSES = new Set(['succeeded', 'failed']);
const INSPECTION_KEYS = Object.freeze([
  'actionAccountingComplete', 'actions',
  'autonomousResearchProviderCanarySideEffectInspectionHash',
  'externalActionMayHaveOccurred', 'externalActionPerformed', 'externalActionScope',
  'failedProviderCanaryActionCount', 'failureCode', 'failurePhase', 'kind',
  'providerCanaryActionCount', 'providerConfigurationHash', 'reservation',
  'researchAuthorCanaryAttemptCount', 'formalReviewerCanaryAttemptCount',
  'status', 'successfulProviderCanaryActionCount', 'version',
].sort());
const RESERVATION_KEYS = Object.freeze([
  'budgetEpochStart', 'budgetReservationId', 'generationSequence',
  'plannedGenerationHash', 'providerCanaryReservedAttemptCount',
  'providerCanaryReservedCostUsd',
].sort());
const ACTION_KEYS = Object.freeze([
  'errorCode', 'providerCanaryReceiptHash', 'role', 'sequence', 'status',
].sort());
const JOURNAL_KEYS = Object.freeze([
  'actions', 'autonomousResearchProviderCanaryAttemptJournalHash',
  'currentRole', 'failurePhase', 'kind', 'providerConfigurationHash',
  'reservation', 'version',
].sort());

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validReservation(value) {
  return exactKeys(value, RESERVATION_KEYS)
    && Number.isSafeInteger(value.generationSequence) && value.generationSequence >= 1
    && SHA256.test(String(value.plannedGenerationHash || ''))
    && SAFE_RESERVATION_ID.test(String(value.budgetReservationId || ''))
    && canonicalInstant(value.budgetEpochStart)
    && value.providerCanaryReservedAttemptCount === 1
    && typeof value.providerCanaryReservedCostUsd === 'number'
    && Number.isFinite(value.providerCanaryReservedCostUsd)
    && value.providerCanaryReservedCostUsd >= 0
    && value.providerCanaryReservedCostUsd <= 100;
}

function sameReservation(left, right) {
  return RESERVATION_KEYS.every((key) => left?.[key] === right?.[key]);
}

function canonicalAction(value, index) {
  if (!exactKeys(value, ACTION_KEYS) || value.sequence !== index + 1
    || !ROLES.has(value.role) || !STATUSES.has(value.status)) return null;
  const succeeded = value.status === 'succeeded';
  if (succeeded !== SHA256.test(String(value.providerCanaryReceiptHash || ''))
    || (succeeded ? value.errorCode !== null : !SAFE_CODE.test(String(value.errorCode || '')))) {
    return null;
  }
  return Object.freeze({
    sequence: value.sequence,
    role: value.role,
    status: value.status,
    providerCanaryReceiptHash: value.providerCanaryReceiptHash,
    errorCode: value.errorCode,
  });
}

export function providerCanaryAction({ role, receipt = null } = {}) {
  const succeeded = Boolean(receipt);
  const receiptHash = receipt?.codexModelAvailabilityCanaryReceiptHash || null;
  if (!ROLES.has(role) || (succeeded && !SHA256.test(String(receiptHash || '')))) {
    throw new Error('autonomous_research_provider_canary_action_invalid');
  }
  return Object.freeze({
    role,
    status: succeeded ? 'succeeded' : 'failed',
    providerCanaryReceiptHash: succeeded ? receiptHash : null,
    errorCode: succeeded ? null : `${role}_canary_failed`,
  });
}

export function buildAutonomousResearchProviderCanaryAttemptJournal({
  providerConfigurationHash,
  reservation,
  actions = [],
  currentRole = null,
  failurePhase,
} = {}) {
  if (!SHA256.test(String(providerConfigurationHash || '')) || !validReservation(reservation)
    || !Array.isArray(actions) || actions.length > 2
    || (currentRole !== null && !ROLES.has(currentRole))
    || !SAFE_CODE.test(String(failurePhase || ''))) {
    throw new Error('autonomous_research_provider_canary_attempt_journal_invalid');
  }
  const canonicalActions = actions.map((action, index) => canonicalAction({
    ...action,
    sequence: index + 1,
  }, index));
  if (canonicalActions.some((action) => !action)
    || new Set(canonicalActions.map((action) => action.role)).size !== canonicalActions.length
    || canonicalActions.some((action, index) => index === 0 && action.role !== 'research_author')
    || canonicalActions.some((action, index) => index === 1 && action.role !== 'formal_reviewer')
    || (currentRole === 'research_author' && canonicalActions.length !== 0)
    || (currentRole === 'formal_reviewer'
      && (canonicalActions.length !== 1
        || canonicalActions[0].role !== 'research_author'
        || canonicalActions[0].status !== 'succeeded'))
    || (currentRole === null && canonicalActions.length === 0
      && failurePhase !== 'provider_canary_reserved')) {
    throw new Error('autonomous_research_provider_canary_attempt_journal_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchProviderCanaryAttemptJournal',
    providerConfigurationHash,
    reservation: Object.freeze({ ...reservation }),
    actions: Object.freeze(canonicalActions),
    currentRole,
    failurePhase,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchProviderCanaryAttemptJournalHash: hashRecord(
      'AutonomousResearchProviderCanaryAttemptJournal', payload,
    ),
  });
}

export function verifyAutonomousResearchProviderCanaryAttemptJournal(value, {
  providerConfigurationHash = null,
  reservation = null,
} = {}) {
  if (!exactKeys(value, JOURNAL_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchProviderCanaryAttemptJournal'
    || !SHA256.test(String(value.providerConfigurationHash || ''))
    || (providerConfigurationHash && value.providerConfigurationHash !== providerConfigurationHash)
    || !validReservation(value.reservation)
    || (reservation && !sameReservation(value.reservation, reservation))
    || !Array.isArray(value.actions) || value.actions.length > 2
    || (value.currentRole !== null && !ROLES.has(value.currentRole))
    || !SAFE_CODE.test(String(value.failurePhase || ''))) return false;
  const actions = value.actions.map(canonicalAction);
  if (actions.some((action) => !action)
    || new Set(actions.map((action) => action.role)).size !== actions.length
    || actions.some((action, index) => index === 0 && action.role !== 'research_author')
    || actions.some((action, index) => index === 1 && action.role !== 'formal_reviewer')
    || (value.currentRole === 'research_author' && actions.length !== 0)
    || (value.currentRole === 'formal_reviewer'
      && (actions.length !== 1
        || actions[0].role !== 'research_author'
        || actions[0].status !== 'succeeded'))
    || (value.currentRole === null && actions.length === 0
      && value.failurePhase !== 'provider_canary_reserved')) return false;
  const {
    autonomousResearchProviderCanaryAttemptJournalHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchProviderCanaryAttemptJournal', payload) === claimedHash;
}

export function buildAutonomousResearchProviderCanarySideEffectInspection({
  providerConfigurationHash,
  reservation,
  actions = [],
  actionAccountingComplete = true,
  failurePhase,
} = {}) {
  if (!SHA256.test(String(providerConfigurationHash || '')) || !validReservation(reservation)
    || !Array.isArray(actions) || actions.length > 2
    || typeof actionAccountingComplete !== 'boolean'
    || !SAFE_CODE.test(String(failurePhase || ''))
    || !SAFE_CODE.test(`${failurePhase}_failed`)) {
    throw new Error('autonomous_research_provider_canary_side_effect_inspection_invalid');
  }
  const canonicalActions = actions.map((action, index) => canonicalAction({
    ...action,
    sequence: index + 1,
  }, index));
  if (canonicalActions.some((action) => !action)
    || new Set(canonicalActions.map((action) => action.role)).size !== canonicalActions.length
    || canonicalActions.some((action, index) => index === 0 && action.role !== 'research_author')
    || canonicalActions.some((action, index) => index === 1 && action.role !== 'formal_reviewer')) {
    throw new Error('autonomous_research_provider_canary_side_effect_inspection_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchProviderCanarySideEffectInspection',
    status: 'autonomous_research_provider_canary_attempt_failed',
    providerConfigurationHash,
    reservation: Object.freeze({ ...reservation }),
    actionAccountingComplete,
    providerCanaryActionCount: canonicalActions.length,
    successfulProviderCanaryActionCount:
      canonicalActions.filter((action) => action.status === 'succeeded').length,
    failedProviderCanaryActionCount:
      canonicalActions.filter((action) => action.status === 'failed').length,
    researchAuthorCanaryAttemptCount:
      canonicalActions.filter((action) => action.role === 'research_author').length,
    formalReviewerCanaryAttemptCount:
      canonicalActions.filter((action) => action.role === 'formal_reviewer').length,
    externalActionPerformed: canonicalActions.length > 0,
    externalActionMayHaveOccurred: canonicalActions.length > 0 || !actionAccountingComplete,
    externalActionScope: canonicalActions.length
      ? 'read_only_ephemeral_model_canaries' : 'none_observed',
    actions: Object.freeze(canonicalActions),
    failurePhase,
    failureCode: `${failurePhase}_failed`,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchProviderCanarySideEffectInspectionHash: hashRecord(
      'AutonomousResearchProviderCanarySideEffectInspection', payload,
    ),
  });
}

export function verifyAutonomousResearchProviderCanarySideEffectInspection(value, {
  providerConfigurationHash = null,
  reservation = null,
} = {}) {
  if (!exactKeys(value, INSPECTION_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchProviderCanarySideEffectInspection'
    || value.status !== 'autonomous_research_provider_canary_attempt_failed'
    || !SHA256.test(String(value.providerConfigurationHash || ''))
    || (providerConfigurationHash && value.providerConfigurationHash !== providerConfigurationHash)
    || !validReservation(value.reservation)
    || (reservation && !sameReservation(value.reservation, reservation))
    || typeof value.actionAccountingComplete !== 'boolean'
    || !Array.isArray(value.actions) || value.actions.length > 2
    || !SAFE_CODE.test(String(value.failurePhase || ''))
    || !SAFE_CODE.test(String(value.failureCode || ''))
    || value.failureCode !== `${value.failurePhase}_failed`) return false;
  const actions = value.actions.map(canonicalAction);
  if (actions.some((action) => !action)
    || new Set(actions.map((action) => action.role)).size !== actions.length
    || actions.some((action, index) => index === 0 && action.role !== 'research_author')
    || actions.some((action, index) => index === 1 && action.role !== 'formal_reviewer')
    || value.providerCanaryActionCount !== actions.length
    || value.successfulProviderCanaryActionCount
      !== actions.filter((action) => action.status === 'succeeded').length
    || value.failedProviderCanaryActionCount
      !== actions.filter((action) => action.status === 'failed').length
    || value.researchAuthorCanaryAttemptCount
      !== actions.filter((action) => action.role === 'research_author').length
    || value.formalReviewerCanaryAttemptCount
      !== actions.filter((action) => action.role === 'formal_reviewer').length
    || value.externalActionPerformed !== (actions.length > 0)
    || value.externalActionMayHaveOccurred !== (actions.length > 0 || !value.actionAccountingComplete)
    || value.externalActionScope !== (actions.length
      ? 'read_only_ephemeral_model_canaries' : 'none_observed')) return false;
  const {
    autonomousResearchProviderCanarySideEffectInspectionHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchProviderCanarySideEffectInspection', payload) === claimedHash;
}

export function attachAutonomousResearchProviderCanarySideEffectInspection(error, options) {
  const failure = error instanceof Error ? error : new Error(String(error || 'unknown_error'));
  failure.autonomousResearchProviderCanarySideEffectInspection =
    buildAutonomousResearchProviderCanarySideEffectInspection(options);
  return failure;
}
