import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256 =
  /^sha256:[0-9a-f]{64}$/;

const ENTRY_KEYS = Object.freeze([
  'event',
  'formalDomainQualificationRecoveryJournalEntryHash',
  'idempotencyKey',
  'operationId',
  'previousEntryHash',
  'recordedAt',
  'result',
  'sequence',
  'stage',
  'version',
].sort());
const STAGES = new Set(['external-replay', 'reviewer', 'signer', 'evidence']);
const EVENTS = new Set(['stage_started', 'stage_completed', 'evidence_completed']);
const ORDERED_OPERATION_STAGES = Object.freeze([
  'external-replay',
  'reviewer',
  'signer',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

export function isFormalDomainQualificationRecoveryStage(stage) {
  return STAGES.has(stage);
}

export function isFormalDomainQualificationRecoveryEvent(event) {
  return EVENTS.has(event);
}

export function formalDomainQualificationRecoveryLineageId({
  coverageReceiptHash,
  externalReplayConfigurationIdentityHash,
  reviewerConfigurationIdentityHash,
  signerConfigurationIdentityHash,
} = {}) {
  if (![coverageReceiptHash, externalReplayConfigurationIdentityHash,
    reviewerConfigurationIdentityHash, signerConfigurationIdentityHash]
    .every((value) => (
      FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(String(value || ''))
    ))) {
    throw new Error('formal_domain_qualification_recovery_operation_invalid');
  }
  return hashRecord('FormalDomainQualificationRecoveryLineage', {
    coverageReceiptHash,
    externalReplayConfigurationIdentityHash,
    reviewerConfigurationIdentityHash,
    signerConfigurationIdentityHash,
  });
}

export function formalDomainQualificationRecoveryOperationId({
  lineageId = null,
  generation = 1,
  ...lineageInput
} = {}) {
  const selectedLineageId = lineageId
    || formalDomainQualificationRecoveryLineageId(lineageInput);
  if (!FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
    String(selectedLineageId || ''),
  ) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('formal_domain_qualification_recovery_operation_invalid');
  }
  return hashRecord('FormalDomainQualificationRecoveryGenerationOperation', {
    lineageId: selectedLineageId,
    generation,
  });
}

export function formalDomainQualificationRecoveryIdempotencyKey({
  operationId,
  stage,
} = {}) {
  if (!FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
    String(operationId || ''),
  ) || !STAGES.has(stage) || stage === 'evidence') {
    throw new Error('formal_domain_qualification_recovery_stage_invalid');
  }
  return hashRecord('FormalDomainQualificationRecoveryStage', {
    operationId,
    stage,
  });
}

export function buildFormalDomainQualificationRecoveryJournalEntry(payload) {
  return Object.freeze({
    ...payload,
    formalDomainQualificationRecoveryJournalEntryHash: hashRecord(
      'FormalDomainQualificationRecoveryJournalEntry',
      payload,
    ),
  });
}

export function verifyFormalDomainQualificationRecoveryJournalEntry(
  entry,
  { operationId, previousEntryHash, sequence },
) {
  if (!exactKeys(entry, ENTRY_KEYS)) {
    throw new Error('formal_domain_qualification_recovery_journal_invalid');
  }
  const {
    formalDomainQualificationRecoveryJournalEntryHash: claimedHash,
    ...payload
  } = entry;
  if (entry.version !== 1
    || entry.operationId !== operationId
    || entry.sequence !== sequence
    || entry.previousEntryHash !== previousEntryHash
    || !STAGES.has(entry.stage)
    || !EVENTS.has(entry.event)
    || ((entry.stage === 'evidence')
      !== (entry.event === 'evidence_completed'))
    || !FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
      String(entry.idempotencyKey || ''),
    )
    || !Number.isFinite(Date.parse(String(entry.recordedAt || '')))
    || new Date(entry.recordedAt).toISOString() !== entry.recordedAt
    || hashRecord('FormalDomainQualificationRecoveryJournalEntry', payload)
      !== claimedHash
    || (entry.event === 'stage_started' && entry.result !== null)
    || (entry.event !== 'stage_started'
      && (!entry.result || typeof entry.result !== 'object'
        || Array.isArray(entry.result)))) {
    throw new Error('formal_domain_qualification_recovery_journal_invalid');
  }
  return Object.freeze(entry);
}

export function assertFormalDomainQualificationRecoveryJournalSequence(
  entries,
  { operationId },
) {
  let stageIndex = 0;
  let stageStarted = false;
  let evidenceCompleted = false;
  for (const entry of entries) {
    if (evidenceCompleted) {
      throw new Error(
        'formal_domain_qualification_recovery_journal_sequence_invalid',
      );
    }
    if (entry.stage === 'evidence') {
      if (entry.event !== 'evidence_completed'
        || entry.idempotencyKey !== operationId
        || stageIndex !== ORDERED_OPERATION_STAGES.length
        || stageStarted) {
        throw new Error(
          'formal_domain_qualification_recovery_journal_sequence_invalid',
        );
      }
      evidenceCompleted = true;
      continue;
    }
    const expectedStage = ORDERED_OPERATION_STAGES[stageIndex];
    const expectedIdempotencyKey =
      formalDomainQualificationRecoveryIdempotencyKey({
        operationId,
        stage: entry.stage,
      });
    if (entry.stage !== expectedStage
      || entry.idempotencyKey !== expectedIdempotencyKey
      || (entry.event === 'stage_started' && stageStarted)
      || (entry.event === 'stage_completed' && !stageStarted)) {
      throw new Error(
        'formal_domain_qualification_recovery_journal_sequence_invalid',
      );
    }
    if (entry.event === 'stage_started') {
      stageStarted = true;
      continue;
    }
    stageStarted = false;
    stageIndex += 1;
  }
  return Object.freeze({
    completedStageCount: stageIndex,
    currentStage: stageStarted
      ? ORDERED_OPERATION_STAGES[stageIndex] : null,
    evidenceCompleted,
  });
}
