import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256,
  formalDomainQualificationRecoveryOperationId,
} from './formal-domain-qualification-recovery-journal-contract.mjs';

const ENTRY_KEYS = Object.freeze([
  'event',
  'evidenceHash',
  'evidenceValidUntil',
  'formalDomainQualificationRecoveryGenerationEntryHash',
  'generation',
  'kind',
  'lineageId',
  'operationId',
  'previousEntryHash',
  'recordedAt',
  'sequence',
  'supersededExternalEvidenceHash',
  'supersedesOperationId',
  'version',
].sort());
const EVENTS = new Set(['generation_selected', 'generation_completed']);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

export function buildFormalDomainQualificationRecoveryGenerationEntry(
  payload,
) {
  return Object.freeze({
    ...payload,
    formalDomainQualificationRecoveryGenerationEntryHash: hashRecord(
      'FormalDomainQualificationRecoveryGenerationEntry',
      payload,
    ),
  });
}

export function verifyFormalDomainQualificationRecoveryGenerationEntry(
  entry,
  { lineageId, previousEntryHash, sequence },
) {
  if (!exactKeys(entry, ENTRY_KEYS)) {
    throw new Error('formal_domain_qualification_recovery_generation_invalid');
  }
  const {
    formalDomainQualificationRecoveryGenerationEntryHash: claimedHash,
    ...payload
  } = entry;
  const selected = entry.event === 'generation_selected';
  if (entry.version !== 1
    || entry.kind !== 'FormalDomainQualificationRecoveryGenerationEntry'
    || entry.lineageId !== lineageId
    || entry.sequence !== sequence
    || entry.previousEntryHash !== previousEntryHash
    || !EVENTS.has(entry.event)
    || !Number.isSafeInteger(entry.generation) || entry.generation < 1
    || entry.operationId !== formalDomainQualificationRecoveryOperationId({
      lineageId,
      generation: entry.generation,
    })
    || (entry.supersedesOperationId !== null
      && !FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
        String(entry.supersedesOperationId || ''),
      ))
    || (entry.supersededExternalEvidenceHash !== null
      && !FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
        String(entry.supersededExternalEvidenceHash || ''),
      ))
    || (selected
      ? entry.evidenceHash !== null || entry.evidenceValidUntil !== null
      : (!FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
        String(entry.evidenceHash || ''),
      ) || (entry.evidenceValidUntil !== null
        && (!Number.isFinite(Date.parse(entry.evidenceValidUntil))
          || new Date(entry.evidenceValidUntil).toISOString()
            !== entry.evidenceValidUntil))))
    || !Number.isFinite(Date.parse(String(entry.recordedAt || '')))
    || new Date(entry.recordedAt).toISOString() !== entry.recordedAt
    || hashRecord('FormalDomainQualificationRecoveryGenerationEntry', payload)
      !== claimedHash) {
    throw new Error('formal_domain_qualification_recovery_generation_invalid');
  }
  return Object.freeze(entry);
}

export function assertFormalDomainQualificationRecoveryGenerationSequence(
  entries,
) {
  let selected = null;
  let completed = null;
  for (const entry of entries) {
    if (entry.event === 'generation_selected') {
      if ((selected && completed?.operationId !== selected.operationId)
        || entry.generation !== (selected?.generation || 0) + 1
        || entry.supersedesOperationId !== (selected?.operationId || null)) {
        throw new Error(
          'formal_domain_qualification_recovery_generation_sequence_invalid',
        );
      }
      selected = entry;
      completed = null;
      continue;
    }
    if (!selected || completed
      || entry.generation !== selected.generation
      || entry.operationId !== selected.operationId
      || entry.supersedesOperationId !== selected.supersedesOperationId
      || entry.supersededExternalEvidenceHash
        !== selected.supersededExternalEvidenceHash) {
      throw new Error(
        'formal_domain_qualification_recovery_generation_sequence_invalid',
      );
    }
    completed = entry;
  }
  return Object.freeze({ selected, completed });
}
